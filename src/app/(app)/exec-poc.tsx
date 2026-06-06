import SkiaWebWrapper from '@/components/web/WithSkiaWeb';
import React, { useEffect, useMemo, useRef, useState, useCallback } from 'react';

// ... other imports stay the same
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
import { SafeAreaView } from 'react-native-safe-area-context';
import { router, useLocalSearchParams } from 'expo-router';
import { useTheme } from '@/hooks/use-theme';
import {
  createExecPocClient,
  ExecConnectionState,
  ExecEventLog,
} from '@/services/exec-poc';
import { FontSize, Spacing } from '@/constants/theme';
import { SkiaTerminal, SkiaTerminalHandle } from '@/components/terminal';

const DEFAULT_CLAUDE_COMMAND = 'claude';

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

export default function ExecPocScreen() {
  const colors = useTheme();
  const params = useLocalSearchParams<{ name?: string; cwd?: string; cmd?: string }>();
  const paramName = typeof params.name === 'string' ? params.name : '';
  const paramCwd = typeof params.cwd === 'string' ? params.cwd : '';
  const paramCmd = typeof params.cmd === 'string' ? params.cmd : '';

  const [spriteName, setSpriteName] = useState(paramName);
  // With a working directory we launch a shell and type `cd <dir> && claude`, which
  // works no matter how the exec endpoint tokenizes `cmd`. Otherwise run the command directly.
  const [command, setCommand] = useState(paramCmd || (paramCwd ? 'bash' : DEFAULT_CLAUDE_COMMAND));
  const [attachSessionId, setAttachSessionId] = useState('');
  const [sessionId, setSessionId] = useState<string | undefined>();
  const [state, setState] = useState<ExecConnectionState>('idle');
  const [showSetup, setShowSetup] = useState(false);
  const [showKeys, setShowKeys] = useState(false);

  const termRef = useRef<SkiaTerminalHandle>(null);
  const initialInputRef = useRef<string | undefined>(
    paramCwd ? `cd "${paramCwd}" && claude\r` : undefined
  );
  const didAutoConnectRef = useRef(false);

  const appendLog = useCallback((entry: ExecEventLog) => {
    if (!termRef.current) return;
    
    if (entry.source === 'ws') {
      termRef.current.write(entry.text);
    } else if (entry.source === 'event') {
      // Commented out to reduce noise, since session_info etc. events come often
      // termRef.current.write(`\r\n\x1b[33m[EVENT]\x1b[0m ${entry.text}\r\n`);
    } else if (entry.source === 'local') {
      // termRef.current.write(`\r\n\x1b[34m[LOCAL]\x1b[0m ${entry.text}\r\n`);
    } else if (entry.source === 'error') {
      termRef.current.write(`\r\n\x1b[31m[ERROR]\x1b[0m ${entry.text}\r\n`);
    }
  }, []);

  const client = useMemo(
    () =>
      createExecPocClient({
        onStateChange: setState,
        onSessionId: setSessionId,
        onLog: appendLog,
      }),
    [appendLog]
  );

  useEffect(() => {
    return () => {
      client.close();
    };
  }, [client]);

  // Auto-connect when launched for a specific sprite (from the sprite screen).
  useEffect(() => {
    if (didAutoConnectRef.current || !paramName) return;
    didAutoConnectRef.current = true;
    (async () => {
      try {
        await client.connect({
          spriteName: paramName,
          command: paramCmd || (paramCwd ? 'bash' : DEFAULT_CLAUDE_COMMAND),
          initialInput: initialInputRef.current,
        });
        setShowSetup(false);
        termRef.current?.focus();
      } catch (error) {
        appendLog({
          timestamp: Date.now(),
          source: 'error',
          text: `Connect failed: ${(error as Error).message}`,
        });
      }
    })();
  }, [paramName, paramCmd, paramCwd, client, appendLog]);

  const sendControl = (label: string, payload: string) => {
    client.send(payload, false);
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
      termRef.current?.focus();
    } catch (error) {
      appendLog({
        timestamp: Date.now(),
        source: 'error',
        text: `Connect failed: ${(error as Error).message}`,
      });
    }
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
  };

  return (
    <SafeAreaView style={[styles.container, { backgroundColor: colors.backgroundSecondary }]} edges={['top']}>
      <KeyboardAvoidingView
        style={styles.container}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      >
        <View style={styles.headerRow}>
          <Pressable onPress={() => router.back()}>
            <Text style={[styles.backButton, { color: colors.tint }]}>Back</Text>
          </Pressable>
          <Text style={[styles.title, { color: colors.text }]} numberOfLines={1}>
            {spriteName ? spriteName : 'Terminal'}
          </Text>
          <View style={styles.headerActions}>
            <Pressable onPress={() => termRef.current?.focus()}>
              <Text style={[styles.clearButton, { color: colors.tint }]}>Focus</Text>
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

        <View style={[styles.logContainer, { backgroundColor: '#0d1117', borderColor: colors.border }]}>
          {Platform.OS === 'web' ? (
            <SkiaWebWrapper>
              <SkiaTerminal
                ref={termRef}
                onData={(data) => client.send(data, false)}
                onResize={(cols, rows) => client.resize(cols, rows)}
                fontSize={13}
                cursorBlinkInterval={600}
                theme={{
                  background: '#0d1117',
                  foreground: '#c9d1d9',
                  cursor: '#58a6ff',
                  cursorAccent: '#0d1117',
                  selectionBackground: '#264f78',
                  selectionForeground: '#ffffff',
                  ansiColors: [
                    '#484f58', '#ff7b72', '#3fb950', '#d29922',
                    '#58a6ff', '#bc8cff', '#39c5cf', '#b1bac4',
                    '#6e7681', '#ffa198', '#56d364', '#e3b341',
                    '#79c0ff', '#d2a8ff', '#56d4dd', '#f0f6fc',
                  ],
                }}
              />
            </SkiaWebWrapper>
          ) : (
            <SkiaTerminal
              ref={termRef}
              onData={(data) => client.send(data, false)}
              onResize={(cols, rows) => client.resize(cols, rows)}
              fontSize={13}
              cursorBlinkInterval={600}
              theme={{
                background: '#0d1117',
                foreground: '#c9d1d9',
                cursor: '#58a6ff',
                cursorAccent: '#0d1117',
                selectionBackground: '#264f78',
                selectionForeground: '#ffffff',
                ansiColors: [
                  '#484f58', '#ff7b72', '#3fb950', '#d29922',
                  '#58a6ff', '#bc8cff', '#39c5cf', '#b1bac4',
                  '#6e7681', '#ffa198', '#56d364', '#e3b341',
                  '#79c0ff', '#d2a8ff', '#56d4dd', '#f0f6fc',
                ],
              }}
            />
          )}
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
  quickControlsRow: {
    flexDirection: 'row',
    gap: Spacing.sm,
    paddingHorizontal: Spacing.lg,
    paddingBottom: Spacing.sm,
  },
  quickControlsScroll: {
    marginBottom: Spacing.sm,
    flexGrow: 0,
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
  logContainer: {
    flex: 1,
    borderTopWidth: StyleSheet.hairlineWidth,
    marginHorizontal: Spacing.lg,
    marginBottom: Spacing.lg,
    borderRadius: 12,
    overflow: 'hidden',
  },
});
