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
  Platform,
} from 'react-native';
import { router } from 'expo-router';
import { useAuth } from '@/contexts/AuthContext';
import { useTheme } from '@/hooks/use-theme';
import { getSetting, setSetting, getSettingBool, setSettingBool } from '@/services/storage';
import { deleteToken, hasToken, saveToken } from '@/services/auth';
import { FontSize, Spacing } from '@/constants/theme';
import {
  AgentEffort,
  AgentProvider,
  effortDisplayName,
  normalizeAgentEffort,
} from '@/models/chat';
import { TranscriptionProvider } from '@/services/client-transcription';
import { DEFAULT_WORKING_DIRECTORY, normalizeWorkingDirectory } from '@/constants/session';

type ClaudeModel = 'sonnet' | 'opus' | 'haiku';
type MaxTurns = 0 | 5 | 10 | 25 | 50;
type ProviderOption = { label: string; value: AgentProvider };

const PROVIDER_OPTIONS: ProviderOption[] = [
  { label: 'Claude', value: 'claude' },
  { label: 'Codex Live', value: 'codexAppServer' },
  { label: 'Legacy', value: 'codex' },
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

const CLAUDE_EFFORT_OPTIONS: AgentEffort[] = ['low', 'medium', 'high', 'xhigh', 'max'];
const CODEX_EFFORT_OPTIONS: AgentEffort[] = ['minimal', 'low', 'medium', 'high', 'xhigh'];
const TRANSCRIPTION_PROVIDER_OPTIONS: { label: string; value: TranscriptionProvider }[] = [
  { label: 'AssemblyAI', value: 'assemblyai' },
  { label: 'OpenAI', value: 'openai' },
  { label: 'Sprite', value: 'sprite' },
];

export default function SettingsScreen() {
  const colors = useTheme();
  const auth = useAuth();

  const [isLoadingSettings, setIsLoadingSettings] = useState(true);

  // Claude Configuration
  const [defaultProvider, setDefaultProvider] = useState<AgentProvider>('claude');
  const [claudeModel, setClaudeModel] = useState<ClaudeModel>('sonnet');
  const [claudeEffort, setClaudeEffort] = useState<AgentEffort>('high');
  const [codexModel, setCodexModel] = useState('');
  const [codexEffort, setCodexEffort] = useState<AgentEffort>('high');
  const [maxTurns, setMaxTurns] = useState<MaxTurns>(0);
  const [customInstructions, setCustomInstructions] = useState('');
  const [defaultWorkingDirectory, setDefaultWorkingDirectory] = useState(DEFAULT_WORKING_DIRECTORY);

  // Git Identity
  const [gitName, setGitName] = useState('');
  const [gitEmail, setGitEmail] = useState('');

  // Preferences
  const [autoCheckpoint, setAutoCheckpoint] = useState(false);

  // Turn-finished push notifications (ntfy.sh or self-hosted ntfy server)
  const [ntfyTopic, setNtfyTopic] = useState('');
  const [ntfyServer, setNtfyServer] = useState('');

  // GitHub token (paste — supports OAuth tokens and fine-grained PATs)
  const [githubTokenInput, setGithubTokenInput] = useState('');
  const [savingGitHub, setSavingGitHub] = useState(false);

  // Client-side transcription provider keys
  const [assemblyAiTokenInput, setAssemblyAiTokenInput] = useState('');
  const [openAiTokenInput, setOpenAiTokenInput] = useState('');
  const [hasAssemblyAiToken, setHasAssemblyAiToken] = useState(false);
  const [hasOpenAiToken, setHasOpenAiToken] = useState(false);
  const [transcriptionProvider, setTranscriptionProvider] =
    useState<TranscriptionProvider>('assemblyai');
  const [savingAssemblyAi, setSavingAssemblyAi] = useState(false);
  const [savingOpenAi, setSavingOpenAi] = useState(false);

  const handleSaveGitHubToken = useCallback(async () => {
    const trimmed = githubTokenInput.trim();
    if (!trimmed) return;
    setSavingGitHub(true);
    try {
      await auth.saveGitHubToken(trimmed);
      setGithubTokenInput('');
      Alert.alert('Saved', 'GitHub token saved. New sprites can now clone your repos.');
    } catch {
      Alert.alert('Error', 'Failed to save GitHub token.');
    }
    setSavingGitHub(false);
  }, [githubTokenInput, auth]);

  const handleSaveAssemblyAiToken = useCallback(async () => {
    const trimmed = assemblyAiTokenInput.trim();
    if (!trimmed) return;
    setSavingAssemblyAi(true);
    try {
      await saveToken('assemblyAiToken', trimmed);
      setAssemblyAiTokenInput('');
      setHasAssemblyAiToken(true);
      Alert.alert('Saved', 'AssemblyAI API key saved for client-side transcription.');
    } catch {
      Alert.alert('Error', 'Failed to save AssemblyAI API key.');
    }
    setSavingAssemblyAi(false);
  }, [assemblyAiTokenInput]);

  const handleSaveOpenAiToken = useCallback(async () => {
    const trimmed = openAiTokenInput.trim();
    if (!trimmed) return;
    setSavingOpenAi(true);
    try {
      await saveToken('openAiToken', trimmed);
      setOpenAiTokenInput('');
      setHasOpenAiToken(true);
      Alert.alert('Saved', 'OpenAI API key saved for client-side transcription.');
    } catch {
      Alert.alert('Error', 'Failed to save OpenAI API key.');
    }
    setSavingOpenAi(false);
  }, [openAiTokenInput]);

  const handleDeleteAssemblyAiToken = useCallback(async () => {
    await deleteToken('assemblyAiToken');
    setHasAssemblyAiToken(false);
  }, []);

  const handleDeleteOpenAiToken = useCallback(async () => {
    await deleteToken('openAiToken');
    setHasOpenAiToken(false);
  }, []);

  // Load all settings on mount
  useEffect(() => {
    (async () => {
      try {
        const [
          providerSetting,
          model,
          savedClaudeEffort,
          savedCodexModel,
          savedCodexEffort,
          turns,
          instructions,
          name,
          email,
          checkpoint,
          workdir,
          assemblyAiSaved,
          openAiSaved,
          savedNtfyTopic,
          savedNtfyServer,
          savedTranscriptionProvider,
        ] =
          await Promise.all([
            getSetting('defaultProvider'),
            getSetting('claudeModel'),
            getSetting('claudeEffort'),
            getSetting('codexModel'),
            getSetting('codexEffort'),
            getSetting('maxTurns'),
            getSetting('customInstructions'),
            getSetting('gitName'),
            getSetting('gitEmail'),
            getSettingBool('autoCheckpoint'),
            getSetting('defaultWorkingDirectory'),
            hasToken('assemblyAiToken'),
            hasToken('openAiToken'),
            getSetting('ntfyTopic'),
            getSetting('ntfyServer'),
            getSetting('transcriptionProvider'),
          ]);

        if (
          providerSetting === 'claude' ||
          providerSetting === 'codex' ||
          providerSetting === 'codexAppServer'
        ) {
          setDefaultProvider(providerSetting as AgentProvider);
        }
        if (model && ['sonnet', 'opus', 'haiku'].includes(model)) {
          setClaudeModel(model as ClaudeModel);
        }
        setClaudeEffort(normalizeAgentEffort(savedClaudeEffort) ?? 'high');
        if (savedCodexModel !== null) setCodexModel(savedCodexModel);
        setCodexEffort(normalizeAgentEffort(savedCodexEffort) ?? 'high');
        if (turns !== null) {
          const parsed = parseInt(turns, 10);
          if ([0, 5, 10, 25, 50].includes(parsed)) {
            setMaxTurns(parsed as MaxTurns);
          }
        }
        if (instructions !== null) setCustomInstructions(instructions);
        if (name !== null) setGitName(name);
        if (email !== null) setGitEmail(email);
        if (workdir) setDefaultWorkingDirectory(workdir);
        setHasAssemblyAiToken(assemblyAiSaved);
        setHasOpenAiToken(openAiSaved);
        setAutoCheckpoint(checkpoint);
        if (savedNtfyTopic !== null) setNtfyTopic(savedNtfyTopic);
        if (savedNtfyServer !== null) setNtfyServer(savedNtfyServer);
        if (
          savedTranscriptionProvider === 'sprite' ||
          savedTranscriptionProvider === 'openai' ||
          savedTranscriptionProvider === 'assemblyai'
        ) {
          setTranscriptionProvider(savedTranscriptionProvider);
        } else {
          setTranscriptionProvider('assemblyai');
        }
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

  const handleClaudeEffortChange = useCallback(async (nextEffort: AgentEffort) => {
    setClaudeEffort(nextEffort);
    await setSetting('claudeEffort', nextEffort);
  }, []);

  const handleCodexModelChange = useCallback(async (text: string) => {
    setCodexModel(text);
    await setSetting('codexModel', text.trim());
  }, []);

  const handleCodexEffortChange = useCallback(async (nextEffort: AgentEffort) => {
    setCodexEffort(nextEffort);
    await setSetting('codexEffort', nextEffort);
  }, []);

  const handleTranscriptionProviderChange = useCallback(
    async (nextProvider: TranscriptionProvider) => {
      setTranscriptionProvider(nextProvider);
      await setSetting('transcriptionProvider', nextProvider);
    },
    []
  );

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

  const handleDefaultWorkingDirectoryChange = useCallback((text: string) => {
    setDefaultWorkingDirectory(text);
  }, []);

  const handleDefaultWorkingDirectoryBlur = useCallback(async () => {
    const normalized = normalizeWorkingDirectory(defaultWorkingDirectory);
    setDefaultWorkingDirectory(normalized);
    await setSetting('defaultWorkingDirectory', normalized);
  }, [defaultWorkingDirectory]);

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

  const handleNtfyTopicChange = useCallback(async (text: string) => {
    setNtfyTopic(text);
    await setSetting('ntfyTopic', text.trim());
  }, []);

  const handleNtfyServerChange = useCallback(async (text: string) => {
    setNtfyServer(text);
    await setSetting('ntfyServer', text.trim());
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

        <View style={[styles.row, styles.rowWithBorder, { borderBottomColor: colors.border }]}>
          <Text style={[styles.rowLabel, { color: colors.text }]}>Claude Auth</Text>
          <View style={styles.statusContainer}>
            <View
              style={[
                styles.statusDot,
                {
                  backgroundColor:
                    auth.hasClaudeCreds || auth.hasClaudeToken ? colors.success : colors.warning,
                },
              ]}
            />
            <Text style={[styles.statusText, { color: colors.textSecondary }]}>
              {auth.hasClaudeCreds
                ? 'Browser login'
                : auth.hasClaudeToken
                  ? 'Pasted token'
                  : 'Not Set'}
            </Text>
          </View>
        </View>

        <Pressable
          style={({ pressed }) => [styles.row, { opacity: pressed ? 0.6 : 1 }]}
          onPress={() => router.push('/(app)/claude-login')}
        >
          <Text style={[styles.rowLabel, { color: colors.text }]}>Log in with browser</Text>
          <Text style={[styles.statusText, { color: colors.tint }]}>Capture →</Text>
        </Pressable>
      </View>

      {/* GitHub Section */}
      <Text style={[styles.sectionHeader, { color: colors.textSecondary }]}>GITHUB</Text>
      <View style={[styles.sectionCard, { backgroundColor: colors.card }]}>
        <View style={[styles.row, styles.rowWithBorder, { borderBottomColor: colors.border }]}>
          <Text style={[styles.rowLabel, { color: colors.text }]}>Token</Text>
          <View style={styles.statusContainer}>
            <View
              style={[
                styles.statusDot,
                { backgroundColor: auth.hasGitHubToken ? colors.success : colors.warning },
              ]}
            />
            <Text style={[styles.statusText, { color: colors.textSecondary }]}>
              {auth.hasGitHubToken ? 'Saved' : 'Not Set'}
            </Text>
          </View>
        </View>
        <View style={[styles.inputRow, styles.rowWithBorder, { borderBottomColor: colors.border }]}>
          <Text style={[styles.inputLabel, { color: colors.text }]}>Paste</Text>
          <TextInput
            style={[styles.textInput, { color: colors.text }]}
            value={githubTokenInput}
            onChangeText={setGithubTokenInput}
            placeholder="ghp_… or github_pat_…"
            placeholderTextColor={colors.textSecondary}
            autoCapitalize="none"
            autoCorrect={false}
            secureTextEntry
          />
        </View>
        <Pressable
          style={({ pressed }) => [styles.row, { opacity: pressed ? 0.6 : 1 }]}
          disabled={savingGitHub || !githubTokenInput.trim()}
          onPress={handleSaveGitHubToken}
        >
          <Text
            style={[
              styles.rowLabel,
              { color: githubTokenInput.trim() ? colors.tint : colors.textSecondary },
            ]}
          >
            {savingGitHub ? 'Saving…' : 'Save Token'}
          </Text>
        </Pressable>
      </View>

      <Text style={[styles.sectionHeader, { color: colors.textSecondary }]}>TRANSCRIPTION</Text>
      <View style={[styles.sectionCard, { backgroundColor: colors.card }]}>
        <View style={[styles.row, styles.rowWithBorder, { borderBottomColor: colors.border }]}>
          <Text style={[styles.rowLabel, { color: colors.text }]}>Default provider</Text>
        </View>
        <View
          style={[
            styles.pickerRow,
            styles.rowWithBorder,
            { borderBottomColor: colors.border },
          ]}
        >
          <View style={[styles.segmentedControl, { backgroundColor: colors.backgroundElement }]}>
            {TRANSCRIPTION_PROVIDER_OPTIONS.map((option) => (
              <Pressable
                key={option.value}
                style={[
                  styles.segmentButton,
                  transcriptionProvider === option.value && {
                    backgroundColor: colors.card,
                    shadowColor: '#000',
                    shadowOffset: { width: 0, height: 1 },
                    shadowOpacity: 0.15,
                    shadowRadius: 2,
                    elevation: 2,
                  },
                ]}
                onPress={() => handleTranscriptionProviderChange(option.value)}
              >
                <Text
                  style={[
                    styles.segmentText,
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
          <Text style={[styles.fieldHint, { color: colors.textSecondary }]}>
            The chat microphone records audio and transcribes it with this provider.
          </Text>
        </View>

        <View style={[styles.row, styles.rowWithBorder, { borderBottomColor: colors.border }]}>
          <Text style={[styles.rowLabel, { color: colors.text }]}>AssemblyAI</Text>
          <View style={styles.statusContainer}>
            <View
              style={[
                styles.statusDot,
                { backgroundColor: hasAssemblyAiToken ? colors.success : colors.warning },
              ]}
            />
            <Text style={[styles.statusText, { color: colors.textSecondary }]}>
              {hasAssemblyAiToken ? 'Saved' : 'Not Set'}
            </Text>
          </View>
        </View>
        <View style={[styles.inputRow, styles.rowWithBorder, { borderBottomColor: colors.border }]}>
          <Text style={[styles.inputLabel, { color: colors.text }]}>Key</Text>
          <TextInput
            style={[styles.textInput, { color: colors.text }]}
            value={assemblyAiTokenInput}
            onChangeText={setAssemblyAiTokenInput}
            placeholder="AssemblyAI API key"
            placeholderTextColor={colors.textSecondary}
            autoCapitalize="none"
            autoCorrect={false}
            secureTextEntry
          />
        </View>
        <View style={[styles.actionRow, styles.rowWithBorder, { borderBottomColor: colors.border }]}>
          <Pressable
            style={({ pressed }) => [styles.inlineAction, { opacity: pressed ? 0.6 : 1 }]}
            disabled={savingAssemblyAi || !assemblyAiTokenInput.trim()}
            onPress={handleSaveAssemblyAiToken}
          >
            <Text
              style={[
                styles.rowLabel,
                { color: assemblyAiTokenInput.trim() ? colors.tint : colors.textSecondary },
              ]}
            >
              {savingAssemblyAi ? 'Saving…' : 'Save AssemblyAI Key'}
            </Text>
          </Pressable>
          {hasAssemblyAiToken && (
            <Pressable
              style={({ pressed }) => [styles.inlineActionRight, { opacity: pressed ? 0.6 : 1 }]}
              onPress={handleDeleteAssemblyAiToken}
            >
              <Text style={[styles.statusText, { color: colors.destructive }]}>Remove</Text>
            </Pressable>
          )}
        </View>

        <View style={[styles.row, styles.rowWithBorder, { borderBottomColor: colors.border }]}>
          <Text style={[styles.rowLabel, { color: colors.text }]}>OpenAI</Text>
          <View style={styles.statusContainer}>
            <View
              style={[
                styles.statusDot,
                { backgroundColor: hasOpenAiToken ? colors.success : colors.warning },
              ]}
            />
            <Text style={[styles.statusText, { color: colors.textSecondary }]}>
              {hasOpenAiToken ? 'Saved' : 'Not Set'}
            </Text>
          </View>
        </View>
        <View style={[styles.inputRow, styles.rowWithBorder, { borderBottomColor: colors.border }]}>
          <Text style={[styles.inputLabel, { color: colors.text }]}>Key</Text>
          <TextInput
            style={[styles.textInput, { color: colors.text }]}
            value={openAiTokenInput}
            onChangeText={setOpenAiTokenInput}
            placeholder="sk-..."
            placeholderTextColor={colors.textSecondary}
            autoCapitalize="none"
            autoCorrect={false}
            secureTextEntry
          />
        </View>
        <View style={styles.actionRow}>
          <Pressable
            style={({ pressed }) => [styles.inlineAction, { opacity: pressed ? 0.6 : 1 }]}
            disabled={savingOpenAi || !openAiTokenInput.trim()}
            onPress={handleSaveOpenAiToken}
          >
            <Text
              style={[
                styles.rowLabel,
                { color: openAiTokenInput.trim() ? colors.tint : colors.textSecondary },
              ]}
            >
              {savingOpenAi ? 'Saving…' : 'Save OpenAI Key'}
            </Text>
          </Pressable>
          {hasOpenAiToken && (
            <Pressable
              style={({ pressed }) => [styles.inlineActionRight, { opacity: pressed ? 0.6 : 1 }]}
              onPress={handleDeleteOpenAiToken}
            >
              <Text style={[styles.statusText, { color: colors.destructive }]}>Remove</Text>
            </Pressable>
          )}
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

      <Text style={[styles.sectionHeader, { color: colors.textSecondary }]}>HELP</Text>
      <View style={[styles.sectionCard, { backgroundColor: colors.card }]}>
        <Pressable
          style={({ pressed }) => [styles.row, { opacity: pressed ? 0.7 : 1 }]}
          onPress={() => router.push('/(app)/guide')}
        >
          <Text style={[styles.rowLabel, { color: colors.text }]}>Guides &amp; Setup</Text>
          <Text style={[styles.statusText, { color: colors.tint }]}>Open</Text>
        </Pressable>
      </View>

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

      {/* Session Defaults Section */}
      <Text style={[styles.sectionHeader, { color: colors.textSecondary }]}>SESSION DEFAULTS</Text>
      <View style={[styles.sectionCard, { backgroundColor: colors.card }]}>
        <View style={styles.row}>
          <Text style={[styles.rowLabel, { color: colors.text }]}>Working Directory</Text>
        </View>
        <View style={styles.textAreaContainer}>
          <TextInput
            style={[
              styles.pathInput,
              {
                backgroundColor: colors.inputBackground,
                color: colors.text,
                borderColor: colors.border,
              },
            ]}
            value={defaultWorkingDirectory}
            onChangeText={handleDefaultWorkingDirectoryChange}
            onBlur={handleDefaultWorkingDirectoryBlur}
            placeholder={DEFAULT_WORKING_DIRECTORY}
            placeholderTextColor={colors.textSecondary}
            autoCapitalize="none"
            autoCorrect={false}
          />
          <Text style={[styles.fieldHint, { color: colors.textSecondary }]}>
            New chats `cd` here before launching the agent. Point it at the folder where you cloned
            your repo (e.g. /home/sprite/my-repo).
          </Text>
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

        <View style={[styles.row, styles.rowWithBorder, { borderBottomColor: colors.border }]}>
          <Text style={[styles.rowLabel, { color: colors.text }]}>Effort</Text>
        </View>
        <View
          style={[
            styles.pickerRow,
            styles.rowWithBorder,
            { borderBottomColor: colors.border },
          ]}
        >
          <View style={[styles.segmentedControl, { backgroundColor: colors.backgroundElement }]}>
            {CLAUDE_EFFORT_OPTIONS.map((option) => (
              <Pressable
                key={option}
                style={[
                  styles.segmentButton,
                  claudeEffort === option && { backgroundColor: colors.card },
                ]}
                onPress={() => handleClaudeEffortChange(option)}
              >
                <Text
                  style={[
                    styles.segmentText,
                    { color: claudeEffort === option ? colors.tint : colors.textSecondary },
                  ]}
                >
                  {effortDisplayName(option)}
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

      <Text style={[styles.sectionHeader, { color: colors.textSecondary }]}>CODEX CONFIGURATION</Text>
      <View style={[styles.sectionCard, { backgroundColor: colors.card }]}>
        <View style={[styles.inputRow, styles.rowWithBorder, { borderBottomColor: colors.border }]}>
          <Text style={[styles.inputLabel, { color: colors.text }]}>Model</Text>
          <TextInput
            style={[styles.textInput, { color: colors.text }]}
            value={codexModel}
            onChangeText={handleCodexModelChange}
            placeholder="Codex default"
            placeholderTextColor={colors.textSecondary}
            autoCapitalize="none"
            autoCorrect={false}
          />
        </View>
        <View style={[styles.row, styles.rowWithBorder, { borderBottomColor: colors.border }]}>
          <Text style={[styles.rowLabel, { color: colors.text }]}>Effort</Text>
        </View>
        <View style={styles.pickerRow}>
          <View style={[styles.segmentedControl, { backgroundColor: colors.backgroundElement }]}>
            {CODEX_EFFORT_OPTIONS.map((option) => (
              <Pressable
                key={option}
                style={[
                  styles.segmentButton,
                  codexEffort === option && { backgroundColor: colors.card },
                ]}
                onPress={() => handleCodexEffortChange(option)}
              >
                <Text
                  style={[
                    styles.segmentText,
                    { color: codexEffort === option ? colors.tint : colors.textSecondary },
                  ]}
                >
                  {effortDisplayName(option)}
                </Text>
              </Pressable>
            ))}
          </View>
          <Text style={[styles.fieldHint, { color: colors.textSecondary }]}>
            The model field is optional. Empty uses the model configured inside the sprite.
          </Text>
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

      {/* Notifications Section */}
      <Text style={[styles.sectionHeader, { color: colors.textSecondary }]}>NOTIFICATIONS</Text>
      <View style={[styles.sectionCard, { backgroundColor: colors.card }]}>
        <View style={[styles.inputRow, styles.rowWithBorder, { borderBottomColor: colors.border }]}>
          <Text style={[styles.inputLabel, { color: colors.text }]}>Topic</Text>
          <TextInput
            style={[styles.textInput, { color: colors.text }]}
            value={ntfyTopic}
            onChangeText={handleNtfyTopicChange}
            placeholder="my-secret-topic"
            placeholderTextColor={colors.textSecondary}
            autoCapitalize="none"
            autoCorrect={false}
          />
        </View>
        <View style={styles.inputRow}>
          <Text style={[styles.inputLabel, { color: colors.text }]}>Server</Text>
          <TextInput
            style={[styles.textInput, { color: colors.text }]}
            value={ntfyServer}
            onChangeText={handleNtfyServerChange}
            placeholder="https://ntfy.sh"
            placeholderTextColor={colors.textSecondary}
            autoCapitalize="none"
            autoCorrect={false}
            keyboardType="url"
          />
        </View>
        <View style={styles.textAreaContainer}>
          <Text style={[styles.fieldHint, { color: colors.textSecondary }]}>
            When set, the sprite sends a push via ntfy when a chat turn finishes — even with the
            app closed. Install the ntfy app and subscribe to the same topic. Pick a long, hard to
            guess topic name; anyone who knows it can read these notifications.
          </Text>
        </View>
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
  pathInput: {
    fontSize: FontSize.md,
    borderRadius: 8,
    borderWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: Spacing.md,
    paddingVertical: Spacing.sm,
    fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
  },
  fieldHint: {
    fontSize: FontSize.xs,
    lineHeight: 17,
    marginTop: Spacing.sm,
  },
  inputRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: Spacing.lg,
    paddingVertical: Spacing.md,
    minHeight: 44,
  },
  actionRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingLeft: Spacing.lg,
    minHeight: 44,
  },
  inlineAction: {
    flex: 1,
    paddingVertical: Spacing.md,
  },
  inlineActionRight: {
    paddingHorizontal: Spacing.lg,
    paddingVertical: Spacing.md,
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
