import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { ChatMessage, ChatContent, toolUseActivityLabel } from '@/models/chat';
import { UserBubble } from './UserBubble';
import { AssistantMessage } from './AssistantMessage';
import { ToolUseCardView } from './ToolUseCardView';
import { ReasoningBlock } from './ReasoningBlock';
import { ThinkingShimmer } from './ThinkingShimmer';
import { useTheme } from '@/hooks/use-theme';
import { FontSize, Spacing } from '@/constants/theme';

interface ChatMessageViewProps {
  message: ChatMessage;
  workingDirectory?: string;
  isCurrentlyStreaming?: boolean;
}

function getActiveToolLabel(
  content: ChatContent[],
  workingDirectory?: string
): string | undefined {
  // Walk backwards to find the last toolUse without a result
  for (let i = content.length - 1; i >= 0; i--) {
    const item = content[i];
    if (item.type === 'toolUse' && !item.card.result) {
      return toolUseActivityLabel(item.card, workingDirectory);
    }
  }
  return undefined;
}

export function ChatMessageView({
  message,
  workingDirectory,
  isCurrentlyStreaming,
}: ChatMessageViewProps) {
  const colors = useTheme();

  if (message.role === 'user') {
    const text = message.content
      .filter((c): c is Extract<ChatContent, { type: 'text' }> => c.type === 'text')
      .map((c) => c.text)
      .join('\n\n');
    return <UserBubble text={text} />;
  }

  if (message.role === 'system') {
    const text = message.content
      .filter((c): c is Extract<ChatContent, { type: 'text' }> => c.type === 'text')
      .map((c) => c.text)
      .join('\n\n');
    return (
      <View style={styles.systemContainer}>
        <Text style={[styles.systemText, { color: colors.textSecondary }]}>{text}</Text>
      </View>
    );
  }

  // Assistant message - render content blocks
  return (
    <View style={styles.assistantContainer}>
      {message.content.map((item, index) => {
        switch (item.type) {
          case 'text':
            return <AssistantMessage key={`text-${index}`} text={item.text} />;
          case 'reasoning':
            return (
              <ReasoningBlock
                key={`reasoning-${index}`}
                text={item.text}
                streaming={isCurrentlyStreaming && index === message.content.length - 1}
              />
            );
          case 'toolUse':
            return (
              <ToolUseCardView
                key={`tool-${item.card.toolUseId}`}
                card={item.card}
                workingDirectory={workingDirectory}
              />
            );
          case 'toolResult':
            // Tool results are displayed inline within ToolUseCardView
            return null;
          case 'error':
            return (
              <View key={`error-${index}`} style={styles.errorContainer}>
                <Text style={[styles.errorText, { color: colors.destructive }]}>
                  {item.message}
                </Text>
              </View>
            );
          default:
            return null;
        }
      })}

      {/* Streaming indicator */}
      {isCurrentlyStreaming && message.content.length === 0 && (
        <ThinkingShimmer />
      )}
      {isCurrentlyStreaming && message.content.length > 0 && (() => {
        const label = getActiveToolLabel(message.content, workingDirectory);
        return label ? <ThinkingShimmer label={label} /> : null;
      })()}
    </View>
  );
}

const styles = StyleSheet.create({
  assistantContainer: {
    marginVertical: Spacing.xs,
  },
  systemContainer: {
    alignItems: 'center',
    paddingVertical: Spacing.sm,
    paddingHorizontal: Spacing.xl,
  },
  systemText: {
    fontSize: FontSize.sm,
    fontStyle: 'italic',
    textAlign: 'center',
  },
  errorContainer: {
    marginHorizontal: Spacing.lg,
    marginVertical: Spacing.xs,
    padding: Spacing.md,
    borderRadius: 8,
  },
  errorText: {
    fontSize: FontSize.sm,
  },
});
