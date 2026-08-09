import React from 'react';
import { View, Text, StyleSheet, Pressable } from 'react-native';
import { useTheme } from '@/hooks/use-theme';
import { FontSize, Spacing, Fonts } from '@/constants/theme';
import { parseMessageSegments } from '@/services/message-text';

interface AssistantMessageProps {
  text: string;
  /** Long-press anywhere in the bubble to open the message actions sheet. */
  onLongPress?: () => void;
  /** Tapping a code block's Copy button. */
  onCopyCode?: (code: string) => void;
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

export function AssistantMessage({ text, onLongPress, onCopyCode }: AssistantMessageProps) {
  const colors = useTheme();

  if (!text.trim()) return null;
  const segments = parseMessageSegments(text);

  return (
    <View style={styles.container}>
      <Pressable
        style={[styles.bubble, { backgroundColor: colors.assistantBubble }]}
        onLongPress={onLongPress}
        delayLongPress={350}
        accessibilityRole={onLongPress ? 'button' : undefined}
        accessibilityHint={onLongPress ? 'Long press for copy and quote actions' : undefined}
      >
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
                <View style={styles.codeHeader}>
                  <Text style={[styles.codeLanguage, { color: colors.textSecondary }]}>
                    {segment.language ?? 'code'}
                  </Text>
                  {onCopyCode && (
                    <Pressable
                      onPress={() => onCopyCode(segment.value)}
                      hitSlop={10}
                      accessibilityRole="button"
                      accessibilityLabel="Copy code block"
                    >
                      <Text style={[styles.codeCopy, { color: colors.tint }]}>Copy</Text>
                    </Pressable>
                  )}
                </View>
                <Text style={[styles.codeText, { color: colors.text }]}>{segment.value}</Text>
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
      </Pressable>
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
  codeHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 6,
    gap: Spacing.md,
  },
  codeLanguage: {
    fontSize: FontSize.xs,
    fontWeight: '600',
    textTransform: 'lowercase',
  },
  codeCopy: {
    fontSize: FontSize.xs,
    fontWeight: '700',
  },
  codeText: {
    fontFamily: Fonts?.mono ?? 'monospace',
    fontSize: FontSize.sm,
  },
});
