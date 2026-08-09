import React from 'react';
import { View, Text, StyleSheet, Pressable } from 'react-native';
import {
  ChatMessage,
  ChatContent,
  TurnOutcome,
  formatTurnDuration,
  toolUseActivityLabel,
} from '@/models/chat';
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
  /** Show turn actions (e.g. Continue after max-turns) — last message only. */
  showTurnActions?: boolean;
  onContinueTurn?: () => void;
  /** Long-press on a bubble: open copy/quote actions for this message. */
  onMessageActions?: (message: ChatMessage) => void;
  /** Copy button on a fenced code block inside an assistant message. */
  onCopyCode?: (code: string) => void;
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

/** Muted one-line footer describing how the turn ended. */
function TurnOutcomeFooter({
  outcome,
  onContinue,
}: {
  outcome: TurnOutcome;
  onContinue?: () => void;
}) {
  const colors = useTheme();
  const duration = formatTurnDuration(outcome.durationMs);
  const details = [
    duration,
    outcome.numTurns !== undefined ? `${outcome.numTurns} turns` : null,
  ].filter(Boolean);
  const suffix = details.length > 0 ? ` · ${details.join(' · ')}` : '';

  let color: string = colors.textSecondary;
  let label: string;
  switch (outcome.status) {
    case 'success':
      label = `✓ Done${suffix}`;
      break;
    case 'maxTurns':
      color = colors.warning;
      label = `⚠ Stopped: max turns reached${suffix}`;
      break;
    case 'error':
      color = colors.destructive;
      label = `✕ Turn failed${outcome.subtype ? ` (${outcome.subtype})` : ''}${suffix}`;
      break;
    case 'interrupted':
      label = '■ Interrupted';
      break;
  }

  return (
    <View style={styles.outcomeRow}>
      <Text style={[styles.outcomeText, { color }]} numberOfLines={1}>
        {label}
      </Text>
      {onContinue && outcome.status === 'maxTurns' && (
        <Pressable
          style={[styles.continueButton, { borderColor: colors.tint }]}
          onPress={onContinue}
          hitSlop={8}
        >
          <Text style={[styles.continueButtonText, { color: colors.tint }]}>Continue</Text>
        </Pressable>
      )}
    </View>
  );
}

export function ChatMessageView({
  message,
  workingDirectory,
  isCurrentlyStreaming,
  showTurnActions,
  onContinueTurn,
  onMessageActions,
  onCopyCode,
}: ChatMessageViewProps) {
  const colors = useTheme();
  const handleLongPress = onMessageActions ? () => onMessageActions(message) : undefined;

  if (message.role === 'user') {
    const text = message.content
      .filter((c): c is Extract<ChatContent, { type: 'text' }> => c.type === 'text')
      .map((c) => c.text)
      .join('\n\n');
    return <UserBubble text={text} onLongPress={handleLongPress} />;
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
            return (
              <AssistantMessage
                key={`text-${index}`}
                text={item.text}
                onLongPress={handleLongPress}
                onCopyCode={onCopyCode}
              />
            );
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
          case 'turnOutcome':
            return (
              <TurnOutcomeFooter
                key={`outcome-${index}`}
                outcome={item.outcome}
                onContinue={showTurnActions ? onContinueTurn : undefined}
              />
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
  outcomeRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.md,
    marginHorizontal: Spacing.lg,
    marginTop: Spacing.xs,
    marginBottom: Spacing.sm,
  },
  outcomeText: {
    fontSize: FontSize.xs,
    flexShrink: 1,
  },
  continueButton: {
    borderWidth: 1,
    borderRadius: 12,
    paddingHorizontal: Spacing.md,
    paddingVertical: 3,
  },
  continueButtonText: {
    fontSize: FontSize.xs,
    fontWeight: '600',
  },
});
