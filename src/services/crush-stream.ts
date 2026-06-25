import { CrushStreamEvent } from '@/models/crush-events';

/**
 * Line-buffered parser for `crush run` stdout.
 *
 * Crush's non-interactive mode prints the assistant's answer as plain text (no
 * NDJSON event envelopes), so unlike the Claude/Codex parsers this does not
 * JSON-parse each line — it simply re-emits every line as an `assistantDelta`,
 * preserving newlines so multi-line / markdown answers render correctly.
 */
export class CrushStreamParser {
  private buffer = '';

  parse(text: string): CrushStreamEvent[] {
    this.buffer += text;
    const events: CrushStreamEvent[] = [];

    while (true) {
      const newlineIndex = this.buffer.indexOf('\n');
      if (newlineIndex === -1) break;

      const line = this.buffer.slice(0, newlineIndex);
      this.buffer = this.buffer.slice(newlineIndex + 1);

      // Preserve blank lines (they carry formatting in markdown answers).
      events.push({ type: 'assistantDelta', text: `${line}\n` });
    }

    return events;
  }

  flush(): CrushStreamEvent[] {
    if (!this.buffer) {
      return [];
    }

    const remaining = this.buffer;
    this.buffer = '';
    return [{ type: 'assistantDelta', text: remaining }];
  }

  reset(): void {
    this.buffer = '';
  }
}
