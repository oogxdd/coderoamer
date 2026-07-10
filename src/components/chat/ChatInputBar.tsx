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
  const canSend = hasText && !disabled && !isStreaming;
  const canDictate = Boolean(onToggleDictation && !disabled && !isStreaming && !isTranscribing);

  const handleAction = () => {
    if (isStreaming) {
      onInterrupt?.();
    } else if (isDictating) {
      onToggleDictation?.();
    } else if (canSend) {
      onSend();
    } else if (!hasText && canDictate) {
      onToggleDictation?.();
    }
  };

  const actionDisabled = isTranscribing || (!isStreaming && !isDictating && !canSend && !canDictate);
  const actionActive = isStreaming || isDictating || canSend;
  const actionDestructive = isStreaming || isDictating;

  return (
    <View
      style={[
        styles.container,
        { backgroundColor: colors.background, borderTopColor: colors.border },
      ]}
    >
      {(dictationStatus || dictationError) && (
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
            {dictationError ?? dictationStatus}
          </Text>
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
                ? `${providerDisplayName(provider)} is working…`
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
              backgroundColor: actionDestructive
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
            isStreaming
              ? 'Stop response'
              : isDictating
                ? 'Stop dictation'
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
              {isStreaming || isDictating ? '■' : canSend ? '↑' : 'Mic'}
            </Text>
          )}
        </Pressable>
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
  composer: {
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
