/**
 * terminalLog — lightweight, always-on diagnostic logger for the Skia terminal.
 *
 * Why this exists: the terminal's data-in path (WebSocket message → buffer.write →
 * AnsiParser → buffer mutation) runs inside an async WebSocket callback, *not* during
 * React render. That means a throw there is NOT caught by <TerminalErrorBoundary> and
 * crashes the whole app. Native Skia render crashes likewise escape the JS boundary.
 *
 * To debug those blind, we log every interesting event into both:
 *   - console (prefixed "[TERM]" so it's greppable in Metro / device logs), and
 *   - an in-memory ring buffer that can be dumped as a single shareable string.
 *
 * Dump the buffer at any time:
 *   - from JS:        import { dumpTerminalLog } from './terminalLog'; dumpTerminalLog()
 *   - from a console: globalThis.__dumpTerminalLog()
 */

export type TermLogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface TermLogEntry {
  t: number;
  level: TermLogLevel;
  tag: string;
  msg: string;
  data?: unknown;
}

// Toggle console mirroring. Keep on while we hunt the crash; set false to silence.
export let TERM_LOG_TO_CONSOLE = true;
export function setTerminalLogConsole(on: boolean): void {
  TERM_LOG_TO_CONSOLE = on;
}

const RING_SIZE = 1000;
const ring: TermLogEntry[] = [];

function push(entry: TermLogEntry): void {
  ring.push(entry);
  if (ring.length > RING_SIZE) ring.splice(0, ring.length - RING_SIZE);
}

/**
 * Render a (possibly control-char-laden) string as a safe, single-line preview with
 * non-printable bytes shown as \xNN / \u escapes. Truncated to `max` source chars.
 */
export function hexPreview(s: string, max = 120): string {
  if (typeof s !== 'string') return String(s);
  const slice = s.length > max ? s.slice(0, max) : s;
  let out = '';
  for (let i = 0; i < slice.length; i++) {
    const c = slice.charCodeAt(i);
    if (c === 0x1b) out += '\\e';
    else if (c === 0x0d) out += '\\r';
    else if (c === 0x0a) out += '\\n';
    else if (c === 0x09) out += '\\t';
    else if (c < 0x20 || c === 0x7f) out += '\\x' + c.toString(16).padStart(2, '0');
    else out += slice[i];
  }
  if (s.length > max) out += `…(+${s.length - max})`;
  return out;
}

function fmtData(data: unknown): string {
  if (data === undefined) return '';
  if (typeof data === 'string') return ' ' + data;
  try {
    return ' ' + JSON.stringify(data);
  } catch {
    return ' ' + String(data);
  }
}

export function tlog(level: TermLogLevel, tag: string, msg: string, data?: unknown): void {
  const entry: TermLogEntry = { t: Date.now(), level, tag, msg, data };
  push(entry);
  if (TERM_LOG_TO_CONSOLE) {
    const line = `[TERM:${tag}] ${msg}${fmtData(data)}`;
    if (level === 'error') console.error(line);
    else if (level === 'warn') console.warn(line);
    else console.log(line);
  }
}

// Convenience helpers
export const tdebug = (tag: string, msg: string, data?: unknown) => tlog('debug', tag, msg, data);
export const tinfo = (tag: string, msg: string, data?: unknown) => tlog('info', tag, msg, data);
export const twarn = (tag: string, msg: string, data?: unknown) => tlog('warn', tag, msg, data);
export const terror = (tag: string, msg: string, data?: unknown) => tlog('error', tag, msg, data);

/** Serialize an Error (message + stack) for logging. */
export function errInfo(e: unknown): { message: string; stack?: string } {
  if (e instanceof Error) return { message: e.message, stack: e.stack };
  return { message: String(e) };
}

/** Return the full ring buffer as a single shareable string. */
export function dumpTerminalLog(): string {
  const lines = ring.map((e) => {
    const ts = new Date(e.t).toISOString().slice(11, 23);
    return `${ts} ${e.level.toUpperCase().padEnd(5)} [${e.tag}] ${e.msg}${fmtData(e.data)}`;
  });
  return lines.join('\n');
}

export function clearTerminalLog(): void {
  ring.length = 0;
}

// Expose a global dumper so it can be called from any JS console / debugger.
try {
  (globalThis as Record<string, unknown>).__dumpTerminalLog = dumpTerminalLog;
  (globalThis as Record<string, unknown>).__clearTerminalLog = clearTerminalLog;
} catch {
  // ignore — globalThis may be locked down in some runtimes
}
