import { Sprite, SpritesListResponse } from '@/models/sprite';
import { Checkpoint, CheckpointStreamEvent } from '@/models/checkpoint';
import { ServiceRequest, ServiceLogEvent, ServiceInfo } from '@/models/service';
import { loadToken } from './auth';

const BASE_URL = 'https://api.sprites.dev/v1';

class AppError extends Error {
  constructor(public code: string, message: string, public statusCode?: number) {
    super(message);
    this.name = 'AppError';
  }
}

async function getToken(): Promise<string> {
  const token = await loadToken('spritesToken');
  if (!token) throw new AppError('noToken', 'No Sprites API token');
  return token;
}

async function apiRequest<T>(
  method: string,
  path: string,
  body?: unknown,
  timeout?: number
): Promise<T> {
  const token = await getToken();
  const url = `${BASE_URL}${path}`;

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

export async function listSprites(): Promise<Sprite[]> {
  const response = await apiRequest<SpritesListResponse>('GET', '/sprites');
  return response.sprites;
}

export async function createSprite(name: string): Promise<Sprite> {
  return apiRequest<Sprite>('POST', '/sprites', { name });
}

export async function getSprite(name: string): Promise<Sprite> {
  return apiRequest<Sprite>('GET', `/sprites/${name}`);
}

export async function deleteSprite(name: string): Promise<void> {
  await apiRequest<{}>('DELETE', `/sprites/${name}`);
}

// MARK: - Checkpoints

export async function listCheckpoints(spriteName: string): Promise<Checkpoint[]> {
  return apiRequest<Checkpoint[]>('GET', `/sprites/${spriteName}/checkpoints`);
}

export async function createCheckpoint(spriteName: string, comment?: string): Promise<void> {
  const token = await getToken();
  const url = `${BASE_URL}/sprites/${spriteName}/checkpoint`;

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

export async function restoreCheckpoint(spriteName: string, checkpointId: string): Promise<void> {
  const token = await getToken();
  const url = `${BASE_URL}/sprites/${spriteName}/checkpoints/${checkpointId}/restore`;

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

// MARK: - Auth Validation

export async function validateToken(): Promise<void> {
  await apiRequest<SpritesListResponse>('GET', '/sprites');
}

// MARK: - Services

export async function streamService(
  spriteName: string,
  serviceName: string,
  config: ServiceRequest,
  onEvent: (event: ServiceLogEvent) => void,
  signal?: AbortSignal,
  duration: string = '3600s'
): Promise<void> {
  const token = await getToken();
  const url = `${BASE_URL}/sprites/${spriteName}/services/${serviceName}?duration=${duration}`;

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
  if (!reader) return;

  const decoder = new TextDecoder();
  let buffer = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';

    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const event: ServiceLogEvent = JSON.parse(line);
        onEvent(event);
      } catch {
        // Skip unparseable lines
      }
    }
  }

  // Process remaining buffer
  if (buffer.trim()) {
    try {
      const event: ServiceLogEvent = JSON.parse(buffer);
      onEvent(event);
    } catch {
      // Skip
    }
  }
}

export async function streamServiceLogs(
  spriteName: string,
  serviceName: string,
  onEvent: (event: ServiceLogEvent) => void,
  signal?: AbortSignal,
  duration: string = '3600s'
): Promise<void> {
  const token = await getToken();
  const url = `${BASE_URL}/sprites/${spriteName}/services/${serviceName}/logs?duration=${duration}`;

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
  if (!reader) return;

  const decoder = new TextDecoder();
  let buffer = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';

    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const event: ServiceLogEvent = JSON.parse(line);
        onEvent(event);
      } catch {
        // Skip
      }
    }
  }

  if (buffer.trim()) {
    try {
      const event: ServiceLogEvent = JSON.parse(buffer);
      onEvent(event);
    } catch {
      // Skip
    }
  }
}

export async function getServiceStatus(spriteName: string, serviceName: string): Promise<ServiceInfo> {
  return apiRequest<ServiceInfo>('GET', `/sprites/${spriteName}/services/${serviceName}`);
}

export async function deleteService(spriteName: string, serviceName: string): Promise<void> {
  await apiRequest<{}>('DELETE', `/sprites/${spriteName}/services/${serviceName}`, undefined, 5);
}

// MARK: - Exec Helpers

/**
 * Run a short command on a sprite via the service API.
 * Creates a temporary service, collects output, and cleans up.
 * Used for simple operations like waking sprites or fetching session info.
 */
export async function runExec(
  spriteName: string,
  command: string,
  timeout: number = 15
): Promise<{ output: string; success: boolean }> {
  const serviceName = `wisp-exec-${Date.now().toString(36)}`;
  const config: ServiceRequest = {
    cmd: 'bash',
    args: ['-c', command],
  };

  let output = '';
  let success = false;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout * 1000);

  try {
    await streamService(
      spriteName,
      serviceName,
      config,
      (event) => {
        if (event.type === 'stdout' && event.data) {
          output += event.data;
        } else if (event.type === 'exit') {
          success = event.exit_code === 0;
        }
      },
      controller.signal,
      `${timeout}s`
    );
    success = true;
  } catch (err: any) {
    if (err.name !== 'AbortError') {
      success = false;
    }
  } finally {
    clearTimeout(timer);
    // Best-effort cleanup
    deleteService(spriteName, serviceName).catch(() => {});
  }

  return { output, success };
}
