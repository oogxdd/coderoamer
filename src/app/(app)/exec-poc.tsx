import React, { useEffect, useMemo, useRef, useState, useCallback } from 'react';
import {
  Alert,
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
import {
  createExecPocClient,
  ExecConnectionState,
  ExecEventLog,
} from '@/services/exec-poc';
import * as Clipboard from 'expo-clipboard';
import { TerminalErrorBoundary } from '@/components/terminal';
import type { SkiaTerminalHandle } from '@/components/terminal';
import { terror, tinfo, errInfo, dumpTerminalLog, clearTerminalLog } from '@/components/terminal/terminalLog';

// On native, statically import. On web, defer until CanvasKit loads.
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

const DEFAULT_SHELL_COMMAND = 'bash';

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function shellPathExpression(path: string): string {
  const trimmed = path.trim();
  if (trimmed === '~' || trimmed === '$HOME') return '$HOME';
  if (trimmed.startsWith('~/')) return `$HOME/${shellQuote(trimmed.slice(2))}`;
  if (trimmed.startsWith('$HOME/')) return `$HOME/${shellQuote(trimmed.slice(6))}`;
  return shellQuote(trimmed);
}

function buildResumeCommand(sessionId: string): string {
  return `claude --resume ${shellQuote(sessionId.trim())}`;
}

function buildInitialInput(cwd: string, command: string): string | undefined {
  const nextCwd = cwd.trim();
  const nextCommand = command.trim();
  if (!nextCwd && !nextCommand) return undefined;
  if (!nextCwd) return `${nextCommand}\r`;

  const cdCommand = `mkdir -p ${shellPathExpression(nextCwd)} && cd ${shellPathExpression(nextCwd)}`;
  return `${nextCommand ? `${cdCommand} && ${nextCommand}` : cdCommand}\r`;
}

const QUICK_CONTROLS = [
  { label: 'Enter', payload: '\r' },
  { label: 'Esc', payload: '\u001b' },
  { label: 'Tab', payload: '\t' },
  { label: '1', payload: '1\r' },
  { label: 'Up', payload: '\u001b[A' },
  { label: 'Down', payload: '\u001b[B' },
  { label: 'Ctrl+C', payload: '\u0003' },
  { label: 'Ctrl+D', payload: '\u0004' },
];

const STATE_COLORS: Record<ExecConnectionState, string> = {
  idle: '#6e7681',
  connecting: '#d29922',
  open: '#3fb950',
  closed: '#6e7681',
  error: '#ff7b72',
};

// ── Web Terminal (deferred Skia loading) ────────────────────────────────
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
    const { LoadSkiaWeb } = require('@shopify/react-native-skia/lib/module/web');
    LoadSkiaWeb()
      .then(async () => {
        if (cancelled) return;
        setSkiaReady(true);
        const mod = await import('@/components/terminal/SkiaTerminalView');
        if (!cancelled) setTerminal(() => mod.default);
      })
      .catch((err: Error) => {
        if (!cancelled) setError(err.message);
      });
    return () => { cancelled = true; };
  }, []);

  if (error) {
    return (
      <View style={styles.terminalPlaceholder}>
        <Text style={{ color: '#ff7b72', fontSize: 13 }}>Failed to load: {error}</Text>
      </View>
    );
  }

  if (!Terminal) {
    return (
      <View style={styles.terminalPlaceholder}>
        <View style={styles.loadingDot} />
        <Text style={{ color: '#6e7681', fontSize: 13, marginTop: 8 }}>
          {skiaReady ? 'Initializing terminal...' : 'Loading CanvasKit...'}
        </Text>
      </View>
    );
  }

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

// ── Main Screen ─────────────────────────────────────────────────────────
export default function ExecPocScreen() {
  const params = useLocalSearchParams<{
    name?: string;
    cwd?: string;
    cmd?: string;
    attachSessionId?: string;
    resumeSessionId?: string;
  }>();
  const paramName = typeof params.name === 'string' ? params.name : '';
  const paramCwd = typeof params.cwd === 'string' ? params.cwd : '';
  const paramCmd = typeof params.cmd === 'string' ? params.cmd : '';
  const paramAttachSessionId = typeof params.attachSessionId === 'string' ? params.attachSessionId : '';
  const paramResumeSessionId = typeof params.resumeSessionId === 'string' ? params.resumeSessionId : '';
  const routeCommand =
    paramCmd ||
    (paramResumeSessionId ? buildResumeCommand(paramResumeSessionId) : '');

  const [spriteName, setSpriteName] = useState(paramName);
  const [cwd, setCwd] = useState(paramCwd);
  const [resumeSessionId, setResumeSessionId] = useState(paramResumeSessionId);
  // With a working directory we launch a shell and type `cd <dir> && <command>`,
  // which works no matter how the exec endpoint tokenizes `cmd`.
  const [command, setCommand] = useState(routeCommand);
  const [attachSessionId, setAttachSessionId] = useState(paramAttachSessionId);
  const [sessionId, setSessionId] = useState<string | undefined>();
  const [state, setState] = useState<ExecConnectionState>('idle');
  const [showSetup, setShowSetup] = useState(!paramName);
  // Bumped to force a clean remount of the terminal (fresh buffer) after the
  // error boundary catches, without tearing down the live WebSocket session.
  const [terminalEpoch, setTerminalEpoch] = useState(0);

  const termRef = useRef<SkiaTerminalHandle>(null);
  const didAutoConnectRef = useRef(false);

  const appendLog = useCallback((entry: ExecEventLog) => {
    if (!termRef.current) return;
    // Defense in depth: termRef.write → buffer.write already contains parser throws,
    // but keep this path total too so a logging write can never bubble up here.
    try {
      if (entry.source === 'ws') {
        termRef.current.write(entry.text);
      } else if (entry.source === 'error') {
        termRef.current.write(`\r\n\x1b[31m[ERROR]\x1b[0m ${entry.text}\r\n`);
      }
    } catch (e) {
      terror('screen.appendLog', 'write threw', { err: errInfo(e), source: entry.source });
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

  useEffect(() => () => client.close(), [client]);

  // Auto-connect on mount. Route params can target a sprite, cwd, command, or existing session.
  useEffect(() => {
    if (didAutoConnectRef.current || !paramName) return;
    didAutoConnectRef.current = true;

    const startupCommand = paramResumeSessionId ? buildResumeCommand(paramResumeSessionId) : routeCommand;
    const initialInput = paramAttachSessionId ? undefined : buildInitialInput(paramCwd, startupCommand);

    (async () => {
      try {
        await client.connect({
          spriteName: paramName,
          command: DEFAULT_SHELL_COMMAND,
          attachSessionId: paramAttachSessionId || undefined,
          initialInput,
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
  }, [
    paramName,
    paramCwd,
    paramCmd,
    paramAttachSessionId,
    paramResumeSessionId,
    routeCommand,
    client,
    appendLog,
  ]);

  const connect = async () => {
    if (!spriteName.trim()) {
      Alert.alert('Missing sprite name', 'Enter a sprite name first.');
      return;
    }
    try {
      const nextResumeSessionId = resumeSessionId.trim();
      const startupCommand = nextResumeSessionId
        ? buildResumeCommand(nextResumeSessionId)
        : command.trim();
      const nextAttachSessionId = attachSessionId.trim() || undefined;
      const initialInput = nextAttachSessionId ? undefined : buildInitialInput(cwd, startupCommand);
      await client.connect({
        spriteName: spriteName.trim(),
        command: DEFAULT_SHELL_COMMAND,
        attachSessionId: nextAttachSessionId,
        initialInput,
      });
      setShowSetup(false);
      termRef.current?.focus();
    } catch (error) {
      appendLog({ timestamp: Date.now(), source: 'error', text: `Connect failed: ${(error as Error).message}` });
    }
  };

  const disconnect = () => {
    client.close();
    setState('closed');
  };

  // Re-mount the terminal with a clean buffer after a render error, then nudge
  // the remote app to repaint into the fresh screen.
  const handleTerminalReset = useCallback(() => {
    tinfo('screen.reset', 'terminal error boundary reset — remounting with fresh buffer');
    setTerminalEpoch((e) => e + 1);
    setTimeout(() => {
      termRef.current?.focus();
      if (client.getState() === 'open') client.send('\f', false);
    }, 50);
  }, [client]);

  const copyLogs = useCallback(async () => {
    const dump = dumpTerminalLog();
    try {
      await Clipboard.setStringAsync(dump);
      Alert.alert('Terminal logs copied', `${dump.split('\n').length} lines copied to clipboard. Paste them to share.`);
    } catch (e) {
      Alert.alert('Copy failed', (e as Error).message);
    }
  }, []);

  const isConnected = state === 'open';

  return (
    <SafeAreaView style={[styles.container, { backgroundColor: '#010409' }]} edges={['top']}>
      {/* No KeyboardAvoidingView here: SkiaTerminal owns keyboard avoidance, and
          stacking both double-subtracts the keyboard height (jumpy canvas + a
          flood of resize events to the PTY). */}
      <View style={styles.container}>
        {/* Header */}
        <View style={styles.header}>
          <Pressable onPress={() => router.back()} hitSlop={8}>
            <Text style={styles.headerLink}>Back</Text>
          </Pressable>
          <View style={styles.headerCenter}>
            <View style={[styles.statusDot, { backgroundColor: STATE_COLORS[state] }]} />
            <Text style={styles.headerTitle}>
              {sessionId ? `Session ${sessionId}` : 'Terminal'}
            </Text>
          </View>
          <View style={styles.headerActions}>
            <Pressable onPress={copyLogs} onLongPress={() => { clearTerminalLog(); Alert.alert('Terminal logs cleared'); }} hitSlop={8}>
              <Text style={styles.headerLink}>Logs</Text>
            </Pressable>
            <Pressable onPress={() => setShowSetup((v) => !v)} hitSlop={8}>
              <Text style={[styles.headerLink, showSetup && { color: '#58a6ff' }]}>
                {showSetup ? 'Hide' : 'Setup'}
              </Text>
            </Pressable>
          </View>
        </View>

        {/* Setup panel */}
        {showSetup && (
          <View style={styles.setupPanel}>
            <View style={styles.setupRow}>
              <TextInput
                style={styles.setupInput}
                placeholder="sprite-name"
                placeholderTextColor="#484f58"
                autoCapitalize="none"
                autoCorrect={false}
                value={spriteName}
                onChangeText={setSpriteName}
              />
              <TextInput
                style={[styles.setupInput, { flex: 0.6 }]}
                placeholder="command"
                placeholderTextColor="#484f58"
                autoCapitalize="none"
                autoCorrect={false}
                value={command}
                onChangeText={setCommand}
              />
            </View>
            <View style={styles.setupRow}>
              <TextInput
                style={styles.setupInput}
                placeholder="working directory, e.g. ~/type/type_new"
                placeholderTextColor="#484f58"
                autoCapitalize="none"
                autoCorrect={false}
                value={cwd}
                onChangeText={setCwd}
              />
            </View>
            <View style={styles.setupRow}>
              <TextInput
                style={styles.setupInput}
                placeholder="claude resume session ID (optional)"
                placeholderTextColor="#484f58"
                autoCapitalize="none"
                autoCorrect={false}
                value={resumeSessionId}
                onChangeText={setResumeSessionId}
              />
            </View>
            <View style={styles.setupRow}>
              <TextInput
                style={styles.setupInput}
                placeholder="attach session ID (optional)"
                placeholderTextColor="#484f58"
                autoCapitalize="none"
                autoCorrect={false}
                value={attachSessionId}
                onChangeText={setAttachSessionId}
              />
              <Pressable
                style={({ pressed }) => [
                  styles.connectButton,
                  isConnected
                    ? { backgroundColor: '#21262d', borderColor: '#30363d' }
                    : { backgroundColor: '#238636', borderColor: '#2ea043' },
                  pressed && { opacity: 0.7 },
                ]}
                onPress={isConnected ? disconnect : connect}
              >
                <Text style={[styles.connectButtonText, isConnected && { color: '#f0f6fc' }]}>
                  {isConnected ? 'Disconnect' : state === 'connecting' ? 'Connecting...' : 'Connect'}
                </Text>
              </Pressable>
            </View>
          </View>
        )}

        {/* Quick keys */}
        {isConnected && (
          <ScrollView
            horizontal
            style={styles.keysScroll}
            contentContainerStyle={styles.keysRow}
            showsHorizontalScrollIndicator={false}
          >
            {QUICK_CONTROLS.map((c) => (
              <Pressable
                key={c.label}
                style={({ pressed }) => [styles.keyButton, pressed && { opacity: 0.6 }]}
                onPress={() => client.send(c.payload, false)}
              >
                <Text style={styles.keyLabel}>{c.label}</Text>
              </Pressable>
            ))}
          </ScrollView>
        )}

        {/* Terminal */}
        <View style={styles.terminalContainer}>
          <TerminalErrorBoundary key={terminalEpoch} onReset={handleTerminalReset}>
            {Platform.OS === 'web' ? (
              <WebTerminal
                termRef={termRef}
                onData={(data) => {
                  if (client.getState() === 'open') client.send(data, false);
                }}
                onResize={(cols, rows) => client.resize(cols, rows)}
              />
            ) : (
              <SkiaTerminalNative
                ref={termRef}
                onData={(data: string) => {
                  if (client.getState() === 'open') client.send(data, false);
                }}
                onResize={(cols: number, rows: number) => client.resize(cols, rows)}
                fontSize={13}
                cursorBlinkInterval={600}
                theme={TERMINAL_THEME}
              />
            )}
          </TerminalErrorBoundary>
        </View>
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  // ── Header ──
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: '#21262d',
  },
  headerCenter: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  headerTitle: {
    color: '#c9d1d9',
    fontSize: 14,
    fontWeight: '600',
  },
  headerLink: {
    color: '#8b949e',
    fontSize: 14,
    fontWeight: '500',
  },
  headerActions: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 16,
  },
  statusDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
  },
  // ── Setup panel ──
  setupPanel: {
    paddingHorizontal: 12,
    paddingVertical: 10,
    gap: 8,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: '#21262d',
  },
  setupRow: {
    flexDirection: 'row',
    gap: 8,
  },
  setupInput: {
    flex: 1,
    backgroundColor: '#0d1117',
    borderWidth: 1,
    borderColor: '#30363d',
    borderRadius: 6,
    paddingHorizontal: 10,
    paddingVertical: 6,
    color: '#c9d1d9',
    fontSize: 13,
  },
  connectButton: {
    borderWidth: 1,
    borderRadius: 6,
    paddingHorizontal: 16,
    paddingVertical: 6,
    alignItems: 'center',
    justifyContent: 'center',
  },
  connectButtonText: {
    color: '#ffffff',
    fontSize: 13,
    fontWeight: '600',
  },
  // ── Quick keys ──
  keysScroll: {
    flexGrow: 0,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: '#21262d',
  },
  keysRow: {
    flexDirection: 'row',
    gap: 6,
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  keyButton: {
    backgroundColor: '#21262d',
    borderRadius: 4,
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderWidth: 1,
    borderColor: '#30363d',
  },
  keyLabel: {
    color: '#8b949e',
    fontSize: 12,
    fontWeight: '500',
    fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
  },
  // ── Terminal ──
  terminalContainer: {
    flex: 1,
    backgroundColor: '#0d1117',
  },
  terminalPlaceholder: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: '#0d1117',
  },
  loadingDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
    backgroundColor: '#484f58',
  },
});
