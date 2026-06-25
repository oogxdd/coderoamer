import { jsonGet, jsonString } from './claude-events';


/**
 * Crush (charm.land) chat provider.
 *
 * Unlike Claude (`--output-format stream-json`) and Codex (`--json`), Crush's
 * non-interactive `crush run` mode emits the assistant's final answer as plain
 * text on stdout — there is no per-event streaming JSON envelope. So the live
 * stream model is intentionally minimal: each stdout chunk becomes an
 * `assistantDelta`. Tool calls and reasoning happen inside the Crush process and
 * are only recoverable afterwards from the on-disk transcript
 * (`crush session show <id> --json`), which is what `crush-sessions.ts` reads.
 */
export type CrushStreamEvent =
  | { type: 'assistantDelta'; text: string }
  | { type: 'unknown' };

// MARK: - On-disk transcript types (`crush session show <id> --json`)

export interface CrushTranscriptMeta {
  id: string;
  uuid?: string;
  title?: string;
  created?: string;
  modified?: string;
}

/**
 * A single part of a Crush transcript message. Crush serialises each message as
 * typed `parts` (text / reasoning / tool_call / tool_result / finish). We model
 * it as a flat interface with optional fields rather than a discriminated union
 * so callers can read fields directly without per-case casts, and so unknown
 * part shapes (forward compatibility) don't break parsing.
 */
export interface CrushPart {
  type: string;
  text?: string;
  thinking?: string;
  tool_call_id?: string;
  name?: string;
  /** Crush serialises tool input as a JSON string. */
  input?: string;
  content?: string;
  reason?: string;
}

export interface CrushTranscriptMessage {
  id: string;
  role: string;
  created?: string;
  model?: string;
  provider?: string;
  parts: CrushPart[];
}

export interface CrushTranscript {
  meta: CrushTranscriptMeta;
  messages: CrushTranscriptMessage[];
}

/** Parse the JSON document printed by `crush session show <id> --json`. */
export function parseCrushTranscript(raw: string): CrushTranscript | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  try {
    const parsed = JSON.parse(trimmed);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    const obj = parsed as Record<string, unknown>;
    if (!obj.meta || typeof obj.meta !== 'object') return null;
    if (!Array.isArray(obj.messages)) return null;
    return parsed as CrushTranscript;
  } catch {
    return null;
  }
}

export function crushMetaId(value: unknown): string | undefined {
  return jsonString(jsonGet(value, 'id'));
}
