import { ChatContent, ChatMessage, ToolResultCard, ToolUseCard, makeId } from '@/models/chat';
import { JSONValue } from '@/models/claude-events';
import { runExec } from './api';
import {
  SessionScanResult,
  extractSentinel,
  heredoc,
  parseScanPayload,
  scannedSessionsWithDetail,
} from './session-scan';

/**
 * Reads Claude Code's own on-disk session transcripts from a sprite — the same
 * data `claude --resume` shows. Claude stores one JSONL file per session under
 * `~/.claude/projects/<encoded-cwd>/<session-id>.jsonl`, where each line is an
 * event ({type:"user"|"assistant"|"system"|"result", message, cwd, timestamp}).
 *
 * Because these live on disk (not in the phone), they survive the process
 * exiting, the app being closed, or even a fresh install — letting the app
 * mirror the desktop "console + claude --resume" / "sessions list" experience.
 */

export interface ClaudeSessionSummary {
  /** Session UUID — the value you pass to `claude --resume <id>`. */
  id: string;
  /** Working directory the session ran in (resume must use the same cwd). */
  cwd?: string;
  /** First human prompt, trimmed — used as the list preview. */
  preview: string;
  /** Number of JSONL lines (rough activity indicator). */
  messageCount: number;
  /** File mtime in ms since epoch. */
  modified: number;
  /**
   * True when a process still holds the transcript open (a running `claude`) or
   * it was appended to within the last ~90s — i.e. the CLI session is likely
   * still going. Best-effort: derived sprite-side from `/proc` and file mtime.
   */
  live: boolean;
}

const SESSION_ID_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]{2,200}$/;

/**
 * Node script (run on the sprite) that scans every transcript and emits a
 * compact JSON summary array. Done sprite-side so we transfer a few KB instead
 * of every full transcript. Delimited by a quoted heredoc so quotes inside the
 * script need no escaping.
 *
 * `SINCE` is the caller's cursor (see `session-scan.ts`): a transcript whose
 * mtime is at or below it is emitted as `{id, modified, live, stale:1}` and
 * never opened — reading and parsing every line of an unchanged transcript is
 * what made a cold Activity scan take tens of seconds.
 */
function listScript(since: number): string {
  return String.raw`
const fs = require('fs'), os = require('os'), path = require('path');
const SINCE = ${Math.max(0, Math.floor(since))};
const SCAN_START = Date.now();
const base = path.join(os.homedir(), '.claude', 'projects');
const out = [];
function firstUserText(lines) {
  for (const line of lines) {
    let o;
    try { o = JSON.parse(line); } catch { continue; }
    if (o && o.type === 'user' && o.message) {
      const c = o.message.content;
      if (typeof c === 'string') return c;
      if (Array.isArray(c)) {
        const t = c.find((b) => b && b.type === 'text' && typeof b.text === 'string');
        if (t) return t.text;
      }
    }
  }
  return '';
}
function cwdOf(lines) {
  for (const line of lines) {
    let o;
    try { o = JSON.parse(line); } catch { continue; }
    if (o && typeof o.cwd === 'string' && o.cwd) return o.cwd;
  }
  return null;
}
// A transcript counts as "live" when some process still holds it open (a running
// claude), or it was appended to within this window. Session filenames are unique
// (<session-id>.jsonl), so matching on basename is enough and dodges realpath skew.
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
try {
  for (const dir of fs.readdirSync(base)) {
    const full = path.join(base, dir);
    let files;
    try { files = fs.readdirSync(full).filter((f) => f.endsWith('.jsonl')); } catch { continue; }
    for (const f of files) {
      const fp = path.join(full, f);
      let stat;
      try { stat = fs.statSync(fp); } catch { continue; }
      const modified = Math.floor(stat.mtimeMs);
      const live = openNames.has(f) || (Date.now() - stat.mtimeMs < LIVE_WINDOW_MS);
      const id = f.replace(/\.jsonl$/, '');
      // Unchanged since the caller's cursor: report liveness only, don't read.
      if (SINCE > 0 && modified <= SINCE) {
        out.push({ id, modified, live, stale: 1 });
        continue;
      }
      let content;
      try { content = fs.readFileSync(fp, 'utf8'); } catch { continue; }
      const lines = content.split('\n').filter((l) => l.trim());
      if (lines.length === 0) continue;
      out.push({
        id,
        cwd: cwdOf(lines),
        preview: firstUserText(lines).slice(0, 240),
        messageCount: lines.length,
        modified,
        live,
      });
    }
  }
} catch (e) {}
out.sort((a, b) => b.modified - a.modified);
process.stdout.write('@@WISP@@' + JSON.stringify({ cursor: SCAN_START, sessions: out }) + '@@WISP@@');
`;
}

/**
 * Scan the sprite's Claude transcript store. Pass the `cursor` from the previous
 * scan to skip re-reading transcripts that haven't changed since (see
 * `session-scan.ts`); `0` forces a full scan.
 */
export async function scanClaudeSessions(
  spriteName: string,
  since = 0
): Promise<SessionScanResult> {
  const { output, success } = await runExec(spriteName, heredoc(listScript(since)), 25);
  if (!success) throw new Error(`Could not scan Claude sessions on ${spriteName}`);
  const payload = extractSentinel(output);
  if (!payload) throw new Error(`Claude session scan returned no data on ${spriteName}`);
  try {
    return parseScanPayload(payload);
  } catch {
    throw new Error(`Claude session scan returned invalid data on ${spriteName}`);
  }
}

export async function listClaudeSessions(spriteName: string): Promise<ClaudeSessionSummary[]> {
  return scannedSessionsWithDetail(await scanClaudeSessions(spriteName, 0));
}

/** Raw transcript lines for one session (cat the JSONL via glob across projects). */
async function readSessionRaw(spriteName: string, sessionId: string): Promise<string> {
  if (!SESSION_ID_RE.test(sessionId)) {
    throw new Error('Invalid session id');
  }
  // Glob matches the file under whichever project (cwd) dir it lives in.
  const cmd = `cat ~/.claude/projects/*/${sessionId}.jsonl 2>/dev/null`;
  const { output } = await runExec(spriteName, cmd, 25);
  return output;
}

// MARK: - Transcript -> ChatMessage rendering

function blockText(block: any): string | undefined {
  if (block && block.type === 'text' && typeof block.text === 'string') return block.text;
  return undefined;
}

/**
 * Convert an on-disk transcript into the app's ChatMessage[] so the existing
 * chat UI can render it natively. Mirrors the live-stream handling in useChat,
 * but also treats human `user` lines as user bubbles (the live path never sees
 * those because the prompt originates locally).
 */
export function transcriptToMessages(raw: string): ChatMessage[] {
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

  for (const line of lines) {
    let o: any;
    try {
      o = JSON.parse(line);
    } catch {
      continue;
    }
    if (!o || typeof o !== 'object') continue;

    const ts = Date.parse(o.timestamp) || Date.now();
    const type = o.type;
    const content = o.message?.content;

    if (type === 'user') {
      // A human prompt (string, or an array with a text block and no tool_result).
      const isToolResult =
        Array.isArray(content) && content.some((b: any) => b && b.type === 'tool_result');

      if (isToolResult) {
        for (const block of content) {
          if (!block || block.type !== 'tool_result') continue;
          const card: ToolResultCard = {
            toolUseId: block.tool_use_id,
            toolName: 'Unknown',
            content: (block.content ?? null) as JSONValue,
            completedAt: ts,
          };
          const idx = toolUseLocation.get(block.tool_use_id);
          if (idx !== undefined) {
            const msg = messages[idx];
            const updated = msg.content.map((item) => {
              if (item.type === 'toolUse' && item.card.toolUseId === block.tool_use_id) {
                card.toolName = item.card.toolName;
                return { type: 'toolUse', card: { ...item.card, result: card } } as ChatContent;
              }
              return item;
            });
            updated.push({ type: 'toolResult', card });
            messages[idx] = { ...msg, content: updated };
          }
        }
        continue;
      }

      let text = '';
      if (typeof content === 'string') text = content;
      else if (Array.isArray(content)) {
        text = content.map(blockText).filter((t): t is string => !!t).join('\n');
      }
      if (!text.trim()) continue;
      // Skip local command/meta noise that Claude records as user lines.
      if (text.startsWith('<command-') || text.startsWith('<local-command')) continue;

      messages.push({ id: makeId(), timestamp: ts, role: 'user', content: [{ type: 'text', text }] });
      currentAssistantIndex = null;
      continue;
    }

    if (type === 'assistant' && Array.isArray(content)) {
      const idx = ensureAssistant(ts);
      const next: ChatContent[] = [...messages[idx].content];
      for (const block of content) {
        if (block?.type === 'text' && typeof block.text === 'string') {
          if (!block.text) continue;
          const last = next[next.length - 1];
          if (last && last.type === 'text') {
            next[next.length - 1] = { type: 'text', text: last.text + block.text };
          } else {
            next.push({ type: 'text', text: block.text });
          }
        } else if (block?.type === 'thinking' && typeof block.thinking === 'string') {
          if (!block.thinking) continue;
          const last = next[next.length - 1];
          if (last && last.type === 'reasoning') {
            next[next.length - 1] = { type: 'reasoning', text: last.text + block.thinking };
          } else {
            next.push({ type: 'reasoning', text: block.thinking });
          }
        } else if (block?.type === 'tool_use' && block.id && block.name) {
          const card: ToolUseCard = {
            toolUseId: block.id,
            toolName: block.name,
            input: (block.input ?? null) as JSONValue,
            startedAt: ts,
          };
          next.push({ type: 'toolUse', card });
          toolUseLocation.set(block.id, idx);
        }
      }
      messages[idx] = { ...messages[idx], content: next };
      continue;
    }

    // system / result / summary lines carry no user-visible bubble.
  }

  return messages;
}

export async function readClaudeSessionMessages(
  spriteName: string,
  sessionId: string
): Promise<ChatMessage[]> {
  const raw = await readSessionRaw(spriteName, sessionId);
  return transcriptToMessages(raw);
}
