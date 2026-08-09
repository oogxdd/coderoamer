import React, { useEffect, useState } from 'react';
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
import {
  AgentEffort,
  AgentProvider,
  effortDisplayName,
  isCodexProvider,
  normalizeAgentEffortForProvider,
  providerDisplayName,
} from '@/models/chat';
import { normalizeWorkingDirectory } from '@/constants/session';
import { setSetting } from '@/services/storage';
import {
  cacheCodexModels,
  CodexModelOption,
  getCachedCodexModels,
  listCodexModels,
} from '@/services/codex-models';
import { CodexModelPicker } from './CodexModelPicker';

export interface NewSessionConfig {
  workingDirectory: string;
  provider: AgentProvider;
  model: string;
  effort: AgentEffort;
}

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

const PROVIDERS: AgentProvider[] = ['claude', 'codexAppServer', 'codex'];
const CLAUDE_MODELS = ['sonnet', 'opus', 'haiku'] as const;
const CLAUDE_EFFORTS: AgentEffort[] = ['low', 'medium', 'high', 'xhigh', 'max'];
const CODEX_EFFORTS: AgentEffort[] = ['none', 'low', 'medium', 'high', 'xhigh'];

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
  const [directory, setDirectory] = useState(defaultDirectory);
  const [provider, setProvider] = useState<AgentProvider>(defaultProvider);
  const [model, setModel] = useState(defaultModel);
  const [effort, setEffort] = useState<AgentEffort>(
    normalizeAgentEffortForProvider(defaultProvider, defaultEffort) ?? 'high'
  );
  const [rememberDirectory, setRememberDirectory] = useState(false);
  const [codexModels, setCodexModels] = useState<CodexModelOption[]>([]);
  const [loadingCodexModels, setLoadingCodexModels] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    let active = true;
    void getCachedCodexModels().then((cached) => {
      if (active && cached.length > 0) setCodexModels(cached);
    });
    setLoadingCodexModels(true);
    void listCodexModels(spriteName, controller.signal)
      .then((models) => {
        if (!active || models.length === 0) return;
        setCodexModels(models);
        return cacheCodexModels(models);
      })
      .catch(() => {
        // The default/custom choices remain usable when a sprite is offline.
      })
      .finally(() => {
        if (active) setLoadingCodexModels(false);
      });
    return () => {
      active = false;
      controller.abort();
    };
  }, [spriteName]);

  const handleCreate = async () => {
    if (locked) {
      onClose();
      return;
    }
    const workingDirectory = normalizeWorkingDirectory(directory);
    if (rememberDirectory) {
      await setSetting('defaultWorkingDirectory', workingDirectory);
    }
    onCreate({ workingDirectory, provider, model: model.trim(), effort });
  };

  const handleProviderChange = (nextProvider: AgentProvider) => {
    setProvider(nextProvider);
    if (isCodexProvider(nextProvider)) {
      setModel(defaultCodexModel);
      setEffort(normalizeAgentEffortForProvider(nextProvider, defaultCodexEffort) ?? 'high');
    } else {
      setModel(defaultClaudeModel);
      setEffort(normalizeAgentEffortForProvider(nextProvider, defaultClaudeEffort) ?? 'high');
    }
  };

  const effortOptions = isCodexProvider(provider) ? CODEX_EFFORTS : CLAUDE_EFFORTS;
  const selectedCodexModel = codexModels.find((option) => option.model === model);
  const visibleEffortOptions =
    isCodexProvider(provider) && selectedCodexModel?.supportedReasoningEfforts.length
      ? selectedCodexModel.supportedReasoningEfforts
      : effortOptions;

  const handleCodexModelChange = (nextModel: string) => {
    setModel(nextModel);
    const option = codexModels.find((candidate) => candidate.model === nextModel);
    if (
      option?.supportedReasoningEfforts.length &&
      !option.supportedReasoningEfforts.includes(effort)
    ) {
      setEffort(option.defaultReasoningEffort ?? option.supportedReasoningEfforts[0]);
    }
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
            editable={!locked}
            autoCapitalize="none"
            autoCorrect={false}
            autoFocus={!locked}
          />
          <Text style={[styles.hint, { color: colors.textSecondary }]}>
            The agent runs `cd` here before starting. Defaults to the sprite home
            (<Text style={styles.mono}>/home/sprite</Text>); point it at the folder where you
            cloned your repo. It&apos;s created if it doesn&apos;t exist.
          </Text>

          {!locked && (
            <View style={styles.rememberRow}>
              <Text style={[styles.rememberLabel, { color: colors.text }]}>
                Remember directory as default
              </Text>
              <Switch
                value={rememberDirectory}
                onValueChange={setRememberDirectory}
                trackColor={{ false: colors.backgroundElement, true: colors.success }}
              />
            </View>
          )}

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
                    onPress={() => handleProviderChange(option)}
                    disabled={locked}
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

          <Text style={[styles.label, { color: colors.textSecondary }]}>Model</Text>
          {isCodexProvider(provider) ? (
            <CodexModelPicker
              models={codexModels}
              value={model}
              onChange={handleCodexModelChange}
              loading={loadingCodexModels}
              disabled={locked}
            />
          ) : (
            <View style={[styles.segmented, { backgroundColor: colors.backgroundElement }]}>
              {CLAUDE_MODELS.map((option) => (
                <Pressable
                  key={option}
                  style={[
                    styles.segment,
                    model === option && { backgroundColor: colors.card },
                  ]}
                  onPress={() => setModel(option)}
                  disabled={locked}
                >
                  <Text
                    style={[
                      styles.segmentText,
                      { color: model === option ? colors.tint : colors.textSecondary },
                    ]}
                  >
                    {option.charAt(0).toUpperCase() + option.slice(1)}
                  </Text>
                </Pressable>
              ))}
            </View>
          )}

          <Text style={[styles.label, { color: colors.textSecondary }]}>Effort</Text>
          <View style={styles.effortGrid}>
            {visibleEffortOptions.map((option) => (
              <Pressable
                key={option}
                style={[
                  styles.effortChip,
                  { borderColor: colors.border, backgroundColor: colors.backgroundElement },
                  effort === option && { borderColor: colors.tint, backgroundColor: colors.tint + '12' },
                ]}
                onPress={() => setEffort(option)}
                disabled={locked}
              >
                <Text
                  style={[
                    styles.effortChipText,
                    { color: effort === option ? colors.tint : colors.textSecondary },
                  ]}
                >
                  {effortDisplayName(option)}
                </Text>
              </Pressable>
            ))}
          </View>

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
  mono: {
    fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
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
    fontSize: FontSize.xs,
    fontWeight: '600',
  },
  effortGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: Spacing.sm,
  },
  effortChip: {
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 999,
    paddingHorizontal: Spacing.md,
    paddingVertical: Spacing.sm,
  },
  effortChipText: {
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
