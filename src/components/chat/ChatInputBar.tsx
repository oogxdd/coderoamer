import React from 'react';
import {
  View,
  TextInput,
  StyleSheet,
  Pressable,
  Text,
  Platform,
} from 'react-native';
import { useTheme } from '@/hooks/use-theme';
import { FontSize, Spacing } from '@/constants/theme';
import { AgentProvider, providerDisplayName } from '@/models/chat';

interface ChatInputBarProps {
  value: string;
  onChangeText: (text: string) => void;
  onSend: () => void;
  onInterrupt?: () => void;
  isStreaming: boolean;
  disabled?: boolean;
  provider: AgentProvider;
  providerLocked?: boolean;
  onProviderChange: (provider: AgentProvider) => void;
}

export function ChatInputBar({
  value,
  onChangeText,
  onSend,
  onInterrupt,
  isStreaming,
  disabled,
  provider,
  providerLocked,
  onProviderChange,
}: ChatInputBarProps) {
  const colors = useTheme();

  const canSend = value.trim().length > 0 && !disabled;

  return (
    <View style={[styles.container, { backgroundColor: colors.background, borderTopColor: colors.border }]}>
      <View style={styles.providerRow}>
        <Text style={[styles.providerLabel, { color: colors.textSecondary }]}>Provider</Text>
        <View style={[styles.providerControl, { backgroundColor: colors.backgroundElement }]}>
          {(['claude', 'codex', 'crush'] as AgentProvider[]).map((option) => (
            <Pressable
              key={option}
              style={[
                styles.providerButton,
                provider === option && { backgroundColor: colors.card },
              ]}
            onPress={() => onProviderChange(option)}
            disabled={isStreaming || providerLocked}
            >
              <Text
                style={[
                  styles.providerButtonText,
                  { color: provider === option ? colors.tint : colors.textSecondary },
                ]}
              >
                {providerDisplayName(option)}
              </Text>
            </Pressable>
          ))}
        </View>
      </View>
      {providerLocked && (
        <Text style={[styles.providerLockHint, { color: colors.textSecondary }]}>
          Session model is locked after the first message.
        </Text>
      )}

      <View style={styles.inputRow}>
        <TextInput
          style={[
            styles.input,
            {
              color: colors.text,
              backgroundColor: colors.inputBackground,
              borderColor: colors.border,
            },
          ]}
          placeholder={isStreaming ? `${providerDisplayName(provider)} is working...` : 'Message...'}
          placeholderTextColor={colors.textSecondary}
          value={value}
          onChangeText={onChangeText}
          multiline
          maxLength={10000}
          editable={!disabled}
          returnKeyType="default"
          blurOnSubmit={false}
        />
        {isStreaming ? (
          <Pressable
            style={[styles.sendButton, { backgroundColor: colors.destructive }]}
            onPress={onInterrupt}
            hitSlop={8}
          >
            <Text style={styles.sendIcon}>■</Text>
          </Pressable>
        ) : (
          <Pressable
            style={[
              styles.sendButton,
              { backgroundColor: canSend ? colors.tint : colors.backgroundElement },
            ]}
            onPress={onSend}
            disabled={!canSend}
            hitSlop={8}
          >
            <Text style={[styles.sendIcon, { opacity: canSend ? 1 : 0.4 }]}>↑</Text>
          </Pressable>
        )}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    paddingHorizontal: Spacing.lg,
    paddingTop: Spacing.sm,
    paddingBottom: Platform.OS === 'ios' ? Spacing.xl : Spacing.md,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  providerRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: Spacing.sm,
  },
  providerLabel: {
    fontSize: FontSize.xs,
    fontWeight: '600',
    textTransform: 'uppercase',
    letterSpacing: 0.4,
  },
  providerControl: {
    flexDirection: 'row',
    borderRadius: 8,
    padding: 2,
  },
  providerLockHint: {
    fontSize: FontSize.xs,
    marginBottom: Spacing.xs,
  },
  providerButton: {
    borderRadius: 6,
    paddingHorizontal: Spacing.md,
    paddingVertical: 5,
  },
  providerButtonText: {
    fontSize: FontSize.sm,
    fontWeight: '600',
  },
  inputRow: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    gap: Spacing.sm,
  },
  input: {
    flex: 1,
    fontSize: FontSize.md,
    paddingHorizontal: Spacing.md,
    paddingTop: Platform.OS === 'ios' ? Spacing.md : Spacing.sm,
    paddingBottom: Platform.OS === 'ios' ? Spacing.md : Spacing.sm,
    borderRadius: 20,
    borderWidth: 1,
    maxHeight: 120,
    minHeight: 40,
  },
  sendButton: {
    width: 34,
    height: 34,
    borderRadius: 17,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 3,
  },
  sendIcon: {
    color: '#FFFFFF',
    fontSize: 18,
    fontWeight: '700',
  },
});
