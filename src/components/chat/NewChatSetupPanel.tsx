import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { FontSize, Spacing } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';
import { AgentEffort, providerDisplayName } from '@/models/chat';
import { SessionSettingsForm, SessionSettingsValue } from './SessionSettingsForm';

interface NewChatSetupPanelProps {
  spriteName: string;
  value: SessionSettingsValue;
  onChange: (value: SessionSettingsValue) => void;
  defaultClaudeModel?: string;
  defaultClaudeEffort?: AgentEffort;
  defaultCodexModel?: string;
  defaultCodexEffort?: AgentEffort;
}

/**
 * What an empty conversation shows instead of a blank transcript.
 *
 * Starting a conversation used to mean answering a modal before the chat even
 * opened. The ＋ button now opens the conversation directly and its empty space
 * — otherwise wasted on a placeholder — carries the same agent, model, effort
 * and directory controls. Settings stay editable here until the first message
 * locks them, so the flow is "open, adjust if you care, type".
 */
export function NewChatSetupPanel({
  spriteName,
  value,
  onChange,
  defaultClaudeModel,
  defaultClaudeEffort,
  defaultCodexModel,
  defaultCodexEffort,
}: NewChatSetupPanelProps) {
  const colors = useTheme();

  return (
    <View style={styles.container}>
      <Text style={[styles.title, { color: colors.text }]}>
        New conversation with {providerDisplayName(value.provider)}
      </Text>
      <Text style={[styles.subtitle, { color: colors.textSecondary }]}>
        Send a message to start this coding session on the sprite. These settings
        lock once the first message is sent.
      </Text>

      <SessionSettingsForm
        spriteName={spriteName}
        value={value}
        onChange={onChange}
        defaultClaudeModel={defaultClaudeModel}
        defaultClaudeEffort={defaultClaudeEffort}
        defaultCodexModel={defaultCodexModel}
        defaultCodexEffort={defaultCodexEffort}
      />

      <Text style={[styles.tip, { color: colors.textSecondary }]}>
        Tip: attach files with the paperclip — they are uploaded to the sprite and
        referenced by path. Long-press any message to copy or quote it, and send a
        follow-up while a turn runs — it queues.
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    paddingHorizontal: Spacing.lg,
    paddingTop: Spacing.lg,
    paddingBottom: Spacing.xxl,
  },
  title: {
    fontSize: FontSize.lg,
    fontWeight: '700',
  },
  subtitle: {
    fontSize: FontSize.sm,
    lineHeight: 20,
    marginTop: Spacing.xs,
  },
  tip: {
    fontSize: FontSize.xs,
    lineHeight: 17,
    marginTop: Spacing.xl,
  },
});
