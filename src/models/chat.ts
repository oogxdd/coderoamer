import { JSONValue, jsonGet, jsonString, jsonPretty } from './claude-events';

export type ChatRole = 'user' | 'assistant' | 'system';
export type AgentProvider = 'claude' | 'codex' | 'codexAppServer';

export type ChatStatus = 'idle' | 'connecting' | 'streaming' | 'reconnecting' | 'error';

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
  | { type: 'error'; message: string };

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
      return 'Codex';
    case 'codexAppServer':
      return 'Codex Server';
    default:
      return 'Claude';
  }
}

export function isCodexProvider(provider: AgentProvider): boolean {
  return provider === 'codex' || provider === 'codexAppServer';
}
