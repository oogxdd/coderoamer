/**
 * SkiaTerminalRenderer — complete Skia renderer
 *
 * Features:
 *   - Font loading via useFont() with matchFont() fallback
 *   - Accurate cell measurement from SkFont metrics
 *   - Cursor blink via Reanimated shared values
 *   - Selection overlay rendering
 *   - Reusable Skia Paint cache (avoids GC churn)
 *   - Bold-as-bright color promotion (xterm.js drawBoldTextInBrightColors)
 *   - Bold/italic/boldItalic font variant selection
 *   - Proper Line decorations for underline/strikethrough
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Platform } from 'react-native';
import {
  Canvas,
  Rect,
  Text as SkiaText,
  useFont,
  matchFont,
  Group,
  Fill,
  Skia,
  Line as SkiaLine,
  vec,
  RoundedRect,
} from '@shopify/react-native-skia';
import type { SkFont, SkPaint } from '@shopify/react-native-skia';
import {
  useSharedValue,
  withRepeat,
  withSequence,
  withTiming,
  useDerivedValue,
  Easing,
  cancelAnimation,
} from 'react-native-reanimated';
import { TerminalBuffer, ANSI_COLORS, BufferLine } from './TerminalBuffer';
import { AttrFlags, CellAttrs } from './AnsiParser';

// ────────────────────────────────────────────────────────────────────────────
// Theme
// ────────────────────────────────────────────────────────────────────────────

export interface TerminalTheme {
  background: string;
  foreground: string;
  cursor: string;
  cursorAccent: string;
  selectionBackground: string;
  selectionForeground?: string;
  ansiColors?: string[];
}

export const DEFAULT_THEME: TerminalTheme = {
  background: '#1e1e1e',
  foreground: '#d4d4d4',
  cursor: '#aeafad',
  cursorAccent: '#000000',
  selectionBackground: '#264f78',
  selectionForeground: '#ffffff',
  ansiColors: [
    '#000000', '#cd3131', '#0dbc79', '#e5e510', '#2472c8', '#bc3fbc', '#11a8cd', '#e5e5e5',
    '#666666', '#f14c4c', '#23d18b', '#f5f543', '#3b8eea', '#d670d6', '#29b8db', '#e5e5e5',
  ],
};

// ────────────────────────────────────────────────────────────────────────────
// Selection
// ────────────────────────────────────────────────────────────────────────────

export interface SelectionRange {
  start: [number, number]; // [col, row] viewport-relative
  end: [number, number];
}

function isCellSelected(x: number, y: number, sel: SelectionRange | null): boolean {
  if (!sel) return false;
  let [sx, sy] = sel.start;
  let [ex, ey] = sel.end;
  if (sy > ey || (sy === ey && sx > ex)) {
    [sx, sy, ex, ey] = [ex, ey, sx, sy];
  }
  if (y < sy || y > ey) return false;
  if (y === sy && y === ey) return x >= sx && x < ex;
  if (y === sy) return x >= sx;
  if (y === ey) return x < ex;
  return true;
}

// ────────────────────────────────────────────────────────────────────────────
// Color resolution
// ────────────────────────────────────────────────────────────────────────────

function resolveColor(attrs: CellAttrs, isFg: boolean, theme: TerminalTheme): string {
  const rgb = isFg ? attrs.fgRGB : attrs.bgRGB;
  const idx = isFg ? attrs.fg : attrs.bg;

  if (rgb !== null) {
    return `rgb(${(rgb >> 16) & 0xff},${(rgb >> 8) & 0xff},${rgb & 0xff})`;
  }
  if (idx >= 0 && idx < 256) {
    // Bold + fg 0-7 → promote to bright 8-15
    if (isFg && (attrs.flags & AttrFlags.BOLD) && idx < 8) {
      const bi = idx + 8;
      return (theme.ansiColors && bi < theme.ansiColors.length) ? theme.ansiColors[bi] : ANSI_COLORS[bi];
    }
    if (idx < 16 && theme.ansiColors && idx < theme.ansiColors.length) {
      return theme.ansiColors[idx];
    }
    return ANSI_COLORS[idx];
  }
  return isFg ? theme.foreground : 'transparent';
}

function resolveCellColors(attrs: CellAttrs, theme: TerminalTheme): { fg: string; bg: string } {
  let fg = resolveColor(attrs, true, theme);
  let bg = resolveColor(attrs, false, theme);
  if (attrs.flags & AttrFlags.INVERSE) {
    const tmp = fg;
    fg = bg === 'transparent' ? theme.background : bg;
    bg = tmp;
  }
  if (attrs.flags & AttrFlags.INVISIBLE) {
    fg = bg === 'transparent' ? theme.background : bg;
  }
  return { fg, bg };
}

// ────────────────────────────────────────────────────────────────────────────
// Font loading
// ────────────────────────────────────────────────────────────────────────────

export interface FontConfig {
  regular?: ReturnType<typeof require>;
  bold?: ReturnType<typeof require>;
  italic?: ReturnType<typeof require>;
  boldItalic?: ReturnType<typeof require>;
}

interface LoadedFonts {
  regular: SkFont;
  bold: SkFont;
  italic: SkFont;
  boldItalic: SkFont;
}

// On web, fetch a font file and create a Skia typeface from its data
function useWebTypeface() {
  const [typeface, setTypeface] = useState<any>(null);

  useEffect(() => {
    if (Platform.OS !== 'web') return;

    // Try CanvasKit's built-in default first
    try {
      const def = (Skia.Typeface as any).GetDefault?.() ?? (Skia.Typeface as any).MakeDefault?.();
      if (def) { setTypeface(def); return; }
    } catch {}

    // Fetch monospace font from public directory
    fetch('/GoogleSansCode-Regular.ttf')
      .then(res => res.arrayBuffer())
      .then(buf => {
        const data = Skia.Data.fromBytes(new Uint8Array(buf));
        const tf = Skia.Typeface.MakeFreeTypeFaceFromData(data);
        if (tf) setTypeface(tf);
      })
      .catch(err => console.error('[useWebTypeface] Font fetch failed:', err));
  }, []);

  return typeface;
}

function useTerminalFonts(fontSize: number, fontConfig?: FontConfig): LoadedFonts | null {
  const customRegular = useFont((fontConfig?.regular as any) ?? null, fontSize);
  const customBold = useFont((fontConfig?.bold as any) ?? null, fontSize);
  const customItalic = useFont((fontConfig?.italic as any) ?? null, fontSize);
  const customBoldItalic = useFont((fontConfig?.boldItalic as any) ?? null, fontSize);

  const webTypeface = useWebTypeface();
  const webFont = useMemo(() => {
    if (!webTypeface) return null;
    try { return Skia.Font(webTypeface, fontSize); }
    catch { return null; }
  }, [webTypeface, fontSize]);

  const sysRegular = useMemo(() => {
    if (Platform.OS === 'web') return null;
    try { return matchFont({ fontFamily: 'monospace', fontSize, fontWeight: 'normal', fontStyle: 'normal' }); }
    catch { return null; }
  }, [fontSize]);
  const sysBold = useMemo(() => {
    if (Platform.OS === 'web') return null;
    try { return matchFont({ fontFamily: 'monospace', fontSize, fontWeight: 'bold', fontStyle: 'normal' }); }
    catch { return null; }
  }, [fontSize]);
  const sysItalic = useMemo(() => {
    if (Platform.OS === 'web') return null;
    try { return matchFont({ fontFamily: 'monospace', fontSize, fontWeight: 'normal', fontStyle: 'italic' }); }
    catch { return null; }
  }, [fontSize]);
  const sysBoldItalic = useMemo(() => {
    if (Platform.OS === 'web') return null;
    try { return matchFont({ fontFamily: 'monospace', fontSize, fontWeight: 'bold', fontStyle: 'italic' }); }
    catch { return null; }
  }, [fontSize]);

  return useMemo(() => {
    const regular = customRegular || sysRegular || webFont;
    if (!regular) return null;
    return {
      regular,
      bold: customBold || sysBold || regular,
      italic: customItalic || sysItalic || regular,
      boldItalic: customBoldItalic || sysBoldItalic || regular,
    };
  }, [customRegular, customBold, customItalic, customBoldItalic,
      sysRegular, sysBold, sysItalic, sysBoldItalic, webFont]);
}

function selectFont(fonts: LoadedFonts, flags: number): SkFont {
  const b = !!(flags & AttrFlags.BOLD), i = !!(flags & AttrFlags.ITALIC);
  if (b && i) return fonts.boldItalic;
  if (b) return fonts.bold;
  if (i) return fonts.italic;
  return fonts.regular;
}

// ────────────────────────────────────────────────────────────────────────────
// Cell measurement
// ────────────────────────────────────────────────────────────────────────────

export interface CellMetrics {
  cellWidth: number;
  cellHeight: number;
  baseline: number;
  underlineY: number;
  strikeY: number;
}

export function measureCell(font: SkFont, fontSize: number): CellMetrics {
  const glyphWidths = font.getGlyphWidths(font.getGlyphIDs('W'));
  const cellWidth = glyphWidths.length > 0 ? glyphWidths[0] : fontSize * 0.6;

  const m = font.getMetrics();
  const ascent = Math.abs(m.ascent);
  const descent = Math.abs(m.descent);
  const leading = m.leading || 0;
  const lineHeight = ascent + descent + leading;

  const cellHeight = Math.ceil(lineHeight * 1.15);
  const baseline = Math.ceil(ascent + (cellHeight - lineHeight) / 2);
  const underlineY = baseline + Math.ceil(descent * 0.4);
  const strikeY = baseline - Math.ceil(ascent * 0.35);

  return { cellWidth, cellHeight, baseline, underlineY, strikeY };
}

// ────────────────────────────────────────────────────────────────────────────
// Props
// ────────────────────────────────────────────────────────────────────────────

export interface SkiaTerminalRendererProps {
  buffer: TerminalBuffer;
  fontSize?: number;
  fontConfig?: FontConfig;
  theme?: TerminalTheme;
  width: number;
  height: number;
  renderVersion?: number;
  selection?: SelectionRange | null;
  focused?: boolean;
  cursorBlinkInterval?: number;
}

// ────────────────────────────────────────────────────────────────────────────
// Component
// ────────────────────────────────────────────────────────────────────────────

export const SkiaTerminalRenderer: React.FC<SkiaTerminalRendererProps> = ({
  buffer,
  fontSize = 14,
  fontConfig,
  theme = DEFAULT_THEME,
  width,
  height,
  renderVersion = 0,
  selection = null,
  focused = true,
  cursorBlinkInterval = 600,
}) => {
  const fonts = useTerminalFonts(fontSize, fontConfig);

  const metrics = useMemo<CellMetrics>(() => {
    if (!fonts) {
      return { cellWidth: fontSize * 0.6, cellHeight: fontSize * 1.2,
               baseline: fontSize * 0.96, underlineY: fontSize * 1.12, strikeY: fontSize * 0.55 };
    }
    return measureCell(fonts.regular, fontSize);
  }, [fonts, fontSize]);

  const { cellWidth, cellHeight, baseline, underlineY: ulY, strikeY: stY } = metrics;

  // ── Cursor blink ──────────────────────────────────────────────────
  const cursorOpacity = useSharedValue(1);

  useEffect(() => {
    // Only blink when the app says cursor is visible AND we're focused
    if (!focused || cursorBlinkInterval <= 0 || !buffer.cursor.visible) {
      cancelAnimation(cursorOpacity);
      cursorOpacity.value = 1;
      return;
    }
    cursorOpacity.value = withRepeat(
      withSequence(
        withTiming(1, { duration: cursorBlinkInterval, easing: Easing.steps(1) }),
        withTiming(0, { duration: cursorBlinkInterval, easing: Easing.steps(1) }),
      ),
      -1, false,
    );
    return () => cancelAnimation(cursorOpacity);
  }, [focused, cursorBlinkInterval, cursorOpacity, buffer.cursor.visible]);

  // Reset blink on every render (cursor movement resets blink in xterm.js)
  useEffect(() => {
    cursorOpacity.value = 1;
  }, [renderVersion, cursorOpacity]);

  // ── Paint cache ───────────────────────────────────────────────────
  const paintCache = useRef<Map<string, SkPaint>>(new Map());
  const getPaint = useCallback((color: string, alpha: number = 1): SkPaint => {
    const key = `${color}|${alpha}`;
    let p = paintCache.current.get(key);
    if (!p) {
      p = Skia.Paint();
      p.setColor(Skia.Color(color));
      if (alpha < 1) p.setAlphaf(alpha);
      paintCache.current.set(key, p);
      if (paintCache.current.size > 512) {
        const first = paintCache.current.keys().next().value;
        if (first) paintCache.current.delete(first);
      }
    }
    return p;
  }, []);

  // ── Viewport ──────────────────────────────────────────────────────
  const viewportLines = buffer.getViewportLines();
  const cursor = buffer.cursor;

  // Loading
  if (!fonts) {
    return <Canvas style={{ width, height }}><Fill color={theme.background} /></Canvas>;
  }

  // ── Row renderer ──────────────────────────────────────────────────

  const renderRow = (line: BufferLine, rowIdx: number): React.ReactNode => {
    if (!line) return null;
    const y = rowIdx * cellHeight;
    const bgRects: React.ReactNode[] = [];
    const selRects: React.ReactNode[] = [];
    const textNodes: React.ReactNode[] = [];
    const decoNodes: React.ReactNode[] = [];

    // Pass 1: backgrounds
    let bgRunStart = 0, bgRunColor = 'transparent';
    for (let x = 0; x <= line.length; x++) {
      const cell = x < line.length ? line[x] : null;
      const bg = cell ? resolveCellColors(cell.attrs, theme).bg : 'transparent';
      if (bg !== bgRunColor || x === line.length) {
        if (bgRunColor !== 'transparent' && x > bgRunStart) {
          bgRects.push(
            <Rect key={`b${rowIdx}_${bgRunStart}`}
              x={bgRunStart * cellWidth} y={y}
              width={(x - bgRunStart) * cellWidth} height={cellHeight}
              color={bgRunColor} />
          );
        }
        bgRunStart = x;
        bgRunColor = bg;
      }
    }

    // Pass 2: selection
    if (selection) {
      let selStart = -1;
      for (let x = 0; x <= line.length; x++) {
        const sel = x < line.length && isCellSelected(x, rowIdx, selection);
        if (sel && selStart === -1) selStart = x;
        else if (!sel && selStart !== -1) {
          selRects.push(
            <Rect key={`s${rowIdx}_${selStart}`}
              x={selStart * cellWidth} y={y}
              width={(x - selStart) * cellWidth} height={cellHeight}
              color={theme.selectionBackground} opacity={0.5} />
          );
          selStart = -1;
        }
      }
    }

    // Pass 3: text runs
    let runChars = '', runStartX = 0, runFg = theme.foreground, runFlags = 0;

    const flush = (endX: number) => {
      if (!runChars.length) return;
      const font = selectFont(fonts, runFlags);
      const dim = !!(runFlags & AttrFlags.DIM);

      textNodes.push(
        <SkiaText key={`t${rowIdx}_${runStartX}`}
          x={runStartX * cellWidth} y={y + baseline}
          text={runChars} font={font} color={runFg}
          opacity={dim ? 0.5 : 1.0} />
      );

      if (runFlags & AttrFlags.UNDERLINE) {
        decoNodes.push(
          <SkiaLine key={`u${rowIdx}_${runStartX}`}
            p1={vec(runStartX * cellWidth, y + ulY)}
            p2={vec(endX * cellWidth, y + ulY)}
            color={runFg} strokeWidth={1} />
        );
      }
      if (runFlags & AttrFlags.STRIKETHROUGH) {
        decoNodes.push(
          <SkiaLine key={`k${rowIdx}_${runStartX}`}
            p1={vec(runStartX * cellWidth, y + stY)}
            p2={vec(endX * cellWidth, y + stY)}
            color={runFg} strokeWidth={1} />
        );
      }
      runChars = '';
      runStartX = endX;
    };

    for (let x = 0; x < line.length; x++) {
      const cell = line[x];
      if (cell.width === 0) continue;
      const { fg } = resolveCellColors(cell.attrs, theme);
      const fl = cell.attrs.flags;
      const ch = cell.char || ' ';
      if (fg !== runFg || fl !== runFlags) { flush(x); runFg = fg; runFlags = fl; }
      runChars += ch;
    }
    flush(line.length);

    return (
      <Group key={`r${rowIdx}`}>
        {bgRects}{selRects}{textNodes}{decoNodes}
      </Group>
    );
  };

  // ── Cursor ────────────────────────────────────────────────────────

  const renderCursor = (): React.ReactNode | null => {
    if (buffer.ydisp !== 0) return null;
    const cx = cursor.x * cellWidth;
    const cy = cursor.y * cellHeight;

    // If the app hid the cursor (e.g. Claude Code TUI), show a thin bar
    // so the user still sees where input goes. Use the full cursor style
    // only when the app says cursor is visible.
    const style = cursor.visible ? cursor.style : 'bar';

    const inner = (() => {
      switch (style) {
        case 'block': {
          const line = viewportLines[cursor.y];
          const cell = line?.[cursor.x];
          return (
            <>
              <Rect x={cx} y={cy} width={cellWidth} height={cellHeight} color={theme.cursor} />
              {cell?.char ? (
                <SkiaText x={cx} y={cy + baseline} text={cell.char}
                  font={selectFont(fonts, cell.attrs.flags)} color={theme.cursorAccent} />
              ) : null}
            </>
          );
        }
        case 'underline':
          return <Rect x={cx} y={cy + cellHeight - 2} width={cellWidth} height={2} color={theme.cursor} />;
        case 'bar':
          return <RoundedRect x={cx} y={cy + 1} width={2} height={cellHeight - 2} r={1} color={theme.cursor} />;
      }
    })();

    // Blink when cursor is visible; steady dim bar when app hid cursor
    const opacity = cursor.visible
      ? (focused ? cursorOpacity : 0.4)
      : (focused ? 0.6 : 0.3);

    return (
      <Group key="cursor" opacity={opacity}>
        {inner}
      </Group>
    );
  };

  // ── Render ────────────────────────────────────────────────────────

  return (
    <Canvas style={{ width, height }}>
      <Fill color={theme.background} />
      {viewportLines.map((line, i) => renderRow(line, i))}
      {renderCursor()}
    </Canvas>
  );
};
