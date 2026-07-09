import React, { useState } from 'react';
import {
  View,
  Text,
  TextInput,
  StyleSheet,
  Pressable,
  Switch,
  KeyboardAvoidingView,
  Platform,
  ScrollView,
} from 'react-native';
import { useTheme } from '@/hooks/use-theme';
import { FontSize, Spacing } from '@/constants/theme';
import { AgentProvider, providerDisplayName } from '@/models/chat';
import { normalizeWorkingDirectory } from '@/constants/session';
import { setSetting } from '@/services/storage';

export interface NewSessionConfig {
  workingDirectory: string;
  provider: AgentProvider;
}

interface NewSessionSheetProps {
  title?: string;
  confirmLabel?: string;
  defaultDirectory: string;
  defaultProvider: AgentProvider;
  /** Hide the provider picker (e.g. while we only support Claude). */
  showProviderPicker?: boolean;
  onClose: () => void;
  onCreate: (config: NewSessionConfig) => void;
}

const PROVIDERS: AgentProvider[] = ['claude', 'codex', 'codexAppServer'];

export function NewSessionSheet({
  title = 'New Session',
  confirmLabel = 'Start Session',
  defaultDirectory,
  defaultProvider,
  showProviderPicker = true,
  onClose,
  onCreate,
}: NewSessionSheetProps) {
  const colors = useTheme();
  const [directory, setDirectory] = useState(defaultDirectory);
  const [provider, setProvider] = useState<AgentProvider>(defaultProvider);
  const [rememberDirectory, setRememberDirectory] = useState(false);

  const handleCreate = async () => {
    const workingDirectory = normalizeWorkingDirectory(directory);
    if (rememberDirectory) {
      await setSetting('defaultWorkingDirectory', workingDirectory);
    }
    onCreate({ workingDirectory, provider });
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

          <Text style={[styles.label, { color: colors.textSecondary }]}>Working directory</Text>
          <TextInput
            style={[
              styles.input,
              {
                color: colors.text,
                backgroundColor: colors.inputBackground,
                borderColor: colors.border,
              },
            ]}
            placeholder="/home/sprite/your-repo"
            placeholderTextColor={colors.textSecondary}
            value={directory}
            onChangeText={setDirectory}
            autoCapitalize="none"
            autoCorrect={false}
            autoFocus
          />
          <Text style={[styles.hint, { color: colors.textSecondary }]}>
            The agent runs `cd` here before starting. Point it at the folder where you cloned
            your repo. It&apos;s created if it doesn&apos;t exist.
          </Text>

          <View style={styles.rememberRow}>
            <Text style={[styles.rememberLabel, { color: colors.text }]}>
              Remember as default
            </Text>
            <Switch
              value={rememberDirectory}
              onValueChange={setRememberDirectory}
              trackColor={{ false: colors.backgroundElement, true: colors.success }}
            />
          </View>

          {showProviderPicker && (
            <>
              <Text style={[styles.label, { color: colors.textSecondary }]}>Agent</Text>
              <View style={[styles.segmented, { backgroundColor: colors.backgroundElement }]}>
                {PROVIDERS.map((option) => (
                  <Pressable
                    key={option}
                    style={[
                      styles.segment,
                      provider === option && { backgroundColor: colors.card },
                    ]}
                    onPress={() => setProvider(option)}
                  >
                    <Text
                      style={[
                        styles.segmentText,
                        { color: provider === option ? colors.tint : colors.textSecondary },
                      ]}
                    >
                      {providerDisplayName(option)}
                    </Text>
                  </Pressable>
                ))}
              </View>
            </>
          )}

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
              <Text style={[styles.buttonText, { color: '#fff' }]}>{confirmLabel}</Text>
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
  label: {
    fontSize: FontSize.xs,
    fontWeight: '600',
    textTransform: 'uppercase',
    letterSpacing: 0.4,
    marginBottom: Spacing.sm,
    marginTop: Spacing.md,
  },
  input: {
    fontSize: FontSize.md,
    padding: Spacing.md,
    borderRadius: 10,
    borderWidth: 1,
  },
  hint: {
    fontSize: FontSize.xs,
    lineHeight: 17,
    marginTop: Spacing.sm,
  },
  rememberRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginTop: Spacing.md,
  },
  rememberLabel: {
    fontSize: FontSize.md,
  },
  segmented: {
    flexDirection: 'row',
    borderRadius: 8,
    padding: 2,
  },
  segment: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: Spacing.sm,
    borderRadius: 6,
  },
  segmentText: {
    fontSize: FontSize.sm,
    fontWeight: '600',
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
