import { AgentEffort, normalizeAgentEffortForProvider } from '@/models/chat';
import { ServiceLogEvent } from '@/models/service';
import * as api from '@/services/api';
import { getSetting, setSetting } from '@/services/storage';

const CACHE_KEY = 'codexModelCatalog';
const REQUEST_TIMEOUT_MS = 12_000;

type JsonObject = Record<string, unknown>;

export interface CodexModelOption {
  id: string;
  model: string;
  displayName: string;
  description?: string;
  supportedReasoningEfforts: AgentEffort[];
  defaultReasoningEffort?: AgentEffort;
  isDefault: boolean;
}

function isObject(value: unknown): value is JsonObject {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined;
}

function readEffort(value: unknown): AgentEffort | undefined {
  const raw = readString(value) ??
    (isObject(value)
      ? readString(value.reasoningEffort) ?? readString(value.effort)
      : undefined);
  return normalizeAgentEffortForProvider('codexAppServer', raw);
}

function parseModel(value: unknown): CodexModelOption | undefined {
  if (!isObject(value)) return undefined;
  const model = readString(value.model) ?? readString(value.id);
  if (!model) return undefined;
  const rawEfforts = Array.isArray(value.supportedReasoningEfforts)
    ? value.supportedReasoningEfforts
    : [];
  const supportedReasoningEfforts = rawEfforts
    .map(readEffort)
    .filter((effort): effort is AgentEffort => !!effort);

  return {
    id: readString(value.id) ?? model,
    model,
    displayName: readString(value.displayName) ?? model,
    description: readString(value.description),
    supportedReasoningEfforts,
    defaultReasoningEffort: readEffort(value.defaultReasoningEffort),
    isDefault: value.isDefault === true,
  };
}

function parseModelListResult(result: unknown): CodexModelOption[] {
  if (!isObject(result) || !Array.isArray(result.data)) return [];
  return result.data
    .map(parseModel)
    .filter((model): model is CodexModelOption => !!model);
}

export async function getCachedCodexModels(): Promise<CodexModelOption[]> {
  const raw = await getSetting(CACHE_KEY);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.map(parseModel).filter((model): model is CodexModelOption => !!model);
  } catch {
    return [];
  }
}

export async function cacheCodexModels(models: CodexModelOption[]): Promise<void> {
  await setSetting(CACHE_KEY, JSON.stringify(models));
}

export async function listCodexModels(
  spriteName: string,
  signal?: AbortSignal
): Promise<CodexModelOption[]> {
  return new Promise((resolve, reject) => {
    const controller = new AbortController();
    let stdin: api.ExecStdinWriter | undefined;
    let buffer = '';
    let execSessionId: string | undefined;
    let settled = false;

    const cleanup = () => {
      clearTimeout(timeout);
      signal?.removeEventListener('abort', handleParentAbort);
      controller.abort();
      if (execSessionId) api.killExecSession(spriteName, execSessionId).catch(() => {});
    };
    const finish = (models?: CodexModelOption[], error?: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (error) reject(error);
      else resolve(models ?? []);
    };
    const handleParentAbort = () => {
      const error = new Error('Aborted');
      error.name = 'AbortError';
      finish(undefined, error);
    };
    const send = (payload: JsonObject) => {
      stdin?.write(`${JSON.stringify(payload)}\n`);
    };
    const handleLine = (line: string) => {
      let message: unknown;
      try {
        message = JSON.parse(line);
      } catch {
        return;
      }
      if (!isObject(message)) return;
      if (message.id === 1) {
        if (message.error) {
          finish(undefined, new Error('Codex app-server initialize failed'));
          return;
        }
        send({ method: 'initialized', params: {} });
        send({ id: 2, method: 'model/list', params: { limit: 100 } });
      } else if (message.id === 2) {
        if (message.error) {
          finish(undefined, new Error('Codex app-server model/list failed'));
          return;
        }
        finish(parseModelListResult(message.result));
      }
    };
    const handleEvent = (event: ServiceLogEvent) => {
      if (event.type === 'stdout' && event.data) {
        buffer += event.data;
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';
        for (const line of lines) handleLine(line);
      } else if (event.type === 'error') {
        finish(undefined, new Error(event.data ?? 'Codex app-server failed'));
      } else if (event.type === 'exit' && !settled) {
        finish(undefined, new Error('Codex app-server exited before model/list completed'));
      }
    };

    const timeout = setTimeout(
      () => finish(undefined, new Error('Codex model catalog timed out')),
      REQUEST_TIMEOUT_MS
    );
    if (signal?.aborted) {
      handleParentAbort();
      return;
    }
    signal?.addEventListener('abort', handleParentAbort, { once: true });

    void api.streamExec(
      spriteName,
      ['bash', '-lc', 'source ~/.sprite_env 2>/dev/null || true\nexec codex app-server --stdio'],
      handleEvent,
      controller.signal,
      {
        path: '/bin/bash',
        stdin: true,
        stdinReadyAfterSessionInfo: true,
        maxRunAfterDisconnect: '0s',
        onSessionId: (sessionId) => {
          execSessionId = sessionId;
        },
        onStdinReady: (writer) => {
          stdin = writer;
          send({
            id: 1,
            method: 'initialize',
            params: {
              clientInfo: {
                name: 'coderoamer',
                title: 'CodeRoamer',
                version: '1.0.0',
              },
              capabilities: { experimentalApi: true },
            },
          });
        },
      }
    ).catch((error) => {
      if (!settled && (error as Error)?.name !== 'AbortError') {
        finish(undefined, error as Error);
      }
    });
  });
}
