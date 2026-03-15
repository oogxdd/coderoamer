import { CodexStreamEvent, parseCodexEvent } from '@/models/codex-events';

/**
 * Line-buffered NDJSON parser for Codex exec --json events.
 */
export class CodexStreamParser {
  private buffer = '';

  parse(text: string): CodexStreamEvent[] {
    this.buffer += text;
    const events: CodexStreamEvent[] = [];

    while (true) {
      const newlineIndex = this.buffer.indexOf('\n');
      if (newlineIndex === -1) break;

      const line = this.buffer.slice(0, newlineIndex);
      this.buffer = this.buffer.slice(newlineIndex + 1);

      if (!line.trim()) continue;

      try {
        const json = JSON.parse(line);
        events.push(...parseCodexEvent(json));
      } catch {
        // Ignore non-JSON lines written by wrappers or shell.
      }
    }

    return events;
  }

  flush(): CodexStreamEvent[] {
    if (!this.buffer.trim()) {
      this.buffer = '';
      return [];
    }

    const remaining = this.buffer;
    this.buffer = '';

    try {
      const json = JSON.parse(remaining);
      return parseCodexEvent(json);
    } catch {
      return [];
    }
  }

  reset(): void {
    this.buffer = '';
  }
}
