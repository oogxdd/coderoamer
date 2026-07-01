/**
 * AnsiParser — simplified port of xterm.js's EscapeSequenceParser
 * 
 * xterm.js uses a state machine with states: GROUND, ESCAPE, ESCAPE_INTERMEDIATE,
 * CSI_ENTRY, CSI_PARAM, CSI_INTERMEDIATE, CSI_IGNORE, OSC_STRING, DCS_*, etc.
 * 
 * We implement the most critical subset: GROUND, ESCAPE, CSI_PARAM, OSC_STRING
 * which covers 95%+ of real terminal output.
 */

export const enum ParserState {
  GROUND = 0,
  ESCAPE = 1,
  CSI_PARAM = 2,
  CSI_INTERMEDIATE = 3,
  OSC_STRING = 4,
  DCS_PASSTHROUGH = 5,
}

/** SGR (Select Graphic Rendition) attribute flags — mirrors xterm.js Attributes */
export const enum AttrFlags {
  BOLD       = 1,
  ITALIC     = 1 << 1,
  UNDERLINE  = 1 << 2,
  BLINK      = 1 << 3,
  INVERSE    = 1 << 4,
  INVISIBLE  = 1 << 5,
  DIM        = 1 << 6,
  STRIKETHROUGH = 1 << 7,
}

export interface CellAttrs {
  fg: number;        // foreground color index (0-255, or -1 for default)
  bg: number;        // background color index (0-255, or -1 for default)
  fgRGB: number | null;  // 24-bit RGB fg if set via SGR 38;2;r;g;b
  bgRGB: number | null;  // 24-bit RGB bg if set via SGR 48;2;r;g;b
  flags: number;     // bitmask of AttrFlags
}

export function defaultAttrs(): CellAttrs {
  return { fg: -1, bg: -1, fgRGB: null, bgRGB: null, flags: 0 };
}

export function cloneAttrs(a: CellAttrs): CellAttrs {
  return { fg: a.fg, bg: a.bg, fgRGB: a.fgRGB, bgRGB: a.bgRGB, flags: a.flags };
}

export interface TerminalCell {
  char: string;      // the character ('' for empty/null)
  width: number;     // character width (1 for normal, 2 for wide/CJK)
  attrs: CellAttrs;
}

export function emptyCell(attrs?: CellAttrs): TerminalCell {
  return { char: '', width: 1, attrs: attrs ? cloneAttrs(attrs) : defaultAttrs() };
}

/**
 * Callback interface — the parser notifies the terminal buffer of actions.
 * This mirrors xterm.js's handler registration pattern.
 */
export interface IParserCallbacks {
  /** Print a printable character at the current cursor position */
  print(char: string, width: number): void;
  /** Execute a C0 control code (e.g. \n, \r, \t, \b, \x07) */
  executeC0(code: number): void;
  /** Execute a CSI sequence (e.g. cursor movement, erase, SGR) */
  executeCsi(params: number[], intermediates: string, finalChar: string): void;
  /** Execute an ESC sequence (e.g. ESC 7, ESC 8, ESC M) */
  executeEsc(intermediates: string, finalChar: string): void;
  /** Receive an OSC string (e.g. title changes) */
  executeOsc(id: number, data: string): void;
}

/**
 * Minimal wcwidth — returns 2 for CJK wide chars, 1 for everything else.
 * xterm.js uses a full Unicode width table; this is a simplified version.
 */
function charWidth(codePoint: number): number {
  if (
    (codePoint >= 0x1100 && codePoint <= 0x115f) ||
    (codePoint >= 0x2e80 && codePoint <= 0xa4cf && codePoint !== 0x303f) ||
    (codePoint >= 0xac00 && codePoint <= 0xd7a3) ||
    (codePoint >= 0xf900 && codePoint <= 0xfaff) ||
    (codePoint >= 0xfe10 && codePoint <= 0xfe6f) ||
    (codePoint >= 0xff01 && codePoint <= 0xff60) ||
    (codePoint >= 0xffe0 && codePoint <= 0xffe6) ||
    (codePoint >= 0x20000 && codePoint <= 0x2fffd) ||
    (codePoint >= 0x30000 && codePoint <= 0x3fffd)
  ) {
    return 2;
  }
  return 1;
}

/**
 * Hard limits to keep a corrupted or hostile stream (e.g. binary output
 * misparsed as a CSI sequence) from growing parser state without bound. These
 * mirror xterm.js, which clamps params to 32 and caps payload length — without
 * them a long digit run becomes a parseInt in the billions and the buffer's CSI
 * handlers loop billions of times, taking down the native process (OOM/ANR)
 * before the JS error boundary can see it.
 */
const MAX_PARAMS = 32;
const MAX_PARAM_DIGITS = 7; // up to 9,999,999 — far beyond any real terminal need
const MAX_INTERMEDIATES = 8;
const MAX_OSC_LENGTH = 1 << 16; // 64 KiB

export class AnsiParser {
  private _state: ParserState = ParserState.GROUND;
  private _params: number[] = [];
  private _currentParam: string = '';
  private _intermediates: string = '';
  private _oscId: number = -1;
  private _oscData: string = '';

  constructor(private _callbacks: IParserCallbacks) {}

  /** Finalize the current param into the params array, clamped to MAX_PARAMS. */
  private _pushParam(): void {
    if (this._params.length < MAX_PARAMS) {
      this._params.push(this._currentParam ? parseInt(this._currentParam, 10) : 0);
    }
    this._currentParam = '';
  }

  /**
   * Parse a chunk of data — this is the main entry point.
   * Mirrors xterm.js's InputHandler.parse() which feeds data through
   * EscapeSequenceParser.parse().
   */
  parse(data: string): void {
    let i = 0;
    while (i < data.length) {
      const code = data.charCodeAt(i);
      let consumed = 1;

      switch (this._state) {
        case ParserState.GROUND:
          consumed = this._handleGround(data, i, code);
          break;
        case ParserState.ESCAPE:
          this._handleEscape(data, i, code);
          break;
        case ParserState.CSI_PARAM:
          this._handleCsiParam(data, i, code);
          break;
        case ParserState.CSI_INTERMEDIATE:
          this._handleCsiIntermediate(data, i, code);
          break;
        case ParserState.OSC_STRING:
          consumed = this._handleOscString(data, i, code);
          break;
      }

      i += consumed;
    }
  }

  private _handleGround(data: string, i: number, code: number): number {
    if (code === 0x1b) {
      // ESC
      this._state = ParserState.ESCAPE;
      this._intermediates = '';
    } else if (code < 0x20 || code === 0x7f) {
      // C0 control codes + DEL
      this._callbacks.executeC0(code);
    } else {
      // Printable character
      const cp = data.codePointAt(i)!;
      if (code >= 0xd800 && code <= 0xdfff && cp <= 0xffff) {
        this._callbacks.print('\uFFFD', 1);
        return 1;
      }
      const ch = String.fromCodePoint(cp);
      const w = charWidth(cp);
      this._callbacks.print(ch, w);
      // Skip surrogate pair if needed
      if (cp > 0xffff) return 2;
    }
    return 1;
  }

  private _handleEscape(data: string, i: number, code: number): void {
    if (code === 0x5b) {
      // [ — enter CSI
      this._state = ParserState.CSI_PARAM;
      this._params = [];
      this._currentParam = '';
      this._intermediates = '';
    } else if (code === 0x5d) {
      // ] — enter OSC
      this._state = ParserState.OSC_STRING;
      this._oscId = -1;
      this._oscData = '';
    } else if (code >= 0x20 && code <= 0x2f) {
      // Intermediate bytes
      if (this._intermediates.length < MAX_INTERMEDIATES) {
        this._intermediates += String.fromCharCode(code);
      }
    } else if (code >= 0x30 && code <= 0x7e) {
      // Final byte — dispatch ESC sequence
      this._callbacks.executeEsc(this._intermediates, String.fromCharCode(code));
      this._state = ParserState.GROUND;
    } else {
      // Unexpected, back to ground
      this._state = ParserState.GROUND;
    }
  }

  private _handleCsiParam(data: string, i: number, code: number): void {
    if (code >= 0x30 && code <= 0x39) {
      // Digit — cap length so a corrupted stream can't build a giant integer.
      if (this._currentParam.length < MAX_PARAM_DIGITS) {
        this._currentParam += String.fromCharCode(code);
      }
    } else if (code === 0x3b) {
      // ; — parameter separator
      this._pushParam();
    } else if (code === 0x3a) {
      // : — sub-parameter separator (used in SGR underline styles etc.)
      // For simplicity, treat as regular separator
      this._pushParam();
    } else if (code >= 0x3c && code <= 0x3f) {
      // Private mode indicator (<, =, >, ?)
      if (this._intermediates.length < MAX_INTERMEDIATES) {
        this._intermediates += String.fromCharCode(code);
      }
    } else if (code >= 0x20 && code <= 0x2f) {
      // Intermediate bytes
      this._pushParam();
      if (this._intermediates.length < MAX_INTERMEDIATES) {
        this._intermediates += String.fromCharCode(code);
      }
      this._state = ParserState.CSI_INTERMEDIATE;
    } else if (code >= 0x40 && code <= 0x7e) {
      // Final byte — dispatch CSI
      this._pushParam();
      this._callbacks.executeCsi(this._params, this._intermediates, String.fromCharCode(code));
      this._state = ParserState.GROUND;
    } else {
      // Unexpected
      this._state = ParserState.GROUND;
    }
  }

  private _handleCsiIntermediate(data: string, i: number, code: number): void {
    if (code >= 0x20 && code <= 0x2f) {
      if (this._intermediates.length < MAX_INTERMEDIATES) {
        this._intermediates += String.fromCharCode(code);
      }
    } else if (code >= 0x40 && code <= 0x7e) {
      this._callbacks.executeCsi(this._params, this._intermediates, String.fromCharCode(code));
      this._state = ParserState.GROUND;
    } else {
      this._state = ParserState.GROUND;
    }
  }

  private _handleOscString(data: string, i: number, code: number): number {
    if (code === 0x07 || (code === 0x1b && i + 1 < data.length && data.charCodeAt(i + 1) === 0x5c)) {
      // BEL or ESC \ — terminate OSC
      if (this._oscId === -1) {
        const semi = this._oscData.indexOf(';');
        if (semi !== -1) {
          this._oscId = parseInt(this._oscData.substring(0, semi), 10) || 0;
          this._oscData = this._oscData.substring(semi + 1);
        }
      }
      this._callbacks.executeOsc(this._oscId, this._oscData);
      this._state = ParserState.GROUND;
      if (code === 0x1b) return 2; // skip the backslash
    } else if (this._oscData.length < MAX_OSC_LENGTH) {
      // Cap payload — an unterminated OSC must not grow this string forever.
      this._oscData += String.fromCharCode(code);
    }
    return 1;
  }

  reset(): void {
    this._state = ParserState.GROUND;
    this._params = [];
    this._currentParam = '';
    this._intermediates = '';
    this._oscId = -1;
    this._oscData = '';
  }
}
