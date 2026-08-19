import { AgentEffort, ChatContent, ChatMessage } from '@/models/chat';
import { CodexStreamEvent } from '@/models/codex-events';
import { stripLogTimestamps } from '@/services/claude-stream';

/**
 * Pure helpers for the chat pipeline (no React, no react-native imports).
 * Extracted from useChat so the reliability-critical logic — shell command
 * building, transcript merging, auth-issue sniffing — is unit-testable.
 */

export const DEBUG_SNIPPET_MAX = 240;

export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

export function safeTaskName(value: string): string {
  return value.replace(/[^A-Za-z0-9_.-]/g, '-').slice(0, 120);
}

/**
 * Wrap a turn command so the sprite stays awake while it runs:
 * a sprite task (expire 5m) re-put every 60s, a stderr dot every 20s to keep
 * the log stream warm, and a cleanup trap that tears both down on exit.
 */
export function withSpriteTaskHeartbeat(command: string, taskName: string): string {
  const quotedTaskName = shellQuote(taskName);
  return [
    `TASK_NAME=${quotedTaskName}`,
    `TASK_EXPIRE=5m`,
    `sprite_task_api() { curl -sS --unix-socket /.sprite/api.sock -H "Content-Type: application/json" "$@" >/dev/null 2>&1 || true; }`,
    `sprite_task_put() { sprite_task_api -X PUT "http://sprite/v1/tasks/$TASK_NAME" -d "{\\"expire\\":\\"$TASK_EXPIRE\\"}"; }`,
    `sprite_task_delete() { sprite_task_api -X DELETE "http://sprite/v1/tasks/$TASK_NAME"; }`,
    'cleanup() { status=$?; trap - EXIT INT TERM; if [ -n "${LOG_HBEAT:-}" ]; then kill "$LOG_HBEAT" 2>/dev/null || true; wait "$LOG_HBEAT" 2>/dev/null || true; fi; if [ -n "${TASK_HBEAT:-}" ]; then kill "$TASK_HBEAT" 2>/dev/null || true; wait "$TASK_HBEAT" 2>/dev/null || true; fi; sprite_task_delete; exit "$status"; }',
    `trap cleanup EXIT INT TERM`,
    `sprite_task_put`,
    `(while true; do sleep 60; sprite_task_put; done) & TASK_HBEAT=$!`,
    `(while true; do sleep 20; printf . >&2; done) & LOG_HBEAT=$!`,
    command,
  ].join('; ');
}

/**
 * App-server is a long-lived process, but mobile chat runs are one process per
 * turn. This tiny Node proxy forwards stdin/stdout and terminates app-server
 * after its terminal `turn/completed` notification. Keeping that lifecycle on
 * the sprite means a disconnected phone does not leave a heartbeat-backed
 * app-server running for hours.
 */
export function buildCodexAppServerCommand(): string {
  const source = [
    `const { spawn } = require('node:child_process')`,
    `const child = spawn('codex', ['app-server', '--stdio'], { stdio: ['pipe', 'pipe', 'inherit'] })`,
    `let buffer = ''`,
    `let turnCompleted = false`,
    `let stopping = false`,
    `process.stdin.on('data', (chunk) => { if (child.exitCode === null) child.stdin.write(chunk) })`,
    `child.stdout.on('data', (chunk) => {`,
    `  process.stdout.write(chunk)`,
    `  buffer += chunk.toString('utf8')`,
    `  while (true) {`,
    `    const newline = buffer.indexOf('\\n')`,
    `    if (newline < 0) break`,
    `    const line = buffer.slice(0, newline).trim()`,
    `    buffer = buffer.slice(newline + 1)`,
    `    if (!line) continue`,
    `    try {`,
    `      const message = JSON.parse(line)`,
    `      if (message && message.method === 'turn/completed') {`,
    `        turnCompleted = true`,
    `        if (!stopping) {`,
    `          stopping = true`,
    `          setTimeout(() => { if (child.exitCode === null) child.kill('SIGTERM') }, 50)`,
    `        }`,
    `      }`,
    `    } catch {}`,
    `  }`,
    `})`,
    `for (const signal of ['SIGINT', 'SIGTERM']) {`,
    `  process.on(signal, () => { if (child.exitCode === null) child.kill(signal) })`,
    `}`,
    `child.on('exit', (code, signal) => process.exit(turnCompleted ? 0 : (code ?? (signal ? 1 : 0))))`,
    `child.on('error', (error) => { console.error(error.message); process.exit(1) })`,
  ].join(';\n');
  return `node -e ${shellQuote(source)}`;
}

/** Strip characters that would break an HTTP header, keep it one line. */
function sanitizeNotifyText(value: string, max: number): string {
  return value
    .replace(/\s+/g, ' ')
    .replace(/[\u0000-\u001F\u007F]/g, '')
    .trim()
    .slice(0, max);
}

/**
 * Shell suffix appended after the agent command: POSTs a ntfy.sh-style push
 * notification with the turn's success/failure, then preserves the agent's
 * exit status. It runs on the sprite, so it fires even when the app is closed
 * mid-turn — subscribe to the topic in the ntfy app to get pinged.
 */
export function buildTurnNotifySuffix(opts: {
  server: string;
  topic: string;
  title: string;
  promptPreview: string;
}): string {
  const topic = opts.topic.trim();
  if (!topic) return '';
  const server = (opts.server.trim() || 'https://ntfy.sh').replace(/\/+$/, '');
  const url = shellQuote(`${server}/${encodeURIComponent(topic)}`);
  const title = shellQuote(`Title: ${sanitizeNotifyText(opts.title, 80)}`);
  const preview = sanitizeNotifyText(opts.promptPreview, 100);
  const okBody = shellQuote(preview ? `Done: ${preview}` : 'Turn finished');
  const failBody = shellQuote(preview ? `Failed: ${preview}` : 'Turn failed');
  return (
    `; WISP_EXIT=$?; if [ "$WISP_EXIT" = "0" ]; then ` +
    `curl -sS -m 10 -H ${title} -H "Tags: white_check_mark" -d ${okBody} ${url} >/dev/null 2>&1 || true; ` +
    `else curl -sS -m 10 -H ${title} -H "Tags: x" -H "Priority: high" -d ${failBody} ${url} >/dev/null 2>&1 || true; fi; ` +
    `(exit "$WISP_EXIT")`
  );
}

/**
 * Command that kills a chat turn's whole process group, located by the unique
 * task-name marker in the bash wrapper's argv. `killExecSession` SIGTERMs the
 * session leader (bash), but bash defers traps while a foreground command
 * runs, so the agent process can survive a plain session kill. The pattern's
 * first character is wrapped in a bracket class so the killer's own command
 * line doesn't match itself.
 */
export function buildProcessGroupKillCommand(taskName: string): string {
  const sanitized = safeTaskName(taskName);
  if (!sanitized) return 'true';
  const escaped = sanitized.replace(/\./g, '\\.');
  const selfExcluding = `[${escaped[0]}]${escaped.slice(1)}`;
  const pattern = shellQuote(selfExcluding);
  return [
    `PID=$(pgrep -f ${pattern} | head -n1)`,
    `if [ -n "$PID" ]; then PGID=$(ps -o pgid= -p "$PID" | tr -d " ")`,
    `if [ -n "$PGID" ]; then kill -TERM -- "-$PGID" 2>/dev/null || true; sleep 2; kill -KILL -- "-$PGID" 2>/dev/null || true; fi; fi`,
    `true`,
  ].join('; ');
}

export function classifyCodexAuthIssue(raw: string): string | undefined {
  const text = raw.toLowerCase();
  const matchesAuthIssue =
    text.includes('codex login') ||
    text.includes('not logged') ||
    text.includes('authentication') ||
    text.includes('unauthorized') ||
    text.includes('forbidden') ||
    text.includes('openai_api_key') ||
    text.includes('api key') ||
    text.includes('login required') ||
    text.includes('chatgpt login') ||
    text.includes('status code: 401') ||
    text.includes('status code: 403');

  if (!matchesAuthIssue) return undefined;

  return [
    'Codex is not authenticated in this sprite environment.',
    'Run `codex login status` and then `codex login` inside the sprite shell, or switch this chat to Claude.',
  ].join(' ');
}

/** pi's --thinking flag spells the no-reasoning level "off", not "none". */
export function piThinkingLevel(effort: AgentEffort): string {
  return effort === 'none' ? 'off' : effort;
}

/** Shell command for one pi chat turn (`pi --mode json`), streaming JSONL events. */
export function buildPiTurnCommand(opts: {
  prompt: string;
  model?: string;
  effort: AgentEffort;
  /** pi session id to resume (`pi --session <id>`). */
  session?: string;
  appendSystemPrompt?: string;
}): string {
  let cmd = 'pi --mode json';
  if (opts.model) cmd += ` --model ${shellQuote(opts.model)}`;
  cmd += ` --thinking ${shellQuote(piThinkingLevel(opts.effort))}`;
  if (opts.appendSystemPrompt) {
    cmd += ` --append-system-prompt ${shellQuote(opts.appendSystemPrompt)}`;
  }
  if (opts.session) cmd += ` --session ${shellQuote(opts.session)}`;
  cmd += ` ${shellQuote(opts.prompt)}`;
  return cmd;
}

/**
 * Sniff pi startup/auth failures from stderr. pi has no permission flags; the
 * two ways a turn dies before any output are a missing install and missing
 * credentials ("No API key found for …", "Run '/login <provider>'").
 */
export function classifyPiIssue(raw: string): string | undefined {
  const text = raw.toLowerCase();
  if (/pi: (command not found|not found)/.test(text) || text.includes('pi: commandnotfound')) {
    return [
      'The pi coding agent is not installed on this sprite.',
      'Install it inside the sprite shell: `npm install -g @earendil-works/pi-coding-agent`, then retry.',
    ].join(' ');
  }
  const matchesAuthIssue =
    text.includes('no api key') ||
    text.includes('api key found') ||
    text.includes("run '/login") ||
    text.includes('run /login') ||
    text.includes('re-authenticate') ||
    text.includes('not authenticated') ||
    text.includes('unauthorized') ||
    text.includes('status code: 401') ||
    text.includes('status code: 403');

  if (!matchesAuthIssue) return undefined;

  return [
    'pi has no model provider credentials in this sprite.',
    'Connect a provider API key in the Integrations tab, or run `pi` and use /login inside the sprite shell.',
  ].join(' ');
}

export function messagePlainText(message: ChatMessage): string {
  return message.content
    .filter((item): item is Extract<ChatContent, { type: 'text' }> => item.type === 'text')
    .map((item) => item.text)
    .join('\n\n')
    .trim();
}

export function buildFallbackPrompt(history: ChatMessage[], prompt: string): string {
  const transcript = history
    .filter((message) => message.role === 'user' || message.role === 'assistant')
    .map((message) => {
      const text = messagePlainText(message);
      if (!text) return null;
      const role = message.role === 'user' ? 'User' : 'Assistant';
      const clipped = text.length > 1200 ? `${text.slice(0, 1200)}...` : text;
      return `${role}: ${clipped}`;
    })
    .filter((line): line is string => line !== null)
    .slice(-12);

  if (transcript.length === 0) return prompt;

  return [
    'Continue this conversation. Here is the prior transcript:',
    transcript.join('\n\n'),
    `User: ${prompt}`,
    'Assistant:',
  ].join('\n\n');
}

export function countUserMessages(messages: ChatMessage[]): number {
  return messages.reduce((n, m) => (m.role === 'user' ? n + 1 : n), 0);
}

/**
 * Index of the first position where two serialized-message snapshots differ.
 * Streaming appends/edits only the conversation tail, so persisting from this
 * index skips rewriting everything before it. Equal arrays return their common
 * length — callers use that to skip the write entirely.
 */
export function firstDivergentIndex(prev: string[], next: string[]): number {
  const min = Math.min(prev.length, next.length);
  let i = 0;
  while (i < min && prev[i] === next[i]) i++;
  return i;
}

/** Stable content fingerprint — two conversations with the same signature render identically. */
export function conversationSignature(messages: ChatMessage[]): string {
  return messages
    .map((m) => {
      const parts = m.content.map((c) => {
        if (c.type === 'text') return `t:${c.text}`;
        if (c.type === 'reasoning') return `r:${c.text.length}`;
        if (c.type === 'toolUse') return `u:${c.card.toolUseId}`;
        if (c.type === 'toolResult') return `R:${c.card.toolUseId}`;
        if (c.type === 'turnOutcome') return `o:${c.outcome.status}`;
        return c.type;
      });
      return `${m.role}|${parts.join('|')}`;
    })
    .join('\n');
}

/**
 * Overlay an incoming (e.g. on-disk transcript) conversation onto the local one,
 * preserving the existing message ids for the common prefix. Keeping ids stable
 * means React reuses the already-mounted bubbles instead of remounting/re-scrolling
 * them — which is what made reopening a chat look like the last turn was duplicated
 * and re-answered.
 */
export function mergeTranscript(local: ChatMessage[], incoming: ChatMessage[]): ChatMessage[] {
  return incoming.map((msg, i) => {
    const localMsg = local[i];
    if (localMsg && localMsg.role === msg.role) {
      const merged: ChatMessage = { ...msg, id: localMsg.id };
      // On-disk transcripts carry no result/outcome lines, so a merge would
      // silently drop the turn-outcome footer the live stream recorded. Carry
      // the local footer over when the incoming message has none.
      if (msg.role === 'assistant' && !msg.content.some((c) => c.type === 'turnOutcome')) {
        const localOutcome = [...localMsg.content]
          .reverse()
          .find((c) => c.type === 'turnOutcome');
        if (localOutcome) {
          merged.content = [...msg.content, localOutcome];
        }
      }
      return merged;
    }
    return msg;
  });
}

export function nextAssistantAfterUser(messages: ChatMessage[], userIndex: number): number {
  for (let i = userIndex + 1; i < messages.length; i++) {
    if (messages[i].role === 'user') break;
    if (messages[i].role === 'assistant') return i;
  }
  return -1;
}

export function elapsedSince(startedAt: number | undefined): string {
  return startedAt ? `+${Date.now() - startedAt}ms` : '+?ms';
}

export function redactDebugText(value: string): string {
  return value
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [redacted]')
    .replace(/sk-[A-Za-z0-9_-]{10,}/g, 'sk-[redacted]')
    .replace(/(OPENAI_API_KEY|CLAUDE_CODE_OAUTH_TOKEN)=\S+/g, '$1=[redacted]');
}

export function compactDebugChunk(value: string, max = DEBUG_SNIPPET_MAX): string {
  const cleaned = redactDebugText(stripLogTimestamps(value))
    .replace(/\u001b\[[0-9;]*m/g, '')
    .replace(/\r/g, '\\r')
    .replace(/\n/g, '\\n')
    .trim();
  if (cleaned.length <= max) return cleaned;
  return `${cleaned.slice(0, max)}…`;
}

export function isHeartbeatStderr(value: string): boolean {
  const compact = stripLogTimestamps(value).replace(/\s/g, '');
  return compact.length > 0 && /^\.+$/.test(compact);
}

export function codexEventDebugLabel(event: CodexStreamEvent): string {
  switch (event.type) {
    case 'unknown':
      return [
        'unknown',
        event.rpcMethod ? `rpc=${event.rpcMethod}` : undefined,
        event.rawType ? `raw=${event.rawType}` : undefined,
        event.itemType ? `item=${event.itemType}` : undefined,
        event.keys?.length ? `keys=${event.keys.join('|')}` : undefined,
      ].filter(Boolean).join(' ');
    case 'assistantDelta':
      return `assistantDelta chars=${event.text.length}`;
    case 'reasoning':
      return `reasoning chars=${event.text.length}`;
    case 'reasoningBoundary':
      return 'reasoningBoundary';
    case 'commandBegin':
      return `commandBegin id=${event.commandId}`;
    case 'commandOutput':
      return `commandOutput id=${event.commandId} chars=${event.delta.length}`;
    case 'commandEnd':
      return `commandEnd id=${event.commandId} exit=${event.exitCode ?? '?'}`;
    case 'fileChangeBegin':
      return `fileChangeBegin files=${event.files.length}`;
    case 'fileChange':
      return `fileChange files=${event.files.length}`;
    case 'mcpToolBegin':
      return `mcpToolBegin tool=${event.server ? `${event.server}.` : ''}${event.tool}`;
    case 'mcpToolEnd':
      return `mcpToolEnd tool=${event.server ? `${event.server}.` : ''}${event.tool} error=${event.isError}`;
    case 'todoList':
      return `todoList items=${event.items.length}`;
    case 'activity':
      return `activity name=${event.name} completed=${event.completed}`;
    case 'turnCompleted':
      return `turnCompleted status=${event.status}`;
    default:
      return event.type;
  }
}
