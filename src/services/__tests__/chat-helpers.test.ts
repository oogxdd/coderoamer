import { describe, expect, it } from 'vitest';
import { ChatMessage } from '@/models/chat';
import {
  buildFallbackPrompt,
  buildCodexAppServerCommand,
  buildProcessGroupKillCommand,
  buildTurnNotifySuffix,
  CHAT_DEBUG_LOG_DIR,
  classifyCodexAuthIssue,
  conversationSignature,
  countUserMessages,
  firstDivergentIndex,
  isHeartbeatStderr,
  mergeTranscript,
  safeTaskName,
  shellQuote,
  withSpriteDebugLogging,
  withSpriteTaskHeartbeat,
} from '@/services/chat-helpers';

function msg(role: ChatMessage['role'], id: string, content: ChatMessage['content']): ChatMessage {
  return { id, timestamp: 0, role, content };
}

function textMsg(role: ChatMessage['role'], id: string, text: string): ChatMessage {
  return msg(role, id, [{ type: 'text', text }]);
}

describe('shellQuote', () => {
  it('wraps in single quotes', () => {
    expect(shellQuote('hello')).toBe("'hello'");
  });

  it('escapes embedded single quotes', () => {
    expect(shellQuote("it's")).toBe("'it'\\''s'");
  });
});

describe('safeTaskName', () => {
  it('replaces unsafe characters and truncates', () => {
    expect(safeTaskName('a b/c$d')).toBe('a-b-c-d');
    expect(safeTaskName('x'.repeat(200))).toHaveLength(120);
  });
});

describe('buildFallbackPrompt', () => {
  it('returns the prompt unchanged with no history', () => {
    expect(buildFallbackPrompt([], 'hi')).toBe('hi');
  });

  it('inlines prior turns with roles', () => {
    const history = [textMsg('user', 'u1', 'first'), textMsg('assistant', 'a1', 'answer')];
    const result = buildFallbackPrompt(history, 'next');
    expect(result).toContain('User: first');
    expect(result).toContain('Assistant: answer');
    expect(result).toContain('User: next');
  });

  it('clips long messages and keeps only the last 12 lines', () => {
    const long = 'x'.repeat(2000);
    const history = Array.from({ length: 20 }, (_, i) => textMsg('user', `u${i}`, i === 19 ? long : `m${i}`));
    const result = buildFallbackPrompt(history, 'next');
    expect(result).not.toContain('m0');
    expect(result).toContain('m8');
    expect(result).toContain(`${'x'.repeat(1200)}...`);
  });
});

describe('classifyCodexAuthIssue', () => {
  it('detects auth-shaped stderr', () => {
    expect(classifyCodexAuthIssue('please run codex login first')).toBeTruthy();
    expect(classifyCodexAuthIssue('request failed with status code: 401')).toBeTruthy();
    expect(classifyCodexAuthIssue('Unauthorized')).toBeTruthy();
  });

  it('ignores ordinary errors', () => {
    expect(classifyCodexAuthIssue('command not found: cargo')).toBeUndefined();
  });
});

describe('conversationSignature', () => {
  it('is stable across message ids', () => {
    const a = [textMsg('user', 'u1', 'hi'), textMsg('assistant', 'a1', 'yo')];
    const b = [textMsg('user', 'other1', 'hi'), textMsg('assistant', 'other2', 'yo')];
    expect(conversationSignature(a)).toBe(conversationSignature(b));
  });

  it('distinguishes turn outcomes', () => {
    const ok = [msg('assistant', 'a', [{ type: 'turnOutcome', outcome: { status: 'success', completedAt: 0 } }])];
    const bad = [msg('assistant', 'a', [{ type: 'turnOutcome', outcome: { status: 'error', completedAt: 0 } }])];
    expect(conversationSignature(ok)).not.toBe(conversationSignature(bad));
  });
});

describe('mergeTranscript', () => {
  it('keeps local ids for the common prefix', () => {
    const local = [textMsg('user', 'localU', 'hi'), textMsg('assistant', 'localA', 'partial')];
    const incoming = [textMsg('user', 'diskU', 'hi'), textMsg('assistant', 'diskA', 'full answer')];
    const merged = mergeTranscript(local, incoming);
    expect(merged.map((m) => m.id)).toEqual(['localU', 'localA']);
    expect(merged[1].content).toEqual([{ type: 'text', text: 'full answer' }]);
  });

  it('uses incoming ids when roles do not line up', () => {
    const local = [textMsg('assistant', 'localA', 'x')];
    const incoming = [textMsg('user', 'diskU', 'hi')];
    expect(mergeTranscript(local, incoming)[0].id).toBe('diskU');
  });

  it('carries the local turn outcome over (transcripts have no result lines)', () => {
    const outcome = { type: 'turnOutcome' as const, outcome: { status: 'maxTurns' as const, completedAt: 1 } };
    const local = [textMsg('user', 'u', 'hi'), msg('assistant', 'a', [{ type: 'text', text: 'part' }, outcome])];
    const incoming = [textMsg('user', 'du', 'hi'), textMsg('assistant', 'da', 'full')];
    const merged = mergeTranscript(local, incoming);
    expect(merged[1].content).toEqual([{ type: 'text', text: 'full' }, outcome]);
  });

  it('does not duplicate an outcome the incoming message already has', () => {
    const localOutcome = { type: 'turnOutcome' as const, outcome: { status: 'error' as const, completedAt: 1 } };
    const incomingOutcome = { type: 'turnOutcome' as const, outcome: { status: 'success' as const, completedAt: 2 } };
    const local = [msg('assistant', 'a', [localOutcome])];
    const incoming = [msg('assistant', 'da', [incomingOutcome])];
    const merged = mergeTranscript(local, incoming);
    expect(merged[0].content).toEqual([incomingOutcome]);
  });
});

describe('firstDivergentIndex', () => {
  it('returns the common length for identical snapshots', () => {
    expect(firstDivergentIndex(['a', 'b'], ['a', 'b'])).toBe(2);
    expect(firstDivergentIndex([], [])).toBe(0);
  });

  it('points at the appended tail', () => {
    expect(firstDivergentIndex(['a', 'b'], ['a', 'b', 'c'])).toBe(2);
  });

  it('points at an in-place change (streaming assistant message)', () => {
    expect(firstDivergentIndex(['u', 'partial'], ['u', 'partial+more'])).toBe(1);
  });

  it('points at an early change after a transcript merge', () => {
    expect(firstDivergentIndex(['a', 'b', 'c'], ['a', 'B', 'c'])).toBe(1);
  });

  it('handles truncation', () => {
    expect(firstDivergentIndex(['a', 'b', 'c'], ['a'])).toBe(1);
  });
});

describe('countUserMessages', () => {
  it('counts only user messages', () => {
    expect(
      countUserMessages([textMsg('user', 'u', 'a'), textMsg('assistant', 'a', 'b'), textMsg('user', 'u2', 'c')])
    ).toBe(2);
  });
});

describe('withSpriteTaskHeartbeat', () => {
  it('wraps the command with task keep-alive and stderr heartbeat', () => {
    const wrapped = withSpriteTaskHeartbeat('echo hi', 'wisp-chat-x');
    expect(wrapped).toContain("TASK_NAME='wisp-chat-x'");
    expect(wrapped).toContain('sleep 60; sprite_task_put');
    expect(wrapped).toContain('sleep 20; printf . >&2');
    expect(wrapped).toContain('trap cleanup EXIT INT TERM');
    expect(wrapped.endsWith('echo hi')).toBe(true);
  });
});

describe('buildCodexAppServerCommand', () => {
  it('forwards stdio and self-terminates after the terminal turn notification', () => {
    const command = buildCodexAppServerCommand();
    expect(command).toContain('app-server');
    expect(command).toContain('turn/completed');
    expect(command).toContain('SIGTERM');
    expect(command).toContain('process.stdin.on');
    expect(command).not.toContain('CODEX_RPC_LOG=');
  });

  it('logs JSON-RPC frames in both directions when given a log path', () => {
    const command = buildCodexAppServerCommand('~/.sprites-chat-debug/x.rpc.jsonl');
    expect(command).toContain('CODEX_RPC_LOG=~/.sprites-chat-debug/x.rpc.jsonl node -e');
    expect(command).toContain('to-app-server');
    expect(command).toContain('from-app-server');
    expect(command).toContain('rpcLog');
  });
});

describe('withSpriteDebugLogging', () => {
  it('mkdirs the debug dir, logs the command text, and tees stdout/stderr separately', () => {
    const wrapped = withSpriteDebugLogging('echo hi', 'codex-abc');
    const base = `${CHAT_DEBUG_LOG_DIR}/codex-abc`;
    expect(wrapped).toContain(`mkdir -p ${CHAT_DEBUG_LOG_DIR}`);
    expect(wrapped).toContain(`>> ${base}.cmd.log`);
    expect(wrapped).toContain(`tee -a ${base}.stdout.log`);
    expect(wrapped).toContain(`tee -a ${base}.stderr.log >&2`);
    expect(wrapped.endsWith('echo hi')).toBe(true);
  });

  it('redacts secrets from the logged command label', () => {
    const wrapped = withSpriteDebugLogging(
      'echo hi',
      'codex-abc',
      'curl -H "Authorization: Bearer sk-ant-oat01-should-not-leak"'
    );
    expect(wrapped).not.toContain('sk-ant-oat01-should-not-leak');
    expect(wrapped).toContain('Bearer [redacted]');
  });
});

describe('buildProcessGroupKillCommand', () => {
  it('never matches its own command line', () => {
    const cmd = buildProcessGroupKillCommand('wisp-chat-claude-abc.123');
    // The raw marker must not appear anywhere in the killer itself.
    expect(cmd).not.toContain('wisp-chat-claude-abc.123');
    expect(cmd).toContain('[w]isp-chat-claude-abc\\.123');
    expect(cmd).toContain('pgrep -f');
    expect(cmd).toContain('kill -TERM -- "-$PGID"');
    expect(cmd).toContain('kill -KILL -- "-$PGID"');
  });

  it('degrades to a no-op for empty names', () => {
    expect(buildProcessGroupKillCommand('')).toBe('true');
  });
});

describe('buildTurnNotifySuffix', () => {
  it('returns nothing without a topic', () => {
    expect(buildTurnNotifySuffix({ server: '', topic: '  ', title: 't', promptPreview: 'p' })).toBe('');
  });

  it('encodes the topic, flattens newlines, and preserves the exit status', () => {
    const suffix = buildTurnNotifySuffix({
      server: '',
      topic: 'my topic',
      title: 'sprite · Claude',
      promptPreview: 'fix\nthe bug',
    });
    expect(suffix).toContain('https://ntfy.sh/my%20topic');
    expect(suffix).toContain("'Done: fix the bug'");
    expect(suffix).toContain("'Failed: fix the bug'");
    expect(suffix.trim().endsWith('(exit "$WISP_EXIT")')).toBe(true);
  });

  it('quotes apostrophes safely and strips trailing slashes from the server', () => {
    const suffix = buildTurnNotifySuffix({
      server: 'https://ntfy.example.com//',
      topic: 't',
      title: "it's done",
      promptPreview: '',
    });
    expect(suffix).toContain('https://ntfy.example.com/t');
    expect(suffix).toContain("'Title: it'\\''s done'");
    expect(suffix).toContain("'Turn finished'");
  });
});

describe('isHeartbeatStderr', () => {
  it('recognizes heartbeat dots, with or without log prefixes', () => {
    expect(isHeartbeatStderr('.')).toBe(true);
    expect(isHeartbeatStderr('...\n')).toBe(true);
    expect(isHeartbeatStderr('2026-02-19T09:13:24.665Z [stderr] .')).toBe(true);
  });

  it('rejects real stderr text', () => {
    expect(isHeartbeatStderr('error: something broke')).toBe(false);
    expect(isHeartbeatStderr('')).toBe(false);
  });
});
