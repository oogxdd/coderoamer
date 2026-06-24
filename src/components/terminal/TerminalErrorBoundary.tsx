/**
 * TerminalErrorBoundary — last line of defense for the terminal render tree.
 *
 * The terminal is a hand-rolled xterm.js port driving a Skia canvas; a single
 * unhandled throw in the parse/render path would otherwise unwind through the
 * whole app and crash it (there is no boundary above this screen). Catching here
 * turns that into a recoverable "tap to reload" surface that re-mounts the
 * terminal with a fresh buffer while leaving the rest of the app alive.
 */

import React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { terror } from './terminalLog';

interface Props {
  children: React.ReactNode;
  /** Notified when the boundary catches, so the host can re-arm input/connection. */
  onReset?: () => void;
}

interface State {
  error: Error | null;
}

export class TerminalErrorBoundary extends React.Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    // Keep the message in the log stream rather than the redbox. NOTE: this only fires
    // for throws during React render/lifecycle — it does NOT catch throws in the async
    // WebSocket→buffer.write parse path, nor native Skia paint crashes. Those are
    // contained / logged at their own sites (see TerminalBuffer.write, terminalLog).
    terror('boundary', 'render error caught', {
      message: error?.message,
      stack: error?.stack,
      componentStack: info?.componentStack,
    });
  }

  private handleReset = () => {
    this.setState({ error: null });
    this.props.onReset?.();
  };

  render() {
    if (this.state.error) {
      return (
        <View style={styles.container}>
          <Text style={styles.title}>Terminal hit an error</Text>
          <Text style={styles.detail} numberOfLines={3}>
            {this.state.error.message || 'Unknown rendering error'}
          </Text>
          <Pressable
            style={({ pressed }) => [styles.button, pressed && { opacity: 0.7 }]}
            onPress={this.handleReset}
          >
            <Text style={styles.buttonText}>Reload terminal</Text>
          </Pressable>
        </View>
      );
    }
    return this.props.children;
  }
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    paddingHorizontal: 32,
    backgroundColor: '#0d1117',
  },
  title: {
    color: '#f0f6fc',
    fontSize: 16,
    fontWeight: '700',
    marginBottom: 8,
  },
  detail: {
    color: '#8b949e',
    fontSize: 13,
    textAlign: 'center',
    marginBottom: 20,
    fontFamily: 'monospace',
  },
  button: {
    backgroundColor: '#238636',
    borderRadius: 6,
    paddingHorizontal: 20,
    paddingVertical: 10,
  },
  buttonText: {
    color: '#ffffff',
    fontSize: 14,
    fontWeight: '600',
  },
});
