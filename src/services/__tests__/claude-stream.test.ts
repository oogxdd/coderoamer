import { describe, expect, it } from 'vitest';
import { ClaudeStreamParser, stripLogTimestamps } from '@/services/claude-stream';

describe('stripLogTimestamps', () => {
  it('strips a service-log prefix', () => {
    expect(stripLogTimestamps('2026-02-19T09:13:24.665Z [stdout] {"type":"system"}')).toBe(
      '{"type":"system"}'
    );
  });

  it('strips prefixes on every line', () => {
    const input =
      '2026-02-19T09:13:24.665Z [stdout] {"a":1}\n2026-02-19T09:13:25.001Z [stderr] .';
    expect(stripLogTimestamps(input)).toBe('{"a":1}\n.');
  });

  it('leaves plain output alone', () => {
    expect(stripLogTimestamps('{"type":"result"}')).toBe('{"type":"result"}');
  });
});

describe('ClaudeStreamParser', () => {
  it('parses complete NDJSON lines', () => {
    const parser = new ClaudeStreamParser();
    const events = parser.parse('{"type":"system","session_id":"s1","model":"m1"}\n');
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('system');
  });

  it('buffers lines split across chunks', () => {
    const parser = new ClaudeStreamParser();
    const line = '{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"hello"}]}}';
    expect(parser.parse(line.slice(0, 40))).toHaveLength(0);
    const events = parser.parse(`${line.slice(40)}\n`);
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('assistant');
  });

  it('parses several events from one chunk and skips junk lines', () => {
    const parser = new ClaudeStreamParser();
    const events = parser.parse(
      '{"type":"system","session_id":"s"}\nnot json at all\n{"type":"result","session_id":"s","subtype":"success"}\n'
    );
    expect(events.map((e) => e.type)).toEqual(['system', 'result']);
  });

  it('flushes a trailing line without a newline', () => {
    const parser = new ClaudeStreamParser();
    parser.parse('{"type":"result","session_id":"s"}');
    const events = parser.flush();
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('result');
  });

  it('carries the event uuid for deduplication', () => {
    const parser = new ClaudeStreamParser();
    const events = parser.parse('{"type":"system","session_id":"s","uuid":"u-1"}\n');
    expect(events[0].uuid).toBe('u-1');
  });
});
