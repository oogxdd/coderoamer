import { JSONValue, jsonGet, jsonString, jsonPretty } from './claude-events';

export type ChatRole = 'user' | 'assistant' | 'system';
export type AgentProvider = 'claude' | 'codex' | 'codexAppServer';
export type AgentEffort = 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';

export type ChatStatus = 'idle' | 'connecting' | 'streaming' | 'reconnecting' | 'error';

/**
 * A conversation that lives on the sprite's disk rather than in the phone's local
 * chat store — i.e. one started from the "sprite console" CLI (`claude` / `codex`)
 * on a computer. Discovered by scanning the sprite's transcript files, it can be
 * pulled into the conversation list and resumed in the chat UI. Shape is the
 * common denominator of Claude/Codex session summaries plus the provider tag.
 */
export interface RemoteAgentSession {
  /** Session/thread id — the value passed to `claude --resume` / `codex resume`. */
  id: string;
  provider: AgentProvider;
  /** Working directory the session ran in (resume must reuse it). */
  cwd?: string;
  /** First user prompt, trimmed — used as the list preview. */
  preview: string;
  /** Number of transcript lines (rough activity indicator). */
  messageCount: number;
  /** Transcript file mtime in ms since epoch. */
  modified: number;
  /** True when the CLI session is (likely) still running. */
  live: boolean;
}

export interface ChatMessage {
  id: string;
  timestamp: number;
  role: ChatRole;
  content: ChatContent[];
  checkpointId?: string;
  checkpointComment?: string;
}

export type ChatContent =
  | { type: 'text'; text: string }
  | { type: 'reasoning'; text: string }
  | { type: 'toolUse'; card: ToolUseCard }
  | { type: 'toolResult'; card: ToolResultCard }
  | { type: 'error'; message: string }
  | { type: 'turnOutcome'; outcome: TurnOutcome };

export type TurnOutcomeStatus = 'success' | 'maxTurns' | 'error' | 'interrupted';

/**
 * How a turn ended — from Claude's `result` event (`subtype`/`is_error`),
 * Codex's `turn.completed`/`error`, or a local interrupt. Rendered as a footer
 * on the assistant message so a silent stop is distinguishable from success.
 */
export interface TurnOutcome {
  status: TurnOutcomeStatus;
  /** Raw CLI result subtype (e.g. `error_max_turns`) when one was reported. */
  subtype?: string;
  durationMs?: number;
  numTurns?: number;
  completedAt: number;
}

export function formatTurnDuration(ms: number | undefined): string | null {
  if (ms === undefined || !Number.isFinite(ms) || ms < 0) return null;
  const seconds = ms / 1000;
  if (seconds < 1) return '<1s';
  if (seconds < 60) return `${Math.floor(seconds)}s`;
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}m ${s}s`;
}

export interface ToolUseCard {
  toolUseId: string;
  toolName: string;
  input: JSONValue;
  startedAt: number;
  result?: ToolResultCard;
}

export interface ToolResultCard {
  toolUseId: string;
  toolName: string;
  content: JSONValue;
  completedAt: number;
}

export function toolUseSummary(card: ToolUseCard): string {
  const input = card.input;
  switch (card.toolName) {
    case 'Bash':
      return jsonString(jsonGet(input, 'command')) ?? 'bash command';
    case 'Read':
      return jsonString(jsonGet(input, 'file_path')) ?? 'read file';
    case 'Write':
      return jsonString(jsonGet(input, 'file_path')) ?? 'write file';
    case 'Edit':
      return jsonString(jsonGet(input, 'file_path')) ?? 'edit file';
    case 'Glob':
      return jsonString(jsonGet(input, 'pattern')) ?? 'glob search';
    case 'Grep':
      return jsonString(jsonGet(input, 'pattern')) ?? 'grep search';
    case 'WebSearch':
      return jsonString(jsonGet(input, 'query')) ?? 'web search';
    case 'TodoWrite': {
      const todos = jsonGet(input, 'todos');
      if (Array.isArray(todos)) {
        const total = todos.length;
        const done = todos.filter(
          (t) => jsonString(jsonGet(t, 'status')) === 'completed'
        ).length;
        return `${done}/${total} tasks`;
      }
      return 'update plan';
    }
    default:
      return card.toolName;
  }
}

export function toolUseIcon(toolName: string): string {
  switch (toolName) {
    case 'Bash': return '>';
    case 'Read': return '📄';
    case 'Write': return '📝';
    case 'Edit': return '✏️';
    case 'Glob': return '🔍';
    case 'Grep': return '🔎';
    case 'WebSearch': return '🌐';
    case 'TodoWrite': return '📋';
    default: return '🔧';
  }
}

export function toolUseActivityLabel(card: ToolUseCard, cwd?: string): string {
  const relativize = (s: string) => {
    if (cwd && s.startsWith(cwd)) {
      const rel = s.slice(cwd.length);
      return rel.startsWith('/') ? rel.slice(1) : rel;
    }
    return s;
  };
  const input = card.input;
  switch (card.toolName) {
    case 'Bash': {
      const cmd = jsonString(jsonGet(input, 'command')) ?? 'command';
      return `Running ${cmd.slice(0, 60)}...`;
    }
    case 'Read': {
      const fp = jsonString(jsonGet(input, 'file_path')) ?? 'file';
      return `Reading ${relativize(fp.split('/').pop() ?? fp)}...`;
    }
    case 'Write': {
      const fp = jsonString(jsonGet(input, 'file_path')) ?? 'file';
      return `Writing ${relativize(fp.split('/').pop() ?? fp)}...`;
    }
    case 'Edit': {
      const fp = jsonString(jsonGet(input, 'file_path')) ?? 'file';
      return `Editing ${relativize(fp.split('/').pop() ?? fp)}...`;
    }
    case 'Glob': {
      const pattern = jsonString(jsonGet(input, 'pattern')) ?? 'files';
      return `Searching ${pattern}...`;
    }
    case 'Grep': {
      const pattern = jsonString(jsonGet(input, 'pattern')) ?? 'code';
      return `Searching ${pattern}...`;
    }
    case 'WebSearch': {
      const query = jsonString(jsonGet(input, 'query')) ?? 'web';
      return `Searching the web for ${query.slice(0, 40)}...`;
    }
    case 'TodoWrite':
      return 'Updating plan...';
    default:
      return `Running ${card.toolName}...`;
  }
}

export function toolElapsedString(card: ToolUseCard): string | null {
  if (!card.result) return null;
  const elapsed = (card.result.completedAt - card.startedAt) / 1000;
  if (elapsed < 1) return '<1s';
  if (elapsed < 60) return `${Math.floor(elapsed)}s`;
  const m = Math.floor(elapsed / 60);
  const s = Math.floor(elapsed % 60);
  return `${m}m ${s}s`;
}

export function toolResultDisplayContent(card: ToolResultCard): string {
  const { content } = card;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    const strings = content.filter((x): x is string => typeof x === 'string');
    if (strings.length > 0) return strings.join('\n');
    const texts = content
      .filter((x): x is Record<string, JSONValue> => typeof x === 'object' && x !== null && !Array.isArray(x))
      .map((x) => typeof x.text === 'string' ? x.text : null)
      .filter((x): x is string => x !== null);
    if (texts.length > 0) return texts.join('\n');
    return jsonPretty(content);
  }
  return jsonPretty(content);
}

export function makeId(): string {
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}

export function providerDisplayName(provider: AgentProvider): string {
  switch (provider) {
    case 'codex':
      return 'Codex Legacy';
    case 'codexAppServer':
      return 'Codex Live';
    default:
      return 'Claude';
  }
}

export function isCodexProvider(provider: AgentProvider): boolean {
  return provider === 'codex' || provider === 'codexAppServer';
}

export function normalizeAgentEffort(value: unknown): AgentEffort | undefined {
  switch (value) {
    case 'none':
    case 'minimal':
    case 'low':
    case 'medium':
    case 'high':
    case 'xhigh':
    case 'max':
      return value;
    default:
      return undefined;
  }
}

export function normalizeAgentEffortForProvider(
  provider: AgentProvider,
  value: unknown
): AgentEffort | undefined {
  const effort = normalizeAgentEffort(value);
  if (!effort) return undefined;

  if (isCodexProvider(provider)) {
    // Older builds exposed "minimal", while current Codex models call the
    // no-reasoning level "none". Also keep cross-provider "max" values valid.
    if (effort === 'minimal') return 'none';
    if (effort === 'max') return 'xhigh';
    return effort;
  }

  // Claude's picker supports low through max, but not Codex's none/minimal.
  if (effort === 'none' || effort === 'minimal') return undefined;
  return effort;
}

export function effortDisplayName(effort: AgentEffort): string {
  if (effort === 'xhigh') return 'Extra high';
  return effort.charAt(0).toUpperCase() + effort.slice(1);
}
