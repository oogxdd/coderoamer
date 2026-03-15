import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  Alert,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import * as Clipboard from 'expo-clipboard';
import { SafeAreaView } from 'react-native-safe-area-context';
import { router } from 'expo-router';
import { useTheme } from '@/hooks/use-theme';
import {
  createExecPocClient,
  ExecConnectionState,
  ExecEventLog,
} from '@/services/exec-poc';
import { FontSize, Fonts, Spacing } from '@/constants/theme';

const DEFAULT_CLAUDE_COMMAND = 'claude';
const ANSI_REGEX = /\u001B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~]|\][^\u0007]*(?:\u0007|\u001B\\))/g;
const CONTROL_CHAR_REGEX = /[\u0000-\u0008\u000B-\u001A\u001C-\u001F\u007F]/g;

type OutputMode = 'clean' | 'raw';

type QuickControl = {
  label: string;
  payload: string;
};

const QUICK_CONTROLS: QuickControl[] = [
  { label: '1+Enter', payload: '1\r' },
  { label: 'Enter', payload: '\r' },
  { label: 'Esc', payload: '\u001b' },
  { label: 'Tab', payload: '\t' },
  { label: 'Up', payload: '\u001b[A' },
  { label: 'Down', payload: '\u001b[B' },
  { label: 'Left', payload: '\u001b[D' },
  { label: 'Right', payload: '\u001b[C' },
  { label: 'Ctrl+C', payload: '\u0003' },
  { label: 'Ctrl+D', payload: '\u0004' },
];

function formatTime(timestamp: number): string {
  return new Date(timestamp).toLocaleTimeString();
}

function cleanTerminalOutput(input: string): string {
  let text = input.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  text = text.replace(ANSI_REGEX, '');
  text = text.replace(CONTROL_CHAR_REGEX, '');
  text = text.replace(/\n{3,}/g, '\n\n');
  return text.trimEnd();
}

function formatLogEntry(entry: ExecEventLog, mode: OutputMode): string {
  if (mode === 'raw') return entry.text;

  if (entry.source === 'ws') {
    return cleanTerminalOutput(entry.text);
  }

  if (entry.source === 'event') {
    try {
      return JSON.stringify(JSON.parse(entry.text), null, 2);
    } catch {
      return entry.text;
    }
  }

  return entry.text;
}

function sourceLabel(entry: ExecEventLog): string {
  return entry.source.toUpperCase();
}

function sourceTint(source: ExecEventLog['source']): string {
  switch (source) {
    case 'local':
      return '#2B6EF2';
    case 'event':
      return '#AA7A00';
    case 'error':
      return '#B3261E';
    case 'ws':
    default:
      return '#6B7280';
  }
}

export default function ExecPocScreen() {
  const colors = useTheme();
  const [spriteName, setSpriteName] = useState('');
  const [command, setCommand] = useState(DEFAULT_CLAUDE_COMMAND);
  const [attachSessionId, setAttachSessionId] = useState('');
  const [inputText, setInputText] = useState('');
  const [sessionId, setSessionId] = useState<string | undefined>();
  const [state, setState] = useState<ExecConnectionState>('idle');
  const [logs, setLogs] = useState<ExecEventLog[]>([]);
  const [outputMode, setOutputMode] = useState<OutputMode>('clean');
  const [showSetup, setShowSetup] = useState(false);
  const [showKeys, setShowKeys] = useState(false);
  const scrollRef = useRef<ScrollView>(null);

  const appendLog = (entry: ExecEventLog) => {
    setLogs((prev) => {
      const next = prev.length > 500 ? prev.slice(prev.length - 500) : prev;
      return [...next, entry];
    });
  };

  const client = useMemo(
    () =>
      createExecPocClient({
        onStateChange: setState,
        onSessionId: setSessionId,
        onLog: appendLog,
      }),
    []
  );

  const displayLogs = useMemo(
    () =>
      logs
        .map((entry) => ({
          ...entry,
          renderedText: formatLogEntry(entry, outputMode),
        }))
        .filter((entry) => outputMode === 'raw' || entry.source !== 'ws' || entry.renderedText.trim()),
    [logs, outputMode]
  );

  const logText = useMemo(
    () =>
      displayLogs
        .map(
          (entry) =>
            `[${formatTime(entry.timestamp)}] ${sourceLabel(entry)}:\n${entry.renderedText || '(terminal control)'}`
        )
        .join('\n\n'),
    [displayLogs]
  );

  useEffect(() => {
    return () => {
      client.close();
    };
  }, [client]);

  useEffect(() => {
    scrollRef.current?.scrollToEnd({ animated: true });
  }, [displayLogs]);

  const sendControl = (label: string, payload: string) => {
    client.send(payload, false);
    appendLog({
      timestamp: Date.now(),
      source: 'local',
      text: `> ${label}`,
    });
  };

  const connect = async () => {
    if (!spriteName.trim()) {
      Alert.alert('Missing sprite name', 'Enter a sprite name first.');
      return;
    }

    try {
      await client.connect({
        spriteName: spriteName.trim(),
        command: command.trim() || DEFAULT_CLAUDE_COMMAND,
        attachSessionId: attachSessionId.trim() || undefined,
      });
      setShowSetup(false);
    } catch (error) {
      appendLog({
        timestamp: Date.now(),
        source: 'error',
        text: `Connect failed: ${(error as Error).message}`,
      });
    }
  };

  const send = (appendNewline: boolean) => {
    const text = inputText;

    if (!text.length) {
      if (appendNewline) {
        sendControl('Enter', '\r');
      }
      return;
    }

    client.send(text, appendNewline);
    appendLog({
      timestamp: Date.now(),
      source: 'local',
      text: appendNewline ? `> ${text}` : `> RAW ${JSON.stringify(text)}`,
    });
    setInputText('');
  };

  const sendKill = async () => {
    try {
      await client.kill();
    } catch (error) {
      appendLog({
        timestamp: Date.now(),
        source: 'error',
        text: `Kill failed: ${(error as Error).message}`,
      });
    }
  };

  const disconnect = () => {
    client.close();
    setState('closed');
    appendLog({
      timestamp: Date.now(),
      source: 'local',
      text: 'Socket closed by client',
    });
  };

  const clearLogs = () => setLogs([]);
  const copyLogs = async () => {
    if (!logText.trim()) return;
    await Clipboard.setStringAsync(logText);
    Alert.alert('Copied', 'Visible logs copied to clipboard.');
  };

  return (
    <SafeAreaView style={[styles.container, { backgroundColor: colors.backgroundSecondary }]}>
      <KeyboardAvoidingView
        style={styles.container}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      >
        <View style={styles.headerRow}>
          <Pressable onPress={() => router.back()}>
            <Text style={[styles.backButton, { color: colors.tint }]}>Back</Text>
          </Pressable>
          <Text style={[styles.title, { color: colors.text }]}>Exec WebSocket POC</Text>
          <View style={styles.headerActions}>
            <Pressable onPress={copyLogs}>
              <Text style={[styles.clearButton, { color: colors.tint }]}>Copy</Text>
            </Pressable>
            <Pressable onPress={clearLogs}>
              <Text style={[styles.clearButton, { color: colors.tint }]}>Clear</Text>
            </Pressable>
          </View>
        </View>

        <View
          style={[
            styles.compactBar,
            { backgroundColor: colors.card, borderColor: colors.border },
          ]}
        >
          <Text style={[styles.compactStatus, { color: colors.text }]}>State: {state}</Text>
          <Text style={[styles.compactStatus, { color: colors.text }]}>
            Session: {sessionId ?? 'n/a'}
          </Text>
          <View style={styles.compactActions}>
            <Pressable
              style={({ pressed }) => [
                styles.compactButton,
                { backgroundColor: colors.backgroundElement, opacity: pressed ? 0.7 : 1 },
              ]}
              onPress={() => setShowKeys((prev) => !prev)}
            >
              <Text style={[styles.compactButtonText, { color: colors.text }]}>
                {showKeys ? 'Hide Keys' : 'Keys'}
              </Text>
            </Pressable>
            <Pressable
              style={({ pressed }) => [
                styles.compactButton,
                { backgroundColor: colors.backgroundElement, opacity: pressed ? 0.7 : 1 },
              ]}
              onPress={() => setShowSetup((prev) => !prev)}
            >
              <Text style={[styles.compactButtonText, { color: colors.text }]}>
                {showSetup ? 'Hide Setup' : 'Setup'}
              </Text>
            </Pressable>
          </View>
        </View>

        {showSetup ? (
          <View style={[styles.card, { backgroundColor: colors.card }]}>
            <Text style={[styles.label, { color: colors.textSecondary }]}>Sprite Name</Text>
            <TextInput
              style={[
                styles.input,
                {
                  backgroundColor: colors.inputBackground,
                  color: colors.text,
                  borderColor: colors.border,
                },
              ]}
              placeholder="my-sprite"
              placeholderTextColor={colors.textSecondary}
              autoCapitalize="none"
              autoCorrect={false}
              value={spriteName}
              onChangeText={setSpriteName}
            />

            <Text style={[styles.label, { color: colors.textSecondary }]}>
              Command (new session)
            </Text>
            <TextInput
              style={[
                styles.input,
                {
                  backgroundColor: colors.inputBackground,
                  color: colors.text,
                  borderColor: colors.border,
                },
              ]}
              placeholder={DEFAULT_CLAUDE_COMMAND}
              placeholderTextColor={colors.textSecondary}
              autoCapitalize="none"
              autoCorrect={false}
              value={command}
              onChangeText={setCommand}
            />

            <Text style={[styles.label, { color: colors.textSecondary }]}>
              Attach Session ID (optional)
            </Text>
            <TextInput
              style={[
                styles.input,
                {
                  backgroundColor: colors.inputBackground,
                  color: colors.text,
                  borderColor: colors.border,
                },
              ]}
              placeholder="Existing session ID"
              placeholderTextColor={colors.textSecondary}
              autoCapitalize="none"
              autoCorrect={false}
              value={attachSessionId}
              onChangeText={setAttachSessionId}
            />

            <View style={styles.buttonRow}>
              <Pressable
                style={({ pressed }) => [
                  styles.button,
                  { backgroundColor: colors.tint, opacity: pressed ? 0.7 : 1 },
                ]}
                onPress={connect}
              >
                <Text style={styles.buttonText}>Connect</Text>
              </Pressable>

              <Pressable
                style={({ pressed }) => [
                  styles.button,
                  { backgroundColor: colors.destructive, opacity: pressed ? 0.7 : 1 },
                ]}
                onPress={sendKill}
              >
                <Text style={styles.buttonText}>Kill</Text>
              </Pressable>

              <Pressable
                style={({ pressed }) => [
                  styles.button,
                  { backgroundColor: colors.backgroundElement, opacity: pressed ? 0.7 : 1 },
                ]}
                onPress={disconnect}
              >
                <Text style={[styles.buttonText, { color: colors.text }]}>Disconnect</Text>
              </Pressable>
            </View>
          </View>
        ) : null}

        <View style={[styles.sendRow, styles.sendRowOuter]}>
          <TextInput
            style={[
              styles.sendInput,
              {
                backgroundColor: colors.inputBackground,
                color: colors.text,
                borderColor: colors.border,
              },
            ]}
            placeholder="Type message or /slash command"
            placeholderTextColor={colors.textSecondary}
            autoCapitalize="none"
            autoCorrect={false}
            value={inputText}
            onChangeText={setInputText}
            onSubmitEditing={() => send(true)}
            returnKeyType="send"
          />
          <Pressable
            style={({ pressed }) => [
              styles.sendButton,
              { backgroundColor: colors.tint, opacity: pressed ? 0.7 : 1 },
            ]}
            onPress={() => send(true)}
          >
            <Text style={styles.buttonText}>Send</Text>
          </Pressable>
          <Pressable
            style={({ pressed }) => [
              styles.sendButton,
              { backgroundColor: colors.backgroundElement, opacity: pressed ? 0.7 : 1 },
            ]}
            onPress={() => send(false)}
          >
            <Text style={[styles.buttonText, { color: colors.text }]}>Raw</Text>
          </Pressable>
        </View>

        {showKeys ? (
          <ScrollView
            horizontal
            style={styles.quickControlsScroll}
            contentContainerStyle={styles.quickControlsRow}
            showsHorizontalScrollIndicator={false}
          >
            {QUICK_CONTROLS.map((control) => (
              <Pressable
                key={control.label}
                style={({ pressed }) => [
                  styles.quickControlButton,
                  {
                    backgroundColor: colors.backgroundElement,
                    borderColor: colors.border,
                    opacity: pressed ? 0.7 : 1,
                  },
                ]}
                onPress={() => sendControl(control.label, control.payload)}
              >
                <Text style={[styles.quickControlLabel, { color: colors.text }]}>
                  {control.label}
                </Text>
              </Pressable>
            ))}
          </ScrollView>
        ) : null}

        <View style={styles.logHeaderRow}>
          <Text style={[styles.logHeaderText, { color: colors.textSecondary }]}>OUTPUT</Text>
          <View style={[styles.modeToggle, { backgroundColor: colors.backgroundElement }]}>
            {(['clean', 'raw'] as OutputMode[]).map((mode) => (
              <Pressable
                key={mode}
                style={({ pressed }) => [
                  styles.modeButton,
                  outputMode === mode && {
                    backgroundColor: colors.card,
                    borderColor: colors.border,
                    borderWidth: StyleSheet.hairlineWidth,
                  },
                  { opacity: pressed ? 0.7 : 1 },
                ]}
                onPress={() => setOutputMode(mode)}
              >
                <Text
                  style={[
                    styles.modeButtonText,
                    { color: outputMode === mode ? colors.text : colors.textSecondary },
                  ]}
                >
                  {mode === 'clean' ? 'Clean' : 'Raw'}
                </Text>
              </Pressable>
            ))}
          </View>
        </View>

        <View style={[styles.logContainer, { backgroundColor: colors.card, borderColor: colors.border }]}>
          <ScrollView ref={scrollRef} contentContainerStyle={styles.logContent}>
            {displayLogs.length === 0 ? (
              <Text style={[styles.emptyText, { color: colors.textSecondary }]}>No events yet.</Text>
            ) : (
              displayLogs.map((entry, idx) => (
                <View
                  key={`${entry.timestamp}-${idx}`}
                  style={[
                    styles.logEntry,
                    {
                      borderColor: colors.border,
                      backgroundColor: colors.backgroundElement,
                    },
                  ]}
                >
                  <Text style={[styles.logMeta, { color: sourceTint(entry.source) }]}>
                    [{formatTime(entry.timestamp)}] {sourceLabel(entry)}
                  </Text>
                  <Text selectable style={[styles.logLine, { color: colors.text }]}>
                    {entry.renderedText || '(terminal control)'}
                  </Text>
                </View>
              ))
            )}
          </ScrollView>
        </View>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  headerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: Spacing.lg,
    paddingTop: Spacing.sm,
    paddingBottom: Spacing.md,
  },
  backButton: {
    fontSize: FontSize.md,
    fontWeight: '500',
  },
  title: {
    fontSize: FontSize.lg,
    fontWeight: '600',
  },
  clearButton: {
    fontSize: FontSize.md,
    fontWeight: '500',
  },
  headerActions: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.md,
  },
  card: {
    marginHorizontal: Spacing.lg,
    borderRadius: 12,
    padding: Spacing.md,
    gap: Spacing.sm,
    marginBottom: Spacing.sm,
  },
  compactBar: {
    marginHorizontal: Spacing.lg,
    marginBottom: Spacing.sm,
    borderRadius: 10,
    borderWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: Spacing.sm,
    paddingVertical: Spacing.sm,
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.sm,
  },
  compactStatus: {
    fontSize: FontSize.xs,
    fontWeight: '600',
  },
  compactActions: {
    marginLeft: 'auto',
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.sm,
  },
  compactButton: {
    borderRadius: 8,
    paddingHorizontal: Spacing.sm,
    paddingVertical: Spacing.xs,
  },
  compactButtonText: {
    fontSize: FontSize.sm,
    fontWeight: '600',
  },
  label: {
    fontSize: FontSize.sm,
    fontWeight: '500',
  },
  input: {
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 8,
    paddingHorizontal: Spacing.md,
    paddingVertical: Spacing.sm,
    fontSize: FontSize.md,
  },
  buttonRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: Spacing.sm,
    marginTop: Spacing.sm,
  },
  button: {
    borderRadius: 8,
    paddingHorizontal: Spacing.md,
    paddingVertical: Spacing.sm,
    minWidth: 98,
    alignItems: 'center',
  },
  buttonText: {
    color: '#FFFFFF',
    fontSize: FontSize.sm,
    fontWeight: '600',
  },
  sendRow: {
    flexDirection: 'row',
    gap: Spacing.sm,
    alignItems: 'center',
  },
  sendRowOuter: {
    marginHorizontal: Spacing.lg,
    marginBottom: Spacing.sm,
  },
  sendInput: {
    flex: 1,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 8,
    paddingHorizontal: Spacing.md,
    paddingVertical: Spacing.sm,
    fontSize: FontSize.md,
  },
  sendButton: {
    borderRadius: 8,
    paddingHorizontal: Spacing.md,
    paddingVertical: Spacing.sm,
    minWidth: 72,
    alignItems: 'center',
  },
  quickControlsRow: {
    flexDirection: 'row',
    gap: Spacing.sm,
    paddingHorizontal: Spacing.lg,
    paddingBottom: Spacing.sm,
  },
  quickControlsScroll: {
    marginBottom: Spacing.sm,
  },
  quickControlButton: {
    borderRadius: 8,
    borderWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: Spacing.md,
    paddingVertical: Spacing.sm,
    minWidth: 78,
    alignItems: 'center',
  },
  quickControlLabel: {
    fontSize: FontSize.sm,
    fontWeight: '500',
  },
  logHeaderRow: {
    marginTop: Spacing.md,
    marginHorizontal: Spacing.lg,
    marginBottom: Spacing.sm,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  logHeaderText: {
    fontSize: FontSize.xs,
    fontWeight: '700',
    letterSpacing: 0.4,
  },
  modeToggle: {
    flexDirection: 'row',
    borderRadius: 8,
    padding: 2,
  },
  modeButton: {
    borderRadius: 6,
    paddingHorizontal: Spacing.md,
    paddingVertical: 4,
  },
  modeButtonText: {
    fontSize: FontSize.sm,
    fontWeight: '600',
  },
  logContainer: {
    flex: 1,
    borderTopWidth: StyleSheet.hairlineWidth,
    marginHorizontal: Spacing.lg,
    marginBottom: Spacing.lg,
    borderRadius: 12,
  },
  logContent: {
    padding: Spacing.md,
    gap: Spacing.sm,
  },
  emptyText: {
    fontSize: FontSize.sm,
  },
  logEntry: {
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 8,
    padding: Spacing.sm,
    gap: Spacing.xs,
  },
  logMeta: {
    fontSize: FontSize.xs,
    fontWeight: '700',
  },
  logLine: {
    fontFamily: Fonts?.mono,
    fontSize: FontSize.sm,
    lineHeight: 18,
  },
});
