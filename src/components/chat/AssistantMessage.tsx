import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { useTheme } from '@/hooks/use-theme';
import { FontSize, Spacing, Fonts } from '@/constants/theme';

interface AssistantMessageProps {
  text: string;
}

type MessageSegment =
  | { type: 'text'; value: string }
  | { type: 'code'; value: string };

function parseMessageSegments(input: string): MessageSegment[] {
  const segments: MessageSegment[] = [];
  const fenceRegex = /```[^\n]*\n?([\s\S]*?)```/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = fenceRegex.exec(input)) !== null) {
    const [fullMatch, codeContent] = match;
    const matchStart = match.index;

    if (matchStart > lastIndex) {
      segments.push({ type: 'text', value: input.slice(lastIndex, matchStart) });
    }

    const normalizedCode = codeContent.replace(/\n$/, '');
    segments.push({ type: 'code', value: normalizedCode });
    lastIndex = matchStart + fullMatch.length;
  }

  if (lastIndex < input.length) {
    segments.push({ type: 'text', value: input.slice(lastIndex) });
  }

  return segments;
}

function renderInlineCode(text: string, colorText: string, colorBg: string, colorCode: string) {
  const inlineCodeRegex = /`([^`]+)`/g;
  const nodes: React.ReactNode[] = [];
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = inlineCodeRegex.exec(text)) !== null) {
    const [fullMatch, codeValue] = match;
    const matchStart = match.index;

    if (matchStart > lastIndex) {
      nodes.push(
        <Text key={`txt-${lastIndex}`} style={{ color: colorText }}>
          {text.slice(lastIndex, matchStart)}
        </Text>
      );
    }

    nodes.push(
      <Text
        key={`code-${matchStart}`}
        style={[
          styles.inlineCode,
          {
            backgroundColor: colorBg,
            color: colorCode,
          },
        ]}
      >
        {codeValue}
      </Text>
    );

    lastIndex = matchStart + fullMatch.length;
  }

  if (lastIndex < text.length) {
    nodes.push(
      <Text key={`tail-${lastIndex}`} style={{ color: colorText }}>
        {text.slice(lastIndex)}
      </Text>
    );
  }

  return nodes;
}

export function AssistantMessage({ text }: AssistantMessageProps) {
  const colors = useTheme();

  if (!text.trim()) return null;
  const segments = parseMessageSegments(text);

  return (
    <View style={styles.container}>
      <View style={[styles.bubble, { backgroundColor: colors.assistantBubble }]}>
        {segments.map((segment, segmentIndex) => {
          if (segment.type === 'code') {
            return (
              <View
                key={`code-${segmentIndex}`}
                style={[
                  styles.codeBlock,
                  {
                    backgroundColor: colors.backgroundElement,
                  },
                ]}
              >
                <Text style={[styles.codeText, { color: colors.text }]}>
                  {segment.value}
                </Text>
              </View>
            );
          }

          const paragraphs = segment.value
            .split(/\n{2,}/)
            .map((p) => p.trim())
            .filter(Boolean);

          return paragraphs.map((paragraph, paragraphIndex) => (
            <Text
              key={`text-${segmentIndex}-${paragraphIndex}`}
              style={[styles.paragraph, { color: colors.assistantBubbleText }]}
            >
              {renderInlineCode(
                paragraph,
                colors.assistantBubbleText,
                colors.backgroundElement,
                colors.text
              )}
            </Text>
          ));
        })}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    alignItems: 'flex-start',
    paddingHorizontal: Spacing.lg,
    paddingVertical: Spacing.xs,
  },
  bubble: {
    maxWidth: '90%',
    paddingHorizontal: Spacing.lg,
    paddingVertical: Spacing.md,
    borderRadius: 18,
    borderBottomLeftRadius: 4,
  },
  paragraph: {
    fontSize: FontSize.md,
    lineHeight: 22,
    marginBottom: 8,
  },
  inlineCode: {
    fontFamily: Fonts?.mono ?? 'monospace',
    fontSize: FontSize.sm,
    paddingHorizontal: 4,
    paddingVertical: 1,
    borderRadius: 4,
  },
  codeBlock: {
    padding: 12,
    borderRadius: 8,
    marginVertical: 8,
  },
  codeText: {
    fontFamily: Fonts?.mono ?? 'monospace',
    fontSize: FontSize.sm,
  },
});
