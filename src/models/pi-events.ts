import { JSONValue, jsonGet, jsonString } from './claude-events';

/**
 * Events from the pi coding agent's `--mode json` stream.
 *
 * pi prints JSONL to stdout: a session header first, then agent lifecycle
 * events (see pi's docs/json.md). The mapping below keeps the same shape as
 * the Claude/Codex event models so `useChat` can treat providers uniformly:
 *
 * - `session` header            → `sessionStarted` (the id is what
 *                                 `pi --session <id>` resumes)
 * - `message_update` deltas     → `assistantDelta` / `reasoningDelta`
 *                                 (token-level preview, replaced by the
 *                                 authoritative `message_end`)
 * - `message_end` (assistant)   → `assistantMessage` (final content blocks)
 * - `tool_execution_end`        → `toolResult` (result attaches to its card)
 * - `agent_end`                 → `turnCompleted` (terminal — the last
 *                                 assistant message's stopReason decides the
 *                                 outcome)
 */

export interface PiAssistantMessage {
  role: 'assistant';
  content: PiContentBlock[];
  provider?: string;
  model?: string;
  stopReason?: string;
  errorMessage?: string;
}

export type PiContentBlock =
  | { type: 'text'; text: string }
  | { type: 'thinking'; thinking: string }
  | { type: 'toolCall'; id: string; name: string; arguments: JSONValue }
  | { type: string };

export type PiStreamEvent =
  | { type: 'sessionStarted'; sessionId: string; cwd?: string }
  | { type: 'assistantDelta'; text: string; contentIndex: number }
  | { type: 'reasoningDelta'; text: string; contentIndex: number }
  | { type: 'assistantMessage'; message: PiAssistantMessage }
  | {
      type: 'toolResult';
      toolCallId: string;
      toolName: string;
      content: JSONValue;
      isError: boolean;
    }
  | {
      type: 'turnCompleted';
      status: 'success' | 'error' | 'interrupted';
      message?: string;
    }
  | { type: 'unknown'; rawType?: string };

function readAssistantMessage(value: unknown): PiAssistantMessage | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const message = jsonGet(value as Record<string, JSONValue>, 'message');
  if (!message || typeof message !== 'object' || Array.isArray(message)) return undefined;
  const role = jsonString(jsonGet(message as Record<string, JSONValue>, 'role'));
  if (role !== 'assistant') return undefined;
  return message as unknown as PiAssistantMessage;
}

/** Terminal outcome derived from an `agent_end` message list. */
function outcomeFromAgentEnd(json: Record<string, JSONValue>): PiStreamEvent {
  const messages = jsonGet(json, 'messages');
  let last: unknown;
  if (Array.isArray(messages)) {
    for (let i = messages.length - 1; i >= 0; i--) {
      const candidate = messages[i];
      if (
        candidate &&
        typeof candidate === 'object' &&
        !Array.isArray(candidate) &&
        jsonString(jsonGet(candidate as Record<string, JSONValue>, 'role')) === 'assistant'
      ) {
        last = candidate;
        break;
      }
    }
  }
  if (last) {
    const record = last as Record<string, JSONValue>;
    const stopReason = jsonString(jsonGet(record, 'stopReason'));
    const errorMessage = jsonString(jsonGet(record, 'errorMessage'));
    if (stopReason === 'error') {
      return { type: 'turnCompleted', status: 'error', message: errorMessage };
    }
    if (stopReason === 'aborted') {
      return { type: 'turnCompleted', status: 'interrupted', message: errorMessage };
    }
  }
  return { type: 'turnCompleted', status: 'success' };
}

export function parsePiEvent(json: any): PiStreamEvent | null {
  if (!json || typeof json !== 'object') return null;
  const type = json.type;

  switch (type) {
    case 'session': {
      const sessionId = jsonString(jsonGet(json, 'id'));
      if (!sessionId) return { type: 'unknown', rawType: 'session' };
      return {
        type: 'sessionStarted',
        sessionId,
        cwd: jsonString(jsonGet(json, 'cwd')),
      };
    }
    case 'message_update': {
      const event = jsonGet(json, 'assistantMessageEvent');
      if (!event || typeof event !== 'object') return { type: 'unknown', rawType: type };
      const inner = event as Record<string, JSONValue>;
      const innerType = jsonString(jsonGet(inner, 'type'));
      const contentIndex = jsonGet(inner, 'contentIndex');
      const index = typeof contentIndex === 'number' ? contentIndex : 0;
      if (innerType === 'text_delta') {
        const delta = jsonString(jsonGet(inner, 'delta'));
        if (delta) return { type: 'assistantDelta', text: delta, contentIndex: index };
        return null;
      }
      if (innerType === 'thinking_delta') {
        const delta = jsonString(jsonGet(inner, 'delta'));
        if (delta) return { type: 'reasoningDelta', text: delta, contentIndex: index };
        return null;
      }
      // toolcall deltas (JSON argument fragments) are intentionally ignored —
      // the complete toolCall arrives on the next assistant message_end.
      return null;
    }
    case 'message_end': {
      const message = readAssistantMessage(json);
      if (message) return { type: 'assistantMessage', message };
      // user / toolResult message_ends duplicate events we already render.
      return null;
    }
    case 'tool_execution_end': {
      const toolCallId = jsonString(jsonGet(json, 'toolCallId'));
      if (!toolCallId) return { type: 'unknown', rawType: type };
      return {
        type: 'toolResult',
        toolCallId,
        toolName: jsonString(jsonGet(json, 'toolName')) ?? 'Unknown',
        content: (jsonGet(json, 'result') ?? null) as JSONValue,
        isError: jsonGet(json, 'isError') === true,
      };
    }
    case 'agent_end':
      return outcomeFromAgentEnd(json);
    default:
      return { type: 'unknown', rawType: typeof type === 'string' ? type : undefined };
  }
}
