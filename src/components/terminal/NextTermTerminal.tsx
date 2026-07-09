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
 * UX parity with <SkiaTerminal/>: scrollback (pan up/down through history),
 * text selection (long-press a word + drag to extend) with a Copy menu, tap to
 * toggle the keyboard, and a return key that sends Enter. Keyboard I/O,
 * rendering, resize, and DA/DSR responses round it out.
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
  Text,
  TextInput,
  Pressable,
  Keyboard,
  Dimensions,
  StyleSheet,
  Platform,
  Vibration,
  NativeSyntheticEvent,
  TextInputKeyPressEventData,
  LayoutChangeEvent,
} from 'react-native';
import {
  GestureDetector,
  Gesture,
  GestureHandlerRootView,
} from 'react-native-gesture-handler';
import { runOnJS } from 'react-native-reanimated';
import * as Clipboard from 'expo-clipboard';
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
  CellGrid,
  VTParser,
  extractText,
  DEFAULT_THEME as CORE_DEFAULT_THEME,
} from '@/vendor/next-term/core';
import type {
  Buffer,
  SelectionRange,
  Theme as CoreTheme,
} from '@/vendor/next-term/core';
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
  /** Read the OS clipboard and send it to the PTY as input. */
  paste: () => void;
  /** Extracted text of the active selection, or null. */
  getSelection: () => string | null;
  clearSelection: () => void;
  /** Jump back to the live bottom of the buffer. */
  scrollToBottom: () => void;
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

function clamp(n: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, n));
}

/** Inclusive [start, end] column range of the word under (row, col). */
function findWordAt(grid: CellGrid, col: number, row: number): [number, number] {
  const isWord = (x: number) => grid.getCodepoint(row, x) > 0x20;
  if (col < 0 || col >= grid.cols || !isWord(col)) return [col, col];
  let start = col;
  while (start > 0 && isWord(start - 1)) start--;
  let end = col;
  while (end < grid.cols - 1 && isWord(end + 1)) end++;
  return [start, end];
}

function copyBufferRows(source: Buffer, target: Buffer): void {
  const rowsToCopy = Math.min(source.rows, target.rows);
  const maxSourceStart = source.rows - rowsToCopy;
  const sourceStart = source.cursor.row < target.rows
    ? 0
    : clamp(source.cursor.row - target.rows + 1, 0, maxSourceStart);
  const targetStart = 0;

  for (let i = 0; i < rowsToCopy; i++) {
    const sourceRow = sourceStart + i;
    const targetRow = targetStart + i;
    target.grid.pasteRow(
      targetRow,
      source.grid.copyRow(sourceRow),
      source.grid.isWrapped(sourceRow),
    );
  }

  const rowDelta = targetStart - sourceStart;
  target.cursor = {
    ...source.cursor,
    row: clamp(source.cursor.row + rowDelta, 0, target.rows - 1),
    col: clamp(source.cursor.col, 0, target.cols - 1),
  };
  if (source.scrollTop === 0 && source.scrollBottom === source.rows - 1) {
    target.scrollTop = 0;
    target.scrollBottom = target.rows - 1;
  } else {
    target.scrollTop = clamp(source.scrollTop + rowDelta, 0, target.rows - 1);
    target.scrollBottom = clamp(source.scrollBottom + rowDelta, target.scrollTop, target.rows - 1);
  }
  for (const col of source.tabStops) {
    if (col >= 0 && col < target.cols) target.tabStops.add(col);
  }
  target.grid.markAllDirty();
}

function copyScrollback(source: BufferSet, target: BufferSet): void {
  const start = Math.max(0, source.scrollback.length - target.maxScrollback);
  target.scrollback = source.scrollback.slice(start);
  target.scrollbackWrap = source.scrollbackWrap.slice(start);
  target.scrollbackCompact = source.scrollbackCompact.slice(start);
}

function resizeBufferSet(source: BufferSet, cols: number, rows: number, scrollback: number): BufferSet {
  const target = new BufferSet(cols, rows, scrollback);
  copyBufferRows(source.normal, target.normal);
  copyBufferRows(source.alternate, target.alternate);
  copyScrollback(source, target);
  target.setActive(source.isAlternate);
  return target;
}

/**
 * Compose the last `rows` lines of the virtual stream `[...scrollback, active]`
 * offset `scrollOffset` lines up from the live bottom into a scratch grid, so
 * the existing per-grid renderer can paint scrolled-back history unchanged.
 *
 * KNOWN LIMITATION (deliberate first pass, not a bug): `scrollOffset` counts
 * lines from the *live bottom*, so while output streams and `scrollback` grows,
 * `maxTop` grows too and the visible content drifts upward under the user —
 * you stay "N lines from the bottom" rather than pinned to an absolute line.
 * To anchor strictly, track an absolute scrollback index (or bump scrollOffset
 * by the number of newly-pushed scrollback lines each frame) instead.
 */
function fillViewport(
  vp: CellGrid,
  bs: BufferSet,
  rows: number,
  scrollOffset: number,
): void {
  const sb = bs.scrollback;
  const sbLen = sb.length;
  const active = bs.active.grid;
  const totalVirtual = sbLen + active.rows;
  const maxTop = Math.max(0, totalVirtual - rows);
  const top = clamp(maxTop - scrollOffset, 0, maxTop);

  for (let r = 0; r < rows; r++) {
    const idx = top + r;
    if (idx < 0 || idx >= totalVirtual) {
      vp.clearRowRaw(r);
      continue;
    }
    if (idx < sbLen) {
      const rowData = sb[idx];
      const wrapped = bs.scrollbackWrap[idx] ?? false;
      if (bs.scrollbackCompact[idx]) vp.pasteCompactRow(r, rowData, wrapped);
      else vp.pasteRow(r, rowData, wrapped);
    } else {
      const ar = idx - sbLen;
      vp.pasteRow(r, active.copyRow(ar), active.isWrapped(ar));
    }
  }
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

    // ── Scroll / selection state ──────────────────────────────────────
    // scrollOffset: lines above the live bottom (0 = live). Kept in a ref so
    // gesture callbacks read the latest without re-subscribing; a small state
    // mirror drives the "scrolled up" affordance + context-menu re-render.
    const scrollOffsetRef = useRef(0);
    const [scrolledUp, setScrolledUp] = useState(false);
    const selectionRef = useRef<SelectionRange | null>(null);
    const [selection, setSelection] = useState<SelectionRange | null>(null);
    // The grid that produced the last frame (active grid, or the scroll
    // viewport). Selection hit-testing / text extraction read from it.
    const renderedGridRef = useRef<CellGrid | null>(null);
    // Scratch grid reused across scrolled frames; rebuilt on size change.
    const viewportGridRef = useRef<CellGrid | null>(null);
    const focusedRef = useRef(false);

    const getViewportGrid = useCallback((c: number, r: number): CellGrid => {
      let cur = viewportGridRef.current;
      if (!cur || cur.cols !== c || cur.rows !== r) {
        cur = new CellGrid(c, r);
        viewportGridRef.current = cur;
      }
      return cur;
    }, []);

    // ── Render (rAF-debounced full-grid pass) ─────────────────────────
    const rafRef = useRef<number | null>(null);
    const pendingRender = useRef(false);
    const renderNow = useCallback(() => {
      const bs = bufferSetRef.current;
      const rd = rendererRef.current;
      if (!bs || !rd) return;
      try {
        const offset = scrollOffsetRef.current;
        let grid = bs.active.grid;
        let cursor = bs.active.cursor;
        // Scrollback only exists for the normal buffer; the alt screen (TUIs)
        // has none, so never composite a viewport there.
        if (offset > 0 && !bs.isAlternate) {
          const vp = getViewportGrid(grid.cols, grid.rows);
          fillViewport(vp, bs, grid.rows, offset);
          grid = vp;
          cursor = { ...cursor, visible: false };
        }
        renderedGridRef.current = grid;
        const cmds = rd.renderFrame(grid, cursor, selectionRef.current);
        setCommands(cmds);
        const active = bs.active.grid;
        for (let r = 0; r < active.rows; r++) active.clearDirty(r);
      } catch {
        // Keep the session alive on a transient render glitch.
      }
    }, [getViewportGrid]);
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

    // ── Resize: the lib has no in-place resize, so rebuild while preserving
    // the visible grid. Focusing the hidden input changes keyboard height,
    // which otherwise created a fresh blank terminal.
    const sizeRef = useRef({ cols, rows });
    useEffect(() => {
      if (cols === sizeRef.current.cols && rows === sizeRef.current.rows) return;
      sizeRef.current = { cols, rows };
      const previous = bufferSetRef.current;
      const bs = previous
        ? resizeBufferSet(previous, cols, rows, scrollback)
        : new BufferSet(cols, rows, scrollback);
      bufferSetRef.current = bs;
      const parser = new VTParser(bs);
      if (onTitleChange) parser.setTitleChangeCallback(onTitleChange);
      parserRef.current = parser;
      onResize?.(cols, rows);
      scheduleRender();
    }, [cols, rows, scrollback, onResize, onTitleChange, scheduleRender]);

    // ── Keyboard avoidance + focus tracking ───────────────────────────
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

    // ── Scroll helpers ────────────────────────────────────────────────
    const setScrollOffset = useCallback((next: number) => {
      const clamped = Math.max(0, next);
      if (clamped === scrollOffsetRef.current) return;
      scrollOffsetRef.current = clamped;
      setScrolledUp(clamped > 0);
      scheduleRender();
    }, [scheduleRender]);

    const scrollToBottom = useCallback(() => setScrollOffset(0), [setScrollOffset]);

    // ── Selection helpers ─────────────────────────────────────────────
    const updateSelection = useCallback((sel: SelectionRange | null) => {
      selectionRef.current = sel;
      setSelection(sel);
      scheduleRender();
    }, [scheduleRender]);

    const getSelectionText = useCallback((): string | null => {
      const grid = renderedGridRef.current ?? bufferSetRef.current?.active.grid;
      const sel = selectionRef.current;
      if (!grid || !sel) return null;
      const text = extractText(grid, sel.startRow, sel.startCol, sel.endRow, sel.endCol);
      return text || null;
    }, []);

    const copySelection = useCallback(() => {
      const text = getSelectionText();
      if (text) Clipboard.setStringAsync(text).catch(() => {});
      updateSelection(null);
    }, [getSelectionText, updateSelection]);

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
      paste: () => {
        Clipboard.getStringAsync()
          .then((text) => { if (text) onDataRef.current?.(text); })
          .catch(() => {});
      },
      getSelection: getSelectionText,
      clearSelection: () => updateSelection(null),
      scrollToBottom,
    }), [drainResponses, scheduleRender, getSelectionText, updateSelection, scrollToBottom]);

    // ── Keyboard input ────────────────────────────────────────────────
    // Typing jumps back to the live bottom, matching a real terminal.
    const sendData = useCallback((data: string) => {
      if (scrollOffsetRef.current !== 0) setScrollOffset(0);
      onDataRef.current?.(data);
    }, [setScrollOffset]);

    const lastInputRef = useRef('');
    const lastEnterRef = useRef(0);
    const handleKeyPress = useCallback((e: NativeSyntheticEvent<TextInputKeyPressEventData>) => {
      const { key } = e.nativeEvent;
      if (selectionRef.current) updateSelection(null);
      const map: Record<string, string> = {
        Enter: '\r', Backspace: '\x7f', Escape: '\x1b', Tab: '\t',
        ArrowUp: '\x1b[A', ArrowDown: '\x1b[B', ArrowRight: '\x1b[C', ArrowLeft: '\x1b[D',
      };
      if (key === 'Enter') lastEnterRef.current = Date.now();
      if (map[key]) { sendData(map[key]); lastInputRef.current = key; }
      else if (key.length === 1) { sendData(key); lastInputRef.current = key; }
    }, [sendData, updateSelection]);
    const handleChangeText = useCallback((text: string) => {
      if (text.length > 0 && text !== lastInputRef.current) sendData(text);
      lastInputRef.current = '';
      setTimeout(() => textInputRef.current?.clear(), 0);
    }, [sendData]);
    // The soft keyboard's return key: iOS doesn't fire onKeyPress('Enter') for
    // it, so translate submit → CR. Guard against Android double-firing both.
    const handleSubmitEditing = useCallback(() => {
      if (Date.now() - lastEnterRef.current > 100) sendData('\r');
    }, [sendData]);

    const onLayout = useCallback((e: LayoutChangeEvent) => {
      const { width, height } = e.nativeEvent.layout;
      setLayout({ width, height });
    }, []);

    // ── Gestures: tap (toggle keyboard), pan (scroll), long-press (select) ──
    const handleTap = useCallback(() => {
      if (selectionRef.current) { updateSelection(null); return; }
      if (focusedRef.current) { Keyboard.dismiss(); textInputRef.current?.blur(); }
      else { textInputRef.current?.focus(); }
    }, [updateSelection]);

    const scrollRemainderRef = useRef(0);
    const lastPanRef = useRef(0);
    const handleScrollUpdate = useCallback((translationY: number) => {
      const bs = bufferSetRef.current;
      if (!bs || bs.isAlternate) return;
      const deltaY = translationY - lastPanRef.current;
      lastPanRef.current = translationY;
      scrollRemainderRef.current += deltaY;
      const lines = Math.trunc(scrollRemainderRef.current / cellHeight);
      if (lines === 0) return;
      scrollRemainderRef.current -= lines * cellHeight;
      // Finger down (deltaY > 0) → toward the live bottom; up → into history.
      const maxOffset = bs.scrollback.length;
      setScrollOffset(clamp(scrollOffsetRef.current - lines, 0, maxOffset));
    }, [cellHeight, setScrollOffset]);
    const handleScrollEnd = useCallback(() => {
      scrollRemainderRef.current = 0;
      lastPanRef.current = 0;
    }, []);

    const handleLongPressStart = useCallback((x: number, y: number) => {
      const grid = renderedGridRef.current ?? bufferSetRef.current?.active.grid;
      if (!grid) return;
      const col = Math.floor(x / cellWidth);
      const row = Math.floor(y / cellHeight);
      if (col < 0 || col >= grid.cols || row < 0 || row >= grid.rows) return;
      const [wStart, wEnd] = findWordAt(grid, col, row);
      updateSelection({ startRow: row, startCol: wStart, endRow: row, endCol: wEnd });
      Vibration.vibrate(30);
    }, [cellWidth, cellHeight, updateSelection]);

    const handleSelectionExtend = useCallback((x: number, y: number) => {
      const grid = renderedGridRef.current ?? bufferSetRef.current?.active.grid;
      const sel = selectionRef.current;
      if (!grid || !sel) return;
      const col = clamp(Math.floor(x / cellWidth), 0, grid.cols - 1);
      const row = clamp(Math.floor(y / cellHeight), 0, grid.rows - 1);
      updateSelection({ ...sel, endRow: row, endCol: col });
    }, [cellWidth, cellHeight, updateSelection]);

    const tapGesture = useMemo(
      () => Gesture.Tap().onEnd(() => { 'worklet'; runOnJS(handleTap)(); }),
      [handleTap],
    );
    const panGesture = useMemo(
      () => Gesture.Pan()
        .minDistance(12)
        .onUpdate((e) => { 'worklet'; runOnJS(handleScrollUpdate)(e.translationY); })
        .onEnd(() => { 'worklet'; runOnJS(handleScrollEnd)(); }),
      [handleScrollUpdate, handleScrollEnd],
    );
    const longPressGesture = useMemo(
      () => Gesture.LongPress()
        .minDuration(350)
        .onStart((e) => { 'worklet'; runOnJS(handleLongPressStart)(e.x, e.y); }),
      [handleLongPressStart],
    );
    const selectionPanGesture = useMemo(
      () => Gesture.Pan()
        .activateAfterLongPress(350)
        .onUpdate((e) => { 'worklet'; runOnJS(handleSelectionExtend)(e.x, e.y); }),
      [handleSelectionExtend],
    );
    const composedGestures = useMemo(
      () => Gesture.Race(
        selectionPanGesture,
        Gesture.Exclusive(longPressGesture, tapGesture),
        panGesture,
      ),
      [selectionPanGesture, longPressGesture, tapGesture, panGesture],
    );

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

    // Context-menu anchor: above the selection's top-left, clamped on-screen.
    const menuLeft = selection
      ? clamp(Math.min(selection.startCol, selection.endCol) * cellWidth, 8, Math.max(8, safeW - 80))
      : 0;
    const menuTop = selection
      ? Math.max(4, Math.min(selection.startRow, selection.endRow) * cellHeight - 38)
      : 0;

    return (
      <GestureHandlerRootView style={styles.fill}>
        <View style={styles.fill} onLayout={onLayout}>
          <GestureDetector gesture={composedGestures}>
            <View style={styles.fill}>
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
            </View>
          </GestureDetector>

          {/* Copy menu for the active selection */}
          {selection && (
            <View style={[styles.contextMenu, { left: menuLeft, top: menuTop }]}>
              <Pressable
                style={({ pressed }) => [styles.contextMenuItem, pressed && { opacity: 0.6 }]}
                onPress={copySelection}
              >
                <Text style={styles.contextMenuText}>Copy</Text>
              </Pressable>
            </View>
          )}

          {/* "Jump to latest" affordance while scrolled into history */}
          {scrolledUp && (
            <Pressable
              style={({ pressed }) => [styles.scrollToBottom, pressed && { opacity: 0.7 }]}
              onPress={scrollToBottom}
            >
              <Text style={styles.scrollToBottomText}>↓ Jump to latest</Text>
            </Pressable>
          )}

          <TextInput
            ref={textInputRef}
            style={styles.hiddenInput}
            autoCapitalize="none"
            autoCorrect={false}
            autoComplete="off"
            spellCheck={false}
            keyboardType="ascii-capable"
            keyboardAppearance="dark"
            returnKeyType="default"
            onKeyPress={handleKeyPress}
            onChangeText={handleChangeText}
            onSubmitEditing={handleSubmitEditing}
            onFocus={() => { focusedRef.current = true; }}
            onBlur={() => { focusedRef.current = false; }}
            blurOnSubmit={false}
            caretHidden
            textContentType="none"
            importantForAutofill="no"
          />
        </View>
      </GestureHandlerRootView>
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
  contextMenu: {
    position: 'absolute',
    backgroundColor: '#2a2a2a',
    borderRadius: 8,
    paddingHorizontal: 2,
    paddingVertical: 2,
    flexDirection: 'row',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.4,
    shadowRadius: 6,
    elevation: 8,
    zIndex: 100,
  },
  contextMenuItem: {
    paddingHorizontal: 16,
    paddingVertical: 6,
    borderRadius: 6,
  },
  contextMenuText: {
    color: '#ffffff',
    fontSize: 13,
    fontWeight: '500',
  },
  scrollToBottom: {
    position: 'absolute',
    right: 12,
    bottom: 12,
    backgroundColor: '#21262d',
    borderColor: '#30363d',
    borderWidth: 1,
    borderRadius: 16,
    paddingHorizontal: 12,
    paddingVertical: 6,
    zIndex: 100,
  },
  scrollToBottomText: {
    color: '#c9d1d9',
    fontSize: 12,
    fontWeight: '600',
  },
});
