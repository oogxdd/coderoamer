import React from 'react';
import {
  ActivityIndicator,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { FontSize, Spacing } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';
import { AgentProvider, providerDisplayName } from '@/models/chat';

interface ChatInputBarProps {
  value: string;
  onChangeText: (text: string) => void;
  onSend: () => void;
  onInterrupt?: () => void;
  isStreaming: boolean;
  disabled?: boolean;
  provider: AgentProvider;
  onToggleDictation?: () => void;
  isDictating?: boolean;
  isTranscribing?: boolean;
  dictationStatus?: string;
  dictationError?: string;
  onClearDictationError?: () => void;
}

export function ChatInputBar({
  value,
  onChangeText,
  onSend,
  onInterrupt,
  isStreaming,
  disabled,
  provider,
  onToggleDictation,
  isDictating,
  isTranscribing,
  dictationStatus,
  dictationError,
  onClearDictationError,
}: ChatInputBarProps) {
  const colors = useTheme();
  const hasText = value.trim().length > 0;
  // Sending during a turn is allowed: useChat queues the prompt and fires it
  // when the turn completes, so a follow-up never interrupts the agent. Stopping
  // is a separate button so the two can't be confused for each other.
  const canSend = hasText && !disabled;
  const willQueue = isStreaming && canSend;
  const canDictate = Boolean(onToggleDictation && !disabled && !isTranscribing);
  const showStop = isStreaming && !!onInterrupt;

  const handleAction = () => {
    if (isDictating) {
      onToggleDictation?.();
    } else if (canSend) {
      onSend();
    } else if (canDictate) {
      onToggleDictation?.();
    }
  };

  const actionDisabled = isTranscribing || (!isDictating && !canSend && !canDictate);
  const actionActive = isDictating || canSend;

  const hint = dictationError ?? dictationStatus ?? (willQueue
    ? `Queued — sends when ${providerDisplayName(provider)} finishes this turn`
    : undefined);

  return (
    <View
      style={[
        styles.container,
        { backgroundColor: colors.background, borderTopColor: colors.border },
      ]}
    >
      {hint && (
        <Pressable
          style={styles.feedback}
          onPress={dictationError ? onClearDictationError : undefined}
          disabled={!dictationError}
        >
          <Text
            style={[
              styles.feedbackText,
              { color: dictationError ? colors.destructive : colors.textSecondary },
            ]}
            numberOfLines={1}
          >
            {hint}
          </Text>
        </Pressable>
      )}

      <View style={styles.row}>
        {showStop && (
          <Pressable
            style={({ pressed }) => [
              styles.stopButton,
              {
                borderColor: colors.destructive,
                backgroundColor: pressed ? colors.destructive + '22' : 'transparent',
              },
            ]}
            onPress={onInterrupt}
            hitSlop={8}
            accessibilityRole="button"
            accessibilityLabel="Stop response"
          >
            <View style={[styles.stopGlyph, { backgroundColor: colors.destructive }]} />
          </Pressable>
        )}

        <View
          style={[
            styles.composer,
            { backgroundColor: colors.inputBackground, borderColor: colors.border },
          ]}
        >
          <TextInput
            style={[styles.input, { color: colors.text }]}
            placeholder={
              isDictating
                ? 'Listening…'
                : isStreaming
                  ? 'Reply — sends when the turn ends'
                  : 'Message'
            }
            placeholderTextColor={colors.textSecondary}
            value={value}
            onChangeText={onChangeText}
            multiline
            maxLength={10000}
            editable={!disabled}
            returnKeyType="default"
            blurOnSubmit={false}
          />

          <Pressable
            style={[
              styles.actionButton,
              {
                backgroundColor: isDictating
                  ? colors.destructive
                  : actionActive
                    ? colors.tint
                    : colors.backgroundElement,
              },
            ]}
            onPress={handleAction}
            disabled={actionDisabled}
            hitSlop={8}
            accessibilityRole="button"
            accessibilityLabel={
              isDictating
                ? 'Stop dictation'
                : willQueue
                  ? 'Queue follow-up message'
                  : canSend
                    ? 'Send message'
                    : 'Start dictation'
            }
          >
            {isTranscribing ? (
              <ActivityIndicator size="small" color={colors.textSecondary} />
            ) : (
              <Text
                style={[
                  styles.actionText,
                  { color: actionActive ? '#FFFFFF' : colors.textSecondary },
                  actionDisabled && styles.disabled,
                ]}
              >
                {isDictating ? '■' : canSend ? '↑' : 'Mic'}
              </Text>
            )}
          </Pressable>
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    paddingHorizontal: Spacing.md,
    paddingTop: Spacing.sm,
    paddingBottom: Platform.OS === 'ios' ? Spacing.xl : Spacing.md,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  feedback: {
    paddingHorizontal: Spacing.sm,
    paddingBottom: Spacing.xs,
  },
  feedbackText: {
    fontSize: FontSize.xs,
    textAlign: 'center',
  },
  row: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    gap: Spacing.sm,
  },
  stopButton: {
    width: 38,
    height: 38,
    borderRadius: 19,
    borderWidth: 1.5,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 5,
  },
  stopGlyph: {
    width: 11,
    height: 11,
    borderRadius: 2,
  },
  composer: {
    flex: 1,
    minHeight: 48,
    maxHeight: 140,
    borderRadius: 24,
    borderWidth: StyleSheet.hairlineWidth,
    flexDirection: 'row',
    alignItems: 'flex-end',
    paddingLeft: Spacing.md,
    paddingRight: 5,
    paddingVertical: 5,
  },
  input: {
    flex: 1,
    minHeight: 36,
    maxHeight: 128,
    fontSize: FontSize.md,
    lineHeight: 21,
    paddingTop: Platform.OS === 'ios' ? 8 : 5,
    paddingBottom: Platform.OS === 'ios' ? 7 : 5,
    paddingRight: Spacing.sm,
  },
  actionButton: {
    width: 38,
    height: 38,
    borderRadius: 19,
    alignItems: 'center',
    justifyContent: 'center',
  },
  actionText: {
    fontSize: FontSize.sm,
    fontWeight: '800',
  },
  disabled: {
    opacity: 0.4,
  },
});
