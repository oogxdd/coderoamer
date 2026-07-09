import { ServiceLogEvent } from '@/models/service';
import * as api from '@/services/api';

type JsonObject = Record<string, unknown>;

interface RpcResponse {
  id: string | number;
  result?: unknown;
  error?: { message?: string; code?: number } | string;
}

export interface CodexAppServerTurnOptions {
  spriteName: string;
  command: string[];
  path?: string;
  workingDirectory: string;
  prompt: string;
  threadId?: string;
  model?: string;
  maxRunAfterDisconnect?: string;
  signal?: AbortSignal;
  onEvent: (event: ServiceLogEvent) => void;
  onSessionId?: (sessionId: string) => void;
  onDisconnectBeforeExit?: () => void;
}

function isObject(value: unknown): value is JsonObject {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function readString(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (typeof value === 'number') return String(value);
  return undefined;
}

function readRpcId(value: unknown): string | number | undefined {
  if (!isObject(value)) return undefined;
  const id = value.id;
  if (typeof id === 'string' || typeof id === 'number') return id;
  return undefined;
}

function readResponseError(error: unknown): string {
  if (typeof error === 'string') return error;
  if (isObject(error)) {
    return readString(error.message) ?? readString(error.code) ?? 'Codex app-server request failed';
  }
  return 'Codex app-server request failed';
}

function readThreadId(result: unknown): string | undefined {
  if (!isObject(result)) return undefined;
  const direct = readString(result.threadId) ?? readString(result.thread_id);
  if (direct) return direct;

  const thread = result.thread;
  if (isObject(thread)) {
    return readString(thread.id) ?? readString(thread.sessionId) ?? readString(thread.session_id);
  }
  return undefined;
}

function compactObject<T extends JsonObject>(value: T): T {
  for (const key of Object.keys(value)) {
    if (value[key] === undefined) delete value[key];
  }
  return value;
}

function makeThreadParams(workingDirectory: string, model?: string): JsonObject {
  return compactObject({
    cwd: workingDirectory,
    model: model || undefined,
    approvalPolicy: 'never',
    sandbox: 'danger-full-access',
  });
}

function makeTurnParams(threadId: string, workingDirectory: string, prompt: string, model?: string): JsonObject {
  return compactObject({
    threadId,
    input: [{ type: 'text', text: prompt, text_elements: [] }],
    cwd: workingDirectory,
    model: model || undefined,
    approvalPolicy: 'never',
    sandboxPolicy: { type: 'dangerFullAccess' },
  });
}

export async function streamCodexAppServerTurn(options: CodexAppServerTurnOptions): Promise<void> {
  let stdin: api.ExecStdinWriter | undefined;
  let nextRequestId = 1;
  let stdoutBuffer = '';
  let activeThreadId = options.threadId;
  let execSessionId: string | undefined;
  let rpcError: Error | undefined;
  const pendingRequests = new Map<string | number, string>();

  const fail = (message: string) => {
    if (rpcError) return;
    rpcError = new Error(message);
    options.onEvent({ type: 'error', data: message });
    if (execSessionId) {
      api.killExecSession(options.spriteName, execSessionId).catch(() => {});
    }
  };

  const sendJson = (payload: JsonObject) => {
    if (!stdin) {
      fail('Codex app-server stdin is not ready');
      return;
    }
    stdin.write(`${JSON.stringify(payload)}\n`);
  };

  const sendNotification = (method: string, params?: JsonObject) => {
    sendJson(params === undefined ? { method } : { method, params });
  };

  const sendRequest = (method: string, params: JsonObject) => {
    const id = nextRequestId++;
    pendingRequests.set(id, method);
    sendJson({ jsonrpc: '2.0', id, method, params });
  };

  const startOrResumeThread = () => {
    if (activeThreadId) {
      sendRequest('thread/resume', {
        threadId: activeThreadId,
        ...makeThreadParams(options.workingDirectory, options.model),
        excludeTurns: true,
      });
    } else {
      sendRequest('thread/start', makeThreadParams(options.workingDirectory, options.model));
    }
  };

  const startTurn = () => {
    if (!activeThreadId) {
      fail('Codex app-server did not return a thread id');
      return;
    }
    sendRequest(
      'turn/start',
      makeTurnParams(activeThreadId, options.workingDirectory, options.prompt, options.model)
    );
  };

  const handleResponse = (message: RpcResponse) => {
    const method = pendingRequests.get(message.id);
    pendingRequests.delete(message.id);

    if (message.error) {
      fail(readResponseError(message.error));
      return;
    }

    if (method === 'initialize') {
      sendNotification('initialized');
      startOrResumeThread();
      return;
    }

    if (method === 'thread/start' || method === 'thread/resume') {
      activeThreadId = readThreadId(message.result) ?? activeThreadId;
      startTurn();
    }
  };

  const handleRpcLine = (line: string) => {
    let message: unknown;
    try {
      message = JSON.parse(line);
    } catch {
      return;
    }

    const id = readRpcId(message);
    if (id !== undefined) {
      handleResponse(message as RpcResponse);
      return;
    }

    if (isObject(message)) {
      const method = readString(message.method);
      if (method === 'turn/completed') {
        if (execSessionId) {
          api.killExecSession(options.spriteName, execSessionId).catch(() => {});
        }
      } else if (method === 'error') {
        const params = isObject(message.params) ? message.params : undefined;
        const error = params && isObject(params.error) ? params.error : undefined;
        fail(readString(error?.message) ?? 'Codex app-server turn failed');
      }
    }
  };

  const handleStdout = (data: string) => {
    stdoutBuffer += data;
    while (true) {
      const newlineIndex = stdoutBuffer.indexOf('\n');
      if (newlineIndex === -1) break;

      const line = stdoutBuffer.slice(0, newlineIndex).trim();
      stdoutBuffer = stdoutBuffer.slice(newlineIndex + 1);
      if (line) handleRpcLine(line);
    }
  };

  await api.streamExec(
    options.spriteName,
    options.command,
    (event) => {
      options.onEvent(event);
      if (event.type === 'stdout' && event.data) {
        handleStdout(event.data);
      }
    },
    options.signal,
    {
      path: options.path,
      stdin: true,
      maxRunAfterDisconnect: options.maxRunAfterDisconnect,
      onDisconnectBeforeExit: options.onDisconnectBeforeExit,
      onSessionId: (sessionId) => {
        execSessionId = sessionId;
        options.onSessionId?.(sessionId);
      },
      onStdinReady: (writer) => {
        stdin = writer;
        sendRequest('initialize', {
          clientInfo: {
            name: 'sprites-rn-manager',
            title: 'Sprites Manager',
            version: '0.0.0',
          },
          capabilities: {
            experimentalApi: true,
            requestAttestation: false,
          },
        });
      },
    }
  );

  if (rpcError) throw rpcError;
}
