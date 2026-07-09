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
import { TranscriptionProvider } from '@/services/client-transcription';

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
  onToggleClientDictation?: () => void;
  onToggleSpriteRecording?: () => void;
  onPickAudioFile?: () => void;
  isClientDictating?: boolean;
  isSpriteRecording?: boolean;
  isTranscribingAudio?: boolean;
  dictationStatus?: string;
  dictationError?: string;
  onClearDictationError?: () => void;
  transcriptionProvider: TranscriptionProvider;
  onTranscriptionProviderChange: (provider: TranscriptionProvider) => void;
}

const TRANSCRIPTION_PROVIDER_OPTIONS: { label: string; value: TranscriptionProvider }[] = [
  { label: 'Sprite', value: 'sprite' },
  { label: 'Assembly', value: 'assemblyai' },
  { label: 'OpenAI', value: 'openai' },
];

const PROVIDER_OPTIONS: AgentProvider[] = ['claude', 'codex', 'codexAppServer'];

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
  onToggleClientDictation,
  onToggleSpriteRecording,
  onPickAudioFile,
  isClientDictating,
  isSpriteRecording,
  isTranscribingAudio,
  dictationStatus,
  dictationError,
  onClearDictationError,
  transcriptionProvider,
  onTranscriptionProviderChange,
}: ChatInputBarProps) {
  const colors = useTheme();

  const canSend = value.trim().length > 0 && !disabled;
  const dictationBusy = Boolean(isClientDictating || isSpriteRecording || isTranscribingAudio);
  const dictationUnavailable = Boolean(disabled || isStreaming);
  const clientDisabled = dictationUnavailable || Boolean(isTranscribingAudio || isSpriteRecording);
  const recordDisabled = dictationUnavailable || Boolean(isTranscribingAudio || isClientDictating);
  const fileDisabled = dictationUnavailable || dictationBusy;

  return (
    <View style={[styles.container, { backgroundColor: colors.background, borderTopColor: colors.border }]}>
      <View style={styles.providerRow}>
        <Text style={[styles.providerLabel, { color: colors.textSecondary }]}>Provider</Text>
        <View style={[styles.providerControl, { backgroundColor: colors.backgroundElement }]}>
          {PROVIDER_OPTIONS.map((option) => (
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

      <View style={styles.transcriptionProviderRow}>
        <Text style={[styles.providerLabel, { color: colors.textSecondary }]}>Transcribe</Text>
        <View style={[styles.providerControl, { backgroundColor: colors.backgroundElement }]}>
          {TRANSCRIPTION_PROVIDER_OPTIONS.map((option) => (
            <Pressable
              key={option.value}
              style={[
                styles.providerButton,
                transcriptionProvider === option.value && { backgroundColor: colors.card },
              ]}
              onPress={() => onTranscriptionProviderChange(option.value)}
              disabled={dictationBusy || isStreaming}
            >
              <Text
                style={[
                  styles.providerButtonText,
                  {
                    color:
                      transcriptionProvider === option.value
                        ? colors.tint
                        : colors.textSecondary,
                  },
                ]}
              >
                {option.label}
              </Text>
            </Pressable>
          ))}
        </View>
      </View>

      <View style={styles.dictationRow}>
        <View style={styles.dictationButtons}>
          <Pressable
            style={[
              styles.dictationButton,
              { borderColor: colors.border, backgroundColor: colors.backgroundElement },
              isClientDictating && { backgroundColor: colors.tint, borderColor: colors.tint },
            ]}
            onPress={onToggleClientDictation}
            disabled={!onToggleClientDictation || clientDisabled}
            hitSlop={6}
          >
            <Text
              style={[
                styles.dictationButtonText,
                { color: isClientDictating ? '#FFFFFF' : colors.textSecondary },
                (!onToggleClientDictation || clientDisabled) && styles.disabledText,
              ]}
            >
              {isClientDictating ? 'Stop' : 'Mic'}
            </Text>
          </Pressable>
          <Pressable
            style={[
              styles.dictationButton,
              { borderColor: colors.border, backgroundColor: colors.backgroundElement },
              isSpriteRecording && { backgroundColor: colors.destructive, borderColor: colors.destructive },
            ]}
            onPress={onToggleSpriteRecording}
            disabled={!onToggleSpriteRecording || recordDisabled}
            hitSlop={6}
          >
            <Text
              style={[
                styles.dictationButtonText,
                { color: isSpriteRecording ? '#FFFFFF' : colors.textSecondary },
                (!onToggleSpriteRecording || recordDisabled) && styles.disabledText,
              ]}
            >
              {isSpriteRecording ? 'Stop' : 'Rec'}
            </Text>
          </Pressable>
          <Pressable
            style={[
              styles.dictationButton,
              { borderColor: colors.border, backgroundColor: colors.backgroundElement },
            ]}
            onPress={onPickAudioFile}
            disabled={!onPickAudioFile || fileDisabled}
            hitSlop={6}
          >
            <Text
              style={[
                styles.dictationButtonText,
                { color: colors.textSecondary },
                (!onPickAudioFile || fileDisabled) && styles.disabledText,
              ]}
            >
              File
            </Text>
          </Pressable>
        </View>
        {(dictationStatus || dictationError) && (
          <Pressable
            style={styles.dictationMessageWrap}
            onPress={dictationError ? onClearDictationError : undefined}
            disabled={!dictationError}
          >
            <Text
              style={[
                styles.dictationMessage,
                { color: dictationError ? colors.destructive : colors.textSecondary },
              ]}
              numberOfLines={1}
            >
              {dictationError ?? dictationStatus}
            </Text>
          </Pressable>
        )}
      </View>

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
          placeholder={
            isStreaming
              ? `${providerDisplayName(provider)} is working — queue a message...`
              : 'Message...'
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
        {isStreaming ? (
          <>
            {canSend && (
              <Pressable
                style={[styles.sendButton, { backgroundColor: colors.tint }]}
                onPress={onSend}
                hitSlop={8}
              >
                <Text style={styles.sendIcon}>↑</Text>
              </Pressable>
            )}
            <Pressable
              style={[styles.sendButton, { backgroundColor: colors.destructive }]}
              onPress={onInterrupt}
              hitSlop={8}
            >
              <Text style={styles.sendIcon}>■</Text>
            </Pressable>
          </>
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
  transcriptionProviderRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: Spacing.sm,
  },
  providerButton: {
    borderRadius: 6,
    paddingHorizontal: Spacing.sm,
    paddingVertical: 5,
  },
  providerButtonText: {
    fontSize: FontSize.sm,
    fontWeight: '600',
  },
  dictationRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: Spacing.sm,
    marginBottom: Spacing.sm,
  },
  dictationButtons: {
    flexDirection: 'row',
    gap: Spacing.xs,
  },
  dictationButton: {
    minWidth: 44,
    height: 30,
    borderRadius: 8,
    borderWidth: StyleSheet.hairlineWidth,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: Spacing.sm,
  },
  dictationButtonText: {
    fontSize: FontSize.xs,
    fontWeight: '700',
  },
  disabledText: {
    opacity: 0.4,
  },
  dictationMessageWrap: {
    flex: 1,
    minWidth: 0,
  },
  dictationMessage: {
    fontSize: FontSize.xs,
    textAlign: 'right',
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
