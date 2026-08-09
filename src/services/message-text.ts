import { ChatContent, ChatMessage } from '@/models/chat';

/**
 * Turning rendered chat messages back into text you can copy or quote.
 *
 * `parseMessageSegments` is the single fence parser shared with
 * `AssistantMessage` — the copy/quote picker must offer exactly the pieces the
 * bubble drew, or users would select one thing and get another.
 */

export type MessageSegment =
  | { type: 'text'; value: string }
  | { type: 'code'; value: string; language?: string };

const FENCE_REGEX = /```([^\n]*)\n?([\s\S]*?)```/g;

export function parseMessageSegments(input: string): MessageSegment[] {
  const segments: MessageSegment[] = [];
  const regex = new RegExp(FENCE_REGEX.source, 'g');
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = regex.exec(input)) !== null) {
    const [fullMatch, infoString, codeContent] = match;
    const matchStart = match.index;

    if (matchStart > lastIndex) {
      segments.push({ type: 'text', value: input.slice(lastIndex, matchStart) });
    }

    const language = infoString.trim();
    segments.push({
      type: 'code',
      value: codeContent.replace(/\n$/, ''),
      language: language || undefined,
    });
    lastIndex = matchStart + fullMatch.length;
  }

  if (lastIndex < input.length) {
    segments.push({ type: 'text', value: input.slice(lastIndex) });
  }

  return segments;
}

/** The message's visible prose, as one plain-text string. */
export function messageText(message: ChatMessage): string {
  return message.content
    .filter((c): c is Extract<ChatContent, { type: 'text' }> => c.type === 'text')
    .map((c) => c.text)
    .join('\n\n')
    .trim();
}

/** Fenced code blocks in the message, in order, without their fences. */
export function messageCodeBlocks(message: ChatMessage): string[] {
  return parseMessageSegments(messageText(message))
    .filter((s): s is Extract<MessageSegment, { type: 'code' }> => s.type === 'code')
    .map((s) => s.value)
    .filter((v) => v.trim().length > 0);
}

/**
 * The message broken into the smallest pieces worth quoting on their own: one
 * per rendered paragraph, with each code block kept whole (and re-fenced, so a
 * quoted snippet still reads as code wherever it lands).
 */
export function quotableParts(text: string): string[] {
  const parts: string[] = [];
  for (const segment of parseMessageSegments(text)) {
    if (segment.type === 'code') {
      if (!segment.value.trim()) continue;
      parts.push(`\`\`\`${segment.language ?? ''}\n${segment.value}\n\`\`\``);
      continue;
    }
    for (const paragraph of segment.value.split(/\n{2,}/)) {
      const trimmed = paragraph.trim();
      if (trimmed) parts.push(trimmed);
    }
  }
  return parts;
}

/** Markdown blockquote, with a trailing blank line to type after. */
export function formatQuote(text: string): string {
  const trimmed = text.trim();
  if (!trimmed) return '';
  const body = trimmed
    .split('\n')
    .map((line) => (line.trim() ? `> ${line}` : '>'))
    .join('\n');
  return `${body}\n\n`;
}

/** Join selected parts back together the way they were rendered. */
export function joinParts(parts: string[]): string {
  return parts.join('\n\n');
}
