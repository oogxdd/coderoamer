import { ChatContent, ChatMessage, ToolResultCard, ToolUseCard, makeId } from '@/models/chat';
import { JSONValue } from '@/models/claude-events';
import {
  CrushTranscript,
  crushMetaId,
  parseCrushTranscript,
} from '@/models/crush-events';
import { runExec } from './api';

/**
 * Reads Crush's own session transcripts from a sprite. Crush stores sessions in
 * its data dir and exposes them through `crush session show <id> --json`, which
 * prints `{meta, messages}` where each message has typed `parts`
 * (text / reasoning / tool_call / tool_result). That is the same history
 * `crush run --session <id>` continues.
 *
 * Because the transcript lives in Crush's backend (not ephemeral process state)
 * it survives the app being closed or a process restart — letting the app
 * recover Crush turns (including tool calls and reasoning that the plain-text
 * `crush run` stdout never surfaces live) the same way it recovers
 * Claude/Codex transcripts.
 */

const SESSION_ID_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]{2,200}$/;

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

/** Safely build `crush session <sub> --json --cwd <wd>` for runExec. */
function crushSessionCommand(sub: string, workingDirectory: string, sessionId?: string): string {
  const parts = ['crush', 'session', sub];
  if (sessionId) parts.push(shellQuote(sessionId));
  parts.push('--json');
  parts.push('--cwd', shellQuote(workingDirectory));
  return parts.join(' ');
}

/** Run `crush session last --json --cwd <wd>` and return the most-recent session id. */
export async function readCrushLastSessionId(
  spriteName: string,
  workingDirectory: string
): Promise<string | undefined> {
  const { output } = await runExec(
    spriteName,
    crushSessionCommand('last', workingDirectory),
    25
  );
  const transcript = parseCrushTranscript(output);
  return transcript ? crushMetaId(transcript.meta) : undefined;
}

// MARK: - Transcript -> ChatMessage rendering

function parseToolInput(raw: unknown): JSONValue {
  if (typeof raw !== 'string') return raw as JSONValue;
  try {
    return JSON.parse(raw) as JSONValue;
  } catch {
    return raw as JSONValue;
  }
}

/** Friendly tool name for a card, mapping Crush's lowercase tool names. */
function toolDisplayName(name: string): string {
  switch (name) {
    case 'bash':
      return 'Bash';
    case 'edit':
    case 'write':
    case 'multiedit':
      return 'Edit';
    case 'view':
    case 'read':
      return 'View';
    case 'grep':
      return 'Grep';
    case 'glob':
      return 'Glob';
    case 'web_search':
    case 'webfetch':
      return 'WebSearch';
    default:
      return name.charAt(0).toUpperCase() + name.slice(1);
  }
}

/** First file path inside a parsed tool input, for the Edit card summary. */
function filePathFromInput(input: JSONValue): string | undefined {
  if (input && typeof input === 'object' && !Array.isArray(input)) {
    const fp = (input as Record<string, unknown>).file_path;
    if (typeof fp === 'string') return fp;
    const path = (input as Record<string, unknown>).path;
    if (typeof path === 'string') return path;
  }
  return undefined;
}

/**
 * Convert a Crush transcript into the app's ChatMessage[] so the existing chat
 * UI renders it natively. Mirrors the live `handleCrushEvent` path, but also
 * recovers tool calls / reasoning / tool results that the plain-text
 * `crush run` stdout omits.
 */
export function crushTranscriptToMessages(transcript: CrushTranscript): ChatMessage[] {
  const messages: ChatMessage[] = [];
  const toolUseLocation = new Map<string, number>();
  let currentAssistantIndex: number | null = null;

  const ensureAssistant = (timestamp: number): number => {
    if (currentAssistantIndex !== null) return currentAssistantIndex;
    messages.push({ id: makeId(), timestamp, role: 'assistant', content: [] });
    currentAssistantIndex = messages.length - 1;
    return currentAssistantIndex;
  };

  const appendAssistantText = (idx: number, text: string) => {
    const next = [...messages[idx].content];
    const last = next[next.length - 1];
    if (last && last.type === 'text') {
      next[next.length - 1] = { type: 'text', text: `${last.text}${text}` };
    } else {
      next.push({ type: 'text', text });
    }
    messages[idx] = { ...messages[idx], content: next };
  };

  const attachResult = (callId: string, content: JSONValue, ts: number) => {
    const idx = toolUseLocation.get(callId);
    if (idx === undefined) return;
    const msg = messages[idx];
    let toolName = 'Tool';
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

  for (const msg of transcript.messages) {
    const ts = (msg.created && Date.parse(msg.created)) || Date.now();

    if (msg.role === 'user') {
      const text = msg.parts
        .filter((p) => p.type === 'text')
        .map((p) => p.text ?? '')
        .join('\n')
        .trim();
      if (!text) continue;
      messages.push({ id: makeId(), timestamp: ts, role: 'user', content: [{ type: 'text', text }] });
      currentAssistantIndex = null;
      continue;
    }

    if (msg.role === 'tool') {
      for (const part of msg.parts) {
        if (part.type === 'tool_result' && part.tool_call_id) {
          attachResult(part.tool_call_id, part.content ?? null, ts);
        }
      }
      continue;
    }

    // assistant (and any unknown role with parts) -> assistant bubble
    ensureAssistant(ts);
    for (const part of msg.parts) {
      switch (part.type) {
        case 'text': {
          if (part.text) appendAssistantText(currentAssistantIndex!, part.text);
          break;
        }
        case 'reasoning': {
          if (part.thinking) {
            const idx = currentAssistantIndex!;
            messages[idx] = {
              ...messages[idx],
              content: [...messages[idx].content, { type: 'reasoning', text: part.thinking }],
            };
          }
          break;
        }
        case 'tool_call': {
          const callId = part.tool_call_id;
          if (!callId) break;
          const displayName = toolDisplayName(part.name || 'tool');
          const input = parseToolInput(part.input);
          const card: ToolUseCard = {
            toolUseId: callId,
            toolName: displayName,
            input: displayName === 'Edit' || displayName === 'View'
              ? { file_path: filePathFromInput(input) ?? '', ...(input as object) }
              : input,
            startedAt: ts,
          };
          const idx = currentAssistantIndex!;
          messages[idx] = {
            ...messages[idx],
            content: [...messages[idx].content, { type: 'toolUse', card }],
          };
          toolUseLocation.set(callId, idx);
          break;
        }
        default:
          break;
      }
    }
  }

  return messages;
}

export async function readCrushSessionMessages(
  spriteName: string,
  sessionId: string,
  workingDirectory: string
): Promise<ChatMessage[]> {
  if (!SESSION_ID_RE.test(sessionId)) {
    throw new Error('Invalid session id');
  }
  const { output } = await runExec(
    spriteName,
    crushSessionCommand('show', workingDirectory, sessionId),
    25
  );
  const transcript = parseCrushTranscript(output);
  if (!transcript) return [];
  return crushTranscriptToMessages(transcript);
}
