// AssemblyAI Universal-Streaming (v3) client.
//
// The existing AssemblyAI path in `client-transcription.ts` is the batch API:
// record the whole clip, upload it, poll until a transcript exists. That is fine
// for a file you picked, but for dictating a prompt it means staring at
// "Transcribing..." for as long as you spoke. This talks to the streaming
// WebSocket instead, so words land in the chat input while you are still
// talking.
//
// Everything the session needs from the outside world — the token request and
// the socket itself — is injectable, because the protocol is the part worth
// testing and it can be tested with no network and no device.
//
// Protocol: https://www.assemblyai.com/docs/api-reference/streaming-api/streaming-api

const STREAMING_TOKEN_URL = 'https://streaming.assemblyai.com/v3/token';
const STREAMING_WS_URL = 'wss://streaming.assemblyai.com/v3/ws';

/** What the microphone must produce: 16-bit little-endian mono PCM. */
export const STREAMING_SAMPLE_RATE = 16_000;
export const STREAMING_ENCODING = 'pcm_s16le';

/** Token redemption window. Only has to survive opening the socket. */
const TOKEN_EXPIRES_IN_SECONDS = 60;
/** How long to wait for the server's Termination before giving up on it. */
const TERMINATE_TIMEOUT_MS = 4000;
/** Frames dropped rather than buffered forever if the socket never opens. */
const MAX_QUEUED_FRAMES = 64;

/**
 * The slice of `WebSocket` this client uses. Narrow on purpose: React Native,
 * the browser, and the test fake all satisfy it.
 */
export interface StreamingWebSocket {
  send(data: string | ArrayBuffer): void;
  close(code?: number, reason?: string): void;
  onopen: ((event?: unknown) => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onerror: ((event: unknown) => void) | null;
  onclose: ((event: { code?: number; reason?: string }) => void) | null;
}

export interface StreamingSessionOptions {
  apiKey: string;
  /** Must match the sample rate of the frames passed to `sendAudio`. */
  sampleRate?: number;
  /**
   * Languages to steer toward, e.g. `['en', 'ru']`. More than one switches to
   * the multilingual model, which is the only one that can handle a mix.
   */
  languageCodes?: string[];
  speechModel?: string;
  /**
   * Every Turn message, partial or final, with the best text for the whole
   * session so far. Feed this straight into the input box.
   */
  onTranscript?: (text: string, info: { endOfTurn: boolean }) => void;
  /** Protocol/transport failures. The session is dead once this fires. */
  onError?: (error: Error) => void;
  fetchToken?: (apiKey: string) => Promise<string>;
  openSocket?: (url: string) => StreamingWebSocket;
}

/** GET a short-lived token so the key never has to ride in a URL or a header. */
export async function fetchStreamingToken(apiKey: string): Promise<string> {
  const url = `${STREAMING_TOKEN_URL}?expires_in_seconds=${TOKEN_EXPIRES_IN_SECONDS}`;
  const response = await fetch(url, { headers: { authorization: apiKey } });
  if (!response.ok) {
    const body = await response.text().catch(() => '');
    if (response.status === 401 || response.status === 403) {
      throw new Error(
        'AssemblyAI rejected this API key. Check it in Settings → Transcription.'
      );
    }
    throw new Error(body || `AssemblyAI token request failed (${response.status}).`);
  }
  const json = (await response.json()) as { token?: unknown };
  if (typeof json.token !== 'string' || !json.token) {
    throw new Error('AssemblyAI did not return a streaming token.');
  }
  return json.token;
}

export function buildStreamingUrl(
  token: string,
  options: { sampleRate: number; languageCodes?: string[]; speechModel?: string }
): string {
  const params = new URLSearchParams({
    token,
    encoding: STREAMING_ENCODING,
    sample_rate: String(options.sampleRate),
  });
  const languages = options.languageCodes?.filter(Boolean) ?? [];
  if (languages.length > 0) {
    params.set('language_codes', JSON.stringify(languages));
    params.set('language_detection', 'true');
  }
  // A single model can't cover a mix of languages, so asking for several
  // implies the multilingual one unless the caller pinned a model.
  const model =
    options.speechModel ??
    (languages.length > 1 ? 'universal-streaming-multilingual' : undefined);
  if (model) {
    params.set('speech_model', model);
  }
  return `${STREAMING_WS_URL}?${params.toString()}`;
}

/** Turn text is assembled here rather than in the UI, so it can be tested. */
export class TranscriptAssembler {
  private finalized: string[] = [];
  private partial = '';

  /** Returns true when this Turn closed a turn. */
  accept(turn: { transcript?: unknown; utterance?: unknown; end_of_turn?: unknown }): boolean {
    const transcript = typeof turn.transcript === 'string' ? turn.transcript : '';
    const utterance = typeof turn.utterance === 'string' ? turn.utterance : '';
    if (turn.end_of_turn === true) {
      // `utterance` is the whole turn and only arrives on end_of_turn; the
      // running `transcript` is the fallback when it doesn't.
      const finalText = (utterance || transcript).trim();
      if (finalText) this.finalized.push(finalText);
      this.partial = '';
      return true;
    }
    // Partials replace rather than append — the server revises them.
    this.partial = transcript.trim();
    return false;
  }

  get text(): string {
    return [...this.finalized, this.partial].filter(Boolean).join(' ');
  }
}

type SessionState = 'connecting' | 'open' | 'closing' | 'closed';

export class AssemblyAiStreamingSession {
  private socket: StreamingWebSocket | null = null;
  private state: SessionState = 'connecting';
  private assembler = new TranscriptAssembler();
  private queued: ArrayBuffer[] = [];
  private finishWaiters: ((text: string) => void)[] = [];
  private finishTimer: ReturnType<typeof setTimeout> | null = null;
  private failure: Error | null = null;

  private constructor(private readonly options: StreamingSessionOptions) {}

  /**
   * Resolves once the server has confirmed the session, so a caller can start
   * pushing audio without worrying about ordering.
   */
  static async start(
    options: StreamingSessionOptions
  ): Promise<AssemblyAiStreamingSession> {
    const session = new AssemblyAiStreamingSession(options);
    await session.connect();
    return session;
  }

  get text(): string {
    return this.assembler.text;
  }

  get isOpen(): boolean {
    return this.state === 'open';
  }

  private async connect(): Promise<void> {
    const apiKey = this.options.apiKey.trim();
    if (!apiKey) {
      throw new Error('AssemblyAI API key is not saved. Add it in Settings.');
    }
    const getToken = this.options.fetchToken ?? fetchStreamingToken;
    const token = await getToken(apiKey);
    const url = buildStreamingUrl(token, {
      sampleRate: this.options.sampleRate ?? STREAMING_SAMPLE_RATE,
      languageCodes: this.options.languageCodes,
      speechModel: this.options.speechModel,
    });

    const open =
      this.options.openSocket ??
      ((target: string) => new WebSocket(target) as unknown as StreamingWebSocket);
    const socket = open(url);
    this.socket = socket;

    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const settle = (error?: Error) => {
        if (settled) return;
        settled = true;
        if (error) reject(error);
        else resolve();
      };

      socket.onopen = () => {
        // Not "open" until Begin arrives: the server can still refuse the
        // session (expired token, bad parameters) after accepting the socket.
        this.flushQueue();
      };
      socket.onmessage = (event) => {
        const message = this.parseMessage(event.data);
        if (!message) return;
        if (message.type === 'Begin') {
          this.state = 'open';
          settle();
          return;
        }
        this.handleMessage(message, settle);
      };
      socket.onerror = () => {
        const error = new Error('AssemblyAI streaming connection failed.');
        this.fail(error);
        settle(error);
      };
      socket.onclose = (event) => {
        const wasConnecting = this.state === 'connecting';
        this.state = 'closed';
        this.resolveFinishers();
        if (event?.code && event.code !== 1000 && !this.failure) {
          this.fail(
            new Error(
              event.reason
                ? `AssemblyAI closed the stream: ${event.reason}`
                : `AssemblyAI closed the stream (code ${event.code}).`
            )
          );
        }
        if (wasConnecting) {
          settle(this.failure ?? new Error('AssemblyAI closed the stream before it started.'));
        }
      };
    });
  }

  private parseMessage(data: unknown): Record<string, unknown> | null {
    if (typeof data !== 'string') return null;
    try {
      const parsed = JSON.parse(data);
      return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null;
    } catch {
      return null;
    }
  }

  private handleMessage(
    message: Record<string, unknown>,
    settle?: (error?: Error) => void
  ): void {
    // AssemblyAI reports refusals as a bare `error` field rather than a type.
    if (typeof message.error === 'string' && message.error) {
      const error = new Error(message.error);
      this.fail(error);
      settle?.(error);
      return;
    }
    switch (message.type) {
      case 'Turn': {
        const endOfTurn = this.assembler.accept(message);
        this.options.onTranscript?.(this.assembler.text, { endOfTurn });
        return;
      }
      case 'Termination': {
        this.state = 'closed';
        this.resolveFinishers();
        this.socket?.close(1000);
        return;
      }
      default:
        return;
    }
  }

  private fail(error: Error): void {
    if (this.failure) return;
    this.failure = error;
    this.options.onError?.(error);
  }

  private flushQueue(): void {
    if (!this.socket) return;
    const frames = this.queued;
    this.queued = [];
    for (const frame of frames) {
      this.socket.send(frame);
    }
  }

  /** One chunk of PCM16 audio; 50–1000 ms per the API. Safe before `Begin`. */
  sendAudio(frame: ArrayBuffer | Uint8Array): void {
    if (this.state === 'closed' || this.state === 'closing') return;
    const buffer =
      frame instanceof Uint8Array
        ? (frame.buffer.slice(
            frame.byteOffset,
            frame.byteOffset + frame.byteLength
          ) as ArrayBuffer)
        : frame;
    if (this.state !== 'open' || !this.socket) {
      if (this.queued.length < MAX_QUEUED_FRAMES) this.queued.push(buffer);
      return;
    }
    this.socket.send(buffer);
  }

  /** Cut the current turn short, e.g. the user tapped stop mid-sentence. */
  forceEndpoint(): void {
    if (this.state !== 'open' || !this.socket) return;
    this.socket.send(JSON.stringify({ type: 'ForceEndpoint' }));
  }

  /**
   * Ask the server to finish, then resolve with the complete transcript. Any
   * outcome resolves — a session that will not shut down cleanly should not
   * cost the user the words they already dictated.
   */
  async finish(): Promise<string> {
    if (this.state === 'closed') return this.text;
    if (this.state === 'open' && this.socket) {
      this.socket.send(JSON.stringify({ type: 'Terminate' }));
    }
    this.state = 'closing';
    return new Promise<string>((resolve) => {
      this.finishWaiters.push(resolve);
      this.finishTimer ??= setTimeout(() => {
        this.socket?.close(1000);
        this.state = 'closed';
        this.resolveFinishers();
      }, TERMINATE_TIMEOUT_MS);
    });
  }

  /** Drop the session without waiting — the user cancelled. */
  abort(): void {
    this.state = 'closed';
    this.queued = [];
    this.resolveFinishers();
    this.socket?.close(1000);
  }

  private resolveFinishers(): void {
    if (this.finishTimer) {
      clearTimeout(this.finishTimer);
      this.finishTimer = null;
    }
    const waiters = this.finishWaiters;
    this.finishWaiters = [];
    for (const resolve of waiters) resolve(this.text);
  }
}
