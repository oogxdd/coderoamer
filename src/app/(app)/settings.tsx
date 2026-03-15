import React, { useState, useEffect, useCallback } from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  Pressable,
  TextInput,
  Switch,
  Alert,
  ActivityIndicator,
} from 'react-native';
import { router } from 'expo-router';
import { useAuth } from '@/contexts/AuthContext';
import { useTheme } from '@/hooks/use-theme';
import { getSetting, setSetting, getSettingBool, setSettingBool } from '@/services/storage';
import { FontSize, Spacing } from '@/constants/theme';
import { AgentProvider } from '@/models/chat';

type ClaudeModel = 'sonnet' | 'opus' | 'haiku';
type MaxTurns = 0 | 5 | 10 | 25 | 50;
type ProviderOption = { label: string; value: AgentProvider };

const PROVIDER_OPTIONS: ProviderOption[] = [
  { label: 'Claude', value: 'claude' },
  { label: 'Codex', value: 'codex' },
];

const MODEL_OPTIONS: { label: string; value: ClaudeModel }[] = [
  { label: 'Sonnet', value: 'sonnet' },
  { label: 'Opus', value: 'opus' },
  { label: 'Haiku', value: 'haiku' },
];

const MAX_TURNS_OPTIONS: { label: string; value: MaxTurns }[] = [
  { label: 'Unlimited', value: 0 },
  { label: '5', value: 5 },
  { label: '10', value: 10 },
  { label: '25', value: 25 },
  { label: '50', value: 50 },
];

export default function SettingsScreen() {
  const colors = useTheme();
  const auth = useAuth();

  const [isLoadingSettings, setIsLoadingSettings] = useState(true);

  // Claude Configuration
  const [defaultProvider, setDefaultProvider] = useState<AgentProvider>('claude');
  const [claudeModel, setClaudeModel] = useState<ClaudeModel>('sonnet');
  const [maxTurns, setMaxTurns] = useState<MaxTurns>(0);
  const [customInstructions, setCustomInstructions] = useState('');

  // Git Identity
  const [gitName, setGitName] = useState('');
  const [gitEmail, setGitEmail] = useState('');

  // Preferences
  const [autoCheckpoint, setAutoCheckpoint] = useState(false);

  // Load all settings on mount
  useEffect(() => {
    (async () => {
      try {
        const [providerSetting, model, turns, instructions, name, email, checkpoint] =
          await Promise.all([
            getSetting('defaultProvider'),
            getSetting('claudeModel'),
            getSetting('maxTurns'),
            getSetting('customInstructions'),
            getSetting('gitName'),
            getSetting('gitEmail'),
            getSettingBool('autoCheckpoint'),
          ]);

        if (providerSetting === 'claude' || providerSetting === 'codex') {
          setDefaultProvider(providerSetting as AgentProvider);
        }
        if (model && ['sonnet', 'opus', 'haiku'].includes(model)) {
          setClaudeModel(model as ClaudeModel);
        }
        if (turns !== null) {
          const parsed = parseInt(turns, 10);
          if ([0, 5, 10, 25, 50].includes(parsed)) {
            setMaxTurns(parsed as MaxTurns);
          }
        }
        if (instructions !== null) setCustomInstructions(instructions);
        if (name !== null) setGitName(name);
        if (email !== null) setGitEmail(email);
        setAutoCheckpoint(checkpoint);
      } catch {
        // Settings load failed silently
      }
      setIsLoadingSettings(false);
    })();
  }, []);

  // Auto-save helpers
  const handleModelChange = useCallback(async (model: ClaudeModel) => {
    setClaudeModel(model);
    await setSetting('claudeModel', model);
  }, []);

  const handleDefaultProviderChange = useCallback(async (nextProvider: AgentProvider) => {
    setDefaultProvider(nextProvider);
    await setSetting('defaultProvider', nextProvider);
  }, []);

  const handleMaxTurnsChange = useCallback(async (turns: MaxTurns) => {
    setMaxTurns(turns);
    await setSetting('maxTurns', String(turns));
  }, []);

  const handleCustomInstructionsChange = useCallback(async (text: string) => {
    setCustomInstructions(text);
    await setSetting('customInstructions', text);
  }, []);

  const handleGitNameChange = useCallback(async (text: string) => {
    setGitName(text);
    await setSetting('gitName', text);
  }, []);

  const handleGitEmailChange = useCallback(async (text: string) => {
    setGitEmail(text);
    await setSetting('gitEmail', text);
  }, []);

  const handleAutoCheckpointChange = useCallback(async (value: boolean) => {
    setAutoCheckpoint(value);
    await setSettingBool('autoCheckpoint', value);
  }, []);

  const handleSignOut = useCallback(() => {
    Alert.alert(
      'Sign Out',
      'This will remove all saved tokens and sign you out. Are you sure?',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Sign Out',
          style: 'destructive',
          onPress: () => auth.signOut(),
        },
      ]
    );
  }, [auth]);

  if (isLoadingSettings) {
    return (
      <View style={[styles.loadingContainer, { backgroundColor: colors.backgroundSecondary }]}>
        <ActivityIndicator size="large" color={colors.tint} />
      </View>
    );
  }

  return (
    <ScrollView
      style={[styles.container, { backgroundColor: colors.backgroundSecondary }]}
      contentContainerStyle={styles.contentContainer}
      keyboardDismissMode="on-drag"
    >
      {/* Account Section */}
      <Text style={[styles.sectionHeader, { color: colors.textSecondary }]}>ACCOUNT</Text>
      <View style={[styles.sectionCard, { backgroundColor: colors.card }]}>
        <View style={[styles.row, styles.rowWithBorder, { borderBottomColor: colors.border }]}>
          <Text style={[styles.rowLabel, { color: colors.text }]}>Sprites API</Text>
          <View style={styles.statusContainer}>
            <View
              style={[
                styles.statusDot,
                { backgroundColor: auth.isAuthenticated ? colors.success : colors.destructive },
              ]}
            />
            <Text style={[styles.statusText, { color: colors.textSecondary }]}>
              {auth.isAuthenticated ? 'Connected' : 'Not Connected'}
            </Text>
          </View>
        </View>

        <View style={styles.row}>
          <Text style={[styles.rowLabel, { color: colors.text }]}>Claude Code Token</Text>
          <View style={styles.statusContainer}>
            <View
              style={[
                styles.statusDot,
                { backgroundColor: auth.hasClaudeToken ? colors.success : colors.warning },
              ]}
            />
            <Text style={[styles.statusText, { color: colors.textSecondary }]}>
              {auth.hasClaudeToken ? 'Saved' : 'Not Set'}
            </Text>
          </View>
        </View>
      </View>

      <Pressable
        style={({ pressed }) => [
          styles.signOutButton,
          { backgroundColor: colors.card, opacity: pressed ? 0.7 : 1 },
        ]}
        onPress={handleSignOut}
      >
        <Text style={[styles.signOutText, { color: colors.destructive }]}>Sign Out</Text>
      </Pressable>

      <Text style={[styles.sectionHeader, { color: colors.textSecondary }]}>DEFAULT AGENT</Text>
      <View style={[styles.sectionCard, { backgroundColor: colors.card }]}>
        <View style={styles.pickerRow}>
          <View style={[styles.segmentedControl, { backgroundColor: colors.backgroundElement }]}>
            {PROVIDER_OPTIONS.map((option) => (
              <Pressable
                key={option.value}
                style={[
                  styles.segmentButton,
                  defaultProvider === option.value && {
                    backgroundColor: colors.card,
                    shadowColor: '#000',
                    shadowOffset: { width: 0, height: 1 },
                    shadowOpacity: 0.15,
                    shadowRadius: 2,
                    elevation: 2,
                  },
                ]}
                onPress={() => handleDefaultProviderChange(option.value)}
              >
                <Text
                  style={[
                    styles.segmentText,
                    { color: defaultProvider === option.value ? colors.tint : colors.textSecondary },
                  ]}
                >
                  {option.label}
                </Text>
              </Pressable>
            ))}
          </View>
        </View>
      </View>

      {/* Claude Configuration Section */}
      <Text style={[styles.sectionHeader, { color: colors.textSecondary }]}>
        CLAUDE CONFIGURATION
      </Text>
      <View style={[styles.sectionCard, { backgroundColor: colors.card }]}>
        {/* Model Picker */}
        <View style={[styles.row, styles.rowWithBorder, { borderBottomColor: colors.border }]}>
          <Text style={[styles.rowLabel, { color: colors.text }]}>Model</Text>
        </View>
        <View
          style={[
            styles.pickerRow,
            styles.rowWithBorder,
            { borderBottomColor: colors.border },
          ]}
        >
          <View style={[styles.segmentedControl, { backgroundColor: colors.backgroundElement }]}>
            {MODEL_OPTIONS.map((option) => (
              <Pressable
                key={option.value}
                style={[
                  styles.segmentButton,
                  claudeModel === option.value && {
                    backgroundColor: colors.card,
                    shadowColor: '#000',
                    shadowOffset: { width: 0, height: 1 },
                    shadowOpacity: 0.15,
                    shadowRadius: 2,
                    elevation: 2,
                  },
                ]}
                onPress={() => handleModelChange(option.value)}
              >
                <Text
                  style={[
                    styles.segmentText,
                    { color: claudeModel === option.value ? colors.tint : colors.textSecondary },
                  ]}
                >
                  {option.label}
                </Text>
              </Pressable>
            ))}
          </View>
        </View>

        {/* Max Turns Picker */}
        <View style={[styles.row, styles.rowWithBorder, { borderBottomColor: colors.border }]}>
          <Text style={[styles.rowLabel, { color: colors.text }]}>Max Turns</Text>
        </View>
        <View
          style={[
            styles.pickerRow,
            styles.rowWithBorder,
            { borderBottomColor: colors.border },
          ]}
        >
          <View style={[styles.segmentedControl, { backgroundColor: colors.backgroundElement }]}>
            {MAX_TURNS_OPTIONS.map((option) => (
              <Pressable
                key={option.value}
                style={[
                  styles.segmentButton,
                  maxTurns === option.value && {
                    backgroundColor: colors.card,
                    shadowColor: '#000',
                    shadowOffset: { width: 0, height: 1 },
                    shadowOpacity: 0.15,
                    shadowRadius: 2,
                    elevation: 2,
                  },
                ]}
                onPress={() => handleMaxTurnsChange(option.value)}
              >
                <Text
                  style={[
                    styles.segmentText,
                    { color: maxTurns === option.value ? colors.tint : colors.textSecondary },
                  ]}
                >
                  {option.label}
                </Text>
              </Pressable>
            ))}
          </View>
        </View>

        {/* Custom Instructions */}
        <View style={styles.row}>
          <Text style={[styles.rowLabel, { color: colors.text }]}>Custom Instructions</Text>
        </View>
        <View style={styles.textAreaContainer}>
          <TextInput
            style={[
              styles.textArea,
              {
                backgroundColor: colors.inputBackground,
                color: colors.text,
                borderColor: colors.border,
              },
            ]}
            value={customInstructions}
            onChangeText={handleCustomInstructionsChange}
            placeholder="Enter custom instructions for Claude..."
            placeholderTextColor={colors.textSecondary}
            multiline
            numberOfLines={4}
            textAlignVertical="top"
          />
        </View>
      </View>

      {/* Git Identity Section */}
      <Text style={[styles.sectionHeader, { color: colors.textSecondary }]}>GIT IDENTITY</Text>
      <View style={[styles.sectionCard, { backgroundColor: colors.card }]}>
        <View style={[styles.inputRow, styles.rowWithBorder, { borderBottomColor: colors.border }]}>
          <Text style={[styles.inputLabel, { color: colors.text }]}>Name</Text>
          <TextInput
            style={[styles.textInput, { color: colors.text }]}
            value={gitName}
            onChangeText={handleGitNameChange}
            placeholder="Your Name"
            placeholderTextColor={colors.textSecondary}
            autoCapitalize="words"
            autoCorrect={false}
          />
        </View>

        <View style={styles.inputRow}>
          <Text style={[styles.inputLabel, { color: colors.text }]}>Email</Text>
          <TextInput
            style={[styles.textInput, { color: colors.text }]}
            value={gitEmail}
            onChangeText={handleGitEmailChange}
            placeholder="you@example.com"
            placeholderTextColor={colors.textSecondary}
            keyboardType="email-address"
            autoCapitalize="none"
            autoCorrect={false}
          />
        </View>
      </View>

      <Text style={[styles.sectionHeader, { color: colors.textSecondary }]}>EXPERIMENTS</Text>
      <View style={[styles.sectionCard, { backgroundColor: colors.card }]}>
        <Pressable
          style={({ pressed }) => [
            styles.row,
            styles.rowWithBorder,
            { borderBottomColor: colors.border, opacity: pressed ? 0.7 : 1 },
          ]}
          onPress={() => router.push('/(app)/ttyd-terminal')}
        >
          <Text style={[styles.rowLabel, { color: colors.text }]}>TTYD Terminal</Text>
          <Text style={[styles.statusText, { color: colors.tint }]}>Open</Text>
        </Pressable>

        <Pressable
          style={({ pressed }) => [
            styles.row,
            { opacity: pressed ? 0.7 : 1 },
          ]}
          onPress={() => router.push('/(app)/exec-poc')}
        >
          <Text style={[styles.rowLabel, { color: colors.text }]}>Exec WebSocket POC</Text>
          <Text style={[styles.statusText, { color: colors.tint }]}>Open</Text>
        </Pressable>
      </View>

      {/* Preferences Section */}
      <Text style={[styles.sectionHeader, { color: colors.textSecondary }]}>PREFERENCES</Text>
      <View style={[styles.sectionCard, { backgroundColor: colors.card }]}>
        <View style={styles.row}>
          <Text style={[styles.rowLabel, { color: colors.text }]}>Auto-Checkpoint</Text>
          <Switch
            value={autoCheckpoint}
            onValueChange={handleAutoCheckpointChange}
            trackColor={{ false: colors.backgroundElement, true: colors.success }}
          />
        </View>
      </View>

      <View style={styles.bottomSpacer} />
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  contentContainer: {
    paddingHorizontal: Spacing.lg,
    paddingTop: Spacing.lg,
  },
  loadingContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
  },
  sectionHeader: {
    fontSize: FontSize.xs,
    fontWeight: '600',
    letterSpacing: 0.5,
    marginBottom: Spacing.sm,
    marginTop: Spacing.xl,
    marginLeft: Spacing.lg,
  },
  sectionCard: {
    borderRadius: 10,
    overflow: 'hidden',
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: Spacing.lg,
    paddingVertical: Spacing.md,
    minHeight: 44,
  },
  rowWithBorder: {
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  rowLabel: {
    fontSize: FontSize.md,
    fontWeight: '400',
  },
  statusContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.sm,
  },
  statusDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
  },
  statusText: {
    fontSize: FontSize.md,
  },
  signOutButton: {
    borderRadius: 10,
    marginTop: Spacing.sm,
    paddingVertical: Spacing.md,
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: 44,
  },
  signOutText: {
    fontSize: FontSize.md,
    fontWeight: '500',
  },
  pickerRow: {
    paddingHorizontal: Spacing.lg,
    paddingVertical: Spacing.sm,
  },
  segmentedControl: {
    flexDirection: 'row',
    borderRadius: 8,
    padding: 2,
  },
  segmentButton: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: Spacing.sm,
    borderRadius: 6,
  },
  segmentText: {
    fontSize: FontSize.sm,
    fontWeight: '500',
  },
  textAreaContainer: {
    paddingHorizontal: Spacing.lg,
    paddingBottom: Spacing.md,
  },
  textArea: {
    fontSize: FontSize.md,
    borderRadius: 8,
    borderWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: Spacing.md,
    paddingTop: Spacing.md,
    paddingBottom: Spacing.md,
    minHeight: 100,
  },
  inputRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: Spacing.lg,
    paddingVertical: Spacing.md,
    minHeight: 44,
  },
  inputLabel: {
    fontSize: FontSize.md,
    fontWeight: '400',
    width: 60,
  },
  textInput: {
    flex: 1,
    fontSize: FontSize.md,
    textAlign: 'right',
    paddingVertical: 0,
  },
  bottomSpacer: {
    height: Spacing.xxl,
  },
});
