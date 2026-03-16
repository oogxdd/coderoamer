/**
 * TerminalBuffer — port of xterm.js's Buffer + InputHandler
 *
 * xterm.js architecture:
 *   - Buffer holds BufferLine[] (active + scrollback)
 *   - BufferLine holds CellData[] (each cell = char + attrs)
 *   - InputHandler receives parsed sequences and mutates the buffer
 *   - Cursor position (x, y) is tracked on the buffer
 *
 * We merge Buffer + InputHandler into one class for simplicity.
 */

import {
  AnsiParser,
  IParserCallbacks,
  CellAttrs,
  TerminalCell,
  AttrFlags,
  defaultAttrs,
  cloneAttrs,
  emptyCell,
} from './AnsiParser';

/** Standard 256-color palette (xterm colors). First 16 are the "named" ANSI colors. */
export const ANSI_COLORS: string[] = [
  // 0-7: normal
  '#000000', '#cd0000', '#00cd00', '#cdcd00', '#0000ee', '#cd00cd', '#00cdcd', '#e5e5e5',
  // 8-15: bright
  '#7f7f7f', '#ff0000', '#00ff00', '#ffff00', '#5c5cff', '#ff00ff', '#00ffff', '#ffffff',
  // 16-231: 6x6x6 color cube
  ...(() => {
    const colors: string[] = [];
    for (let r = 0; r < 6; r++)
      for (let g = 0; g < 6; g++)
        for (let b = 0; b < 6; b++) {
          const ri = r ? 55 + r * 40 : 0;
          const gi = g ? 55 + g * 40 : 0;
          const bi = b ? 55 + b * 40 : 0;
          colors.push(`#${ri.toString(16).padStart(2,'0')}${gi.toString(16).padStart(2,'0')}${bi.toString(16).padStart(2,'0')}`);
        }
    return colors;
  })(),
  // 232-255: grayscale ramp
  ...(() => {
    const colors: string[] = [];
    for (let i = 0; i < 24; i++) {
      const v = 8 + i * 10;
      colors.push(`#${v.toString(16).padStart(2,'0')}${v.toString(16).padStart(2,'0')}${v.toString(16).padStart(2,'0')}`);
    }
    return colors;
  })(),
];

export interface CursorState {
  x: number;
  y: number;
  visible: boolean;
  style: 'block' | 'underline' | 'bar';
}

export type BufferLine = TerminalCell[];

export interface DirtyRegion {
  startRow: number;
  endRow: number;  // inclusive
}

export class TerminalBuffer implements IParserCallbacks {
  cols: number;
  rows: number;
  scrollback: number;

  /** All lines: scrollback + viewport. Viewport starts at lines[ybase]. */
  lines: BufferLine[] = [];

  /** Index into lines[] where the viewport begins */
  ybase: number = 0;

  /** Scroll offset for viewing scrollback (0 = bottom) */
  ydisp: number = 0;

  cursor: CursorState = { x: 0, y: 0, visible: true, style: 'block' };

  /** Current SGR attributes applied to new characters */
  private _curAttrs: CellAttrs = defaultAttrs();

  /** Saved cursor state (ESC 7 / ESC 8) — mirrors xterm.js _savedCursor */
  private _savedCursor: { x: number; y: number; attrs: CellAttrs } | null = null;

  /** Scroll region top/bottom (CSI r) */
  private _scrollTop: number = 0;
  private _scrollBottom: number;

  /** Dirty tracking for efficient re-rendering — mirrors xterm.js's renderDebouncer */
  private _dirty: Set<number> = new Set();

  /** Alternate buffer (CSI ?1049h) — simplified */
  private _altBuffer: { lines: BufferLine[]; ybase: number; cursor: CursorState } | null = null;

  /** The parser instance */
  parser: AnsiParser;

  constructor(cols: number, rows: number, scrollback: number = 1000) {
    this.cols = cols;
    this.rows = rows;
    this.scrollback = scrollback;
    this._scrollBottom = rows - 1;

    // Initialize viewport lines
    for (let i = 0; i < rows; i++) {
      this.lines.push(this._createEmptyLine());
    }

    this.parser = new AnsiParser(this);
  }

  // ──────────────────────────────────────────────────────────────────────
  // Public API
  // ──────────────────────────────────────────────────────────────────────

  /** Write raw data (with ANSI escapes) into the terminal */
  write(data: string): void {
    this._dirty.clear();
    this.parser.parse(data);
  }

  /** Get the visible viewport lines */
  getViewportLines(): BufferLine[] {
    const start = this.ybase + this.ydisp;
    return this.lines.slice(start, start + this.rows);
  }

  /** Get absolute line at viewport row y */
  getLine(y: number): BufferLine {
    return this.lines[this.ybase + this.ydisp + y];
  }

  /** Get dirty rows since last write (for incremental rendering) */
  getDirtyRows(): number[] {
    return Array.from(this._dirty);
  }

  /** Clear dirty tracking */
  clearDirty(): void {
    this._dirty.clear();
  }

  /** Resize the terminal — mirrors xterm.js's Buffer.resize() */
  resize(cols: number, rows: number): void {
    // Truncate or extend each existing line to new col count
    for (let i = 0; i < this.lines.length; i++) {
      const line = this.lines[i];
      if (cols > this.cols) {
        for (let c = this.cols; c < cols; c++) {
          line.push(emptyCell());
        }
      } else {
        line.length = cols;
      }
    }

    // Add/remove viewport rows
    if (rows > this.rows) {
      for (let i = 0; i < rows - this.rows; i++) {
        this.lines.push(this._createEmptyLine(cols));
      }
    }

    this.cols = cols;
    this.rows = rows;
    this._scrollBottom = rows - 1;
    this.cursor.x = Math.min(this.cursor.x, cols - 1);
    this.cursor.y = Math.min(this.cursor.y, rows - 1);

    // Mark everything dirty
    for (let i = 0; i < rows; i++) this._dirty.add(i);
  }

  // ──────────────────────────────────────────────────────────────────────
  // IParserCallbacks — called by AnsiParser
  // ──────────────────────────────────────────────────────────────────────

  /** 
   * Print a character — mirrors xterm.js InputHandler.print()
   * This is the hottest path. xterm.js's canvas renderer uses a glyph cache
   * (texture atlas) here; we just store into the buffer and let Skia render.
   */
  print(char: string, width: number): void {
    // Handle line wrap
    if (this.cursor.x >= this.cols) {
      this.cursor.x = 0;
      this._lineFeed();
    }

    const line = this._getActiveLine(this.cursor.y);

    // For wide chars, clear the next cell too
    if (width === 2 && this.cursor.x + 1 < this.cols) {
      line[this.cursor.x] = { char, width: 2, attrs: cloneAttrs(this._curAttrs) };
      line[this.cursor.x + 1] = { char: '', width: 0, attrs: cloneAttrs(this._curAttrs) };
      this.cursor.x += 2;
    } else {
      line[this.cursor.x] = { char, width: 1, attrs: cloneAttrs(this._curAttrs) };
      this.cursor.x++;
    }

    this._dirty.add(this.cursor.y);
  }

  /** Execute C0 control — mirrors xterm.js InputHandler C0 handlers */
  executeC0(code: number): void {
    switch (code) {
      case 0x07: // BEL
        // Could trigger a bell callback
        break;
      case 0x08: // BS (backspace)
        if (this.cursor.x > 0) this.cursor.x--;
        break;
      case 0x09: // HT (tab)
        this.cursor.x = Math.min(this.cols - 1, (Math.floor(this.cursor.x / 8) + 1) * 8);
        break;
      case 0x0a: // LF (line feed)
      case 0x0b: // VT
      case 0x0c: // FF
        this._lineFeed();
        break;
      case 0x0d: // CR (carriage return)
        this.cursor.x = 0;
        break;
    }
  }

  /**
   * Execute CSI sequence — mirrors xterm.js InputHandler CSI dispatch.
   * This is where the bulk of terminal control lives.
   */
  executeCsi(params: number[], intermediates: string, finalChar: string): void {
    // Private mode sequences (CSI ? ...)
    if (intermediates === '?') {
      this._csiPrivateMode(params, finalChar);
      return;
    }

    const p0 = params[0] || 0;
    const p1 = params[1] || 0;

    switch (finalChar) {
      case 'A': // CUU — Cursor Up
        this.cursor.y = Math.max(this._scrollTop, this.cursor.y - (p0 || 1));
        break;
      case 'B': // CUD — Cursor Down
        this.cursor.y = Math.min(this._scrollBottom, this.cursor.y + (p0 || 1));
        break;
      case 'C': // CUF — Cursor Forward
        this.cursor.x = Math.min(this.cols - 1, this.cursor.x + (p0 || 1));
        break;
      case 'D': // CUB — Cursor Back
        this.cursor.x = Math.max(0, this.cursor.x - (p0 || 1));
        break;
      case 'H': // CUP — Cursor Position
      case 'f': // HVP — same as CUP
        this.cursor.y = Math.min(this.rows - 1, Math.max(0, (p0 || 1) - 1));
        this.cursor.x = Math.min(this.cols - 1, Math.max(0, (p1 || 1) - 1));
        break;
      case 'J': // ED — Erase in Display
        this._eraseInDisplay(p0);
        break;
      case 'K': // EL — Erase in Line
        this._eraseInLine(p0);
        break;
      case 'L': // IL — Insert Lines
        this._insertLines(p0 || 1);
        break;
      case 'M': // DL — Delete Lines
        this._deleteLines(p0 || 1);
        break;
      case 'P': // DCH — Delete Characters
        this._deleteChars(p0 || 1);
        break;
      case '@': // ICH — Insert Characters
        this._insertChars(p0 || 1);
        break;
      case 'G': // CHA — Cursor Character Absolute
        this.cursor.x = Math.min(this.cols - 1, Math.max(0, (p0 || 1) - 1));
        break;
      case 'd': // VPA — Line Position Absolute
        this.cursor.y = Math.min(this.rows - 1, Math.max(0, (p0 || 1) - 1));
        break;
      case 'm': // SGR — Select Graphic Rendition
        this._handleSgr(params);
        break;
      case 'r': // DECSTBM — Set Scrolling Region
        this._scrollTop = Math.max(0, (p0 || 1) - 1);
        this._scrollBottom = Math.min(this.rows - 1, (p1 || this.rows) - 1);
        this.cursor.x = 0;
        this.cursor.y = 0;
        break;
      case 'S': // SU — Scroll Up
        for (let i = 0; i < (p0 || 1); i++) this._scrollUp();
        break;
      case 'T': // SD — Scroll Down
        for (let i = 0; i < (p0 || 1); i++) this._scrollDown();
        break;
      case 'X': // ECH — Erase Characters
        this._eraseChars(p0 || 1);
        break;
    }
  }

  /** Execute ESC sequence */
  executeEsc(intermediates: string, finalChar: string): void {
    switch (finalChar) {
      case '7': // DECSC — Save Cursor
        this._savedCursor = { x: this.cursor.x, y: this.cursor.y, attrs: cloneAttrs(this._curAttrs) };
        break;
      case '8': // DECRC — Restore Cursor
        if (this._savedCursor) {
          this.cursor.x = this._savedCursor.x;
          this.cursor.y = this._savedCursor.y;
          this._curAttrs = cloneAttrs(this._savedCursor.attrs);
        }
        break;
      case 'M': // RI — Reverse Index (scroll down)
        if (this.cursor.y === this._scrollTop) {
          this._scrollDown();
        } else if (this.cursor.y > 0) {
          this.cursor.y--;
        }
        break;
      case 'D': // IND — Index (scroll up)
        this._lineFeed();
        break;
      case 'E': // NEL — Next Line
        this.cursor.x = 0;
        this._lineFeed();
        break;
      case 'c': // RIS — Full Reset
        this._fullReset();
        break;
    }
  }

  /** Handle OSC sequences (titles, etc.) */
  executeOsc(id: number, data: string): void {
    // OSC 0 and 2 = Set window title — we can expose this as a callback
    // For now, we just ignore. In a real implementation you'd emit an event.
  }

  // ──────────────────────────────────────────────────────────────────────
  // SGR handling — mirrors xterm.js InputHandler._handleSGR()
  // ──────────────────────────────────────────────────────────────────────

  private _handleSgr(params: number[]): void {
    if (params.length === 0 || (params.length === 1 && params[0] === 0)) {
      this._curAttrs = defaultAttrs();
      return;
    }

    for (let i = 0; i < params.length; i++) {
      const p = params[i];

      if (p === 0) {
        this._curAttrs = defaultAttrs();
      } else if (p === 1) {
        this._curAttrs.flags |= AttrFlags.BOLD;
      } else if (p === 2) {
        this._curAttrs.flags |= AttrFlags.DIM;
      } else if (p === 3) {
        this._curAttrs.flags |= AttrFlags.ITALIC;
      } else if (p === 4) {
        this._curAttrs.flags |= AttrFlags.UNDERLINE;
      } else if (p === 5 || p === 6) {
        this._curAttrs.flags |= AttrFlags.BLINK;
      } else if (p === 7) {
        this._curAttrs.flags |= AttrFlags.INVERSE;
      } else if (p === 8) {
        this._curAttrs.flags |= AttrFlags.INVISIBLE;
      } else if (p === 9) {
        this._curAttrs.flags |= AttrFlags.STRIKETHROUGH;
      } else if (p === 22) {
        this._curAttrs.flags &= ~(AttrFlags.BOLD | AttrFlags.DIM);
      } else if (p === 23) {
        this._curAttrs.flags &= ~AttrFlags.ITALIC;
      } else if (p === 24) {
        this._curAttrs.flags &= ~AttrFlags.UNDERLINE;
      } else if (p === 25) {
        this._curAttrs.flags &= ~AttrFlags.BLINK;
      } else if (p === 27) {
        this._curAttrs.flags &= ~AttrFlags.INVERSE;
      } else if (p === 28) {
        this._curAttrs.flags &= ~AttrFlags.INVISIBLE;
      } else if (p === 29) {
        this._curAttrs.flags &= ~AttrFlags.STRIKETHROUGH;
      } else if (p >= 30 && p <= 37) {
        // Standard foreground colors
        this._curAttrs.fg = p - 30;
        this._curAttrs.fgRGB = null;
      } else if (p === 38) {
        // Extended foreground: 38;5;n or 38;2;r;g;b
        i = this._parseSgrColor(params, i, true);
      } else if (p === 39) {
        this._curAttrs.fg = -1;
        this._curAttrs.fgRGB = null;
      } else if (p >= 40 && p <= 47) {
        // Standard background colors
        this._curAttrs.bg = p - 40;
        this._curAttrs.bgRGB = null;
      } else if (p === 48) {
        // Extended background
        i = this._parseSgrColor(params, i, false);
      } else if (p === 49) {
        this._curAttrs.bg = -1;
        this._curAttrs.bgRGB = null;
      } else if (p >= 90 && p <= 97) {
        // Bright foreground colors
        this._curAttrs.fg = p - 90 + 8;
        this._curAttrs.fgRGB = null;
      } else if (p >= 100 && p <= 107) {
        // Bright background colors
        this._curAttrs.bg = p - 100 + 8;
        this._curAttrs.bgRGB = null;
      }
    }
  }

  /** Parse 256-color or truecolor SGR sequences */
  private _parseSgrColor(params: number[], i: number, isFg: boolean): number {
    if (i + 1 < params.length && params[i + 1] === 5 && i + 2 < params.length) {
      // 256-color: 38;5;n
      const colorIdx = params[i + 2];
      if (isFg) {
        this._curAttrs.fg = colorIdx;
        this._curAttrs.fgRGB = null;
      } else {
        this._curAttrs.bg = colorIdx;
        this._curAttrs.bgRGB = null;
      }
      return i + 2;
    } else if (i + 1 < params.length && params[i + 1] === 2 && i + 4 < params.length) {
      // Truecolor: 38;2;r;g;b
      const r = params[i + 2] & 0xff;
      const g = params[i + 3] & 0xff;
      const b = params[i + 4] & 0xff;
      const rgb = (r << 16) | (g << 8) | b;
      if (isFg) {
        this._curAttrs.fgRGB = rgb;
        this._curAttrs.fg = -1;
      } else {
        this._curAttrs.bgRGB = rgb;
        this._curAttrs.bg = -1;
      }
      return i + 4;
    }
    return i;
  }

  // ──────────────────────────────────────────────────────────────────────
  // Private mode sequences (CSI ? ...)
  // ──────────────────────────────────────────────────────────────────────

  private _csiPrivateMode(params: number[], finalChar: string): void {
    for (const p of params) {
      const enable = finalChar === 'h';
      switch (p) {
        case 25: // DECTCEM — cursor visibility
          this.cursor.visible = enable;
          break;
        case 1049: // Alternate screen buffer
          if (enable) {
            this._altBuffer = {
              lines: this.lines,
              ybase: this.ybase,
              cursor: { ...this.cursor },
            };
            this.lines = [];
            this.ybase = 0;
            this.ydisp = 0;
            for (let i = 0; i < this.rows; i++) {
              this.lines.push(this._createEmptyLine());
            }
            this.cursor.x = 0;
            this.cursor.y = 0;
          } else if (this._altBuffer) {
            this.lines = this._altBuffer.lines;
            this.ybase = this._altBuffer.ybase;
            this.cursor = { ...this._altBuffer.cursor };
            this._altBuffer = null;
          }
          // Mark all dirty
          for (let i = 0; i < this.rows; i++) this._dirty.add(i);
          break;
        case 2004: // Bracketed paste mode — just acknowledge
          break;
      }
    }
  }

  // ──────────────────────────────────────────────────────────────────────
  // Buffer manipulation — mirrors xterm.js Buffer scroll/erase methods
  // ──────────────────────────────────────────────────────────────────────

  private _getActiveLine(y: number): BufferLine {
    return this.lines[this.ybase + y];
  }

  private _createEmptyLine(cols?: number): BufferLine {
    const c = cols || this.cols;
    const line: BufferLine = [];
    for (let i = 0; i < c; i++) {
      line.push(emptyCell());
    }
    return line;
  }

  private _lineFeed(): void {
    if (this.cursor.y === this._scrollBottom) {
      this._scrollUp();
    } else if (this.cursor.y < this.rows - 1) {
      this.cursor.y++;
    }
    this._dirty.add(this.cursor.y);
  }

  /** Scroll viewport up by one line — add line at bottom, remove at top of scroll region */
  private _scrollUp(): void {
    // If at the top of the buffer, the line scrolls into scrollback
    if (this._scrollTop === 0) {
      this.lines.splice(this.ybase + this._scrollBottom + 1, 0, this._createEmptyLine());
      // Don't remove the line — it becomes scrollback. Trim if exceeds max.
      if (this.ybase > this.scrollback) {
        this.lines.shift();
      } else {
        this.ybase++;
        this.ydisp = 0; // Auto-scroll to bottom
      }
    } else {
      // Scroll within scroll region
      this.lines.splice(this.ybase + this._scrollTop, 1);
      this.lines.splice(this.ybase + this._scrollBottom, 0, this._createEmptyLine());
    }
    // Mark entire scroll region dirty
    for (let i = this._scrollTop; i <= this._scrollBottom; i++) {
      this._dirty.add(i);
    }
  }

  private _scrollDown(): void {
    this.lines.splice(this.ybase + this._scrollBottom, 1);
    this.lines.splice(this.ybase + this._scrollTop, 0, this._createEmptyLine());
    for (let i = this._scrollTop; i <= this._scrollBottom; i++) {
      this._dirty.add(i);
    }
  }

  private _eraseInDisplay(mode: number): void {
    switch (mode) {
      case 0: // Erase below (cursor to end)
        this._eraseInLine(0);
        for (let y = this.cursor.y + 1; y < this.rows; y++) {
          this.lines[this.ybase + y] = this._createEmptyLine();
          this._dirty.add(y);
        }
        break;
      case 1: // Erase above (start to cursor)
        this._eraseInLine(1);
        for (let y = 0; y < this.cursor.y; y++) {
          this.lines[this.ybase + y] = this._createEmptyLine();
          this._dirty.add(y);
        }
        break;
      case 2: // Erase all
      case 3: // Erase all + scrollback
        for (let y = 0; y < this.rows; y++) {
          this.lines[this.ybase + y] = this._createEmptyLine();
          this._dirty.add(y);
        }
        if (mode === 3) {
          this.lines = this.lines.slice(this.ybase);
          this.ybase = 0;
          this.ydisp = 0;
        }
        break;
    }
  }

  private _eraseInLine(mode: number): void {
    const line = this._getActiveLine(this.cursor.y);
    switch (mode) {
      case 0: // Erase to right
        for (let x = this.cursor.x; x < this.cols; x++) {
          line[x] = emptyCell();
        }
        break;
      case 1: // Erase to left
        for (let x = 0; x <= this.cursor.x; x++) {
          line[x] = emptyCell();
        }
        break;
      case 2: // Erase entire line
        for (let x = 0; x < this.cols; x++) {
          line[x] = emptyCell();
        }
        break;
    }
    this._dirty.add(this.cursor.y);
  }

  private _insertLines(count: number): void {
    for (let i = 0; i < count; i++) {
      this.lines.splice(this.ybase + this._scrollBottom, 1);
      this.lines.splice(this.ybase + this.cursor.y, 0, this._createEmptyLine());
    }
    for (let i = this.cursor.y; i <= this._scrollBottom; i++) this._dirty.add(i);
  }

  private _deleteLines(count: number): void {
    for (let i = 0; i < count; i++) {
      this.lines.splice(this.ybase + this.cursor.y, 1);
      this.lines.splice(this.ybase + this._scrollBottom, 0, this._createEmptyLine());
    }
    for (let i = this.cursor.y; i <= this._scrollBottom; i++) this._dirty.add(i);
  }

  private _deleteChars(count: number): void {
    const line = this._getActiveLine(this.cursor.y);
    line.splice(this.cursor.x, count);
    for (let i = 0; i < count; i++) {
      line.push(emptyCell());
    }
    this._dirty.add(this.cursor.y);
  }

  private _insertChars(count: number): void {
    const line = this._getActiveLine(this.cursor.y);
    for (let i = 0; i < count; i++) {
      line.splice(this.cursor.x, 0, emptyCell());
    }
    line.length = this.cols;
    this._dirty.add(this.cursor.y);
  }

  private _eraseChars(count: number): void {
    const line = this._getActiveLine(this.cursor.y);
    for (let i = 0; i < count && this.cursor.x + i < this.cols; i++) {
      line[this.cursor.x + i] = emptyCell();
    }
    this._dirty.add(this.cursor.y);
  }

  private _fullReset(): void {
    this._curAttrs = defaultAttrs();
    this.cursor = { x: 0, y: 0, visible: true, style: 'block' };
    this._scrollTop = 0;
    this._scrollBottom = this.rows - 1;
    this._savedCursor = null;
    this._altBuffer = null;
    this.lines = [];
    this.ybase = 0;
    this.ydisp = 0;
    for (let i = 0; i < this.rows; i++) {
      this.lines.push(this._createEmptyLine());
    }
    for (let i = 0; i < this.rows; i++) this._dirty.add(i);
  }
}
