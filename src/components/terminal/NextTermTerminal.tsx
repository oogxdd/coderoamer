/**
 * NextTermTerminal — experimental terminal backed by the vendored `next-term`
 * library (`@/vendor/next-term`) instead of our own AnsiParser/TerminalBuffer.
 *
 * The vendored lib gives us the VT engine (`BufferSet` + `VTParser`) and a
 * `SkiaRenderer` that turns the cell grid into a flat `RenderCommand[]`
 * (rect/text/line). It does NOT paint — this component is the Skia surface that
 * consumes those commands, plus a hidden TextInput for keyboard input.
 *
 * Exposes the subset of the terminal handle the screen actually uses
 * (`write`/`focus`/`blur`) so it can drop in next to <SkiaTerminal/>.
 *
 * Scope (experiment): no scrollback gestures or selection yet — keyboard I/O,
 * rendering, resize, and DA/DSR responses. Per-cell text commands (the lib
 * doesn't batch runs) make this heavier than our own renderer; fine for A/B.
 */

import React, {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from 'react';
import {
  View,
  TextInput,
  Pressable,
  Keyboard,
  Dimensions,
  StyleSheet,
  Platform,
  NativeSyntheticEvent,
  TextInputKeyPressEventData,
  LayoutChangeEvent,
} from 'react-native';
import {
  Canvas,
  Fill,
  Rect,
  Text as SkiaText,
  matchFont,
} from '@shopify/react-native-skia';
import type { SkFont } from '@shopify/react-native-skia';
import {
  BufferSet,
  VTParser,
  DEFAULT_THEME as CORE_DEFAULT_THEME,
} from '@/vendor/next-term/core';
import type { Theme as CoreTheme } from '@/vendor/next-term/core';
import { SkiaRenderer } from '@/vendor/next-term/SkiaRenderer';
import type { RenderCommand } from '@/vendor/next-term/SkiaRenderer';
import type { TerminalTheme } from './SkiaTerminalRenderer';

// ────────────────────────────────────────────────────────────────────────────
// Types
// ────────────────────────────────────────────────────────────────────────────

export interface NextTermTerminalHandle {
  write: (data: string) => void;
  focus: () => void;
  blur: () => void;
}

export interface NextTermTerminalProps {
  fontSize?: number;
  /** App-shaped theme (ansiColors[0..15] + named); mapped to the core Theme. */
  theme?: TerminalTheme;
  scrollback?: number;
  onData?: (data: string) => void;
  onResize?: (cols: number, rows: number) => void;
  onTitleChange?: (title: string) => void;
  /** Accepted for prop-compatibility with <SkiaTerminal/>; unused here. */
  cursorBlinkInterval?: number;
}

// ────────────────────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────────────────────

/** Map our app theme (ansiColors[16]) onto the vendored core Theme. */
function toCoreTheme(t?: TerminalTheme): CoreTheme {
  if (!t) return CORE_DEFAULT_THEME;
  const a = t.ansiColors ?? [];
  const at = (i: number, fallback: string) => a[i] ?? fallback;
  return {
    foreground: t.foreground,
    background: t.background,
    cursor: t.cursor,
    cursorAccent: t.cursorAccent,
    selectionBackground: t.selectionBackground,
    black: at(0, CORE_DEFAULT_THEME.black),
    red: at(1, CORE_DEFAULT_THEME.red),
    green: at(2, CORE_DEFAULT_THEME.green),
    yellow: at(3, CORE_DEFAULT_THEME.yellow),
    blue: at(4, CORE_DEFAULT_THEME.blue),
    magenta: at(5, CORE_DEFAULT_THEME.magenta),
    cyan: at(6, CORE_DEFAULT_THEME.cyan),
    white: at(7, CORE_DEFAULT_THEME.white),
    brightBlack: at(8, CORE_DEFAULT_THEME.brightBlack),
    brightRed: at(9, CORE_DEFAULT_THEME.brightRed),
    brightGreen: at(10, CORE_DEFAULT_THEME.brightGreen),
    brightYellow: at(11, CORE_DEFAULT_THEME.brightYellow),
    brightBlue: at(12, CORE_DEFAULT_THEME.brightBlue),
    brightMagenta: at(13, CORE_DEFAULT_THEME.brightMagenta),
    brightCyan: at(14, CORE_DEFAULT_THEME.brightCyan),
    brightWhite: at(15, CORE_DEFAULT_THEME.brightWhite),
  };
}

// Skia throws on a color it can't parse; the renderer emits hex + rgb(), but
// guard anyway so a stray value can't crash the native surface.
const VALID_COLOR_RE = /^(#[0-9a-fA-F]{3,8}|rgba?\([^)]*\)|transparent)$/;
function safeColor(c: string | undefined, fallback: string): string {
  return typeof c === 'string' && VALID_COLOR_RE.test(c) ? c : fallback;
}

const sharedEncoder = typeof TextEncoder !== 'undefined' ? new TextEncoder() : null;
function encodeUtf8(s: string): Uint8Array {
  if (sharedEncoder) return sharedEncoder.encode(s);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i) & 0xff;
  return out;
}
/** Parser responses (DA/DSR/etc.) are ASCII escape sequences. */
function decodeAscii(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return s;
}

function matchMono(
  fontSize: number,
  fontWeight: 'normal' | 'bold',
  fontStyle: 'normal' | 'italic',
): SkFont | null {
  try {
    return matchFont({ fontFamily: 'monospace', fontSize, fontWeight, fontStyle });
  } catch {
    return null;
  }
}

function useMonoFonts(fontSize: number) {
  const regular = useMemo(() => matchMono(fontSize, 'normal', 'normal'), [fontSize]);
  const bold = useMemo(() => matchMono(fontSize, 'bold', 'normal'), [fontSize]);
  const italic = useMemo(() => matchMono(fontSize, 'normal', 'italic'), [fontSize]);
  const boldItalic = useMemo(() => matchMono(fontSize, 'bold', 'italic'), [fontSize]);
  return { regular, bold, italic, boldItalic };
}

// ────────────────────────────────────────────────────────────────────────────
// Component
// ────────────────────────────────────────────────────────────────────────────

export const NextTermTerminal = forwardRef<NextTermTerminalHandle, NextTermTerminalProps>(
  function NextTermTerminal(
    { fontSize = 13, theme, scrollback = 1000, onData, onResize, onTitleChange },
    ref,
  ) {
    // ── Layout / keyboard avoidance ───────────────────────────────────
    const [layout, setLayout] = useState({ width: 0, height: 0 });
    const [keyboardHeight, setKeyboardHeight] = useState(0);
    const screen = Dimensions.get('window');
    const containerWidth = layout.width || screen.width;
    const containerHeight = (layout.height || screen.height) - keyboardHeight;

    const coreTheme = useMemo(() => toCoreTheme(theme), [theme]);
    const fonts = useMonoFonts(fontSize);

    // ── Renderer (geometry source of truth) ───────────────────────────
    const rendererRef = useRef<SkiaRenderer | null>(null);
    if (!rendererRef.current) {
      rendererRef.current = new SkiaRenderer({ fontSize, fontFamily: 'monospace', theme: coreTheme });
    }
    const { width: cellWidth, height: cellHeight } = rendererRef.current.getCellSize();
    const cols = Math.max(2, Math.floor(containerWidth / cellWidth));
    const rows = Math.max(1, Math.floor(containerHeight / cellHeight));

    // ── VT engine ─────────────────────────────────────────────────────
    const bufferSetRef = useRef<BufferSet | null>(null);
    const parserRef = useRef<VTParser | null>(null);
    if (!bufferSetRef.current) {
      bufferSetRef.current = new BufferSet(cols, rows, scrollback);
      parserRef.current = new VTParser(bufferSetRef.current);
    }

    const [commands, setCommands] = useState<RenderCommand[]>([]);
    const textInputRef = useRef<TextInput>(null);

    const onDataRef = useRef(onData);
    useEffect(() => { onDataRef.current = onData; }, [onData]);

    // ── Render (rAF-debounced full-grid pass) ─────────────────────────
    const rafRef = useRef<number | null>(null);
    const pendingRender = useRef(false);
    const renderNow = useCallback(() => {
      const bs = bufferSetRef.current;
      const rd = rendererRef.current;
      if (!bs || !rd) return;
      try {
        const cmds = rd.renderFrame(bs.active.grid, bs.active.cursor, null);
        setCommands(cmds);
        const grid = bs.active.grid;
        for (let r = 0; r < grid.rows; r++) grid.clearDirty(r);
      } catch {
        // Keep the session alive on a transient render glitch.
      }
    }, []);
    const scheduleRender = useCallback(() => {
      if (pendingRender.current) return;
      pendingRender.current = true;
      rafRef.current = requestAnimationFrame(() => {
        pendingRender.current = false;
        renderNow();
      });
    }, [renderNow]);
    useEffect(() => () => { if (rafRef.current != null) cancelAnimationFrame(rafRef.current); }, []);

    // Drain DA/DSR/etc. replies the parser queued, back to the PTY.
    const drainResponses = useCallback(() => {
      const parser = parserRef.current;
      if (!parser) return;
      while (parser.hasResponse()) {
        const r = parser.readResponse();
        if (!r) break;
        onDataRef.current?.(decodeAscii(r));
      }
    }, []);

    // Title callback
    useEffect(() => {
      if (onTitleChange) parserRef.current?.setTitleChangeCallback(onTitleChange);
    }, [onTitleChange]);

    // Theme / font updates
    useEffect(() => { rendererRef.current?.setTheme(coreTheme); scheduleRender(); }, [coreTheme, scheduleRender]);
    useEffect(() => { rendererRef.current?.setFont(fontSize, 'monospace'); scheduleRender(); }, [fontSize, scheduleRender]);

    // ── Resize: the lib has no in-place resize, so rebuild the engine ──
    const sizeRef = useRef({ cols, rows });
    useEffect(() => {
      if (cols === sizeRef.current.cols && rows === sizeRef.current.rows) return;
      sizeRef.current = { cols, rows };
      const bs = new BufferSet(cols, rows, scrollback);
      bufferSetRef.current = bs;
      const parser = new VTParser(bs);
      if (onTitleChange) parser.setTitleChangeCallback(onTitleChange);
      parserRef.current = parser;
      onResize?.(cols, rows);
      scheduleRender();
    }, [cols, rows, scrollback, onResize, onTitleChange, scheduleRender]);

    // ── Keyboard avoidance ────────────────────────────────────────────
    useEffect(() => {
      const show = Keyboard.addListener(
        Platform.OS === 'ios' ? 'keyboardWillShow' : 'keyboardDidShow',
        (e) => setKeyboardHeight(e.endCoordinates.height),
      );
      const hide = Keyboard.addListener(
        Platform.OS === 'ios' ? 'keyboardWillHide' : 'keyboardDidHide',
        () => setKeyboardHeight(0),
      );
      return () => { show.remove(); hide.remove(); };
    }, []);

    // ── Imperative handle ─────────────────────────────────────────────
    useImperativeHandle(ref, () => ({
      write: (data: string) => {
        const parser = parserRef.current;
        if (!parser) return;
        try { parser.write(encodeUtf8(data)); } catch {}
        drainResponses();
        scheduleRender();
      },
      focus: () => textInputRef.current?.focus(),
      blur: () => textInputRef.current?.blur(),
    }), [drainResponses, scheduleRender]);

    // ── Keyboard input ────────────────────────────────────────────────
    const sendData = useCallback((data: string) => { onDataRef.current?.(data); }, []);
    const lastInputRef = useRef('');
    const handleKeyPress = useCallback((e: NativeSyntheticEvent<TextInputKeyPressEventData>) => {
      const { key } = e.nativeEvent;
      const map: Record<string, string> = {
        Enter: '\r', Backspace: '\x7f', Escape: '\x1b', Tab: '\t',
        ArrowUp: '\x1b[A', ArrowDown: '\x1b[B', ArrowRight: '\x1b[C', ArrowLeft: '\x1b[D',
      };
      if (map[key]) { sendData(map[key]); lastInputRef.current = key; }
      else if (key.length === 1) { sendData(key); lastInputRef.current = key; }
    }, [sendData]);
    const handleChangeText = useCallback((text: string) => {
      if (text.length > 0 && text !== lastInputRef.current) sendData(text);
      lastInputRef.current = '';
      setTimeout(() => textInputRef.current?.clear(), 0);
    }, [sendData]);

    const onLayout = useCallback((e: LayoutChangeEvent) => {
      const { width, height } = e.nativeEvent.layout;
      setLayout({ width, height });
    }, []);

    // ── Paint ─────────────────────────────────────────────────────────
    const selectFont = (bold?: boolean, italic?: boolean): SkFont | null => {
      if (bold && italic) return fonts.boldItalic ?? fonts.regular;
      if (bold) return fonts.bold ?? fonts.regular;
      if (italic) return fonts.italic ?? fonts.regular;
      return fonts.regular;
    };

    const safeW = Number.isFinite(containerWidth) && containerWidth > 0 ? containerWidth : 1;
    const safeH = Number.isFinite(containerHeight) && containerHeight > 0 ? containerHeight : 1;
    const bg = safeColor(coreTheme.background, '#1e1e1e');

    return (
      <View style={styles.fill} onLayout={onLayout}>
        <Pressable style={styles.fill} onPress={() => textInputRef.current?.focus()}>
          <Canvas style={{ width: safeW, height: safeH }}>
            <Fill color={bg} />
            {commands.map((cmd, i) => {
              if (cmd.type === 'text') {
                if (!cmd.text) return null;
                const font = selectFont(cmd.bold, cmd.italic);
                if (!font) return null;
                return (
                  <SkiaText
                    key={i}
                    x={cmd.x}
                    y={cmd.y}
                    text={cmd.text}
                    font={font}
                    color={safeColor(cmd.color, coreTheme.foreground)}
                    opacity={cmd.opacity ?? 1}
                  />
                );
              }
              // rect + line (line is just a 1px-tall rect with the given width)
              return (
                <Rect
                  key={i}
                  x={cmd.x}
                  y={cmd.y}
                  width={cmd.width ?? 0}
                  height={cmd.height ?? (cmd.type === 'line' ? 1 : 0)}
                  color={safeColor(cmd.color, bg)}
                  opacity={cmd.opacity ?? 1}
                />
              );
            })}
          </Canvas>
        </Pressable>

        <TextInput
          ref={textInputRef}
          style={styles.hiddenInput}
          autoCapitalize="none"
          autoCorrect={false}
          autoComplete="off"
          spellCheck={false}
          keyboardType="ascii-capable"
          keyboardAppearance="dark"
          onKeyPress={handleKeyPress}
          onChangeText={handleChangeText}
          blurOnSubmit={false}
          caretHidden
          textContentType="none"
          importantForAutofill="no"
        />
      </View>
    );
  },
);

NextTermTerminal.displayName = 'NextTermTerminal';

const styles = StyleSheet.create({
  fill: { flex: 1 },
  hiddenInput: {
    position: 'absolute',
    opacity: 0,
    width: 1,
    height: 1,
    left: -9999,
    top: -9999,
  },
});
