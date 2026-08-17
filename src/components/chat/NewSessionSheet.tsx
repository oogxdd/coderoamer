import React, { useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  Pressable,
  KeyboardAvoidingView,
  Platform,
  ScrollView,
} from 'react-native';
import { useTheme } from '@/hooks/use-theme';
import { FontSize, Spacing } from '@/constants/theme';
import { AgentEffort, AgentProvider, normalizeAgentEffortForProvider } from '@/models/chat';
import { normalizeWorkingDirectory } from '@/constants/session';
import { setSetting } from '@/services/storage';
import { SessionSettingsForm, SessionSettingsValue } from './SessionSettingsForm';

export type NewSessionConfig = SessionSettingsValue;

interface NewSessionSheetProps {
  spriteName: string;
  title?: string;
  confirmLabel?: string;
  defaultDirectory: string;
  defaultProvider: AgentProvider;
  defaultModel: string;
  defaultEffort: AgentEffort;
  defaultClaudeModel?: string;
  defaultClaudeEffort?: AgentEffort;
  defaultCodexModel?: string;
  defaultCodexEffort?: AgentEffort;
  /** Hide the provider picker (e.g. while we only support Claude). */
  showProviderPicker?: boolean;
  locked?: boolean;
  onClose: () => void;
  onCreate: (config: NewSessionConfig) => void;
}

/**
 * Modal editor for a conversation's agent settings.
 *
 * New conversations no longer come through here — pressing ＋ opens the chat
 * straight away and its empty state hosts the same fields inline (see
 * `SessionSettingsForm`). This sheet remains the way to review or change an
 * existing conversation's settings from the chat header.
 */
export function NewSessionSheet({
  spriteName,
  title = 'New Session',
  confirmLabel = 'Start Session',
  defaultDirectory,
  defaultProvider,
  defaultModel,
  defaultEffort,
  defaultClaudeModel = 'sonnet',
  defaultClaudeEffort = 'high',
  defaultCodexModel = '',
  defaultCodexEffort = 'high',
  showProviderPicker = true,
  locked = false,
  onClose,
  onCreate,
}: NewSessionSheetProps) {
  const colors = useTheme();
  const [value, setValue] = useState<SessionSettingsValue>({
    workingDirectory: defaultDirectory,
    provider: defaultProvider,
    model: defaultModel,
    effort: normalizeAgentEffortForProvider(defaultProvider, defaultEffort) ?? 'high',
  });
  const [rememberDirectory, setRememberDirectory] = useState(false);

  const handleCreate = async () => {
    if (locked) {
      onClose();
      return;
    }
    const workingDirectory = normalizeWorkingDirectory(value.workingDirectory);
    if (rememberDirectory) {
      await setSetting('defaultWorkingDirectory', workingDirectory);
    }
    onCreate({ ...value, workingDirectory, model: value.model.trim() });
  };

  return (
    <KeyboardAvoidingView
      behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
      style={[styles.overlay, { backgroundColor: 'rgba(0,0,0,0.5)' }]}
    >
      <Pressable style={styles.backdrop} onPress={onClose} />
      <View style={[styles.sheet, { backgroundColor: colors.card }]}>
        <ScrollView keyboardShouldPersistTaps="handled">
          <Text style={[styles.title, { color: colors.text }]}>{title}</Text>

          {locked && (
            <View style={[styles.lockedNotice, { backgroundColor: colors.backgroundElement }]}>
              <Text style={[styles.lockedNoticeText, { color: colors.textSecondary }]}>
                Agent, model, effort, and directory are locked after the first message.
              </Text>
            </View>
          )}

          <SessionSettingsForm
            spriteName={spriteName}
            value={value}
            onChange={setValue}
            locked={locked}
            showProviderPicker={showProviderPicker}
            defaultClaudeModel={defaultClaudeModel}
            defaultClaudeEffort={defaultClaudeEffort}
            defaultCodexModel={defaultCodexModel}
            defaultCodexEffort={defaultCodexEffort}
            rememberDirectory={rememberDirectory}
            onRememberDirectoryChange={setRememberDirectory}
            autoFocusDirectory
          />

          <View style={styles.buttons}>
            <Pressable
              style={[styles.button, { backgroundColor: colors.backgroundElement }]}
              onPress={onClose}
            >
              <Text style={[styles.buttonText, { color: colors.text }]}>Cancel</Text>
            </Pressable>
            <Pressable
              style={[styles.button, { backgroundColor: colors.tint }]}
              onPress={handleCreate}
            >
              <Text style={[styles.buttonText, { color: '#fff' }]}>
                {locked ? 'Done' : confirmLabel}
              </Text>
            </Pressable>
          </View>
        </ScrollView>
      </View>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  overlay: {
    ...StyleSheet.absoluteFillObject,
    justifyContent: 'flex-end',
  },
  backdrop: {
    flex: 1,
  },
  sheet: {
    borderTopLeftRadius: 16,
    borderTopRightRadius: 16,
    padding: Spacing.xl,
    paddingBottom: 40,
    maxHeight: '85%',
  },
  title: {
    fontSize: FontSize.xl,
    fontWeight: '700',
    marginBottom: Spacing.lg,
  },
  lockedNotice: {
    borderRadius: 10,
    padding: Spacing.md,
    marginBottom: Spacing.sm,
  },
  lockedNoticeText: {
    fontSize: FontSize.sm,
    lineHeight: 19,
  },
  buttons: {
    flexDirection: 'row',
    gap: Spacing.md,
    marginTop: Spacing.xl,
  },
  button: {
    flex: 1,
    paddingVertical: Spacing.md,
    borderRadius: 10,
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: 44,
  },
  buttonText: {
    fontSize: FontSize.lg,
    fontWeight: '600',
  },
});
