import { Sprite, SpritesListResponse } from '@/models/sprite';
import { Checkpoint, CheckpointStreamEvent } from '@/models/checkpoint';
import { ServiceRequest, ServiceLogEvent, ServiceInfo } from '@/models/service';
import { Platform } from 'react-native';
import { loadToken } from './auth';
import { Connection } from '@/models/connection';

// Sprites defaults — also the fallback when no custom connection is active. Web
// stays Sprites-only: custom connections are native-only (§3.3), so the web proxy
// / ws-proxy bases below are never used for a remote-backed connection.
const SPRITE_HTTP_BASE = Platform.OS === 'web' ? '/api/v1' : 'https://api.sprites.dev/v1';
const SPRITE_WS_BASE = Platform.OS === 'web' ? 'ws://localhost:8082/v1' : 'wss://api.sprites.dev/v1';

// The connection all provider-agnostic api calls target when no explicit `conn`
// is passed. Set by ConnectionsContext when the user enters a VM.
//
// Design note (deviation from remote-agent/MIGRATION.md, recorded per §1/§5):
// MIGRATION.md proposed threading a `conn` param through every api function AND
// every caller. Instead we keep a module-level active-connection pointer plus a
// trailing optional `conn?` on each function. Existing call sites (11 files) keep
// compiling and inherit the active connection; the explicit `conn?` covers the
// only case that must target a specific connection irrespective of the active one
// — dashboard aggregation, which lists VMs across all connections at once.
let activeConnection: Connection | null = null;

export function setActiveConnection(conn: Connection | null): void {
  activeConnection = conn;
}

export function getActiveConnection(): Connection | null {
  return activeConnection;
}

function isRemoteTarget(conn: Connection | null): conn is Connection {
  return !!conn && conn.backing !== 'sprite' && !!conn.baseUrl;
}

function httpBaseFor(conn: Connection | null): string {
  if (isRemoteTarget(conn)) return `${conn.baseUrl!.replace(/\/+$/, '')}/v1`;
  return SPRITE_HTTP_BASE;
}

function wsBaseFor(conn: Connection | null): string {
  if (isRemoteTarget(conn)) {
    const origin = conn.baseUrl!.replace(/\/+$/, '');
    const wsOrigin = /^https:/i.test(origin)
      ? origin.replace(/^https:/i, 'wss:')
      : origin.replace(/^http:/i, 'ws:');
    return `${wsOrigin}/v1`;
  }
  return SPRITE_WS_BASE;
}

/**
 * Resolve the HTTP base, WS base, and bearer token for a request. Uses the
 * explicit `conn` when given, else the module-level active connection, else
 * falls back to the legacy global sprites token (covers the app-startup window
 * before ConnectionsContext has set an active connection).
 */
async function resolveTarget(
  conn?: Connection
): Promise<{ httpBase: string; wsBase: string; token: string }> {
  const c = conn ?? activeConnection;
  let token: string;
  if (c) {
    token = c.token;
  } else {
    const legacy = await loadToken('spritesToken');
    if (!legacy) throw new AppError('noToken', 'No Sprites API token');
    token = legacy;
  }
  return { httpBase: httpBaseFor(c), wsBase: wsBaseFor(c), token };
}

type RNWebSocketCtor = new (
  url: string,
  protocols?: string | string[] | null,
  options?: { headers?: Record<string, string> } | null
) => WebSocket;

class AppError extends Error {
  constructor(public code: string, message: string, public statusCode?: number) {
    super(message);
    this.name = 'AppError';
  }
}

function parseServiceEventLine(line: string): ServiceLogEvent | null {
  const trimmed = line.trim();
  if (!trimmed) return null;

  if (
    trimmed.startsWith('event:') ||
    trimmed.startsWith('id:') ||
    trimmed.startsWith('retry:') ||
    trimmed.startsWith(':')
  ) {
    return null;
  }

  const payload = trimmed.startsWith('data:') ? trimmed.slice(5).trim() : trimmed;
  if (!payload || payload === '[DONE]') return null;

  try {
    return JSON.parse(payload) as ServiceLogEvent;
  } catch {
    return null;
  }
}

async function apiRequest<T>(
  method: string,
  path: string,
  body?: unknown,
  timeout?: number,
  conn?: Connection
): Promise<T> {
  const { httpBase, token } = await resolveTarget(conn);
  const url = `${httpBase}${path}`;

  const controller = new AbortController();
  const timeoutId = timeout
    ? setTimeout(() => controller.abort(), timeout * 1000)
    : null;

  try {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    };

    const response = await fetch(url, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    });

    if (timeoutId) clearTimeout(timeoutId);

    if (response.status === 401) throw new AppError('unauthorized', 'Unauthorized');
    if (response.status === 404) throw new AppError('notFound', 'Not found');
    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new AppError('serverError', text || `Server error ${response.status}`, response.status);
    }

    const text = await response.text();
    if (!text) return {} as T;
    return JSON.parse(text) as T;
  } catch (err) {
    if (timeoutId) clearTimeout(timeoutId);
    if (err instanceof AppError) throw err;
    throw new AppError('networkError', (err as Error).message);
  }
}

// MARK: - Sprites

export async function listSprites(conn?: Connection): Promise<Sprite[]> {
  const response = await apiRequest<SpritesListResponse>('GET', '/sprites', undefined, undefined, conn);
  return response.sprites;
}

export async function createSprite(name: string, conn?: Connection): Promise<Sprite> {
  return apiRequest<Sprite>('POST', '/sprites', { name }, undefined, conn);
}

export async function getSprite(name: string, conn?: Connection): Promise<Sprite> {
  return apiRequest<Sprite>('GET', `/sprites/${name}`, undefined, undefined, conn);
}

export async function deleteSprite(name: string, conn?: Connection): Promise<void> {
  await apiRequest<{}>('DELETE', `/sprites/${name}`, undefined, undefined, conn);
}

export type SpriteUrlAuth = 'public' | 'sprite';

/**
 * Set the sprite's public URL auth mode.
 * `public` opens the URL to anyone (the URL proxies to port 8080 / first HTTP port);
 * `sprite` requires org membership / a token. Needed before an embedded WebView
 * (e.g. ttyd) can reach a service, since the WebView can't carry the API token on
 * its in-page WebSocket/XHR requests.
 */
export async function updateSpriteUrlAuth(
  name: string,
  auth: SpriteUrlAuth,
  conn?: Connection
): Promise<Sprite> {
  return apiRequest<Sprite>('PUT', `/sprites/${name}`, { url_settings: { auth } }, undefined, conn);
}

// MARK: - Checkpoints

export async function listCheckpoints(spriteName: string, conn?: Connection): Promise<Checkpoint[]> {
  return apiRequest<Checkpoint[]>('GET', `/sprites/${spriteName}/checkpoints`, undefined, undefined, conn);
}

export async function createCheckpoint(
  spriteName: string,
  comment?: string,
  conn?: Connection
): Promise<void> {
  const { httpBase, token } = await resolveTarget(conn);
  const url = `${httpBase}/sprites/${spriteName}/checkpoint`;

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ comment: comment ?? null }),
  });

  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new AppError('serverError', text || `Error ${response.status}`, response.status);
  }

  // Consume NDJSON stream
  const reader = response.body?.getReader();
  if (reader) {
    const decoder = new TextDecoder();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const text = decoder.decode(value, { stream: true });
      for (const line of text.split('\n')) {
        if (!line.trim()) continue;
        try {
          const event: CheckpointStreamEvent = JSON.parse(line);
          if (event.type === 'error') {
            throw new AppError('serverError', event.error ?? event.data ?? 'Checkpoint error');
          }
        } catch (e) {
          if (e instanceof AppError) throw e;
        }
      }
    }
  }
}

export async function restoreCheckpoint(
  spriteName: string,
  checkpointId: string,
  conn?: Connection
): Promise<void> {
  const { httpBase, token } = await resolveTarget(conn);
  const url = `${httpBase}/sprites/${spriteName}/checkpoints/${checkpointId}/restore`;

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
  });

  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new AppError('serverError', text || `Error ${response.status}`, response.status);
  }

  // Consume NDJSON stream
  const reader = response.body?.getReader();
  if (reader) {
    const decoder = new TextDecoder();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const text = decoder.decode(value, { stream: true });
      for (const line of text.split('\n')) {
        if (!line.trim()) continue;
        try {
          const event: CheckpointStreamEvent = JSON.parse(line);
          if (event.type === 'error') {
            throw new AppError('serverError', event.error ?? event.data ?? 'Restore error');
          }
        } catch (e) {
          if (e instanceof AppError) throw e;
        }
      }
    }
  }
}

// MARK: - Filesystem

export interface SpriteFileWriteResult {
  path: string;
  size: number;
  mode: string;
}

export async function writeSpriteFile(
  spriteName: string,
  path: string,
  workingDir: string,
  bytes: Uint8Array,
  options: { mode?: string; mkdir?: boolean; contentType?: string } = {},
  conn?: Connection
): Promise<SpriteFileWriteResult> {
  const { httpBase, token } = await resolveTarget(conn);
  const params = new URLSearchParams({
    path,
    workingDir,
  });
  if (options.mode) params.set('mode', options.mode);
  if (options.mkdir) params.set('mkdir', 'true');

  const body = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  const response = await fetch(
    `${httpBase}/sprites/${encodeURIComponent(spriteName)}/fs/write?${params.toString()}`,
    {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': options.contentType ?? 'application/octet-stream',
      },
      body: body as BodyInit,
    }
  );

  if (response.status === 401) throw new AppError('unauthorized', 'Unauthorized');
  if (response.status === 404) throw new AppError('notFound', 'Not found');
  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new AppError('serverError', text || `Write file error ${response.status}`, response.status);
  }

  return response.json() as Promise<SpriteFileWriteResult>;
}

// MARK: - Auth Validation

export async function validateToken(conn?: Connection): Promise<void> {
  await apiRequest<SpritesListResponse>('GET', '/sprites', undefined, undefined, conn);
}

// MARK: - Services

export async function streamService(
  spriteName: string,
  serviceName: string,
  config: ServiceRequest,
  onEvent: (event: ServiceLogEvent) => void,
  signal?: AbortSignal,
  duration: string = '3600s',
  conn?: Connection
): Promise<void> {
  const { httpBase, token } = await resolveTarget(conn);
  const url = `${httpBase}/sprites/${spriteName}/services/${serviceName}?duration=${duration}`;

  const response = await fetch(url, {
    method: 'PUT',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(config),
    signal,
  });

  if (response.status === 401) throw new AppError('unauthorized', 'Unauthorized');
  if (response.status === 404) throw new AppError('notFound', 'Not found');
  if (!response.ok) {
    throw new AppError('serverError', `Service error ${response.status}`, response.status);
  }

  const reader = response.body?.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const consumeChunk = (chunk: string) => {
    buffer += chunk;
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';

    for (const line of lines) {
      const event = parseServiceEventLine(line);
      if (event) onEvent(event);
    }
  };

  if (reader) {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      consumeChunk(decoder.decode(value, { stream: true }));
    }
  } else {
    // Some RN runtimes don't expose a streaming reader; fall back to full text parse.
    const text = await response.text();
    if (text) consumeChunk(text.endsWith('\n') ? text : `${text}\n`);
  }

  // Process remaining buffer
  if (buffer.trim()) {
    const event = parseServiceEventLine(buffer);
    if (event) onEvent(event);
  }
}

export async function streamServiceLogs(
  spriteName: string,
  serviceName: string,
  onEvent: (event: ServiceLogEvent) => void,
  signal?: AbortSignal,
  duration: string = '3600s',
  conn?: Connection
): Promise<void> {
  const { httpBase, token } = await resolveTarget(conn);
  const url = `${httpBase}/sprites/${spriteName}/services/${serviceName}/logs?duration=${duration}`;

  const response = await fetch(url, {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${token}`,
    },
    signal,
  });

  if (response.status === 401) throw new AppError('unauthorized', 'Unauthorized');
  if (response.status === 404) throw new AppError('notFound', 'Not found');
  if (!response.ok) {
    throw new AppError('serverError', `Logs error ${response.status}`, response.status);
  }

  const reader = response.body?.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const consumeChunk = (chunk: string) => {
    buffer += chunk;
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';

    for (const line of lines) {
      const event = parseServiceEventLine(line);
      if (event) onEvent(event);
    }
  };

  if (reader) {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      consumeChunk(decoder.decode(value, { stream: true }));
    }
  } else {
    const text = await response.text();
    if (text) consumeChunk(text.endsWith('\n') ? text : `${text}\n`);
  }

  if (buffer.trim()) {
    const event = parseServiceEventLine(buffer);
    if (event) onEvent(event);
  }
}

// MARK: - Exec Streaming

export interface ExecStdinWriter {
  write: (text: string) => void;
  writeBytes: (bytes: Uint8Array) => void;
}

export interface StreamExecOptions {
  attachSessionId?: string;
  path?: string;
  maxRunAfterDisconnect?: string;
  tty?: boolean;
  stdin?: boolean;
  onStdinReady?: (writer: ExecStdinWriter) => void;
  onSessionId?: (sessionId: string) => void;
  onDisconnectBeforeExit?: () => void;
}

function createAbortError(): Error {
  const error = new Error('Aborted');
  error.name = 'AbortError';
  return error;
}

function makeExecWsUrl(
  spriteName: string,
  command: string[],
  token: string,
  wsBase: string,
  options: StreamExecOptions
): string {
  if (options.attachSessionId) {
    const params = new URLSearchParams();
    if (Platform.OS === 'web') params.set('token', token);
    const query = params.toString();
    return `${wsBase}/sprites/${encodeURIComponent(spriteName)}/exec/${encodeURIComponent(options.attachSessionId)}${query ? `?${query}` : ''}`;
  }

  const params = new URLSearchParams();
  for (const part of command) params.append('cmd', part);
  params.set('path', options.path ?? command[0] ?? 'bash');
  params.set('tty', options.tty ? 'true' : 'false');
  params.set('stdin', options.stdin ? 'true' : 'false');
  params.set('max_run_after_disconnect', options.maxRunAfterDisconnect ?? '0s');
  if (Platform.OS === 'web') params.set('token', token);

  return `${wsBase}/sprites/${encodeURIComponent(spriteName)}/exec?${params.toString()}`;
}

async function messageDataToBytes(data: unknown): Promise<Uint8Array | undefined> {
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (ArrayBuffer.isView(data)) {
    return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  }
  if (typeof Blob !== 'undefined' && data instanceof Blob) {
    return new Uint8Array(await data.arrayBuffer());
  }
  return undefined;
}

async function messageDataToText(data: unknown): Promise<string> {
  if (typeof data === 'string') return data;
  const bytes = await messageDataToBytes(data);
  if (bytes) return new TextDecoder().decode(bytes);
  return String(data ?? '');
}

function extractExecSessionId(payload: unknown): string | undefined {
  if (!payload || typeof payload !== 'object') return undefined;
  const obj = payload as Record<string, unknown>;
  const direct = obj.session_id ?? obj.sessionId;
  if (typeof direct === 'string') return direct;
  if (typeof direct === 'number') return String(direct);
  return undefined;
}

function parseExecExitCode(bytes: Uint8Array): number {
  if (bytes.length === 0) return 0;
  if (bytes.length === 1) return bytes[0];

  const text = new TextDecoder().decode(bytes).trim();
  const parsed = Number(text);
  return Number.isFinite(parsed) ? parsed : bytes[0];
}

function stringLooksLikeBinaryFrame(text: string): boolean {
  if (!text) return false;
  const streamId = text.charCodeAt(0);
  return streamId >= 0 && streamId <= 4;
}

function stringToBytes(text: string): Uint8Array {
  return Uint8Array.from(Array.from(text, (ch) => ch.charCodeAt(0) & 0xff));
}

function textToUtf8Bytes(text: string): Uint8Array {
  if (typeof TextEncoder !== 'undefined') return new TextEncoder().encode(text);

  const encoded = unescape(encodeURIComponent(text));
  return Uint8Array.from(Array.from(encoded, (ch) => ch.charCodeAt(0) & 0xff));
}

function makeExecStdinFrame(payload: Uint8Array): ArrayBuffer {
  const frame = new Uint8Array(payload.length + 1);
  frame[0] = 0;
  frame.set(payload, 1);
  return frame.buffer;
}

/**
 * Stream a one-shot command through the Exec API.
 *
 * Chat turns must not use the Services API: services are persistent supervised
 * processes and may be restarted by the sprite service manager, replaying the
 * same prompt into `claude --resume`. Exec sessions do not auto-restart, and
 * `max_run_after_disconnect` explicitly controls disconnect behavior.
 */
export async function streamExec(
  spriteName: string,
  command: string[],
  onEvent: (event: ServiceLogEvent) => void,
  signal?: AbortSignal,
  options: StreamExecOptions = {},
  conn?: Connection
): Promise<void> {
  const { wsBase, token } = await resolveTarget(conn);
  const url = makeExecWsUrl(spriteName, command, token, wsBase, options);
  const stdoutDecoder = new TextDecoder();
  const stderrDecoder = new TextDecoder();

  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(createAbortError());
      return;
    }

    let socket: WebSocket | null = null;
    let settled = false;
    let sawExit = false;

    const cleanup = () => {
      signal?.removeEventListener('abort', handleAbort);
      if (socket) {
        socket.onopen = null;
        socket.onmessage = null;
        socket.onerror = null;
        socket.onclose = null;
      }
    };

    const settle = (err?: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (err) {
        reject(err);
      } else {
        onEvent({ type: 'complete' });
        resolve();
      }
    };

    const closeSocket = () => {
      if (!socket) return;
      if (socket.readyState === WebSocket.CLOSED || socket.readyState === WebSocket.CLOSING) return;
      socket.close();
    };

    const writeStdinBytes = (bytes: Uint8Array) => {
      if (!socket || socket.readyState !== WebSocket.OPEN) {
        throw new AppError('networkError', 'Exec WebSocket is not open');
      }
      socket.send(makeExecStdinFrame(bytes));
    };

    const stdinWriter: ExecStdinWriter = {
      write: (text: string) => writeStdinBytes(textToUtf8Bytes(text)),
      writeBytes: writeStdinBytes,
    };

    function handleAbort() {
      closeSocket();
      settle(createAbortError());
    }

    const handleJsonMessage = (payload: unknown): boolean => {
      if (!payload || typeof payload !== 'object') return false;
      const obj = payload as Record<string, unknown>;
      const sessionId = extractExecSessionId(obj);
      if (sessionId) options.onSessionId?.(sessionId);

      if (obj.type === 'session_info') {
        onEvent({ type: 'started' });
        return true;
      }

      if (obj.type === 'exit') {
        sawExit = true;
        const exitCode =
          typeof obj.exit_code === 'number' ? obj.exit_code :
          typeof obj.exitCode === 'number' ? obj.exitCode :
          0;
        onEvent({ type: 'exit', exit_code: exitCode });
        closeSocket();
        return true;
      }

      return false;
    };

    const handleTextMessage = (text: string): boolean => {
      try {
        return handleJsonMessage(JSON.parse(text));
      } catch {
        return false;
      }
    };

    const handleBinaryMessage = (bytes: Uint8Array) => {
      if (bytes.length === 0) return;
      const streamId = bytes[0];
      const payload = bytes.slice(1);

      if (streamId === 1) {
        const data = stdoutDecoder.decode(payload, { stream: true });
        if (data) onEvent({ type: 'stdout', data });
      } else if (streamId === 2) {
        const data = stderrDecoder.decode(payload, { stream: true });
        if (data) onEvent({ type: 'stderr', data });
      } else if (streamId === 3) {
        const stdoutRemainder = stdoutDecoder.decode();
        const stderrRemainder = stderrDecoder.decode();
        if (stdoutRemainder) onEvent({ type: 'stdout', data: stdoutRemainder });
        if (stderrRemainder) onEvent({ type: 'stderr', data: stderrRemainder });
        sawExit = true;
        onEvent({ type: 'exit', exit_code: parseExecExitCode(payload) });
        closeSocket();
      }
    };

    signal?.addEventListener('abort', handleAbort, { once: true });

    if (Platform.OS === 'web') {
      socket = new WebSocket(url);
    } else {
      const RNWebSocket = WebSocket as unknown as RNWebSocketCtor;
      socket = new RNWebSocket(url, undefined, {
        headers: {
          Authorization: `Bearer ${token}`,
        },
      });
    }

    socket.binaryType = 'arraybuffer';

    socket.onopen = () => {
      onEvent({ type: 'started' });
      try {
        options.onStdinReady?.(stdinWriter);
      } catch (err) {
        settle(err as Error);
      }
    };

    socket.onmessage = async (event) => {
      try {
        if (typeof event.data === 'string') {
          if (stringLooksLikeBinaryFrame(event.data)) {
            handleBinaryMessage(stringToBytes(event.data));
            return;
          }
          if (!handleTextMessage(event.data)) {
            onEvent({ type: 'stdout', data: event.data });
          }
          return;
        }

        const bytes = await messageDataToBytes(event.data);
        if (bytes) {
          handleBinaryMessage(bytes);
          return;
        }

        const text = await messageDataToText(event.data);
        if (!handleTextMessage(text)) {
          onEvent({ type: 'stdout', data: text });
        }
      } catch (err) {
        settle(err as Error);
      }
    };

    socket.onerror = () => {
      closeSocket();
      settle(new AppError('networkError', 'Exec WebSocket error'));
    };

    socket.onclose = () => {
      if (signal?.aborted) {
        settle(createAbortError());
        return;
      }
      if (!sawExit) {
        if (options.onDisconnectBeforeExit) {
          options.onDisconnectBeforeExit();
        } else {
          onEvent({ type: 'exit', exit_code: 0 });
        }
      }
      settle();
    };
  });
}

/**
 * Start a long-running service and let it keep running in the background.
 * `streamService` only resolves when the service exits, so this fires it without
 * awaiting and resolves `started` once the first lifecycle event arrives (or after
 * `settleMs`). Aborting the returned controller stops *streaming logs*; use
 * `deleteService` to actually stop the service.
 */
export function startBackgroundService(
  spriteName: string,
  serviceName: string,
  config: ServiceRequest,
  onEvent?: (event: ServiceLogEvent) => void,
  settleMs: number = 1500,
  conn?: Connection
): { controller: AbortController; started: Promise<void> } {
  const controller = new AbortController();
  const started = new Promise<void>((resolve) => {
    let settled = false;
    const settle = () => {
      if (settled) return;
      settled = true;
      resolve();
    };
    const timer = setTimeout(settle, settleMs);
    streamService(
      spriteName,
      serviceName,
      config,
      (event) => {
        onEvent?.(event);
        if (event.type === 'started' || event.type === 'stdout' || event.type === 'stderr') {
          settle();
        }
      },
      controller.signal,
      undefined,
      conn
    )
      .catch((err) => {
        if ((err as Error)?.name !== 'AbortError') {
          onEvent?.({ type: 'error', data: (err as Error).message });
        }
      })
      .finally(() => {
        clearTimeout(timer);
        settle();
      });
  });
  return { controller, started };
}

export async function getServiceStatus(
  spriteName: string,
  serviceName: string,
  conn?: Connection
): Promise<ServiceInfo> {
  return apiRequest<ServiceInfo>('GET', `/sprites/${spriteName}/services/${serviceName}`, undefined, undefined, conn);
}

export async function deleteService(
  spriteName: string,
  serviceName: string,
  conn?: Connection
): Promise<void> {
  await apiRequest<{}>('DELETE', `/sprites/${spriteName}/services/${serviceName}`, undefined, 5, conn);
}

export async function listServices(spriteName: string, conn?: Connection): Promise<ServiceInfo[]> {
  const result = await apiRequest<ServiceInfo[] | { services?: ServiceInfo[] }>(
    'GET',
    `/sprites/${spriteName}/services`,
    undefined,
    undefined,
    conn
  );
  if (Array.isArray(result)) return result;
  if (result && Array.isArray(result.services)) return result.services;
  return [];
}

export async function cleanupLegacyChatServices(spriteName: string, conn?: Connection): Promise<void> {
  const stalePrefixes = ['wisp-claude-', 'wisp-codex-', 'wisp-exec-'];
  const services = await listServices(spriteName, conn);
  const staleServices = services.filter((service) =>
    stalePrefixes.some((prefix) => service.name.startsWith(prefix))
  );

  await Promise.allSettled(
    staleServices.map((service) => deleteService(spriteName, service.name, conn))
  );
}

// MARK: - Exec Sessions

export interface ExecSession {
  id: string;
  cmd?: string;
  tty: boolean;
  created_at?: string;
  last_activity?: string;
}

/** List currently running exec sessions on a sprite (GET /sprites/{name}/exec). */
export async function listExecSessions(spriteName: string, conn?: Connection): Promise<ExecSession[]> {
  try {
    const result = await apiRequest<ExecSession[] | { sessions: ExecSession[] }>(
      'GET',
      `/sprites/${spriteName}/exec`,
      undefined,
      undefined,
      conn
    );
    if (Array.isArray(result)) return result;
    if (result && Array.isArray((result as any).sessions)) return (result as any).sessions;
    return [];
  } catch {
    return [];
  }
}

export async function killExecSession(
  spriteName: string,
  sessionId: string,
  signal: string = 'SIGTERM',
  timeout: string = '5s',
  conn?: Connection
): Promise<void> {
  const { httpBase, token } = await resolveTarget(conn);
  const params = new URLSearchParams({ signal, timeout });
  const response = await fetch(
    `${httpBase}/sprites/${encodeURIComponent(spriteName)}/exec/${encodeURIComponent(sessionId)}/kill?${params.toString()}`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
      },
    }
  );

  if (response.status === 401) throw new AppError('unauthorized', 'Unauthorized');
  if (response.status === 404) throw new AppError('notFound', 'Not found');
  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new AppError('serverError', text || `Kill error ${response.status}`, response.status);
  }

  const reader = response.body?.getReader();
  if (reader) {
    while (true) {
      const { done } = await reader.read();
      if (done) break;
    }
  }
}

// MARK: - Exec Helpers

/**
 * Run a short command on a sprite via the Exec API.
 * Creates a temporary exec session and collects stdout.
 * Used for simple operations like waking sprites or fetching session info.
 */
export async function runExec(
  spriteName: string,
  command: string,
  timeout: number = 15,
  conn?: Connection
): Promise<{ output: string; success: boolean }> {
  let output = '';
  let exitCode: number | undefined;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout * 1000);

  try {
    await streamExec(
      spriteName,
      ['bash', '-c', command],
      (event) => {
        if (event.type === 'stdout' && event.data) {
          output += event.data;
        } else if (event.type === 'exit') {
          exitCode = event.exit_code ?? 0;
        }
      },
      controller.signal,
      {
        path: '/bin/bash',
        maxRunAfterDisconnect: '1s',
      },
      conn
    );
  } catch (err: any) {
    if (err.name !== 'AbortError') {
      exitCode = exitCode ?? 1;
    }
  } finally {
    clearTimeout(timer);
  }

  return { output, success: exitCode === 0 };
}
