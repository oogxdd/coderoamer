import { ChatContent, ChatMessage, ToolResultCard, ToolUseCard, makeId } from '@/models/chat';
import { JSONValue } from '@/models/claude-events';
import { runExec } from './api';

/**
 * Reads the pi agent's own on-disk session transcripts from a sprite — the
 * same sessions `pi --session <id>` continues. pi stores one JSONL file per
 * session under
 * `~/.pi/agent/sessions/--<cwd-with-slashes-dashed>--/<timestamp>_<uuid>.jsonl`.
 * The first line is a header carrying the session `id` (the resume key) and
 * `cwd`; the remaining lines are tree entries, of which we care about
 * `{type: "message", message: {role: "user"|"assistant"|"toolResult", ...}}`.
 *
 * Mirror of `claude-sessions.ts` / `codex-sessions.ts`: because the transcript
 * lives on disk it survives the process exiting or the app being closed,
 * letting the app recover pi turns that finished (or ran from a terminal)
 * while away. Raw transcripts can be large, so the sprite-side script filters
 * to renderable entries and caps long tool output before shipping it.
 */

const SESSION_ID_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]{2,200}$/;

export interface PiSessionSummary {
  /** pi session UUID — the value passed to `pi --session <id>`. */
  id: string;
  /** Working directory recorded in the session header. */
  cwd?: string;
  /** First user prompt, trimmed — used as the list preview. */
  preview: string;
  /** Number of message entries (rough activity indicator). */
  messageCount: number;
  /** File mtime in ms since epoch. */
  modified: number;
  /** True when a process still holds the file open or it changed recently. */
  live: boolean;
}

const LIST_SCRIPT = String.raw`
const fs = require('fs'), os = require('os'), path = require('path');
const root = path.join(os.homedir(), '.pi', 'agent', 'sessions');
const out = [];
const LIVE_WINDOW_MS = 90000;
function openTranscriptNames() {
  const set = new Set();
  let pids;
  try { pids = fs.readdirSync('/proc'); } catch { return set; }
  for (const pid of pids) {
    if (!/^[0-9]+$/.test(pid)) continue;
    let fds;
    try { fds = fs.readdirSync('/proc/' + pid + '/fd'); } catch { continue; }
    for (const fd of fds) {
      let target;
      try { target = fs.readlinkSync('/proc/' + pid + '/fd/' + fd); } catch { continue; }
      if (target.slice(-6) === '.jsonl') set.add(path.basename(target));
    }
  }
  return set;
}
const openNames = openTranscriptNames();
function userText(message) {
  const c = message && message.content;
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) {
    const t = c.find((b) => b && b.type === 'text' && typeof b.text === 'string');
    if (t) return t.text;
  }
  return '';
}
function walk(dir) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walk(full);
    else if (e.name.endsWith('.jsonl')) readSession(full, e.name);
  }
}
function readSession(fp, name) {
  let stat, content;
  try { stat = fs.statSync(fp); content = fs.readFileSync(fp, 'utf8'); } catch { return; }
  const lines = content.split('\n').filter((l) => l.trim());
  if (lines.length === 0) return;
  let id = null, cwd = null, preview = '', count = 0;
  for (const line of lines) {
    let o;
    try { o = JSON.parse(line); } catch { continue; }
    if (!o || typeof o !== 'object') continue;
    if (o.type === 'session') {
      if (typeof o.id === 'string' && o.id) id = o.id;
      if (typeof o.cwd === 'string' && o.cwd) cwd = o.cwd;
      continue;
    }
    if (o.type === 'message' && o.message && typeof o.message === 'object') {
      count += 1;
      if (!preview && o.message.role === 'user') preview = userText(o.message);
    }
  }
  if (!id) return;
  out.push({
    id,
    cwd,
    preview: (preview || '').slice(0, 240),
    messageCount: count,
    modified: Math.floor(stat.mtimeMs),
    live: openNames.has(name) || (Date.now() - stat.mtimeMs < LIVE_WINDOW_MS),
  });
}
try { walk(root); } catch (e) {}
out.sort((a, b) => b.modified - a.modified);
process.stdout.write('@@WISP@@' + JSON.stringify(out) + '@@WISP@@');
`;

/**
 * Node script (run on the sprite) that finds the transcript for a session id
 * and re-emits only its message entries between sentinel markers — a few KB
 * instead of the full file. The id is inlined as a JS string literal;
 * callers must validate it against SESSION_ID_RE first.
 */
function readScript(sessionId: string): string {
  return String.raw`
const fs = require('fs'), os = require('os'), path = require('path');
const ID = ${JSON.stringify(sessionId)};
const root = path.join(os.homedir(), '.pi', 'agent', 'sessions');
function find(dir) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return null; }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) { const hit = find(full); if (hit) return hit; }
    else if (e.name.endsWith('.jsonl') && (e.name.includes(ID) || headerMatches(full))) {
      return full;
    }
  }
  return null;
}
function headerMatches(fp) {
  let fd;
  try { fd = fs.openSync(fp, 'r'); } catch { return false; }
  const buf = Buffer.alloc(4096);
  const n = fs.readSync(fd, buf, 0, buf.length, 0);
  fs.closeSync(fd);
  const line = buf.toString('utf8', 0, n).split('\n')[0];
  try { const o = JSON.parse(line); return o && o.type === 'session' && o.id === ID; }
  catch { return false; }
}
const CAP = 4000;
function cap(message) {
  if (!message || typeof message !== 'object') return message;
  const c = message.content;
  if (Array.isArray(c)) {
    message.content = c.map((b) => {
      if (b && typeof b === 'object' && typeof b.text === 'string' && b.text.length > CAP) {
        return { ...b, text: b.text.slice(0, CAP) + '\n…[truncated]' };
      }
      return b;
    });
  }
  return message;
}
const out = [];
try {
  const fp = find(root);
  if (fp) {
    for (const line of fs.readFileSync(fp, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      let o; try { o = JSON.parse(line); } catch { continue; }
      if (!o || o.type !== 'message' || !o.message || typeof o.message !== 'object') continue;
      const role = o.message.role;
      if (role !== 'user' && role !== 'assistant' && role !== 'toolResult') continue;
      out.push(JSON.stringify({ type: 'message', timestamp: o.timestamp, message: cap(o.message) }));
    }
  }
} catch (e) {}
process.stdout.write('@@WISP@@' + out.join('\n') + '@@WISP@@');
`;
}

function heredoc(script: string): string {
  return `node <<'WISP_NODE_EOF'\n${script}\nWISP_NODE_EOF\n`;
}

/** Pull the payload out of the sentinel markers, tolerating shell noise. */
function extractSentinel(output: string): string | null {
  const start = output.indexOf('@@WISP@@');
  if (start === -1) return null;
  const end = output.indexOf('@@WISP@@', start + 8);
  if (end === -1) return null;
  return output.slice(start + 8, end);
}

export async function listPiSessions(spriteName: string): Promise<PiSessionSummary[]> {
  const { output } = await runExec(spriteName, heredoc(LIST_SCRIPT), 25);
  const payload = extractSentinel(output);
  if (!payload) return [];
  try {
    const parsed = JSON.parse(payload);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((x): x is PiSessionSummary => !!x && typeof x.id === 'string')
      .map((x) => ({
        id: x.id,
        cwd: typeof x.cwd === 'string' ? x.cwd : undefined,
        preview: typeof x.preview === 'string' ? x.preview.trim() : '',
        messageCount: Number(x.messageCount) || 0,
        modified: Number(x.modified) || 0,
        live: !!x.live,
      }));
  } catch {
    return [];
  }
}

async function readSessionRaw(spriteName: string, sessionId: string): Promise<string> {
  if (!SESSION_ID_RE.test(sessionId)) {
    throw new Error('Invalid session id');
  }
  const { output } = await runExec(spriteName, heredoc(readScript(sessionId)), 25);
  return extractSentinel(output) ?? '';
}

// MARK: - Transcript -> ChatMessage rendering

function contentText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((block) =>
        block && typeof block === 'object' && typeof (block as any).text === 'string'
          ? (block as any).text
          : ''
      )
      .filter(Boolean)
      .join('\n');
  }
  return '';
}

function contentToJsonValue(content: unknown): JSONValue {
  if (typeof content === 'string' || Array.isArray(content) || content == null) {
    return content as JSONValue;
  }
  return String(content);
}

/**
 * Convert a (pre-filtered) pi session transcript into the app's ChatMessage[]
 * so the existing chat UI renders it natively. Mirrors the live
 * `handlePiEvent` path in useChat, but also emits user bubbles for the
 * locally-originated prompts stored in the transcript.
 */
export function piTranscriptToMessages(raw: string): ChatMessage[] {
  const lines = raw.split('\n').map((l) => l.trim()).filter(Boolean);
  const messages: ChatMessage[] = [];
  const toolUseLocation = new Map<string, number>();
  let currentAssistantIndex: number | null = null;

  const ensureAssistant = (timestamp: number): number => {
    if (currentAssistantIndex !== null) return currentAssistantIndex;
    messages.push({ id: makeId(), timestamp, role: 'assistant', content: [] });
    currentAssistantIndex = messages.length - 1;
    return currentAssistantIndex;
  };

  const appendAssistantText = (idx: number, text: string) => {
    if (!text.trim()) return;
    const next = [...messages[idx].content];
    const last = next[next.length - 1];
    if (last && last.type === 'text') {
      next[next.length - 1] = { type: 'text', text: `${last.text}\n${text}` };
    } else {
      next.push({ type: 'text', text });
    }
    messages[idx] = { ...messages[idx], content: next };
  };

  const appendReasoning = (idx: number, text: string) => {
    if (!text.trim()) return;
    const next = [...messages[idx].content];
    const last = next[next.length - 1];
    if (last && last.type === 'reasoning') {
      next[next.length - 1] = { type: 'reasoning', text: `${last.text}\n${text}` };
    } else {
      next.push({ type: 'reasoning', text });
    }
    messages[idx] = { ...messages[idx], content: next };
  };

  const attachResult = (callId: string, toolName: string, content: JSONValue, ts: number) => {
    const idx = toolUseLocation.get(callId);
    if (idx === undefined) return;
    const msg = messages[idx];
    const result: ToolResultCard = { toolUseId: callId, toolName, content, completedAt: ts };
    const updated = msg.content.map((item) =>
      item.type === 'toolUse' && item.card.toolUseId === callId
        ? ({ type: 'toolUse', card: { ...item.card, result } } as ChatContent)
        : item
    );
    updated.push({ type: 'toolResult', card: result });
    messages[idx] = { ...msg, content: updated };
  };

  for (const line of lines) {
    let o: any;
    try {
      o = JSON.parse(line);
    } catch {
      continue;
    }
    if (!o || typeof o !== 'object') continue;
    const message = o.message;
    if (!message || typeof message !== 'object') continue;

    const ts = Date.parse(o.timestamp) || Date.now();
    const role = message.role;

    if (role === 'user') {
      const text = contentText(message.content);
      if (!text.trim()) continue;
      messages.push({ id: makeId(), timestamp: ts, role: 'user', content: [{ type: 'text', text }] });
      currentAssistantIndex = null;
      continue;
    }

    if (role === 'assistant') {
      const blocks = Array.isArray(message.content) ? message.content : [];
      const idx = ensureAssistant(ts);
      for (const block of blocks) {
        if (!block || typeof block !== 'object') continue;
        if (block.type === 'text' && typeof block.text === 'string') {
          appendAssistantText(idx, block.text);
        } else if (block.type === 'thinking' && typeof block.thinking === 'string') {
          appendReasoning(idx, block.thinking);
        } else if (block.type === 'toolCall' && typeof block.id === 'string') {
          const card: ToolUseCard = {
            toolUseId: block.id,
            toolName: typeof block.name === 'string' ? block.name : 'Tool',
            input: (block.arguments ?? {}) as JSONValue,
            startedAt: ts,
          };
          messages[idx] = {
            ...messages[idx],
            content: [...messages[idx].content, { type: 'toolUse', card }],
          };
          toolUseLocation.set(card.toolUseId, idx);
        }
      }
      continue;
    }

    if (role === 'toolResult') {
      if (typeof message.toolCallId === 'string') {
        attachResult(
          message.toolCallId,
          typeof message.toolName === 'string' ? message.toolName : 'Tool',
          contentToJsonValue(message.content),
          ts
        );
      }
    }
  }

  return messages;
}

export async function readPiSessionMessages(
  spriteName: string,
  sessionId: string
): Promise<ChatMessage[]> {
  const raw = await readSessionRaw(spriteName, sessionId);
  return piTranscriptToMessages(raw);
}
