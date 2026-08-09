import { JSONValue, jsonGet, jsonNumber, jsonString } from './claude-events';

export interface FileChangeEntry {
  path: string;
  kind: string;
  diff?: string;
}

export interface TodoEntry {
  text: string;
  status: 'pending' | 'inProgress' | 'completed';
}

export type CodexStreamEvent =
  | { type: 'threadStarted'; threadId: string }
  | { type: 'turnStarted'; turnId?: string }
  | { type: 'assistantDelta'; text: string }
  | { type: 'reasoning'; text: string }
  | { type: 'reasoningBoundary' }
  | { type: 'commandBegin'; commandId: string; command: string; cwd?: string }
  | { type: 'commandOutput'; commandId: string; delta: string }
  | {
      type: 'commandEnd';
      commandId: string;
      command: string;
      output: string | null;
      exitCode?: number;
      status?: string;
      durationMs?: number;
    }
  | { type: 'fileChangeBegin'; changeId: string; files: FileChangeEntry[] }
  | { type: 'fileChange'; changeId: string; files: FileChangeEntry[]; status: string }
  | { type: 'mcpToolBegin'; callId: string; server: string; tool: string; args: JSONValue }
  | { type: 'mcpToolEnd'; callId: string; server: string; tool: string; output: string | null; isError: boolean }
  | {
      type: 'activity';
      activityId: string;
      name: string;
      input: JSONValue;
      output?: JSONValue;
      completed: boolean;
      isError?: boolean;
    }
  | { type: 'todoList'; listId: string; items: TodoEntry[] }
  | {
      type: 'turnCompleted';
      status: 'completed' | 'failed' | 'interrupted';
      message?: string;
    }
  | { type: 'error'; message: string }
  | {
      type: 'unknown';
      rawType?: string;
      rpcMethod?: string;
      itemType?: string;
      keys?: string[];
    };

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
      diff: jsonString(jsonGet(change as any, 'diff')) ?? undefined,
    }))
    .filter((change) => change.path.length > 0);
}

function readTodoItems(item: unknown): TodoEntry[] {
  const items = jsonGet(item as any, 'items');
  if (!Array.isArray(items)) return [];
  return items
    .map((entry) => ({
      text: jsonString(jsonGet(entry as any, 'text')) ?? '',
      status:
        jsonString(jsonGet(entry as any, 'status')) === 'in_progress'
          ? 'inProgress' as const
          : jsonString(jsonGet(entry as any, 'status')) === 'completed' ||
              jsonGet(entry as any, 'completed') === true
            ? 'completed' as const
            : 'pending' as const,
    }))
    .filter((entry) => entry.text.length > 0);
}

function readAppServerThreadId(params: unknown): string | undefined {
  const thread = jsonGet(params as any, 'thread');
  return jsonString(jsonGet(thread as any, 'id')) ?? jsonString(jsonGet(params as any, 'threadId'));
}

function readAppServerItem(params: unknown): unknown {
  return jsonGet(params as any, 'item');
}

function readAppServerFileChanges(item: unknown): FileChangeEntry[] {
  const changes = jsonGet(item as any, 'changes');
  if (!Array.isArray(changes)) return [];
  return changes
    .map((change) => ({
      path: jsonString(jsonGet(change as any, 'path')) ?? '',
      kind: jsonString(jsonGet(change as any, 'kind')) ?? 'update',
      diff: jsonString(jsonGet(change as any, 'diff')) ?? undefined,
    }))
    .filter((change) => change.path.length > 0);
}

function readWebSearchInput(item: unknown): JSONValue {
  const action = jsonGet(item as any, 'action');
  const query =
    jsonString(jsonGet(item as any, 'query')) ??
    jsonString(jsonGet(action as any, 'query')) ??
    undefined;
  const queries = jsonGet(action as any, 'queries');
  return {
    ...(query ? { query } : {}),
    ...(Array.isArray(queries) ? { queries } : {}),
    ...(action && typeof action === 'object' && !Array.isArray(action) ? { action } : {}),
  } as JSONValue;
}

function readWebSearchLabel(item: unknown): string {
  const action = jsonGet(item as any, 'action');
  const actionType = jsonString(jsonGet(action as any, 'type'));
  if (actionType === 'openPage' || actionType === 'open_page') return 'WebOpen';
  if (actionType === 'findInPage' || actionType === 'find_in_page') return 'WebFind';
  return 'WebSearch';
}

function genericItemActivity(item: unknown, completed: boolean): CodexStreamEvent | undefined {
  const itemId = readItemId(item) ?? `activity-${Date.now().toString(36)}`;
  const itemType = readItemType(item);

  switch (itemType) {
    case 'webSearch':
      return {
        type: 'activity',
        activityId: itemId,
        name: readWebSearchLabel(item),
        input: readWebSearchInput(item),
        output: completed ? (jsonGet(item as any, 'action') ?? null) : undefined,
        completed,
      };
    case 'collabToolCall':
      return {
        type: 'activity',
        activityId: itemId,
        name: jsonString(jsonGet(item as any, 'tool')) ?? 'Collaboration',
        input: {
          prompt: jsonString(jsonGet(item as any, 'prompt')) ?? null,
          receiverThreadId: jsonString(jsonGet(item as any, 'receiverThreadId')) ?? null,
          newThreadId: jsonString(jsonGet(item as any, 'newThreadId')) ?? null,
        },
        output: completed ? (jsonGet(item as any, 'agentStatus') ?? null) : undefined,
        completed,
        isError: jsonString(jsonGet(item as any, 'status')) === 'failed',
      };
    case 'dynamicToolCall':
      return {
        type: 'activity',
        activityId: itemId,
        name: jsonString(jsonGet(item as any, 'tool')) ?? 'Tool',
        input: (jsonGet(item as any, 'arguments') ?? null) as JSONValue,
        output: completed
          ? ((jsonGet(item as any, 'contentItems') ??
              jsonGet(item as any, 'success') ??
              null) as JSONValue)
          : undefined,
        completed,
        isError: completed && jsonGet(item as any, 'success') === false,
      };
    case 'imageView':
      return {
        type: 'activity',
        activityId: itemId,
        name: 'ImageView',
        input: { path: jsonString(jsonGet(item as any, 'path')) ?? '' },
        output: completed ? null : undefined,
        completed,
      };
    case 'sleep':
      return {
        type: 'activity',
        activityId: itemId,
        name: 'Wait',
        input: { durationMs: jsonNumber(jsonGet(item as any, 'durationMs')) ?? 0 },
        output: completed ? null : undefined,
        completed,
      };
    case 'contextCompaction':
    case 'compacted':
      return {
        type: 'activity',
        activityId: itemId,
        name: 'Compaction',
        input: {},
        output: completed ? 'Context compacted' : undefined,
        completed,
      };
    case 'enteredReviewMode':
    case 'exitedReviewMode':
      return {
        type: 'activity',
        activityId: itemId,
        name: 'Review',
        input: {
          target:
            itemType === 'enteredReviewMode'
              ? (jsonString(jsonGet(item as any, 'review')) ?? '')
              : '',
        },
        output:
          completed && itemType === 'exitedReviewMode'
            ? (jsonString(jsonGet(item as any, 'review')) ?? null)
            : undefined,
        completed,
      };
    default:
      return undefined;
  }
}

function readAppServerMcpOutput(item: unknown): { output: string | null; isError: boolean } {
  const error = jsonGet(item as any, 'error');
  if (error) {
    return {
      output: jsonString(jsonGet(error as any, 'message')) ?? readMessage(error) ?? 'MCP tool error',
      isError: true,
    };
  }

  const result = jsonGet(item as any, 'result');
  const content = jsonGet(result as any, 'content');
  if (Array.isArray(content)) {
    const text = content
      .map((block) => {
        if (typeof block === 'string') return block;
        return (
          jsonString(jsonGet(block as any, 'text')) ??
          jsonString(jsonGet(block as any, 'content')) ??
          ''
        );
      })
      .filter((x) => x.length > 0)
      .join('\n');
    if (text) return { output: text, isError: false };
  }

  return { output: null, isError: false };
}

function parseCodexAppServerNotification(
  method: string,
  params: unknown
): { events: CodexStreamEvent[]; recognized: boolean } {
  const events: CodexStreamEvent[] = [];
  let recognized = true;

  switch (method) {
    case 'thread/started': {
      const threadId = readAppServerThreadId(params);
      if (threadId) events.push({ type: 'threadStarted', threadId });
      break;
    }
    case 'turn/started': {
      const turn = jsonGet(params as any, 'turn');
      events.push({
        type: 'turnStarted',
        turnId:
          jsonString(jsonGet(turn as any, 'id')) ??
          jsonString(jsonGet(params as any, 'turnId')),
      });
      break;
    }
    case 'item/agentMessage/delta': {
      const text = jsonString(jsonGet(params as any, 'delta'));
      if (text) events.push({ type: 'assistantDelta', text });
      break;
    }
    case 'item/reasoning/textDelta':
    case 'item/reasoning/summaryTextDelta': {
      const text = jsonString(jsonGet(params as any, 'delta'));
      if (text) events.push({ type: 'reasoning', text });
      break;
    }
    case 'item/reasoning/summaryPartAdded': {
      events.push({ type: 'reasoningBoundary' });
      break;
    }
    case 'turn/plan/updated': {
      const plan = jsonGet(params as any, 'plan');
      if (Array.isArray(plan)) {
        events.push({
          type: 'todoList',
          listId: jsonString(jsonGet(params as any, 'turnId')) ?? 'plan',
          items: plan
            .map((step): TodoEntry => {
              const rawStatus = jsonString(jsonGet(step as any, 'status'));
              return {
                text: jsonString(jsonGet(step as any, 'step')) ?? '',
                status:
                  rawStatus === 'completed'
                    ? 'completed'
                    : rawStatus === 'inProgress'
                      ? 'inProgress'
                      : 'pending',
              };
            })
            .filter((step) => step.text.length > 0),
        });
      }
      break;
    }
    case 'item/started': {
      const item = readAppServerItem(params);
      switch (readItemType(item)) {
        case 'commandExecution': {
          const command = jsonString(jsonGet(item as any, 'command'));
          if (command) {
            events.push({
              type: 'commandBegin',
              commandId: readItemId(item) ?? `cmd-${Date.now().toString(36)}`,
              command,
              cwd: jsonString(jsonGet(item as any, 'cwd')) ?? undefined,
            });
          }
          break;
        }
        case 'fileChange': {
          events.push({
            type: 'fileChangeBegin',
            changeId: readItemId(item) ?? `patch-${Date.now().toString(36)}`,
            files: readAppServerFileChanges(item),
          });
          break;
        }
        case 'mcpToolCall': {
          events.push({
            type: 'mcpToolBegin',
            callId: readItemId(item) ?? `mcp-${Date.now().toString(36)}`,
            server: jsonString(jsonGet(item as any, 'server')) ?? '',
            tool: jsonString(jsonGet(item as any, 'tool')) ?? 'tool',
            args: jsonGet(item as any, 'arguments') ?? null,
          });
          break;
        }
        default: {
          const activity = genericItemActivity(item, false);
          if (activity) events.push(activity);
          else recognized = false;
        }
      }
      break;
    }
    case 'item/commandExecution/outputDelta': {
      const commandId = jsonString(jsonGet(params as any, 'itemId'));
      const delta = jsonString(jsonGet(params as any, 'delta'));
      if (commandId && delta) events.push({ type: 'commandOutput', commandId, delta });
      break;
    }
    case 'item/completed': {
      const item = readAppServerItem(params);
      switch (readItemType(item)) {
        case 'commandExecution': {
          events.push({
            type: 'commandEnd',
            commandId: readItemId(item) ?? `cmd-${Date.now().toString(36)}`,
            command: jsonString(jsonGet(item as any, 'command')) ?? 'command',
            output: jsonString(jsonGet(item as any, 'aggregatedOutput')) ?? null,
            exitCode: jsonNumber(jsonGet(item as any, 'exitCode')),
            status: jsonString(jsonGet(item as any, 'status')) ?? undefined,
            durationMs: jsonNumber(jsonGet(item as any, 'durationMs')),
          });
          break;
        }
        case 'fileChange': {
          events.push({
            type: 'fileChange',
            changeId: readItemId(item) ?? `patch-${Date.now().toString(36)}`,
            files: readAppServerFileChanges(item),
            status: jsonString(jsonGet(item as any, 'status')) ?? 'completed',
          });
          break;
        }
        case 'mcpToolCall': {
          const { output, isError } = readAppServerMcpOutput(item);
          events.push({
            type: 'mcpToolEnd',
            callId: readItemId(item) ?? `mcp-${Date.now().toString(36)}`,
            server: jsonString(jsonGet(item as any, 'server')) ?? '',
            tool: jsonString(jsonGet(item as any, 'tool')) ?? 'tool',
            output,
            isError,
          });
          break;
        }
        default: {
          const activity = genericItemActivity(item, true);
          if (activity) events.push(activity);
          else recognized = false;
        }
      }
      break;
    }
    case 'turn/diff/updated': {
      const turnId = jsonString(jsonGet(params as any, 'turnId')) ?? 'turn';
      const diff = jsonString(jsonGet(params as any, 'diff'));
      if (diff) {
        events.push({
          type: 'activity',
          activityId: `turn-diff-${turnId}`,
          name: 'Diff',
          input: { turnId },
          output: diff,
          completed: true,
        });
      }
      break;
    }
    case 'model/rerouted': {
      events.push({
        type: 'activity',
        activityId: `model-reroute-${jsonString(jsonGet(params as any, 'turnId')) ?? 'turn'}`,
        name: 'Model',
        input: {
          from: jsonString(jsonGet(params as any, 'fromModel')) ?? '',
          to: jsonString(jsonGet(params as any, 'toModel')) ?? '',
        },
        output: jsonString(jsonGet(params as any, 'reason')) ?? null,
        completed: true,
      });
      break;
    }
    case 'warning':
    case 'configWarning': {
      const message =
        jsonString(jsonGet(params as any, 'message')) ??
        jsonString(jsonGet(params as any, 'summary')) ??
        'Codex warning';
      events.push({
        type: 'activity',
        activityId: `warning-${Date.now().toString(36)}`,
        name: 'Warning',
        input: {},
        output: message,
        completed: true,
        isError: true,
      });
      break;
    }
    case 'turn/completed': {
      const turn = jsonGet(params as any, 'turn');
      const rawStatus = jsonString(jsonGet(turn as any, 'status'));
      const status =
        rawStatus === 'failed'
          ? 'failed'
          : rawStatus === 'interrupted'
            ? 'interrupted'
            : 'completed';
      const error = jsonGet(turn as any, 'error');
      events.push({
        type: 'turnCompleted',
        status,
        message: readMessage(error),
      });
      break;
    }
    case 'error': {
      if (jsonGet(params as any, 'willRetry') === true) break;
      const error = jsonGet(params as any, 'error');
      events.push({
        type: 'error',
        message: readMessage(error) ?? 'Codex app-server turn failed',
      });
      break;
    }
    case 'thread/tokenUsage/updated':
    case 'thread/status/changed':
    case 'item/plan/delta':
      // Known protocol state that is either represented by a richer event or
      // intentionally not persisted in the chat transcript.
      break;
    default:
      recognized = false;
      break;
  }

  return { events, recognized };
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
  if (typeof json.method === 'string') {
    const { events, recognized } = parseCodexAppServerNotification(json.method, json.params);
    if (events.length > 0) return events;
    if (recognized) return [];
    const params =
      json.params && typeof json.params === 'object' && !Array.isArray(json.params)
        ? json.params
        : undefined;
    const item = params ? jsonGet(params, 'item') : undefined;
    return [{
      type: 'unknown',
      rpcMethod: json.method,
      itemType:
        item && typeof item === 'object' && !Array.isArray(item)
          ? readItemType(item)
          : undefined,
      // Field names are enough to evolve the parser without logging prompts,
      // tool arguments, command output, or other potentially sensitive values.
      keys: params ? Object.keys(params).slice(0, 12) : [],
    }];
  }
  if ('id' in json && ('result' in json || 'error' in json)) {
    return [];
  }

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
              cwd: jsonString(jsonGet(item, 'cwd')) ?? undefined,
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
            status: jsonString(jsonGet(item, 'status')) ?? undefined,
            durationMs: jsonNumber(jsonGet(item, 'duration_ms')),
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
          events.push({
            type: 'activity',
            activityId: readItemId(item) ?? `web-${Date.now().toString(36)}`,
            name: 'WebSearch',
            input: query ? { query } : {},
            output: jsonGet(item, 'action') ?? null,
            completed: true,
          });
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
      events.push({ type: 'turnCompleted', status: 'completed' });
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
    default: {
      const item = jsonGet(json, 'item');
      events.push({
        type: 'unknown',
        rawType: type || undefined,
        itemType: item && typeof item === 'object' && !Array.isArray(item)
          ? readItemType(item)
          : undefined,
        keys: Object.keys(json).slice(0, 12),
      });
    }
  }

  return events;
}
