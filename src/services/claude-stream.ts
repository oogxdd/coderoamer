import { ClaudeStreamEvent, parseClaudeEvent } from '@/models/claude-events';

/**
 * Line-buffered NDJSON parser for Claude stream events.
 * Mirrors the Swift ClaudeStreamParser actor.
 */
export class ClaudeStreamParser {
  private buffer = '';

  parse(text: string): ClaudeStreamEvent[] {
    this.buffer += text;
    const events: ClaudeStreamEvent[] = [];

    while (true) {
      const newlineIndex = this.buffer.indexOf('\n');
      if (newlineIndex === -1) break;

      const line = this.buffer.slice(0, newlineIndex);
      this.buffer = this.buffer.slice(newlineIndex + 1);

      if (!line.trim()) continue;

      try {
        const json = JSON.parse(line);
        const event = parseClaudeEvent(json);
        if (event) events.push(event);
      } catch {
        // Skip unparseable lines (forward compatibility)
      }
    }

    return events;
  }

  flush(): ClaudeStreamEvent[] {
    if (!this.buffer.trim()) {
      this.buffer = '';
      return [];
    }

    const remaining = this.buffer;
    this.buffer = '';

    try {
      const json = JSON.parse(remaining);
      const event = parseClaudeEvent(json);
      return event ? [event] : [];
    } catch {
      return [];
    }
  }

  reset(): void {
    this.buffer = '';
  }
}

/**
 * Strip log timestamps that the service logs endpoint prefixes to each line.
 * Format: "2026-02-19T09:13:24.665Z [stdout] {...}"
 */
export function stripLogTimestamps(text: string): string {
  // Match ISO timestamp + [stdout]/[stderr] prefix
  return text.replace(
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z?\s*\[(?:stdout|stderr)\]\s*/gm,
    ''
  );
}
