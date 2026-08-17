/**
 * Shared contract for the two on-disk transcript scanners (`claude-sessions.ts`
 * and `codex-sessions.ts`).
 *
 * A full scan is expensive: the sprite-side script has to read *and* JSON-parse
 * every line of every transcript just to recover the first prompt and the line
 * count. Stores grow monotonically, so re-deriving that for a hundred old
 * sessions on every visit is pure waste — the transcripts didn't change.
 *
 * So a scan takes a **cursor**: transcripts whose mtime is at or below it are
 * reported as a bare `{id, modified, live}` heartbeat and never opened, and the
 * caller fills the detail back in from its own cache. `live` and `modified` are
 * always fresh (both come from a `stat` plus the `/proc` sweep), so a cached row
 * never shows a stale running/finished state.
 *
 * The cursor is the sprite's own clock at scan start, not the phone's: it is
 * only ever compared against mtimes produced on that same machine, so clock
 * skew between phone and sprite can't make the scan skip a changed file.
 */

export interface ScannedSessionDetail {
  /** Working directory recorded in the transcript (resume must reuse it). */
  cwd?: string;
  /** First user prompt, trimmed — the list preview. */
  preview: string;
  /** Number of transcript lines (rough activity indicator). */
  messageCount: number;
}

export interface ScannedSession {
  id: string;
  /** Transcript mtime in ms since epoch (sprite clock). */
  modified: number;
  /** True when the CLI session is (likely) still running. */
  live: boolean;
  /**
   * Present when the transcript was read this scan — i.e. it changed after the
   * cursor, or the scan was a full one. Absent means "unchanged, reuse cache".
   */
  detail?: ScannedSessionDetail;
}

export interface SessionScanResult {
  /**
   * Sprite-side wall clock when the scan started. Pass it back as the next
   * scan's cursor; anything modified from this instant on is re-read.
   */
  cursor: number;
  /** Every transcript in the store — the authoritative id set for pruning. */
  entries: ScannedSession[];
}

/** Wraps a Node script in a quoted heredoc so quotes inside need no escaping. */
export function heredoc(script: string): string {
  return `node <<'WISP_NODE_EOF'\n${script}\nWISP_NODE_EOF\n`;
}

/** Pull the payload out of the sentinel markers, tolerating shell noise. */
export function extractSentinel(output: string): string | null {
  const start = output.indexOf('@@WISP@@');
  if (start === -1) return null;
  const end = output.indexOf('@@WISP@@', start + 8);
  if (end === -1) return null;
  return output.slice(start + 8, end);
}

/**
 * Parse the `{cursor, sessions:[…]}` envelope both scan scripts emit. Entries
 * that carry no `preview`/`messageCount` fields are unchanged-since-cursor
 * heartbeats and come back without `detail`.
 */
export function parseScanPayload(payload: string): SessionScanResult {
  const parsed = JSON.parse(payload);
  if (!parsed || typeof parsed !== 'object') throw new Error('Expected an object');
  const rawEntries = Array.isArray(parsed.sessions) ? parsed.sessions : [];
  const entries: ScannedSession[] = [];

  for (const raw of rawEntries) {
    if (!raw || typeof raw.id !== 'string' || !raw.id) continue;
    const entry: ScannedSession = {
      id: raw.id,
      modified: Number(raw.modified) || 0,
      live: !!raw.live,
    };
    if (!raw.stale) {
      entry.detail = {
        cwd: typeof raw.cwd === 'string' && raw.cwd ? raw.cwd : undefined,
        preview: typeof raw.preview === 'string' ? raw.preview.trim() : '',
        messageCount: Number(raw.messageCount) || 0,
      };
    }
    entries.push(entry);
  }

  return { cursor: Number(parsed.cursor) || 0, entries };
}

/** Detail-only view of a scan — what a full scan (`since = 0`) always yields. */
export function scannedSessionsWithDetail(
  result: SessionScanResult
): (ScannedSessionDetail & { id: string; modified: number; live: boolean })[] {
  return result.entries
    .filter((entry) => !!entry.detail)
    .map((entry) => ({
      id: entry.id,
      modified: entry.modified,
      live: entry.live,
      cwd: entry.detail!.cwd,
      preview: entry.detail!.preview,
      messageCount: entry.detail!.messageCount,
    }));
}
