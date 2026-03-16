import React, { forwardRef, useState } from 'react';
import { View, Text, Pressable } from 'react-native';
import { Canvas, Fill, Text as SkiaText, matchFont, Rect } from '@shopify/react-native-skia';
import { SkiaTerminal, SkiaTerminalHandle } from './SkiaTerminal';

export interface SkiaTerminalViewProps {
  onData: (data: string) => void;
  onResize: (cols: number, rows: number) => void;
  fontSize?: number;
  cursorBlinkInterval?: number;
  theme?: Record<string, any>;
}

// Minimal Skia test to verify rendering works
function SkiaDebugCanvas() {
  let font = null;
  let fontError = '';
  try {
    font = matchFont({ fontFamily: 'monospace', fontSize: 16, fontWeight: 'normal', fontStyle: 'normal' });
    console.log('[SkiaDebug] matchFont result:', font);
  } catch (e: any) {
    fontError = e.message;
    console.error('[SkiaDebug] matchFont failed:', e);
  }

  return (
    <View style={{ flex: 1 }}>
      <Text style={{ color: '#c9d1d9', padding: 8 }}>
        Skia Debug: font={font ? 'loaded' : 'null'} {fontError ? `err: ${fontError}` : ''}
      </Text>
      <Canvas style={{ flex: 1, width: '100%' }}>
        <Fill color="#0d1117" />
        <Rect x={10} y={10} width={200} height={40} color="#58a6ff" />
        {font && (
          <SkiaText x={20} y={35} text="Hello from Skia on Web!" font={font} color="#ffffff" />
        )}
        <Rect x={10} y={60} width={100} height={20} color="#3fb950" />
        <Rect x={120} y={60} width={100} height={20} color="#ff7b72" />
      </Canvas>
    </View>
  );
}

const SkiaTerminalView = forwardRef<SkiaTerminalHandle, SkiaTerminalViewProps>(
  ({ onData, onResize, fontSize = 13, cursorBlinkInterval = 600, theme }, ref) => {
    const [debug, setDebug] = useState(true);

    if (debug) {
      return (
        <View style={{ flex: 1 }}>
          <Pressable onPress={() => setDebug(false)} style={{ padding: 8, backgroundColor: '#21262d' }}>
            <Text style={{ color: '#58a6ff' }}>Switch to real terminal</Text>
          </Pressable>
          <SkiaDebugCanvas />
        </View>
      );
    }

    return (
      <SkiaTerminal
        ref={ref}
        onData={onData}
        onResize={onResize}
        fontSize={fontSize}
        cursorBlinkInterval={cursorBlinkInterval}
        theme={theme}
      />
    );
  }
);

export default SkiaTerminalView;
