import { describe, expect, it } from 'vitest';
import { PiStreamParser } from '@/services/pi-stream';

// Lines below are taken verbatim from `pi --mode json` output (session ids and
// call ids shortened) so the parser is tested against the real wire format.
const SESSION_LINE =
  '{"type":"session","version":3,"id":"01a016be-b7ae-70bb-a70d-ef3003cd1820","timestamp":"2026-08-18T21:19:52.750Z","cwd":"/home/sprite/repo"}';

const TEXT_DELTA_LINE =
  '{"type":"message_update","usage":{"input":143,"output":3,"cacheRead":1344,"cacheWrite":0,"totalTokens":1490},"assistantMessageEvent":{"type":"text_delta","contentIndex":0,"delta":"OK"}}';

const THINKING_DELTA_LINE =
  '{"type":"message_update","usage":{"input":143,"output":3},"assistantMessageEvent":{"type":"thinking_delta","contentIndex":0,"delta":"Thinking..."}}';

const TOOLCALL_DELTA_LINE =
  '{"type":"message_update","usage":{"input":29,"output":34},"assistantMessageEvent":{"type":"toolcall_delta","contentIndex":1,"delta":"{\\"command\\":\\"echo hi\\"}"}}';

const ASSISTANT_END_LINE =
  '{"type":"message_end","message":{"role":"assistant","content":[{"type":"thinking","thinking":"Run it.","thinkingSignature":"reasoning_content"},{"type":"toolCall","id":"call_3ce1","name":"bash","arguments":{"command":"echo hello-wisp"}}],"api":"openai-completions","provider":"zai","model":"glm-5.3","usage":{"input":29,"output":34,"cacheRead":1472,"cacheWrite":0,"totalTokens":1535,"cost":{"input":0,"output":0,"cacheRead":0,"cacheWrite":0,"total":0}},"stopReason":"toolUse","timestamp":1787088006717}}';

const TOOL_EXECUTION_END_LINE =
  '{"type":"tool_execution_end","toolCallId":"call_3ce1","toolName":"bash","result":{"content":[{"type":"text","text":"hello-wisp\\n"}]},"isError":false}';

const USER_MESSAGE_END_LINE =
  '{"type":"message_end","message":{"role":"user","content":[{"type":"text","text":"Run the command"}],"timestamp":1787088006664}}';

const TOOLRESULT_MESSAGE_END_LINE =
  '{"type":"message_end","message":{"role":"toolResult","toolCallId":"call_3ce1","toolName":"bash","content":[{"type":"text","text":"hello-wisp\\n"}],"isError":false,"timestamp":1787088011240}}';

function agentEndLine(stopReason: string, errorMessage?: string) {
  return JSON.stringify({
    type: 'agent_end',
    messages: [
      { role: 'user', content: [{ type: 'text', text: 'hi' }], timestamp: 1 },
      {
        role: 'assistant',
        content: [{ type: 'text', text: 'done' }],
        provider: 'zai',
        model: 'glm-5.3',
        stopReason,
        ...(errorMessage ? { errorMessage } : {}),
      },
    ],
    willRetry: false,
  });
}

function parseAll(lines: string[]) {
  const parser = new PiStreamParser();
  return parser.parse(lines.join('\n') + '\n');
}

describe('PiStreamParser — pi --mode json events', () => {
  it('maps the session header to sessionStarted with the resume id', () => {
    const events = parseAll([SESSION_LINE]);
    expect(events).toEqual([
      {
        type: 'sessionStarted',
        sessionId: '01a016be-b7ae-70bb-a70d-ef3003cd1820',
        cwd: '/home/sprite/repo',
      },
    ]);
  });

  it('maps text and thinking deltas with their contentIndex', () => {
    const events = parseAll([TEXT_DELTA_LINE, THINKING_DELTA_LINE]);
    expect(events).toEqual([
      { type: 'assistantDelta', text: 'OK', contentIndex: 0 },
      { type: 'reasoningDelta', text: 'Thinking...', contentIndex: 0 },
    ]);
  });

  it('ignores toolcall argument deltas and non-JSON noise', () => {
    const events = parseAll([TOOLCALL_DELTA_LINE, 'not json at all']);
    expect(events).toEqual([]);
  });

  it('maps assistant message_end to the authoritative message', () => {
    const events = parseAll([ASSISTANT_END_LINE]);
    expect(events).toHaveLength(1);
    const event = events[0];
    expect(event.type).toBe('assistantMessage');
    if (event.type !== 'assistantMessage') return;
    expect(event.message.provider).toBe('zai');
    expect(event.message.model).toBe('glm-5.3');
    const blocks = event.message.content as any[];
    expect(blocks.map((b) => b.type)).toEqual(['thinking', 'toolCall']);
    expect(blocks[1].id).toBe('call_3ce1');
    expect(blocks[1].arguments).toEqual({ command: 'echo hello-wisp' });
  });

  it('ignores user and toolResult message_end duplicates', () => {
    const events = parseAll([USER_MESSAGE_END_LINE, TOOLRESULT_MESSAGE_END_LINE]);
    expect(events).toEqual([]);
  });

  it('maps tool_execution_end to a toolResult', () => {
    const events = parseAll([TOOL_EXECUTION_END_LINE]);
    expect(events).toEqual([
      {
        type: 'toolResult',
        toolCallId: 'call_3ce1',
        toolName: 'bash',
        content: { content: [{ type: 'text', text: 'hello-wisp\n' }] },
        isError: false,
      },
    ]);
  });

  it('derives the turn outcome from the last assistant message', () => {
    expect(parseAll([agentEndLine('stop')])).toEqual([
      { type: 'turnCompleted', status: 'success' },
    ]);
    expect(parseAll([agentEndLine('toolUse')])).toEqual([
      { type: 'turnCompleted', status: 'success' },
    ]);
    expect(parseAll([agentEndLine('error', 'No API key')])).toEqual([
      { type: 'turnCompleted', status: 'error', message: 'No API key' },
    ]);
    expect(parseAll([agentEndLine('aborted')])).toEqual([
      { type: 'turnCompleted', status: 'interrupted' },
    ]);
  });

  it('flushes a trailing line without a newline and resets', () => {
    const parser = new PiStreamParser();
    expect(parser.parse(SESSION_LINE)).toEqual([]);
    const flushed = parser.flush();
    expect(flushed[0]).toMatchObject({
      type: 'sessionStarted',
      sessionId: '01a016be-b7ae-70bb-a70d-ef3003cd1820',
    });
    parser.reset();
    expect(parser.flush()).toEqual([]);
  });
});
