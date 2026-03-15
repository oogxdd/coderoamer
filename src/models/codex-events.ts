import { jsonGet, jsonNumber, jsonString } from './claude-events';

export type CodexStreamEvent =
  | { type: 'threadStarted'; threadId: string }
  | { type: 'assistantDelta'; text: string }
  | { type: 'commandBegin'; commandId: string; command: string }
  | { type: 'commandEnd'; commandId: string; command: string; output: string | null; exitCode?: number }
  | { type: 'turnCompleted'; model?: string; text?: string }
  | { type: 'error'; message: string }
  | { type: 'unknown' };

function readCommandId(value: unknown): string | undefined {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const id =
      jsonString(jsonGet(value as any, 'id')) ??
      jsonString(jsonGet(value as any, 'command_id')) ??
      jsonString(jsonGet(value as any, 'tool_call_id')) ??
      jsonString(jsonGet(value as any, 'call_id'));
    return id;
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
      const itemType = readMessage(jsonGet(item, 'type'));
      if (itemType === 'command_execution' || itemType === 'command') {
        const command = readCommand(item);
        if (command) {
          events.push({
            type: 'commandBegin',
            commandId: readCommandId(item) ?? `cmd-${Date.now().toString(36)}`,
            command,
          });
        }
      }
      break;
    }
    case 'item.completed': {
      const item = json.item;
      const itemType = readMessage(jsonGet(item, 'type'));
      if (itemType === 'agent_message') {
        const text = readAgentMessageText(item);
        if (text) events.push({ type: 'assistantDelta', text });
      } else if (itemType === 'command_execution' || itemType === 'command') {
        events.push({
          type: 'commandEnd',
          commandId: readCommandId(item) ?? `cmd-${Date.now().toString(36)}`,
          command: readCommand(item) ?? 'command',
          output: readOutput(item),
          exitCode: jsonNumber(jsonGet(item, 'exit_code')),
        });
      }
      break;
    }
    case 'exec.agent_message_delta': {
      const text = readMessage(json.delta) ?? readMessage(json.text);
      if (text) events.push({ type: 'assistantDelta', text });
      break;
    }
    case 'exec.command_begin': {
      const command = readCommand(json);
      if (command) {
        events.push({
          type: 'commandBegin',
          commandId: readCommandId(json) ?? `cmd-${Date.now().toString(36)}`,
          command,
        });
      }
      break;
    }
    case 'exec.command_end': {
      events.push({
        type: 'commandEnd',
        commandId: readCommandId(json) ?? `cmd-${Date.now().toString(36)}`,
        command: readCommand(json) ?? 'command',
        output: readOutput(json),
        exitCode: jsonNumber(jsonGet(json, 'exit_code')),
      });
      break;
    }
    case 'turn.completed': {
      const text =
        readMessage(json.result) ??
        readMessage(json.output_text) ??
        readMessage(json.output) ??
        undefined;
      events.push({
        type: 'turnCompleted',
        model: readMessage(json.model),
        text,
      });
      break;
    }
    case 'error':
    case 'turn.failed':
    case 'exec.error':
    case 'response.error': {
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
