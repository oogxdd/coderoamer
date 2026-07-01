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
  Text,
  TextInput,
  Pressable,
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
import * as Clipboard from 'expo-clipboard';
import { TerminalBuffer } from './TerminalBuffer';
import { tinfo, tdebug, twarn, hexPreview } from './terminalLog';
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
  /** Called when terminal resizes */
  onResize?: (cols: number, rows: number) => void;
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

async function copyToClipboard(text: string): Promise<void> {
  if (Platform.OS === 'web') {
    try {
      await navigator.clipboard.writeText(text);
    } catch {}
  } else {
    await Clipboard.setStringAsync(text);
  }
}

function findWordAt(
  buffer: TerminalBuffer,
  col: number,
  row: number,
): [number, number] {
  const lines = buffer.getViewportLines();
  const line = lines[row];
  if (!line) return [col, col + 1];

  const isWord = (x: number) => {
    const ch = line[x]?.char;
    return ch != null && ch !== '' && ch !== ' ';
  };

  if (!isWord(col)) return [col, col + 1];

  let start = col;
  while (start > 0 && isWord(start - 1)) start--;
  let end = col;
  while (end < line.length && isWord(end)) end++;
  return [start, end];
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
  onResize,
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

  // Wire up terminal response callback (DA, DSR replies sent back to host)
  useEffect(() => {
    buffer.onResponse = (data: string) => {
      onData?.(data);
    };
    return () => { buffer.onResponse = null; };
  }, [buffer, onData]);

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
    tinfo('conn', `status → ${connectionStatus}`);
    onConnectionChange?.(connectionStatus);
  }, [connectionStatus, onConnectionChange]);

  // ── Selection state ───────────────────────────────────────────────
  const [selection, setSelection] = useState<SelectionRange | null>(null);
  const containerRef = useRef<View>(null);
  const selectionRef = useRef<SelectionRange | null>(null);
  selectionRef.current = selection;

  const textInputRef = useRef<TextInput>(null);

  const copySelection = useCallback(() => {
    if (!selectionRef.current) return;
    const text = extractSelectionText(buffer, selectionRef.current);
    if (text) {
      copyToClipboard(text);
      onSelectionChange?.(text);
    }
    setSelection(null);
  }, [buffer, onSelectionChange]);

  // ── Web mouse selection ─────────────────────────────────────────
  useEffect(() => {
    if (Platform.OS !== 'web') return;
    const el = (containerRef.current as unknown as HTMLElement);
    if (!el) return;

    let isDragging = false;
    let startCol = 0;
    let startRow = 0;
    let didMove = false;

    const toCell = (e: MouseEvent) => {
      const rect = el.getBoundingClientRect();
      return {
        col: Math.max(0, Math.min(buffer.cols, Math.floor((e.clientX - rect.left) / cellWidth))),
        row: Math.max(0, Math.min(buffer.rows - 1, Math.floor((e.clientY - rect.top) / cellHeight))),
      };
    };

    const onMouseDown = (e: MouseEvent) => {
      if (e.button !== 0) return;
      const { col, row } = toCell(e);
      startCol = col;
      startRow = row;
      isDragging = true;
      didMove = false;
      setSelection(null);
    };

    const onMouseMove = (e: MouseEvent) => {
      if (!isDragging) return;
      const { col, row } = toCell(e);
      if (!didMove && col === startCol && row === startRow) return;
      didMove = true;
      setSelection({ start: [startCol, startRow], end: [col, row] });
      scheduleRender();
    };

    const onMouseUp = (e: MouseEvent) => {
      if (!isDragging) return;
      isDragging = false;
      if (!didMove) {
        // Click without drag — clear selection, focus input
        setSelection(null);
        textInputRef.current?.focus();
        return;
      }
      const { col, row } = toCell(e);
      const sel: SelectionRange = { start: [startCol, startRow], end: [col, row] };
      setSelection(sel);
      scheduleRender();
    };

    const onDblClick = (e: MouseEvent) => {
      const { col, row } = toCell(e);
      const [wStart, wEnd] = findWordAt(buffer, col, row);
      setSelection({ start: [wStart, row], end: [wEnd, row] });
      scheduleRender();
    };

    el.addEventListener('mousedown', onMouseDown);
    el.addEventListener('mousemove', onMouseMove);
    el.addEventListener('mouseup', onMouseUp);
    el.addEventListener('dblclick', onDblClick);
    return () => {
      el.removeEventListener('mousedown', onMouseDown);
      el.removeEventListener('mousemove', onMouseMove);
      el.removeEventListener('mouseup', onMouseUp);
      el.removeEventListener('dblclick', onDblClick);
    };
  }, [buffer, cellWidth, cellHeight, scheduleRender]);

  // ── Web Ctrl/Cmd+C to copy selection ────────────────────────────
  useEffect(() => {
    if (Platform.OS !== 'web') return;
    const onKeyDown = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'c' && selectionRef.current) {
        e.preventDefault();
        copySelection();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [copySelection]);

  // ── WebSocket ─────────────────────────────────────────────────────
  const wsRef = useRef<WebSocket | null>(null);

  const sendToServer = useCallback((data: string) => {
    tdebug('input', 'send', { data: hexPreview(data, 60), len: data.length });
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
      tdebug('output', 'ws.message', { data: hexPreview(data, 80), len: data.length });
      buffer.write(data);
      scheduleRender();
    };

    ws.onerror = (ev) => { twarn('conn', 'ws error', { ev: String((ev as any)?.message ?? ev) }); setConnectionStatus('error'); };
    ws.onclose = (ev) => { tinfo('conn', 'ws close', { code: (ev as any)?.code, reason: (ev as any)?.reason }); setConnectionStatus('disconnected'); };

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
  const lastInputRef = useRef('');

  // Track modifier keys (best-effort on RN)
  const modifiersRef = useRef({ ctrl: false, meta: false, alt: false, shift: false });

  const handleKeyPress = useCallback((
    e: NativeSyntheticEvent<TextInputKeyPressEventData>,
  ) => {
    const { key } = e.nativeEvent;

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
      // Clear selection on any non-copy keystroke
      if (selectionRef.current) {
        setSelection(null);
        onSelectionChange?.(null);
      }
      sendToServer(keyMap[key]);
      lastInputRef.current = key;
    } else if (key.length === 1) {
      const code = key.charCodeAt(0);
      // Ctrl+C (0x03) with active selection → copy instead of sending to terminal
      if (code === 3 && selectionRef.current) {
        copySelection();
        lastInputRef.current = key;
        return;
      }
      // Clear selection on any other keystroke
      if (selectionRef.current) {
        setSelection(null);
        onSelectionChange?.(null);
      }
      sendToServer(key);
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

  const clearSelection = useCallback(() => {
    if (!selectionRef.current) return;
    setSelection(null);
    onSelectionChange?.(null);
  }, [onSelectionChange]);

  const handleTapGestureEnd = useCallback(() => {
    textInputRef.current?.focus();
    clearSelection();
  }, [clearSelection]);

  const scrollRemainderRef = useRef(0);
  const lastPanTranslationRef = useRef(0);
  const handleScrollGestureUpdate = useCallback((translationY: number) => {
    const deltaY = translationY - lastPanTranslationRef.current;
    lastPanTranslationRef.current = translationY;
    scrollRemainderRef.current += deltaY;

    const linesToScroll = Math.trunc(scrollRemainderRef.current / cellHeight);
    if (linesToScroll === 0) return;

    scrollRemainderRef.current -= linesToScroll * cellHeight;
    const maxScroll = buffer.ybase;
    const newDisp = Math.max(-maxScroll, Math.min(0, buffer.ydisp + linesToScroll));
    if (newDisp !== buffer.ydisp) {
      buffer.ydisp = newDisp;
      scheduleRender();
    }
  }, [buffer, cellHeight, scheduleRender]);

  const handleScrollGestureEnd = useCallback(() => {
    scrollRemainderRef.current = 0;
    lastPanTranslationRef.current = 0;
  }, []);

  const handleLongPressGestureStart = useCallback((x: number, y: number) => {
    const col = Math.floor(x / cellWidth);
    const row = Math.floor(y / cellHeight);
    if (col >= 0 && col < buffer.cols && row >= 0 && row < buffer.rows) {
      const [wStart, wEnd] = findWordAt(buffer, col, row);
      setSelection({ start: [wStart, row], end: [wEnd, row] });
      if (Platform.OS !== 'web') Vibration.vibrate(30);
    }
  }, [buffer, cellWidth, cellHeight]);

  const handleSelectionPanUpdate = useCallback((x: number, y: number) => {
    if (!selectionRef.current) return;
    const col = Math.max(0, Math.min(buffer.cols, Math.floor(x / cellWidth)));
    const row = Math.max(0, Math.min(buffer.rows - 1, Math.floor(y / cellHeight)));
    setSelection((prev) => prev ? { ...prev, end: [col, row] } : null);
  }, [buffer, cellWidth, cellHeight]);

  const handleSelectionPanEnd = useCallback(() => {
    if (selectionRef.current) {
      onSelectionChange?.(extractSelectionText(buffer, selectionRef.current));
    }
  }, [buffer, onSelectionChange]);

  // Tap → focus
  const tapGesture = Gesture.Tap()
    .onEnd(() => {
      'worklet';
      runOnJS(handleTapGestureEnd)();
    });

  // Pan → scroll through scrollback
  const panGesture = Gesture.Pan()
    .onUpdate((e) => {
      'worklet';
      runOnJS(handleScrollGestureUpdate)(e.translationY);
    })
    .onEnd(() => {
      'worklet';
      runOnJS(handleScrollGestureEnd)();
    });

  // Long press → select word at position
  const longPressGesture = Gesture.LongPress()
    .minDuration(400)
    .onStart((e) => {
      'worklet';
      runOnJS(handleLongPressGestureStart)(e.x, e.y);
    });

  // Pan after long press → extend selection
  const selectionPanGesture = Gesture.Pan()
    .activateAfterLongPress(400)
    .onUpdate((e) => {
      'worklet';
      runOnJS(handleSelectionPanUpdate)(e.x, e.y);
    })
    .onEnd(() => {
      'worklet';
      runOnJS(handleSelectionPanEnd)();
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
      tinfo('resize', `${buffer.cols}x${buffer.rows} → ${newCols}x${newRows}`, {
        containerWidth, containerHeight, cellWidth, cellHeight,
      });
      buffer.resize(newCols, newRows);
      scheduleRender();
      onResize?.(newCols, newRows);

      if (wsRef.current?.readyState === WebSocket.OPEN) {
        try {
          wsRef.current.send(JSON.stringify({
            type: 'resize', cols: newCols, rows: newRows,
          }));
        } catch {}
      }
    }
  }, [containerWidth, containerHeight, cellWidth, cellHeight, propCols, propRows, buffer, scheduleRender, onResize]);

  // ── Layout callback ───────────────────────────────────────────────
  const onLayout = useCallback((e: LayoutChangeEvent) => {
    const { width: w, height: h } = e.nativeEvent.layout;
    setLayoutSize({ width: w, height: h });
  }, []);

  // ── Imperative handle ─────────────────────────────────────────────
  React.useImperativeHandle(ref, () => ({
    write: (data: string) => {
      tdebug('output', 'write', { data: hexPreview(data, 80), len: data.length });
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

  const handleTerminalPress = useCallback(() => {
    textInputRef.current?.focus();
    if (selection) {
      setSelection(null);
      onSelectionChange?.(null);
    }
  }, [selection, onSelectionChange]);

  return (
    <GestureHandlerRootView style={[styles.container, { width: propWidth, height: propHeight }]}>
      <View ref={containerRef} style={styles.fill} onLayout={onLayout}>
        <GestureDetector gesture={composedGestures}>
          <Pressable style={styles.fill} onPress={handleTerminalPress}>
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
          </Pressable>
        </GestureDetector>

        {/* Native context menu */}
        {Platform.OS !== 'web' && selection && (
          <View
            style={[
              styles.contextMenu,
              {
                left: Math.max(8, ((Math.min(selection.start[0], selection.end[0]) +
                  Math.max(selection.start[0], selection.end[0])) / 2) * cellWidth - 30),
                top: Math.max(4, Math.min(selection.start[1], selection.end[1]) * cellHeight - 38),
              },
            ]}
          >
            <Pressable
              style={({ pressed }) => [styles.contextMenuItem, pressed && { opacity: 0.6 }]}
              onPress={copySelection}
            >
              <Text style={styles.contextMenuText}>Copy</Text>
            </Pressable>
          </View>
        )}

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
  contextMenu: {
    position: 'absolute',
    backgroundColor: '#2a2a2a',
    borderRadius: 8,
    paddingHorizontal: 2,
    paddingVertical: 2,
    flexDirection: 'row',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.4,
    shadowRadius: 6,
    elevation: 8,
    zIndex: 100,
  },
  contextMenuItem: {
    paddingHorizontal: 14,
    paddingVertical: 6,
    borderRadius: 6,
  },
  contextMenuText: {
    color: '#ffffff',
    fontSize: 13,
    fontWeight: '500',
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
