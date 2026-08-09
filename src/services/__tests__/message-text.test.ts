import { describe, expect, it } from 'vitest';
import { ChatMessage } from '@/models/chat';
import {
  formatQuote,
  joinParts,
  messageCodeBlocks,
  messageText,
  parseMessageSegments,
  quotableParts,
} from '@/services/message-text';

function assistant(text: string): ChatMessage {
  return { id: 'a', timestamp: 0, role: 'assistant', content: [{ type: 'text', text }] };
}

describe('parseMessageSegments', () => {
  it('returns a single text segment when there are no fences', () => {
    expect(parseMessageSegments('hello world')).toEqual([{ type: 'text', value: 'hello world' }]);
  });

  it('splits prose around a fenced block and captures the language', () => {
    expect(parseMessageSegments('before\n```ts\nconst a = 1;\n```\nafter')).toEqual([
      { type: 'text', value: 'before\n' },
      { type: 'code', value: 'const a = 1;', language: 'ts' },
      { type: 'text', value: '\nafter' },
    ]);
  });

  it('leaves the language undefined for a bare fence', () => {
    expect(parseMessageSegments('```\nraw\n```')).toEqual([
      { type: 'code', value: 'raw', language: undefined },
    ]);
  });

  it('is not stateful across calls', () => {
    const input = '```\nx\n```';
    expect(parseMessageSegments(input)).toEqual(parseMessageSegments(input));
  });
});

describe('messageText', () => {
  it('joins text blocks and ignores tool cards', () => {
    const message: ChatMessage = {
      id: 'm',
      timestamp: 0,
      role: 'assistant',
      content: [
        { type: 'text', text: 'one' },
        {
          type: 'toolUse',
          card: { toolUseId: 't', toolName: 'Bash', input: null, startedAt: 0 },
        },
        { type: 'text', text: 'two' },
      ],
    };
    expect(messageText(message)).toBe('one\n\ntwo');
  });

  it('is empty for a message with no prose', () => {
    expect(messageText({ id: 'm', timestamp: 0, role: 'assistant', content: [] })).toBe('');
  });
});

describe('messageCodeBlocks', () => {
  it('extracts fenced blocks without their fences', () => {
    expect(messageCodeBlocks(assistant('a\n```sh\nls -la\n```\nb\n```\necho hi\n```'))).toEqual([
      'ls -la',
      'echo hi',
    ]);
  });

  it('skips empty blocks', () => {
    expect(messageCodeBlocks(assistant('```\n\n```'))).toEqual([]);
  });
});

describe('quotableParts', () => {
  it('splits prose into paragraphs', () => {
    expect(quotableParts('first para\n\nsecond para')).toEqual(['first para', 'second para']);
  });

  it('keeps a code block whole and re-fences it', () => {
    expect(quotableParts('intro\n\n```py\nx = 1\ny = 2\n```')).toEqual([
      'intro',
      '```py\nx = 1\ny = 2\n```',
    ]);
  });

  it('drops blank paragraphs', () => {
    expect(quotableParts('a\n\n\n\n   \n\nb')).toEqual(['a', 'b']);
  });
});

describe('formatQuote', () => {
  it('prefixes every line', () => {
    expect(formatQuote('one\ntwo')).toBe('> one\n> two\n\n');
  });

  it('keeps interior blank lines as bare markers', () => {
    expect(formatQuote('one\n\ntwo')).toBe('> one\n>\n> two\n\n');
  });

  it('returns nothing for blank input', () => {
    expect(formatQuote('   \n  ')).toBe('');
  });
});

describe('joinParts', () => {
  it('rejoins with paragraph spacing', () => {
    expect(joinParts(['a', 'b'])).toBe('a\n\nb');
  });
});
