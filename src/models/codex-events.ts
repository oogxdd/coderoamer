import { JSONValue, jsonGet, jsonNumber, jsonString } from './claude-events';

export interface FileChangeEntry {
  path: string;
  kind: string;
}

export interface TodoEntry {
  text: string;
  completed: boolean;
}

export type CodexStreamEvent =
  | { type: 'threadStarted'; threadId: string }
  | { type: 'assistantDelta'; text: string }
  | { type: 'reasoning'; text: string }
  | { type: 'commandBegin'; commandId: string; command: string }
  | { type: 'commandEnd'; commandId: string; command: string; output: string | null; exitCode?: number }
  | { type: 'fileChange'; changeId: string; files: FileChangeEntry[]; status: string }
  | { type: 'mcpToolBegin'; callId: string; server: string; tool: string; args: JSONValue }
  | { type: 'mcpToolEnd'; callId: string; server: string; tool: string; output: string | null; isError: boolean }
  | { type: 'webSearch'; query: string }
  | { type: 'todoList'; listId: string; items: TodoEntry[] }
  | { type: 'turnCompleted' }
  | { type: 'error'; message: string }
  | { type: 'unknown' };

function readItemId(value: unknown): string | undefined {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return (
      jsonString(jsonGet(value as any, 'id')) ??
      jsonString(jsonGet(value as any, 'command_id')) ??
      jsonString(jsonGet(value as any, 'tool_call_id')) ??
      jsonString(jsonGet(value as any, 'call_id'))
    );
  }
  return undefined;
}

function readCommand(value: unknown): string | undefined {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return (
      jsonString(jsonGet(value as any, 'command')) ??
      jsonString(jsonGet(value as any, 'input')) ??
      jsonString(jsonGet(value as any, 'name'))
    );
  }
  return undefined;
}

function readOutput(value: unknown): string | null {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return (
      jsonString(jsonGet(value as any, 'aggregated_output')) ??
      jsonString(jsonGet(value as any, 'output')) ??
      jsonString(jsonGet(value as any, 'stdout')) ??
      jsonString(jsonGet(value as any, 'text')) ??
      null
    );
  }
  return null;
}

function readAgentMessageText(value: unknown): string | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;

  const direct =
    jsonString(jsonGet(value as any, 'text')) ??
    jsonString(jsonGet(value as any, 'content_text')) ??
    undefined;
  if (direct) return direct;

  const content = jsonGet(value as any, 'content');
  if (Array.isArray(content)) {
    const joined = content
      .map((item) => {
        if (typeof item === 'string') return item;
        if (item && typeof item === 'object' && !Array.isArray(item)) {
          return (
            jsonString(jsonGet(item as any, 'text')) ??
            jsonString(jsonGet(item as any, 'content')) ??
            ''
          );
        }
        return '';
      })
      .filter((x) => x.length > 0)
      .join('\n');
    if (joined) return joined;
  }

  return undefined;
}

function readMessage(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return (
      jsonString(jsonGet(value as any, 'message')) ??
      jsonString(jsonGet(value as any, 'error')) ??
      jsonString(jsonGet(value as any, 'text'))
    );
  }
  return undefined;
}

function readItemType(item: unknown): string {
  return readMessage(jsonGet(item as any, 'type')) ?? '';
}

function readFileChanges(item: unknown): FileChangeEntry[] {
  const changes = jsonGet(item as any, 'changes');
  if (!Array.isArray(changes)) return [];
  return changes
    .map((change) => ({
      path: jsonString(jsonGet(change as any, 'path')) ?? '',
      kind: jsonString(jsonGet(change as any, 'kind')) ?? 'update',
    }))
    .filter((change) => change.path.length > 0);
}

function readTodoItems(item: unknown): TodoEntry[] {
  const items = jsonGet(item as any, 'items');
  if (!Array.isArray(items)) return [];
  return items
    .map((entry) => ({
      text: jsonString(jsonGet(entry as any, 'text')) ?? '',
      completed: jsonGet(entry as any, 'completed') === true,
    }))
    .filter((entry) => entry.text.length > 0);
}

function readMcpResult(item: unknown): { output: string | null; isError: boolean } {
  const error = jsonGet(item as any, 'error');
  if (error) {
    return { output: readMessage(error) ?? 'MCP tool error', isError: true };
  }
  const result = jsonGet(item as any, 'result');
  const content = jsonGet(result as any, 'content');
  if (Array.isArray(content)) {
    const text = content
      .map((block) => jsonString(jsonGet(block as any, 'text')) ?? '')
      .filter((x) => x.length > 0)
      .join('\n');
    if (text) return { output: text, isError: false };
  }
  return { output: null, isError: false };
}

export function parseCodexEvent(json: any): CodexStreamEvent[] {
  if (!json || typeof json !== 'object') return [{ type: 'unknown' }];
  const type = typeof json.type === 'string' ? json.type : '';
  const events: CodexStreamEvent[] = [];

  switch (type) {
    case 'thread.started': {
      const threadId = readMessage(json.thread_id) ?? readMessage(json.threadId);
      if (threadId) events.push({ type: 'threadStarted', threadId });
      break;
    }
    case 'item.started': {
      const item = json.item;
      switch (readItemType(item)) {
        case 'command_execution': {
          const command = readCommand(item);
          if (command) {
            events.push({
              type: 'commandBegin',
              commandId: readItemId(item) ?? `cmd-${Date.now().toString(36)}`,
              command,
            });
          }
          break;
        }
        case 'mcp_tool_call': {
          events.push({
            type: 'mcpToolBegin',
            callId: readItemId(item) ?? `mcp-${Date.now().toString(36)}`,
            server: jsonString(jsonGet(item, 'server')) ?? '',
            tool: jsonString(jsonGet(item, 'tool')) ?? 'tool',
            args: jsonGet(item, 'arguments') ?? null,
          });
          break;
        }
      }
      break;
    }
    case 'item.updated': {
      const item = json.item;
      // Surface the plan live as Codex revises it.
      if (readItemType(item) === 'todo_list') {
        events.push({
          type: 'todoList',
          listId: readItemId(item) ?? 'todo',
          items: readTodoItems(item),
        });
      }
      break;
    }
    case 'item.completed': {
      const item = json.item;
      switch (readItemType(item)) {
        case 'agent_message': {
          const text = readAgentMessageText(item);
          if (text) events.push({ type: 'assistantDelta', text });
          break;
        }
        case 'reasoning': {
          const text = readAgentMessageText(item);
          if (text) events.push({ type: 'reasoning', text });
          break;
        }
        case 'command_execution': {
          events.push({
            type: 'commandEnd',
            commandId: readItemId(item) ?? `cmd-${Date.now().toString(36)}`,
            command: readCommand(item) ?? 'command',
            output: readOutput(item),
            exitCode: jsonNumber(jsonGet(item, 'exit_code')),
          });
          break;
        }
        case 'file_change': {
          events.push({
            type: 'fileChange',
            changeId: readItemId(item) ?? `patch-${Date.now().toString(36)}`,
            files: readFileChanges(item),
            status: jsonString(jsonGet(item, 'status')) ?? 'completed',
          });
          break;
        }
        case 'mcp_tool_call': {
          const { output, isError } = readMcpResult(item);
          events.push({
            type: 'mcpToolEnd',
            callId: readItemId(item) ?? `mcp-${Date.now().toString(36)}`,
            server: jsonString(jsonGet(item, 'server')) ?? '',
            tool: jsonString(jsonGet(item, 'tool')) ?? 'tool',
            output,
            isError,
          });
          break;
        }
        case 'web_search': {
          const query = jsonString(jsonGet(item, 'query'));
          if (query) events.push({ type: 'webSearch', query });
          break;
        }
        case 'todo_list': {
          events.push({
            type: 'todoList',
            listId: readItemId(item) ?? 'todo',
            items: readTodoItems(item),
          });
          break;
        }
        case 'error': {
          events.push({ type: 'error', message: readMessage(item) ?? 'Codex error' });
          break;
        }
      }
      break;
    }
    case 'turn.completed': {
      events.push({ type: 'turnCompleted' });
      break;
    }
    case 'error':
    case 'turn.failed': {
      events.push({
        type: 'error',
        message: readMessage(json.error) ?? readMessage(json.message) ?? 'Codex execution failed',
      });
      break;
    }
    default:
      events.push({ type: 'unknown' });
  }

  return events;
}
