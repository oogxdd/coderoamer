// Arbitrary JSON value type
export type JSONValue =
  | string
  | number
  | boolean
  | null
  | JSONValue[]
  | { [key: string]: JSONValue };

export function jsonString(val: JSONValue | undefined): string | undefined {
  if (typeof val === 'string') return val;
  return undefined;
}

export function jsonNumber(val: JSONValue | undefined): number | undefined {
  if (typeof val === 'number') return val;
  return undefined;
}

export function jsonGet(val: JSONValue | undefined, key: string): JSONValue | undefined {
  if (val && typeof val === 'object' && !Array.isArray(val)) {
    return (val as Record<string, JSONValue>)[key];
  }
  return undefined;
}

export function jsonPretty(val: JSONValue | undefined): string {
  if (val === undefined || val === null) return 'null';
  if (typeof val === 'string') return val;
  if (typeof val === 'number') {
    if (val === Math.floor(val) && val < 1e15) return String(Math.floor(val));
    return String(val);
  }
  if (typeof val === 'boolean') return val ? 'true' : 'false';
  return JSON.stringify(val, null, 2);
}

// Claude stream event types

export type ClaudeStreamEvent =
  | { type: 'system'; event: ClaudeSystemEvent; uuid?: string }
  | { type: 'assistant'; event: ClaudeAssistantEvent; uuid?: string }
  | { type: 'user'; event: ClaudeToolResultEvent; uuid?: string }
  | { type: 'result'; event: ClaudeResultEvent; uuid?: string }
  | { type: 'streamEvent'; event: ClaudePartialStreamEvent; uuid?: string }
  | { type: 'unknown'; uuid?: string };

/**
 * A `stream_event` line emitted with `--include-partial-messages`: the raw
 * Anthropic streaming envelope (message_start / content_block_start /
 * content_block_delta / ... / message_stop). Text and thinking deltas render
 * token-by-token; the complete `assistant` event that follows each API message
 * remains the authoritative content.
 */
export interface ClaudePartialStreamEvent {
  type: 'stream_event';
  session_id?: string;
  event?: {
    type?: string;
    index?: number;
    delta?: {
      type?: string;
      text?: string;
      thinking?: string;
      partial_json?: string;
    };
    content_block?: { type?: string };
  };
  uuid?: string;
}

export interface ClaudeSystemEvent {
  type: 'system';
  session_id: string;
  model?: string;
  tools?: string[];
  cwd?: string;
  uuid?: string;
}

export interface ClaudeAssistantEvent {
  type: 'assistant';
  message: {
    role: string;
    content: ClaudeContentBlock[];
  };
  uuid?: string;
}

export type ClaudeContentBlock =
  | { type: 'text'; text: string }
  | { type: 'thinking'; thinking: string; signature?: string }
  | { type: 'redacted_thinking'; data?: string }
  | { type: 'tool_use'; id: string; name: string; input: JSONValue }
  | { type: string }; // unknown

export interface ClaudeToolResultEvent {
  type: 'user';
  message: {
    role: string;
    content: ClaudeToolResult[];
  };
  uuid?: string;
}

export interface ClaudeToolResult {
  type: string;
  tool_use_id: string;
  content?: JSONValue;
}

export interface ClaudeResultEvent {
  type: 'result';
  subtype?: string;
  session_id: string;
  is_error?: boolean;
  duration_ms?: number;
  num_turns?: number;
  result?: string;
  uuid?: string;
}

export function parseClaudeEvent(json: any): ClaudeStreamEvent | null {
  try {
    const type = json.type;
    const uuid = json.uuid;
    switch (type) {
      case 'system':
        return { type: 'system', event: json as ClaudeSystemEvent, uuid };
      case 'assistant':
        return { type: 'assistant', event: json as ClaudeAssistantEvent, uuid };
      case 'user':
        return { type: 'user', event: json as ClaudeToolResultEvent, uuid };
      case 'result':
        return { type: 'result', event: json as ClaudeResultEvent, uuid };
      case 'stream_event':
        return { type: 'streamEvent', event: json as ClaudePartialStreamEvent, uuid };
      default:
        return { type: 'unknown', uuid };
    }
  } catch {
    return null;
  }
}
