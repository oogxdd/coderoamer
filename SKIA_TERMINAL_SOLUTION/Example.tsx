/**
 * Example usage of skia-terminal
 *
 * Dependencies to install:
 *   npm install @shopify/react-native-skia react-native-reanimated react-native-gesture-handler
 *
 * Optional: bundle monospace fonts in your project:
 *   assets/fonts/JetBrainsMono-Regular.ttf
 *   assets/fonts/JetBrainsMono-Bold.ttf
 *   assets/fonts/JetBrainsMono-Italic.ttf
 *   assets/fonts/JetBrainsMono-BoldItalic.ttf
 */

import React, { useRef, useState, useCallback } from 'react';
import { View, StyleSheet, Text, TouchableOpacity, Clipboard, Alert } from 'react-native';
import {
  SkiaTerminal,
  SkiaTerminalHandle,
  SkiaTerminalRenderer,
  useTerminal,
  DEFAULT_THEME,
  ConnectionStatus,
  FontConfig,
} from './src';

// ════════════════════════════════════════════════════════════════════════════
// Example 1: Full terminal connected to sprites.dev
// ════════════════════════════════════════════════════════════════════════════

const GITHUB_DARK_THEME = {
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

// Uncomment if you've bundled these fonts:
// const FONT_CONFIG: FontConfig = {
//   regular: require('./assets/fonts/JetBrainsMono-Regular.ttf'),
//   bold: require('./assets/fonts/JetBrainsMono-Bold.ttf'),
//   italic: require('./assets/fonts/JetBrainsMono-Italic.ttf'),
//   boldItalic: require('./assets/fonts/JetBrainsMono-BoldItalic.ttf'),
// };

export function SpritesTerminalScreen() {
  const termRef = useRef<SkiaTerminalHandle>(null);
  const [title, setTitle] = useState('Terminal');
  const [status, setStatus] = useState<ConnectionStatus>('disconnected');
  const [selectedText, setSelectedText] = useState<string | null>(null);

  const handleCopy = useCallback(() => {
    if (selectedText) {
      Clipboard.setString(selectedText);
      termRef.current?.clearSelection();
      Alert.alert('Copied', `${selectedText.length} characters copied`);
    }
  }, [selectedText]);

  const handlePaste = useCallback(async () => {
    const text = await Clipboard.getString();
    if (text && termRef.current) {
      // Send paste via bracketed paste mode
      termRef.current.write(`\x1b[200~${text}\x1b[201~`);
    }
  }, []);

  const statusColor = {
    disconnected: '#666',
    connecting: '#d29922',
    connected: '#3fb950',
    error: '#ff7b72',
  }[status];

  return (
    <View style={styles.container}>
      {/* Title bar */}
      <View style={styles.titleBar}>
        <View style={[styles.statusDot, { backgroundColor: statusColor }]} />
        <Text style={styles.titleText}>{title}</Text>
        <View style={styles.titleActions}>
          {selectedText && (
            <TouchableOpacity onPress={handleCopy} style={styles.actionBtn}>
              <Text style={styles.actionText}>Copy</Text>
            </TouchableOpacity>
          )}
          <TouchableOpacity onPress={handlePaste} style={styles.actionBtn}>
            <Text style={styles.actionText}>Paste</Text>
          </TouchableOpacity>
        </View>
      </View>

      {/* Terminal */}
      <SkiaTerminal
        ref={termRef}
        wsUrl="wss://api.sprites.dev/v1/sprites/first-sprite/exec?cmd=bash&tty=true&stdin=true&cols=120&rows=40"
        fontSize={13}
        // fontConfig={FONT_CONFIG}
        theme={GITHUB_DARK_THEME}
        cursorBlinkInterval={600}
        onTitleChange={setTitle}
        onConnectionChange={setStatus}
        onSelectionChange={setSelectedText}
        onBell={() => console.log('🔔 Bell!')}
        onData={(data) => {
          // Optional: log all input for debugging
          // console.log('TX:', JSON.stringify(data));
        }}
      />
    </View>
  );
}

// ════════════════════════════════════════════════════════════════════════════
// Example 2: Standalone demo (no WebSocket)
// ════════════════════════════════════════════════════════════════════════════

export function DemoTerminalScreen() {
  const { buffer, write, renderVersion } = useTerminal(80, 24);

  React.useEffect(() => {
    write('\x1b[1;32m┌──────────────────────────────────────┐\x1b[0m\r\n');
    write('\x1b[1;32m│\x1b[0m  Welcome to \x1b[1;36mSkia Terminal\x1b[0m            \x1b[1;32m│\x1b[0m\r\n');
    write('\x1b[1;32m│\x1b[0m  Native rendering via react-native-skia \x1b[1;32m│\x1b[0m\r\n');
    write('\x1b[1;32m└──────────────────────────────────────┘\x1b[0m\r\n');
    write('\r\n');

    // Text styles
    write('Styles: \x1b[1mbold\x1b[0m \x1b[3mitalic\x1b[0m \x1b[1;3mbold+italic\x1b[0m ');
    write('\x1b[4munderline\x1b[0m \x1b[9mstrikethrough\x1b[0m \x1b[2mdim\x1b[0m\r\n');
    write('\r\n');

    // Standard 8 colors
    write('Standard:  ');
    for (let i = 0; i < 8; i++) write(`\x1b[${30 + i}m██\x1b[0m`);
    write('\r\n');

    // Bright 8 colors
    write('Bright:    ');
    for (let i = 0; i < 8; i++) write(`\x1b[${90 + i}m██\x1b[0m`);
    write('\r\n');

    // 256 color ramp
    write('256-color: ');
    for (let i = 16; i < 52; i++) write(`\x1b[38;5;${i}m▀\x1b[0m`);
    write('\r\n');

    // Truecolor gradient
    write('Truecolor: ');
    for (let i = 0; i < 36; i++) {
      const r = Math.round(255 * (1 - i / 36));
      const g = Math.round(255 * (i / 36));
      write(`\x1b[38;2;${r};${g};100m▀\x1b[0m`);
    }
    write('\r\n');

    // Background colors
    write('BG colors: ');
    for (let i = 0; i < 8; i++) write(`\x1b[${40 + i}m  \x1b[0m`);
    write('\r\n');

    // Inverse
    write('Inverse:   \x1b[7m this is inverted \x1b[0m\r\n');

    // Bold-as-bright
    write('Bold+color: \x1b[1;31mred\x1b[0m \x1b[1;32mgreen\x1b[0m \x1b[1;34mblue\x1b[0m (promoted to bright)\r\n');

    write('\r\n');
    write('\x1b[1;34m$\x1b[0m ');
  }, [write]);

  return (
    <View style={styles.demoContainer}>
      <SkiaTerminalRenderer
        buffer={buffer}
        fontSize={14}
        theme={DEFAULT_THEME}
        width={500}
        height={400}
        renderVersion={renderVersion}
        focused
      />
    </View>
  );
}

// ════════════════════════════════════════════════════════════════════════════
// Styles
// ════════════════════════════════════════════════════════════════════════════

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#0d1117',
  },
  titleBar: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 12,
    paddingVertical: 8,
    backgroundColor: '#161b22',
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: '#30363d',
  },
  statusDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    marginRight: 8,
  },
  titleText: {
    color: '#c9d1d9',
    fontSize: 13,
    fontWeight: '600',
    flex: 1,
  },
  titleActions: {
    flexDirection: 'row',
    gap: 8,
  },
  actionBtn: {
    paddingHorizontal: 10,
    paddingVertical: 4,
    backgroundColor: '#21262d',
    borderRadius: 6,
    borderWidth: 1,
    borderColor: '#30363d',
  },
  actionText: {
    color: '#c9d1d9',
    fontSize: 12,
  },
  demoContainer: {
    flex: 1,
    backgroundColor: '#1e1e1e',
    justifyContent: 'center',
    alignItems: 'center',
  },
});
