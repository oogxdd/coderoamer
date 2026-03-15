import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import Markdown from 'react-native-markdown-display';
import { useTheme } from '@/hooks/use-theme';
import { FontSize, Spacing, Fonts } from '@/constants/theme';

interface AssistantMessageProps {
  text: string;
}

export function AssistantMessage({ text }: AssistantMessageProps) {
  const colors = useTheme();

  if (!text.trim()) return null;

  const markdownStyles = {
    body: {
      color: colors.assistantBubbleText,
      fontSize: FontSize.md,
      lineHeight: 22,
    },
    paragraph: {
      marginTop: 0,
      marginBottom: 8,
    },
    code_inline: {
      backgroundColor: colors.backgroundElement,
      color: colors.text,
      fontFamily: Fonts?.mono ?? 'monospace',
      fontSize: FontSize.sm,
      paddingHorizontal: 4,
      paddingVertical: 1,
      borderRadius: 4,
    },
    fence: {
      backgroundColor: colors.backgroundElement,
      color: colors.text,
      fontFamily: Fonts?.mono ?? 'monospace',
      fontSize: FontSize.sm,
      padding: 12,
      borderRadius: 8,
      marginVertical: 8,
    },
    code_block: {
      backgroundColor: colors.backgroundElement,
      color: colors.text,
      fontFamily: Fonts?.mono ?? 'monospace',
      fontSize: FontSize.sm,
      padding: 12,
      borderRadius: 8,
    },
    heading1: {
      color: colors.text,
      fontSize: 24,
      fontWeight: '700' as const,
      marginBottom: 8,
      marginTop: 16,
    },
    heading2: {
      color: colors.text,
      fontSize: 20,
      fontWeight: '600' as const,
      marginBottom: 6,
      marginTop: 12,
    },
    heading3: {
      color: colors.text,
      fontSize: 17,
      fontWeight: '600' as const,
      marginBottom: 4,
      marginTop: 10,
    },
    link: {
      color: colors.tint,
    },
    blockquote: {
      backgroundColor: colors.backgroundElement,
      borderLeftColor: colors.tint,
      borderLeftWidth: 3,
      paddingLeft: 12,
      paddingVertical: 4,
      marginVertical: 8,
    },
    list_item: {
      marginBottom: 4,
    },
    strong: {
      fontWeight: '700' as const,
    },
    em: {
      fontStyle: 'italic' as const,
    },
    hr: {
      backgroundColor: colors.border,
      height: 1,
      marginVertical: 12,
    },
  };

  return (
    <View style={styles.container}>
      <View style={[styles.bubble, { backgroundColor: colors.assistantBubble }]}>
        <Markdown style={markdownStyles}>{text}</Markdown>
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
});
