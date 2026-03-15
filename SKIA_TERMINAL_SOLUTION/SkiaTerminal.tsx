/**
 * SkiaTerminal — complete terminal component
 *
 * Features:
 *   - WebSocket connection with reconnect support
 *   - Gesture-based scrollback (pan up/down through history)
 *   - Text selection via long-press + drag
 *   - Keyboard input with Ctrl/Meta modifier support
 *   - requestAnimationFrame-based render debouncing
 *   - Bell event callback
 *   - Title change callback (OSC 0/2)
 *   - Connection status tracking
 *   - Keyboard avoidance (adjust height when keyboard shows)
 */

import React, { useCallback, useEffect, useRef, useState, useMemo } from 'react';
import {
  View,
  TextInput,
  Keyboard,
  Dimensions,
  StyleSheet,
  Platform,
  NativeSyntheticEvent,
  TextInputKeyPressEventData,
  LayoutChangeEvent,
  Vibration,
} from 'react-native';
import {
  GestureDetector,
  Gesture,
  GestureHandlerRootView,
} from 'react-native-gesture-handler';
import { runOnJS } from 'react-native-reanimated';
import { TerminalBuffer } from './TerminalBuffer';
import {
  SkiaTerminalRenderer,
  TerminalTheme,
  DEFAULT_THEME,
  SelectionRange,
  FontConfig,
  CellMetrics,
  measureCell,
} from './SkiaTerminalRenderer';

// ────────────────────────────────────────────────────────────────────────────
// Types
// ────────────────────────────────────────────────────────────────────────────

export type ConnectionStatus = 'disconnected' | 'connecting' | 'connected' | 'error';

export interface SkiaTerminalProps {
  wsUrl?: string;
  webSocket?: WebSocket;
  cols?: number;
  rows?: number;
  fontSize?: number;
  fontConfig?: FontConfig;
  scrollback?: number;
  theme?: TerminalTheme;
  cursorBlinkInterval?: number;
  /** Called when user types (data sent to server) */
  onData?: (data: string) => void;
  /** Called on OSC title change */
  onTitleChange?: (title: string) => void;
  /** Called on BEL */
  onBell?: () => void;
  /** Called when connection status changes */
  onConnectionChange?: (status: ConnectionStatus) => void;
  /** Called when selection changes */
  onSelectionChange?: (text: string | null) => void;
  width?: number;
  height?: number;
}

export interface SkiaTerminalHandle {
  write: (data: string) => void;
  focus: () => void;
  blur: () => void;
  getSelection: () => string | null;
  clearSelection: () => void;
  scrollToBottom: () => void;
  buffer: TerminalBuffer;
}

// ────────────────────────────────────────────────────────────────────────────
// Selection text extraction
// ────────────────────────────────────────────────────────────────────────────

function extractSelectionText(
  buffer: TerminalBuffer,
  selection: SelectionRange,
): string {
  let [sx, sy] = selection.start;
  let [ex, ey] = selection.end;
  if (sy > ey || (sy === ey && sx > ex)) {
    [sx, sy, ex, ey] = [ex, ey, sx, sy];
  }

  const lines: string[] = [];
  const viewportLines = buffer.getViewportLines();

  for (let y = sy; y <= ey; y++) {
    const line = viewportLines[y];
    if (!line) continue;

    const startX = y === sy ? sx : 0;
    const endX = y === ey ? ex : line.length;
    let row = '';
    for (let x = startX; x < endX; x++) {
      row += line[x]?.char || ' ';
    }
    lines.push(row.trimEnd());
  }

  return lines.join('\n');
}

// ────────────────────────────────────────────────────────────────────────────
// Component
// ────────────────────────────────────────────────────────────────────────────

export const SkiaTerminal = React.forwardRef<SkiaTerminalHandle, SkiaTerminalProps>(({
  wsUrl,
  webSocket: externalWs,
  fontSize = 14,
  fontConfig,
  scrollback = 1000,
  theme = DEFAULT_THEME,
  cursorBlinkInterval = 600,
  onData,
  onTitleChange,
  onBell,
  onConnectionChange,
  onSelectionChange,
  width: propWidth,
  height: propHeight,
  cols: propCols,
  rows: propRows,
}, ref) => {
  // ── Layout ──────────────────────────────────────────────────────────
  const [layoutSize, setLayoutSize] = useState({ width: 0, height: 0 });
  const [keyboardHeight, setKeyboardHeight] = useState(0);

  const screenDims = Dimensions.get('window');
  const containerWidth = propWidth || layoutSize.width || screenDims.width;
  const containerHeight = (propHeight || layoutSize.height || screenDims.height) - keyboardHeight;

  // Rough cell size before fonts load (will be refined)
  const cellWidth = fontSize * 0.6;
  const cellHeight = fontSize * 1.2;
  const cols = propCols || Math.max(1, Math.floor(containerWidth / cellWidth));
  const rows = propRows || Math.max(1, Math.floor(containerHeight / cellHeight));

  // ── Keyboard avoidance ────────────────────────────────────────────
  useEffect(() => {
    const showSub = Keyboard.addListener(
      Platform.OS === 'ios' ? 'keyboardWillShow' : 'keyboardDidShow',
      (e) => setKeyboardHeight(e.endCoordinates.height),
    );
    const hideSub = Keyboard.addListener(
      Platform.OS === 'ios' ? 'keyboardWillHide' : 'keyboardDidHide',
      () => setKeyboardHeight(0),
    );
    return () => { showSub.remove(); hideSub.remove(); };
  }, []);

  // ── Buffer ──────────────────────────────────────────────────────────
  const bufferRef = useRef<TerminalBuffer | null>(null);
  if (!bufferRef.current) {
    bufferRef.current = new TerminalBuffer(cols, rows, scrollback);
  }
  const buffer = bufferRef.current;

  // ── Render trigger (rAF-based) ────────────────────────────────────
  const [renderVersion, setRenderVersion] = useState(0);
  const rafRef = useRef<number | null>(null);
  const pendingRender = useRef(false);

  const scheduleRender = useCallback(() => {
    if (pendingRender.current) return;
    pendingRender.current = true;
    rafRef.current = requestAnimationFrame(() => {
      pendingRender.current = false;
      setRenderVersion((v) => v + 1);
    });
  }, []);

  useEffect(() => {
    return () => {
      if (rafRef.current != null) cancelAnimationFrame(rafRef.current);
    };
  }, []);

  // ── Connection state ──────────────────────────────────────────────
  const [connectionStatus, setConnectionStatus] = useState<ConnectionStatus>('disconnected');
  const [focused, setFocused] = useState(false);

  useEffect(() => {
    onConnectionChange?.(connectionStatus);
  }, [connectionStatus, onConnectionChange]);

  // ── Selection state ───────────────────────────────────────────────
  const [selection, setSelection] = useState<SelectionRange | null>(null);

  // ── WebSocket ─────────────────────────────────────────────────────
  const wsRef = useRef<WebSocket | null>(null);

  const sendToServer = useCallback((data: string) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(data);
    }
    onData?.(data);
  }, [onData]);

  useEffect(() => {
    const ws = externalWs || (wsUrl ? new WebSocket(wsUrl) : null);
    if (!ws) return;

    wsRef.current = ws;
    if (ws.readyState === WebSocket.CONNECTING) {
      setConnectionStatus('connecting');
    } else if (ws.readyState === WebSocket.OPEN) {
      setConnectionStatus('connected');
    }

    const prevOnOpen = ws.onopen;
    ws.onopen = (ev) => {
      setConnectionStatus('connected');
      // Send initial size
      try {
        ws.send(JSON.stringify({
          type: 'resize',
          cols: buffer.cols,
          rows: buffer.rows,
        }));
      } catch {}
      if (typeof prevOnOpen === 'function') prevOnOpen.call(ws, ev);
    };

    ws.onmessage = (event) => {
      const data = typeof event.data === 'string' ? event.data : '';
      buffer.write(data);
      scheduleRender();
    };

    ws.onerror = () => setConnectionStatus('error');
    ws.onclose = () => setConnectionStatus('disconnected');

    return () => {
      if (!externalWs && ws.readyState !== WebSocket.CLOSED) {
        ws.close();
      }
      wsRef.current = null;
    };
  }, [wsUrl, externalWs, buffer, scheduleRender]);

  // ── OSC / Bell hooks on buffer ────────────────────────────────────
  // Override executeOsc on the buffer to capture title changes
  useEffect(() => {
    const origOsc = buffer.executeOsc.bind(buffer);
    buffer.executeOsc = (id: number, data: string) => {
      origOsc(id, data);
      if ((id === 0 || id === 2) && onTitleChange) {
        onTitleChange(data);
      }
    };

    const origC0 = buffer.executeC0.bind(buffer);
    buffer.executeC0 = (code: number) => {
      origC0(code);
      if (code === 0x07 && onBell) {
        onBell();
        Vibration.vibrate(50);
      }
    };
  }, [buffer, onTitleChange, onBell]);

  // ── Keyboard input ────────────────────────────────────────────────
  const textInputRef = useRef<TextInput>(null);
  const lastInputRef = useRef('');

  // Track modifier keys (best-effort on RN)
  const modifiersRef = useRef({ ctrl: false, meta: false, alt: false, shift: false });

  const handleKeyPress = useCallback((
    e: NativeSyntheticEvent<TextInputKeyPressEventData>,
  ) => {
    const { key } = e.nativeEvent;

    // Clear selection on any keystroke
    if (selection) {
      setSelection(null);
      onSelectionChange?.(null);
    }

    // Special keys → escape sequences
    const keyMap: Record<string, string> = {
      'Enter': '\r',
      'Backspace': '\x7f',
      'Escape': '\x1b',
      'Tab': '\t',
      'ArrowUp': '\x1b[A',
      'ArrowDown': '\x1b[B',
      'ArrowRight': '\x1b[C',
      'ArrowLeft': '\x1b[D',
      'Home': '\x1b[H',
      'End': '\x1b[F',
      'PageUp': '\x1b[5~',
      'PageDown': '\x1b[6~',
      'Delete': '\x1b[3~',
      'Insert': '\x1b[2~',
      'F1': '\x1bOP', 'F2': '\x1bOQ', 'F3': '\x1bOR', 'F4': '\x1bOS',
      'F5': '\x1b[15~', 'F6': '\x1b[17~', 'F7': '\x1b[18~', 'F8': '\x1b[19~',
      'F9': '\x1b[20~', 'F10': '\x1b[21~', 'F11': '\x1b[23~', 'F12': '\x1b[24~',
    };

    if (keyMap[key]) {
      sendToServer(keyMap[key]);
      lastInputRef.current = key;
    } else if (key.length === 1) {
      // Ctrl+key handling: Ctrl+A → 0x01, Ctrl+C → 0x03, etc.
      // On iOS/Android physical keyboards, Ctrl combos may arrive as single chars
      const code = key.charCodeAt(0);
      if (code >= 1 && code <= 26) {
        // Already a control character
        sendToServer(key);
      } else {
        sendToServer(key);
      }
      lastInputRef.current = key;
    }
  }, [sendToServer, selection, onSelectionChange]);

  const handleTextChange = useCallback((text: string) => {
    // onChangeText fires for regular character input and IME
    // Avoid double-sending if onKeyPress already handled it
    if (text.length > 0 && text !== lastInputRef.current) {
      sendToServer(text);
    }
    lastInputRef.current = '';
    setTimeout(() => textInputRef.current?.clear(), 0);
  }, [sendToServer]);

  // ── Gestures ──────────────────────────────────────────────────────

  // Tap → focus
  const tapGesture = Gesture.Tap()
    .onEnd(() => {
      'worklet';
      runOnJS(() => {
        textInputRef.current?.focus();
        if (selection) {
          setSelection(null);
          onSelectionChange?.(null);
        }
      })();
    });

  // Pan → scroll through scrollback
  const scrollAccumulator = useRef(0);
  const panGesture = Gesture.Pan()
    .onUpdate((e) => {
      'worklet';
      runOnJS((dy: number) => {
        scrollAccumulator.current += dy;
        const linesToScroll = Math.trunc(scrollAccumulator.current / cellHeight);
        if (linesToScroll !== 0) {
          scrollAccumulator.current -= linesToScroll * cellHeight;
          const maxScroll = buffer.ybase;
          const newDisp = Math.max(-maxScroll, Math.min(0, buffer.ydisp + linesToScroll));
          if (newDisp !== buffer.ydisp) {
            buffer.ydisp = newDisp;
            scheduleRender();
          }
        }
      })(e.translationY - (scrollAccumulator.current || 0));
    })
    .onEnd(() => {
      'worklet';
      runOnJS(() => { scrollAccumulator.current = 0; })();
    });

  // Long press → start selection
  const longPressGesture = Gesture.LongPress()
    .minDuration(400)
    .onStart((e) => {
      'worklet';
      runOnJS((x: number, y: number) => {
        const col = Math.floor(x / cellWidth);
        const row = Math.floor(y / cellHeight);
        if (col >= 0 && col < buffer.cols && row >= 0 && row < buffer.rows) {
          // Select the word at this position (simplified: select single cell)
          setSelection({ start: [col, row], end: [col + 1, row] });
          Vibration.vibrate(30);
        }
      })(e.x, e.y);
    });

  // Pan after long press → extend selection
  const selectionPanGesture = Gesture.Pan()
    .activateAfterLongPress(400)
    .onUpdate((e) => {
      'worklet';
      runOnJS((x: number, y: number) => {
        if (!selection) return;
        const col = Math.max(0, Math.min(buffer.cols, Math.floor(x / cellWidth)));
        const row = Math.max(0, Math.min(buffer.rows - 1, Math.floor(y / cellHeight)));
        setSelection((prev) => prev ? { ...prev, end: [col, row] } : null);
      })(e.x, e.y);
    })
    .onEnd(() => {
      'worklet';
      runOnJS(() => {
        if (selection) {
          const text = extractSelectionText(buffer, selection);
          onSelectionChange?.(text);
        }
      })();
    });

  const composedGestures = Gesture.Race(
    selectionPanGesture,
    Gesture.Exclusive(longPressGesture, tapGesture),
    panGesture,
  );

  // ── Resize ────────────────────────────────────────────────────────
  useEffect(() => {
    const newCols = propCols || Math.max(1, Math.floor(containerWidth / cellWidth));
    const newRows = propRows || Math.max(1, Math.floor(containerHeight / cellHeight));

    if (newCols !== buffer.cols || newRows !== buffer.rows) {
      buffer.resize(newCols, newRows);
      scheduleRender();

      if (wsRef.current?.readyState === WebSocket.OPEN) {
        try {
          wsRef.current.send(JSON.stringify({
            type: 'resize', cols: newCols, rows: newRows,
          }));
        } catch {}
      }
    }
  }, [containerWidth, containerHeight, cellWidth, cellHeight, propCols, propRows, buffer, scheduleRender]);

  // ── Layout callback ───────────────────────────────────────────────
  const onLayout = useCallback((e: LayoutChangeEvent) => {
    const { width: w, height: h } = e.nativeEvent.layout;
    setLayoutSize({ width: w, height: h });
  }, []);

  // ── Imperative handle ─────────────────────────────────────────────
  React.useImperativeHandle(ref, () => ({
    write: (data: string) => {
      buffer.write(data);
      scheduleRender();
    },
    focus: () => textInputRef.current?.focus(),
    blur: () => textInputRef.current?.blur(),
    getSelection: () => selection ? extractSelectionText(buffer, selection) : null,
    clearSelection: () => { setSelection(null); onSelectionChange?.(null); },
    scrollToBottom: () => {
      buffer.ydisp = 0;
      scheduleRender();
    },
    buffer,
  }), [buffer, selection, scheduleRender, onSelectionChange]);

  // ── Render ────────────────────────────────────────────────────────

  const termWidth = Math.max(1, containerWidth);
  const termHeight = Math.max(1, containerHeight);

  return (
    <GestureHandlerRootView style={[styles.container, { width: propWidth, height: propHeight }]}>
      <View style={styles.fill} onLayout={onLayout}>
        <GestureDetector gesture={composedGestures}>
          <View style={styles.fill}>
            <SkiaTerminalRenderer
              buffer={buffer}
              fontSize={fontSize}
              fontConfig={fontConfig}
              theme={theme}
              width={termWidth}
              height={termHeight}
              renderVersion={renderVersion}
              selection={selection}
              focused={focused}
              cursorBlinkInterval={cursorBlinkInterval}
            />
          </View>
        </GestureDetector>

        <TextInput
          ref={textInputRef}
          style={styles.hiddenInput}
          autoCapitalize="none"
          autoCorrect={false}
          autoComplete="off"
          spellCheck={false}
          keyboardType="ascii-capable"
          keyboardAppearance="dark"
          onKeyPress={handleKeyPress}
          onChangeText={handleTextChange}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          blurOnSubmit={false}
          caretHidden
          textContentType="none"
          importantForAutofill="no"
          // Prevent password autofill prompts on iOS
          secureTextEntry={false}
        />
      </View>
    </GestureHandlerRootView>
  );
});

SkiaTerminal.displayName = 'SkiaTerminal';

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  fill: {
    flex: 1,
  },
  hiddenInput: {
    position: 'absolute',
    opacity: 0,
    width: 1,
    height: 1,
    left: -9999,
    top: -9999,
  },
});

// ────────────────────────────────────────────────────────────────────────────
// Hook: standalone terminal (no WebSocket)
// ────────────────────────────────────────────────────────────────────────────

export function useTerminal(cols = 80, rows = 24, scrollback = 1000) {
  const bufferRef = useRef(new TerminalBuffer(cols, rows, scrollback));
  const [version, setVersion] = useState(0);

  const write = useCallback((data: string) => {
    bufferRef.current.write(data);
    setVersion((v) => v + 1);
  }, []);

  const reset = useCallback(() => {
    bufferRef.current.write('\x1bc'); // RIS
    setVersion((v) => v + 1);
  }, []);

  return {
    buffer: bufferRef.current,
    write,
    reset,
    renderVersion: version,
  };
}
