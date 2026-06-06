import { loadToken } from '@/services/auth';

const EXEC_HTTP_BASE = 'https://api.sprites.dev/v1';
const EXEC_WS_BASE = 'wss://api.sprites.dev/v1';
const DEFAULT_COLS = 120;
const DEFAULT_ROWS = 40;

export type ExecConnectionState = 'idle' | 'connecting' | 'open' | 'closed' | 'error';
type RNWebSocketCtor = new (
  url: string,
  protocols?: string | string[] | null,
  options?: { headers?: Record<string, string> } | null
) => WebSocket;

export interface ExecConnectOptions {
  spriteName: string;
  command: string;
  attachSessionId?: string;
  /**
   * Text typed into the session shortly after it opens (e.g. `cd /repo && claude\r`).
   * Sent through the TTY so it works regardless of how the exec endpoint parses `cmd`.
   */
  initialInput?: string;
}

export interface ExecEventLog {
  timestamp: number;
  source: 'ws' | 'event' | 'local' | 'error';
  text: string;
}

export interface ExecPocClient {
  connect: (options: ExecConnectOptions) => Promise<void>;
  send: (text: string, appendNewline?: boolean) => void;
  sendCtrlC: () => void;
  close: () => void;
  kill: () => Promise<void>;
  resize: (cols: number, rows: number) => void;
  getState: () => ExecConnectionState;
  getSessionId: () => string | undefined;
}

interface CreateExecClientOptions {
  onStateChange: (state: ExecConnectionState) => void;
  onSessionId: (sessionId: string | undefined) => void;
  onLog: (entry: ExecEventLog) => void;
}

function makeLog(source: ExecEventLog['source'], text: string): ExecEventLog {
  return { source, text, timestamp: Date.now() };
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

function toArrayBuffer(text: string): ArrayBuffer {
  if (typeof TextEncoder !== 'undefined') {
    return new TextEncoder().encode(text).buffer;
  }

  const bytes = Array.from(text, (ch) => ch.charCodeAt(0) & 0xff);
  return Uint8Array.from(bytes).buffer;
}

function extractSessionId(payload: unknown): string | undefined {
  if (!payload || typeof payload !== 'object') return undefined;
  const obj = payload as Record<string, unknown>;

  const direct = obj.session_id ?? obj.sessionId;
  if (typeof direct === 'string') return direct;
  if (typeof direct === 'number') return String(direct);

  const session = obj.session;
  if (session && typeof session === 'object') {
    const nested = (session as Record<string, unknown>).id;
    if (typeof nested === 'string') return nested;
    if (typeof nested === 'number') return String(nested);
  }

  const data = obj.data;
  if (data && typeof data === 'object') {
    const nested = (data as Record<string, unknown>).session_id ??
      (data as Record<string, unknown>).sessionId;
    if (typeof nested === 'string') return nested;
    if (typeof nested === 'number') return String(nested);
  }

  return undefined;
}

function extractOutput(payload: unknown): string | undefined {
  if (!payload || typeof payload !== 'object') return undefined;
  const obj = payload as Record<string, unknown>;

  const type = asString(obj.type);
  const data = asString(obj.data);
  if (data && (type === 'stdout' || type === 'stderr')) {
    return data;
  }

  const stdout = asString(obj.stdout);
  if (stdout) return stdout;

  const stderr = asString(obj.stderr);
  if (stderr) return stderr;

  const output = asString(obj.output);
  if (output) return output;

  return undefined;
}

function decodeMessageData(data: unknown): string {
  if (typeof data === 'string') return data;

  if (data instanceof ArrayBuffer) {
    return new TextDecoder().decode(data);
  }

  if (ArrayBuffer.isView(data)) {
    return new TextDecoder().decode(data as ArrayBufferView);
  }

  return String(data ?? '');
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

export function createExecPocClient(options: CreateExecClientOptions): ExecPocClient {
  let socket: WebSocket | null = null;
  let state: ExecConnectionState = 'idle';
  let currentSpriteName: string | undefined;
  let currentSessionId: string | undefined;

  const setState = (next: ExecConnectionState) => {
    state = next;
    options.onStateChange(next);
  };

  const close = () => {
    if (!socket) return;
    socket.onopen = null;
    socket.onmessage = null;
    socket.onerror = null;
    socket.onclose = null;
    socket.close();
    socket = null;
  };

  const sendResize = (cols: number = DEFAULT_COLS, rows: number = DEFAULT_ROWS) => {
    if (!socket || socket.readyState !== WebSocket.OPEN) return;
    socket.send(
      JSON.stringify({
        type: 'resize',
        cols,
        rows,
      })
    );
    options.onLog(makeLog('local', `Requested resize: ${cols}x${rows}`));
  };

  const connect = async ({ spriteName, command, attachSessionId, initialInput }: ExecConnectOptions) => {
    const token = await loadToken('spritesToken');
    if (!token) {
      throw new Error('No Sprites API token found. Add it in Auth first.');
    }

    close();
    currentSpriteName = spriteName;
    currentSessionId = attachSessionId || undefined;
    options.onSessionId(currentSessionId);

    const encodedSprite = encodeURIComponent(spriteName);
    const wsUrl = attachSessionId
      ? `${EXEC_WS_BASE}/sprites/${encodedSprite}/exec/${encodeURIComponent(attachSessionId)}`
      : `${EXEC_WS_BASE}/sprites/${encodedSprite}/exec?cmd=${encodeURIComponent(command)}&tty=true&stdin=true&cols=${DEFAULT_COLS}&rows=${DEFAULT_ROWS}`;

    setState('connecting');
    options.onLog(makeLog('local', `Connecting: ${wsUrl}`));

    const RNWebSocket = WebSocket as unknown as RNWebSocketCtor;
    socket = new RNWebSocket(wsUrl, undefined, {
      headers: {
        Authorization: `Bearer ${token}`,
      },
    });

    socket.onopen = () => {
      setState('open');
      options.onLog(makeLog('local', 'WebSocket connected'));
      sendResize();
      if (attachSessionId) {
        options.onSessionId(attachSessionId);
      }
      if (initialInput) {
        // Give the shell a moment to print its prompt before typing into it.
        setTimeout(() => {
          if (socket && socket.readyState === WebSocket.OPEN) {
            socket.send(toArrayBuffer(initialInput));
            options.onLog(makeLog('local', 'Sent initial command'));
          }
        }, 700);
      }
    };

    socket.onmessage = (event) => {
      const raw = decodeMessageData(event.data);

      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        parsed = undefined;
      }

      if (parsed !== undefined) {
        const obj = parsed as Record<string, unknown>;
        const eventType = asString(obj.type);

        const sessionId = extractSessionId(parsed);
        if (sessionId && sessionId !== currentSessionId) {
          currentSessionId = sessionId;
          options.onSessionId(sessionId);
          options.onLog(makeLog('local', `Session ID: ${sessionId}`));
        }

        if (eventType === 'session_info') {
          const cols = asNumber(obj.cols) ?? 0;
          const rows = asNumber(obj.rows) ?? 0;
          if (cols <= 0 || rows <= 0) {
            sendResize();
          }
        }

        const output = extractOutput(parsed);
        if (output) {
          options.onLog(makeLog('ws', output));
          return;
        }

        options.onLog(makeLog('event', safeStringify(parsed)));
        return;
      }

      options.onLog(makeLog('ws', raw));
    };

    socket.onerror = (event) => {
      setState('error');
      options.onLog(makeLog('error', `WebSocket error: ${safeStringify(event)}`));
    };

    socket.onclose = (event) => {
      setState('closed');
      options.onLog(
        makeLog('local', `WebSocket closed (code=${event.code}, reason=${event.reason || 'n/a'})`)
      );
      socket = null;
    };
  };

  const send = (text: string, appendNewline: boolean = true) => {
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      options.onLog(makeLog('error', 'Cannot send: socket is not open'));
      return;
    }

    const payload = appendNewline ? `${text}\r` : text;
    socket.send(toArrayBuffer(payload));
  };

  const sendCtrlC = () => {
    send('\u0003', false);
  };

  const kill = async () => {
    if (!currentSpriteName) {
      throw new Error('No active sprite selected for kill request.');
    }
    if (!currentSessionId) {
      throw new Error('No exec session ID available yet.');
    }

    const token = await loadToken('spritesToken');
    if (!token) {
      throw new Error('No Sprites API token found. Add it in Auth first.');
    }

    const response = await fetch(
      `${EXEC_HTTP_BASE}/sprites/${encodeURIComponent(currentSpriteName)}/exec/${encodeURIComponent(currentSessionId)}/kill`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
        },
      }
    );

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw new Error(body || `Kill failed (${response.status})`);
    }

    options.onLog(makeLog('local', `Kill signal sent to session ${currentSessionId}`));
  };

  return {
    connect,
    send,
    sendCtrlC,
    close,
    kill,
    resize: sendResize,
    getState: () => state,
    getSessionId: () => currentSessionId,
  };
}
