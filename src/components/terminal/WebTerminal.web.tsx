import React, { useEffect, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import type { SkiaTerminalHandle } from './SkiaTerminal';
import type { TerminalTheme } from './SkiaTerminalRenderer';

type Props = {
  termRef: React.RefObject<SkiaTerminalHandle | null>;
  onData: (data: string) => void;
  onResize: (cols: number, rows: number) => void;
  theme: TerminalTheme;
};

export default function WebTerminal({ termRef, onData, onResize, theme }: Props) {
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
        const mod = await import('./SkiaTerminalView');
        if (!cancelled) setTerminal(() => mod.default);
      })
      .catch((err: Error) => {
        if (!cancelled) setError(err.message);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (error) {
    return (
      <View style={styles.terminalPlaceholder}>
        <Text style={styles.errorText}>Failed to load: {error}</Text>
      </View>
    );
  }

  if (!Terminal) {
    return (
      <View style={styles.terminalPlaceholder}>
        <View style={styles.loadingDot} />
        <Text style={styles.loadingText}>
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
      theme={theme}
    />
  );
}

const styles = StyleSheet.create({
  terminalPlaceholder: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  loadingDot: {
    width: 12,
    height: 12,
    borderRadius: 6,
    backgroundColor: '#58a6ff',
  },
  loadingText: {
    color: '#6e7681',
    fontSize: 13,
    marginTop: 8,
  },
  errorText: {
    color: '#ff7b72',
    fontSize: 13,
  },
});
