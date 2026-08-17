import React, { useEffect, useState } from 'react';
import { Platform, Pressable, StyleSheet, Switch, Text, TextInput, View } from 'react-native';
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
import {
  cacheCodexModels,
  CodexModelOption,
  getCachedCodexModels,
  listCodexModels,
} from '@/services/codex-models';
import { CodexModelPicker } from './CodexModelPicker';

export interface SessionSettingsValue {
  workingDirectory: string;
  provider: AgentProvider;
  model: string;
  effort: AgentEffort;
}

interface SessionSettingsFormProps {
  spriteName: string;
  value: SessionSettingsValue;
  onChange: (value: SessionSettingsValue) => void;
  /** Read-only once the conversation has started. */
  locked?: boolean;
  showProviderPicker?: boolean;
  defaultClaudeModel?: string;
  defaultClaudeEffort?: AgentEffort;
  defaultCodexModel?: string;
  defaultCodexEffort?: AgentEffort;
  /** "Remember directory as default" — only meaningful when creating. */
  rememberDirectory?: boolean;
  onRememberDirectoryChange?: (remember: boolean) => void;
  autoFocusDirectory?: boolean;
}

const PROVIDERS: AgentProvider[] = ['claude', 'codexAppServer', 'codex'];
const CLAUDE_MODELS = ['sonnet', 'opus', 'haiku'] as const;
const CLAUDE_EFFORTS: AgentEffort[] = ['low', 'medium', 'high', 'xhigh', 'max'];
const CODEX_EFFORTS: AgentEffort[] = ['none', 'low', 'medium', 'high', 'xhigh'];

/**
 * Agent / model / effort / working directory, as one controlled block.
 *
 * Shared on purpose by the "Chat Settings" sheet and the inline setup panel a
 * new conversation opens on: a session's configuration should look and behave
 * the same wherever it's edited, and the two must never drift apart in which
 * options they offer.
 */
export function SessionSettingsForm({
  spriteName,
  value,
  onChange,
  locked = false,
  showProviderPicker = true,
  defaultClaudeModel = 'sonnet',
  defaultClaudeEffort = 'high',
  defaultCodexModel = '',
  defaultCodexEffort = 'high',
  rememberDirectory,
  onRememberDirectoryChange,
  autoFocusDirectory = false,
}: SessionSettingsFormProps) {
  const colors = useTheme();
  const [codexModels, setCodexModels] = useState<CodexModelOption[]>([]);
  const [loadingCodexModels, setLoadingCodexModels] = useState(false);
  // The directory is edited locally and committed on blur: patching the chat on
  // every keystroke would write a row per character.
  const [directoryDraft, setDirectoryDraft] = useState(value.workingDirectory);

  useEffect(() => {
    setDirectoryDraft(value.workingDirectory);
  }, [value.workingDirectory]);

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

  const handleProviderChange = (nextProvider: AgentProvider) => {
    if (isCodexProvider(nextProvider)) {
      onChange({
        ...value,
        provider: nextProvider,
        model: defaultCodexModel,
        effort: normalizeAgentEffortForProvider(nextProvider, defaultCodexEffort) ?? 'high',
      });
    } else {
      onChange({
        ...value,
        provider: nextProvider,
        model: defaultClaudeModel,
        effort: normalizeAgentEffortForProvider(nextProvider, defaultClaudeEffort) ?? 'high',
      });
    }
  };

  const effortOptions = isCodexProvider(value.provider) ? CODEX_EFFORTS : CLAUDE_EFFORTS;
  const selectedCodexModel = codexModels.find((option) => option.model === value.model);
  const visibleEffortOptions =
    isCodexProvider(value.provider) && selectedCodexModel?.supportedReasoningEfforts.length
      ? selectedCodexModel.supportedReasoningEfforts
      : effortOptions;

  const handleCodexModelChange = (nextModel: string) => {
    const option = codexModels.find((candidate) => candidate.model === nextModel);
    const keepsEffort =
      !option?.supportedReasoningEfforts.length ||
      option.supportedReasoningEfforts.includes(value.effort);
    onChange({
      ...value,
      model: nextModel,
      effort: keepsEffort
        ? value.effort
        : option?.defaultReasoningEffort ?? option!.supportedReasoningEfforts[0],
    });
  };

  return (
    <View>
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
        value={directoryDraft}
        onChangeText={setDirectoryDraft}
        onBlur={() => onChange({ ...value, workingDirectory: directoryDraft })}
        onSubmitEditing={() => onChange({ ...value, workingDirectory: directoryDraft })}
        editable={!locked}
        autoCapitalize="none"
        autoCorrect={false}
        autoFocus={autoFocusDirectory && !locked}
      />
      <Text style={[styles.hint, { color: colors.textSecondary }]}>
        The agent runs `cd` here before starting. Defaults to the sprite home
        (<Text style={styles.mono}>/home/sprite</Text>); point it at the folder where you
        cloned your repo. It&apos;s created if it doesn&apos;t exist.
      </Text>

      {!locked && onRememberDirectoryChange ? (
        <View style={styles.rememberRow}>
          <Text style={[styles.rememberLabel, { color: colors.text }]}>
            Remember directory as default
          </Text>
          <Switch
            value={!!rememberDirectory}
            onValueChange={onRememberDirectoryChange}
            trackColor={{ false: colors.backgroundElement, true: colors.success }}
          />
        </View>
      ) : null}

      {showProviderPicker && (
        <>
          <Text style={[styles.label, { color: colors.textSecondary }]}>Agent</Text>
          <View style={[styles.segmented, { backgroundColor: colors.backgroundElement }]}>
            {PROVIDERS.map((option) => (
              <Pressable
                key={option}
                style={[
                  styles.segment,
                  value.provider === option && { backgroundColor: colors.card },
                ]}
                onPress={() => handleProviderChange(option)}
                disabled={locked}
              >
                <Text
                  style={[
                    styles.segmentText,
                    { color: value.provider === option ? colors.tint : colors.textSecondary },
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
      {isCodexProvider(value.provider) ? (
        <CodexModelPicker
          models={codexModels}
          value={value.model}
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
                value.model === option && { backgroundColor: colors.card },
              ]}
              onPress={() => onChange({ ...value, model: option })}
              disabled={locked}
            >
              <Text
                style={[
                  styles.segmentText,
                  { color: value.model === option ? colors.tint : colors.textSecondary },
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
              value.effort === option && {
                borderColor: colors.tint,
                backgroundColor: colors.tint + '12',
              },
            ]}
            onPress={() => onChange({ ...value, effort: option })}
            disabled={locked}
          >
            <Text
              style={[
                styles.effortChipText,
                { color: value.effort === option ? colors.tint : colors.textSecondary },
              ]}
            >
              {effortDisplayName(option)}
            </Text>
          </Pressable>
        ))}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
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
});
