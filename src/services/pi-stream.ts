import { PiStreamEvent, parsePiEvent } from '@/models/pi-events';

/**
 * Line-buffered NDJSON parser for `pi --mode json` events. Mirrors
 * CodexStreamParser: tolerates non-JSON noise from wrappers, flushes a
 * trailing partial line on exit.
 */
export class PiStreamParser {
  private buffer = '';

  parse(text: string): PiStreamEvent[] {
    this.buffer += text;
    const events: PiStreamEvent[] = [];

    while (true) {
      const newlineIndex = this.buffer.indexOf('\n');
      if (newlineIndex === -1) break;

      const line = this.buffer.slice(0, newlineIndex);
      this.buffer = this.buffer.slice(newlineIndex + 1);

      if (!line.trim()) continue;

      try {
        const json = JSON.parse(line);
        const event = parsePiEvent(json);
        if (event) events.push(event);
      } catch {
        // Ignore non-JSON lines written by wrappers or shell.
      }
    }

    return events;
  }

  flush(): PiStreamEvent[] {
    if (!this.buffer.trim()) {
      this.buffer = '';
      return [];
    }

    const remaining = this.buffer;
    this.buffer = '';

    try {
      const json = JSON.parse(remaining);
      const event = parsePiEvent(json);
      return event ? [event] : [];
    } catch {
      return [];
    }
  }

  reset(): void {
    this.buffer = '';
  }
}
