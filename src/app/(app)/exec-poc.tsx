import React, { useEffect, useMemo, useRef, useState, useCallback } from 'react';
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
import { router } from 'expo-router';
import { useTheme } from '@/hooks/use-theme';
import {
  createExecPocClient,
  ExecConnectionState,
  ExecEventLog,
} from '@/services/exec-poc';
import { FontSize, Spacing } from '@/constants/theme';
import type { SkiaTerminalHandle } from '@/components/terminal';

// On native, we can statically import SkiaTerminal.
// On web, we must defer it until CanvasKit is loaded via WithSkiaWeb.
const SkiaTerminalNative =
  Platform.OS !== 'web'
    ? require('@/components/terminal').SkiaTerminal
    : null;

const TERMINAL_THEME = {
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
};

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

// Lazy web terminal: loads CanvasKit wasm, then dynamically imports SkiaTerminal
function WebTerminal({
  termRef,
  onData,
  onResize,
}: {
  termRef: React.RefObject<SkiaTerminalHandle | null>;
  onData: (data: string) => void;
  onResize: (cols: number, rows: number) => void;
}) {
  const [skiaReady, setSkiaReady] = useState(false);
  const [Terminal, setTerminal] = useState<React.ComponentType<any> | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    console.log('[WebTerminal] Starting LoadSkiaWeb...');
    const { LoadSkiaWeb } = require('@shopify/react-native-skia/lib/module/web');
    LoadSkiaWeb()
      .then(async () => {
        console.log('[WebTerminal] CanvasKit loaded, importing SkiaTerminalView...');
        if (cancelled) return;
        setSkiaReady(true);
        const mod = await import('@/components/terminal/SkiaTerminalView');
        console.log('[WebTerminal] SkiaTerminalView imported, default export:', typeof mod.default);
        if (!cancelled) setTerminal(() => mod.default);
      })
      .catch((err: Error) => {
        console.error('[WebTerminal] Error:', err);
        if (!cancelled) setError(err.message);
      });
    return () => { cancelled = true; };
  }, []);

  if (error) {
    return (
      <View style={{ flex: 1, justifyContent: 'center', alignItems: 'center' }}>
        <Text style={{ color: '#ff6b6b' }}>Skia error: {error}</Text>
      </View>
    );
  }

  if (!Terminal) {
    return (
      <View style={{ flex: 1, justifyContent: 'center', alignItems: 'center' }}>
        <Text style={{ color: '#c9d1d9' }}>
          {skiaReady ? 'Loading terminal...' : 'Loading Skia...'}
        </Text>
      </View>
    );
  }

  console.log('[WebTerminal] Rendering Terminal component, termRef.current:', termRef.current);

  return (
    <Terminal
      ref={termRef}
      onData={onData}
      onResize={onResize}
      fontSize={13}
      cursorBlinkInterval={600}
      theme={TERMINAL_THEME}
    />
  );
}

export default function ExecPocScreen() {
  const colors = useTheme();
  const [spriteName, setSpriteName] = useState('');
  const [command, setCommand] = useState(DEFAULT_CLAUDE_COMMAND);
  const [attachSessionId, setAttachSessionId] = useState('');
  const [sessionId, setSessionId] = useState<string | undefined>();
  const [state, setState] = useState<ExecConnectionState>('idle');
  const [showSetup, setShowSetup] = useState(false);
  const [showKeys, setShowKeys] = useState(false);

  const termRef = useRef<SkiaTerminalHandle>(null);

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

  const testTerminal = () => {
    if (!termRef.current) {
      console.warn('termRef.current is null');
      return;
    }
    const sample =
      '\x1b[?2026h' +
      '\r\n────────────────────────────────────────────────────────────────────────────────\r\n\r\n' +
      '\x1b[1C Accessing workspace:\r\n\r\n' +
      '\x1b[1C /home/sprite\r\n\r\n' +
      '\x1b[1C Quick safety check: Is this a project you created or one you trust?\r\n' +
      '\x1b[1C (Like your own code, a well-known open source project, or work from your team).\r\n\r\n' +
      '\x1b[32mHello \x1b[1;33mWorld\x1b[0m - Terminal is working!\r\n\r\n' +
      '\x1b[1C \x1b[36m❯\x1b[0m 1. Yes, I trust this folder\r\n' +
      '\x1b[3C 2. No, exit\r\n';
    termRef.current.write(sample);
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
          <Text style={[styles.title, { color: colors.text }]}>Terminal</Text>
          <View style={styles.headerActions}>
            <Pressable onPress={testTerminal}>
              <Text style={[styles.clearButton, { color: colors.destructive || '#ff6b6b' }]}>Test</Text>
            </Pressable>
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
            <WebTerminal
              termRef={termRef}
              onData={(data) => client.send(data, false)}
              onResize={(cols, rows) => client.resize(cols, rows)}
            />
          ) : (
            <SkiaTerminalNative
              ref={termRef}
              onData={(data: string) => client.send(data, false)}
              onResize={(cols: number, rows: number) => client.resize(cols, rows)}
              fontSize={13}
              cursorBlinkInterval={600}
              theme={TERMINAL_THEME}
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
