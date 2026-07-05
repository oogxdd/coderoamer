import { ChatContent, ChatMessage, ToolResultCard, ToolUseCard, makeId } from '@/models/chat';
import { JSONValue } from '@/models/claude-events';
import { runExec } from './api';

/**
 * Reads Codex CLI's own on-disk "rollout" transcripts from a sprite — the same
 * thread `codex exec resume <id>` continues. Codex stores one JSONL file per
 * thread under
 * `~/.codex/sessions/<YYYY>/<MM>/<DD>/rollout-<ts>-<thread_id>.jsonl`, where the
 * trailing `<thread_id>` is the same UUID we keep as `codexSessionId` (the
 * `thread.started` id). Each line is an envelope `{type, payload, timestamp}`.
 *
 * Mirror of `claude-sessions.ts`: because the rollout lives on disk it survives
 * the process exiting, the app being closed, or a fresh install — letting the
 * app recover Codex turns that completed (or ran from a terminal) while away.
 *
 * The raw rollout is large (every turn also stores encrypted reasoning blobs and
 * token-count spam), so we filter to the few line types we render *sprite-side*
 * and ship only those — see READ_SCRIPT.
 */

const SESSION_ID_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]{2,200}$/;

export interface CodexSessionSummary {
  /** Codex thread id — the value passed to `codex exec resume <id>`. */
  id: string;
  /** Working directory recorded in the rollout, when Codex wrote one. */
  cwd?: string;
  /** First user prompt, trimmed — used as the list preview. */
  preview: string;
  /** Number of JSONL lines in the rollout. */
  messageCount: number;
  /** File mtime in ms since epoch. */
  modified: number;
  /**
   * True when a process still holds the rollout open (a running `codex`) or it
   * was appended to within the last ~90s — i.e. the CLI thread is likely still
   * going. Best-effort: derived sprite-side from `/proc` and file mtime.
   */
  live: boolean;
}

/** Rollout line types we keep; everything else is preamble/usage/encrypted noise. */
const KEPT = `new Set([
  'event_msg:user_message',
  'event_msg:agent_message',
  'response_item:function_call',
  'response_item:function_call_output',
  'response_item:custom_tool_call',
  'response_item:custom_tool_call_output',
  'response_item:web_search_call',
])`;

const LIST_SCRIPT = String.raw`
const fs = require('fs'), os = require('os'), path = require('path');
const root = path.join(os.homedir(), '.codex', 'sessions');
const out = [];
const UUID_RE = /([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})\.jsonl$/;
// A rollout counts as "live" when some process still holds it open (a running
// codex), or it was appended to within this window. Rollout filenames are unique
// (rollout-<ts>-<uuid>.jsonl), so matching on basename is enough.
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
function walk(dir) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walk(full);
    else if (e.name.startsWith('rollout-') && e.name.endsWith('.jsonl')) readRollout(full, e.name);
  }
}
function findString(value, keys) {
  if (!value || typeof value !== 'object') return null;
  if (Array.isArray(value)) {
    for (const item of value) {
      const hit = findString(item, keys);
      if (hit) return hit;
    }
    return null;
  }
  for (const key of keys) {
    if (typeof value[key] === 'string' && value[key]) return value[key];
  }
  for (const key of Object.keys(value)) {
    const hit = findString(value[key], keys);
    if (hit) return hit;
  }
  return null;
}
function userPreview(o) {
  const p = o && o.payload;
  if (o && o.type === 'event_msg' && p && p.type === 'user_message') {
    if (typeof p.message === 'string') return p.message;
    return findString(p.message, ['text', 'content']) || '';
  }
  if (o && (o.type === 'user_message' || o.type === 'user')) {
    return findString(o, ['message', 'text', 'content']) || '';
  }
  return '';
}
function threadId(o) {
  const p = o && o.payload;
  return findString(o, ['thread_id', 'threadId']) || (p && findString(p, ['thread_id', 'threadId'])) || null;
}
function fileId(name) {
  const uuid = name.match(UUID_RE);
  if (uuid) return uuid[1];
  return name.replace(/^rollout-/, '').replace(/\.jsonl$/, '').split('-').pop();
}
function readRollout(fp, name) {
  let stat, content;
  try { stat = fs.statSync(fp); content = fs.readFileSync(fp, 'utf8'); } catch { return; }
  const lines = content.split('\n').filter((l) => l.trim());
  if (lines.length === 0) return;
  let id = fileId(name);
  let cwd = null;
  let preview = '';
  for (const line of lines) {
    let o;
    try { o = JSON.parse(line); } catch { continue; }
    if (!id) id = threadId(o);
    if (!cwd) cwd = findString(o, ['cwd', 'working_directory', 'workingDirectory']);
    if (!preview) preview = userPreview(o);
    if (id && cwd && preview) break;
  }
  if (!id) return;
  out.push({
    id,
    cwd,
    preview: (preview || '').slice(0, 240),
    messageCount: lines.length,
    modified: Math.floor(stat.mtimeMs),
    live: openNames.has(name) || (Date.now() - stat.mtimeMs < LIVE_WINDOW_MS),
  });
}
try { walk(root); } catch (e) {}
out.sort((a, b) => b.modified - a.modified);
process.stdout.write('@@WISP@@' + JSON.stringify(out) + '@@WISP@@');
`;

/**
 * Node script (run on the sprite) that locates the rollout for a thread id and
 * re-emits only the relevant lines between sentinel markers, so we transfer a
 * few KB rather than the multi-MB raw file. The id is inlined as a JS string
 * literal; callers must validate it against SESSION_ID_RE first.
 */
function readScript(sessionId: string): string {
  return String.raw`
const fs = require('fs'), os = require('os'), path = require('path');
const ID = ${JSON.stringify(sessionId)};
const root = path.join(os.homedir(), '.codex', 'sessions');
const KEPT = ${KEPT};
function find(dir) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return null; }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) { const hit = find(full); if (hit) return hit; }
    else if (e.name.startsWith('rollout-') && e.name.endsWith('.jsonl') && e.name.includes(ID)) {
      return full;
    }
  }
  return null;
}
const out = [];
try {
  const fp = find(root);
  if (fp) {
    const content = fs.readFileSync(fp, 'utf8');
    const CAP = 4000;
    for (const line of content.split('\n')) {
      if (!line.trim()) continue;
      let o; try { o = JSON.parse(line); } catch { continue; }
      const p = o && o.payload;
      const key = o && o.type + ':' + (p && p.type);
      if (!key || !KEPT.has(key)) continue;
      // Cap large command outputs so a transcript sync stays a few hundred KB.
      if (p && typeof p.output === 'string' && p.output.length > CAP) {
        p.output = p.output.slice(0, CAP) + '\n…[truncated]';
        out.push(JSON.stringify(o));
      } else {
        out.push(line);
      }
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

export async function listCodexSessions(spriteName: string): Promise<CodexSessionSummary[]> {
  const { output } = await runExec(spriteName, heredoc(LIST_SCRIPT), 25);
  const payload = extractSentinel(output);
  if (!payload) return [];
  try {
    const parsed = JSON.parse(payload);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((x): x is CodexSessionSummary => !!x && typeof x.id === 'string')
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

/** Parse a `function_call.arguments` JSON string into a shell command line. */
function commandFromArgs(argsRaw: unknown): string {
  if (typeof argsRaw !== 'string') return 'command';
  let args: any;
  try {
    args = JSON.parse(argsRaw);
  } catch {
    return argsRaw;
  }
  if (args && typeof args.cmd === 'string') return args.cmd;
  if (args && Array.isArray(args.command)) return args.command.join(' ');
  if (args && typeof args.command === 'string') return args.command;
  return 'command';
}

/** First file path mentioned in an apply_patch body, for the Edit card summary. */
function patchFirstFile(patch: unknown): string | undefined {
  if (typeof patch !== 'string') return undefined;
  const m = patch.match(/\*\*\* (?:Add|Update|Delete) File: (.+)/);
  return m ? m[1].trim() : undefined;
}

/**
 * Convert a (pre-filtered) Codex rollout into the app's ChatMessage[] so the
 * existing chat UI renders it natively. Mirrors the live `handleCodexEvent`
 * path in useChat, but also treats `user_message` lines as user bubbles (the
 * live path never sees those because the prompt originates locally).
 */
export function codexTranscriptToMessages(raw: string): ChatMessage[] {
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

  const attachResult = (callId: string, content: JSONValue, ts: number) => {
    const idx = toolUseLocation.get(callId);
    if (idx === undefined) return;
    const msg = messages[idx];
    let toolName = 'Bash';
    const updated = msg.content.map((item) => {
      if (item.type === 'toolUse' && item.card.toolUseId === callId) {
        toolName = item.card.toolName;
        const result: ToolResultCard = { toolUseId: callId, toolName, content, completedAt: ts };
        return { type: 'toolUse', card: { ...item.card, result } } as ChatContent;
      }
      return item;
    });
    updated.push({ type: 'toolResult', card: { toolUseId: callId, toolName, content, completedAt: ts } });
    messages[idx] = { ...msg, content: updated };
  };

  const pushToolUse = (idx: number, card: ToolUseCard) => {
    messages[idx] = { ...messages[idx], content: [...messages[idx].content, { type: 'toolUse', card }] };
    toolUseLocation.set(card.toolUseId, idx);
  };

  const appendAssistantText = (idx: number, text: string) => {
    const next = [...messages[idx].content];
    const last = next[next.length - 1];
    if (last && last.type === 'text') {
      next[next.length - 1] = { type: 'text', text: `${last.text}\n${text}` };
    } else {
      next.push({ type: 'text', text });
    }
    messages[idx] = { ...messages[idx], content: next };
  };

  for (const line of lines) {
    let o: any;
    try {
      o = JSON.parse(line);
    } catch {
      continue;
    }
    if (!o || typeof o !== 'object') continue;
    const p = o.payload;
    if (!p || typeof p !== 'object') continue;

    const ts = Date.parse(o.timestamp) || Date.now();
    const key = `${o.type}:${p.type}`;

    switch (key) {
      case 'event_msg:user_message': {
        const text = typeof p.message === 'string' ? p.message : '';
        if (!text.trim()) break;
        messages.push({ id: makeId(), timestamp: ts, role: 'user', content: [{ type: 'text', text }] });
        currentAssistantIndex = null;
        break;
      }
      case 'event_msg:agent_message': {
        const text = typeof p.message === 'string' ? p.message : '';
        if (!text.trim()) break;
        appendAssistantText(ensureAssistant(ts), text);
        break;
      }
      case 'response_item:function_call': {
        const callId = p.call_id ?? p.id;
        if (!callId) break;
        const card: ToolUseCard = {
          toolUseId: callId,
          toolName: 'Bash',
          input: { command: commandFromArgs(p.arguments) },
          startedAt: ts,
        };
        pushToolUse(ensureAssistant(ts), card);
        break;
      }
      case 'response_item:function_call_output': {
        if (p.call_id) attachResult(p.call_id, (p.output ?? null) as JSONValue, ts);
        break;
      }
      case 'response_item:custom_tool_call': {
        const callId = p.call_id ?? p.id;
        if (!callId) break;
        const isPatch = p.name === 'apply_patch';
        const card: ToolUseCard = {
          toolUseId: callId,
          toolName: isPatch ? 'Edit' : typeof p.name === 'string' ? p.name : 'Tool',
          input: isPatch
            ? { file_path: patchFirstFile(p.input) ?? 'patch', patch: p.input }
            : { input: p.input },
          startedAt: ts,
        };
        pushToolUse(ensureAssistant(ts), card);
        break;
      }
      case 'response_item:custom_tool_call_output': {
        if (p.call_id) attachResult(p.call_id, (p.output ?? null) as JSONValue, ts);
        break;
      }
      case 'response_item:web_search_call': {
        const id = p.id ?? p.call_id ?? `web-${makeId()}`;
        const query = p.action && typeof p.action.query === 'string' ? p.action.query : '';
        const idx = ensureAssistant(ts);
        const result: ToolResultCard = { toolUseId: id, toolName: 'WebSearch', content: null, completedAt: ts };
        pushToolUse(idx, {
          toolUseId: id,
          toolName: 'WebSearch',
          input: { query },
          startedAt: ts,
          result,
        });
        break;
      }
    }
  }

  return messages;
}

export async function readCodexSessionMessages(
  spriteName: string,
  sessionId: string
): Promise<ChatMessage[]> {
  const raw = await readSessionRaw(spriteName, sessionId);
  return codexTranscriptToMessages(raw);
}
