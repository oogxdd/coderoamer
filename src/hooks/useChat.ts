import { useCallback, useRef, useState } from 'react';
import {
  AgentEffort,
  AgentProvider,
  ChatContent,
  ChatMessage,
  ChatStatus,
  ToolResultCard,
  ToolUseCard,
  TurnOutcome,
  isCodexProvider,
  makeId,
  normalizeAgentEffortForProvider,
  providerDisplayName,
} from '@/models/chat';
import {
  ClaudeAssistantEvent,
  ClaudePartialStreamEvent,
  ClaudeResultEvent,
  ClaudeStreamEvent,
  ClaudeSystemEvent,
  ClaudeToolResultEvent,
} from '@/models/claude-events';
import { CodexStreamEvent } from '@/models/codex-events';
import { ServiceLogEvent } from '@/models/service';
import { ClaudeStreamParser, stripLogTimestamps } from '@/services/claude-stream';
import { CodexStreamParser } from '@/services/codex-stream';
import { streamCodexAppServerTurn } from '@/services/codex-app-server';
import { readClaudeSessionMessages } from '@/services/claude-sessions';
import { readCodexSessionMessages } from '@/services/codex-sessions';
import * as api from '@/services/api';
import { ensureProvisionedOnce } from '@/services/provision';
import { ActiveChatRun, chatRepository } from '@/services/chat-repository';
import { getSetting } from '@/services/storage';
import {
  buildFallbackPrompt,
  buildCodexAppServerCommand,
  buildProcessGroupKillCommand,
  buildTurnNotifySuffix,
  classifyCodexAuthIssue,
  codexEventDebugLabel,
  compactDebugChunk,
  conversationSignature,
  countUserMessages,
  elapsedSince,
  firstDivergentIndex,
  isHeartbeatStderr,
  mergeTranscript,
  nextAssistantAfterUser,
  safeTaskName,
  shellQuote,
  withSpriteTaskHeartbeat,
} from '@/services/chat-helpers';

const CODEX_DEFAULT_MODEL_LABEL = 'Codex default';
const CHAT_MAX_RUN_AFTER_DISCONNECT = '8h';

interface SessionIds {
  claudeSessionId?: string;
  codexSessionId?: string;
}

/** A send that failed before anything launched on the sprite — safe to retry. */
interface FailedSend {
  prompt: string;
  userMessageId: string;
  assistantMessageId: string;
}

/** A message written while a turn was in flight, waiting to be sent. */
export interface QueuedPrompt {
  id: string;
  text: string;
}

interface UseChatOptions {
  spriteName: string;
  chatId: string;
  workingDirectory: string;
  provider: AgentProvider;
  model?: string;
  effort?: AgentEffort;
  initialClaudeSessionId?: string;
  initialCodexSessionId?: string;
  initialActiveRun?: ActiveChatRun;
  onSessionIdsChange?: (sessionIds: SessionIds) => void;
  onActiveRunChange?: (activeRun: ActiveChatRun | undefined) => void;
  onCodexAuthIssue?: (message: string) => void;
}

function debugChat(...args: unknown[]) {
  if (!__DEV__) return;
  // eslint-disable-next-line no-console
  console.log('[chat-debug]', ...args);
}

type ChatTurnTiming = {
  startedAt?: number;
  firstStdoutAt?: number;
  firstStderrAt?: number;
  firstParsedAt?: number;
  firstAssistantAt?: number;
};

export function useChat(options: UseChatOptions) {
  const { spriteName, chatId, workingDirectory, provider, model, effort } = options;

  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [status, setStatus] = useState<ChatStatus>('idle');
  const [modelName, setModelName] = useState<string | undefined>();
  const [errorMessage, setErrorMessage] = useState<string | undefined>();
  const [inputText, setInputText] = useState('');
  const [codexAuthIssue, setCodexAuthIssue] = useState<string | undefined>();
  const [failedSend, setFailedSendState] = useState<FailedSend | undefined>();
  // In-memory only, per chat: queued messages don't survive app restarts.
  const [queuedPrompts, setQueuedPromptsState] = useState<QueuedPrompt[]>([]);

  const claudeSessionIdRef = useRef<string | undefined>(options.initialClaudeSessionId);
  const codexSessionIdRef = useRef<string | undefined>(options.initialCodexSessionId);
  const activeRunRef = useRef<ActiveChatRun | undefined>(options.initialActiveRun);
  const execSessionIdRef = useRef<string | undefined>(undefined);
  const abortRef = useRef<AbortController | null>(null);
  const claudeParserRef = useRef(new ClaudeStreamParser());
  const codexParserRef = useRef(new CodexStreamParser());
  const loadRequestRef = useRef(0);
  const loadedChatIdRef = useRef<string | undefined>(undefined);
  const messagesRef = useRef<ChatMessage[]>([]);
  const activeUserMessageIdRef = useRef<string | undefined>(undefined);
  const activeAssistantMessageIdRef = useRef<string | undefined>(undefined);
  const toolUseIndexRef = useRef<Map<string, { messageIndex: number; toolName: string }>>(new Map());
  const processedUUIDsRef = useRef<Set<string>>(new Set());
  const statusRef = useRef<ChatStatus>('idle');
  const assistantTextSeenRef = useRef(false);
  const serviceEventsSeenRef = useRef(0);
  const codexStderrRef = useRef('');
  const codexSawAssistantRef = useRef(false);
  const agentTurnCompleteRef = useRef(false);
  const turnTimingRef = useRef<ChatTurnTiming>({});
  const detachingControllersRef = useRef<Set<AbortController>>(new Set());
  const processServiceEventRef = useRef<(event: ServiceLogEvent) => void>(() => {});
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const reconnectAttemptRef = useRef(0);
  const attachToRunRef = useRef<(run: ActiveChatRun, loadRequest: number) => void>(() => {});
  const failedSendRef = useRef<FailedSend | undefined>(undefined);
  const queuedPromptsRef = useRef<QueuedPrompt[]>([]);
  const sendMessageRef = useRef<(text?: string) => Promise<void>>(async () => {});
  // Token streaming (--include-partial-messages): count of trailing content
  // items in the active assistant message built from deltas of the in-flight
  // API message, and whether the newest one is still appendable. The complete
  // `assistant` event replaces these with the authoritative blocks.
  const partialDeltaCountRef = useRef(0);
  const partialBlockOpenRef = useRef(false);
  // Old CLIs reject the flag; sniffed from stderr, retried once without it.
  const partialFlagRejectedRef = useRef(false);
  const partialMessagesUnsupportedRef = useRef(false);
  // Serialized snapshot of the last persisted transcript, keyed by chat, so
  // saves can write only the rows that changed since the previous save.
  const persistedPayloadsRef = useRef<{ chatId: string; payloads: string[] } | null>(null);
  // All DB writes go through one promise chain — SQLite transactions on the
  // shared connection must not interleave.
  const persistChainRef = useRef<Promise<void>>(Promise.resolve());
  const persistTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const setFailedSend = useCallback((value: FailedSend | undefined) => {
    failedSendRef.current = value;
    setFailedSendState(value);
  }, []);

  const setQueuedPrompts = useCallback((value: QueuedPrompt[]) => {
    queuedPromptsRef.current = value;
    setQueuedPromptsState(value);
  }, []);

  /** Fire the next queued message once the chat is fully idle again. */
  const maybeSendNextQueued = useCallback(() => {
    if (queuedPromptsRef.current.length === 0) return;
    if (statusRef.current !== 'idle' || activeRunRef.current) return;
    const [next, ...rest] = queuedPromptsRef.current;
    setQueuedPrompts(rest);
    // Defer one tick so the finished turn's state fully settles first.
    setTimeout(() => {
      sendMessageRef.current(next.text);
    }, 0);
  }, [setQueuedPrompts]);

  const setStatusTracked = useCallback((s: ChatStatus) => {
    statusRef.current = s;
    setStatus(s);
  }, []);

  const emitSessionIds = useCallback(() => {
    options.onSessionIdsChange?.({
      claudeSessionId: claudeSessionIdRef.current,
      codexSessionId: codexSessionIdRef.current,
    });
  }, [options.onSessionIdsChange]);

  const setActiveRun = useCallback(
    (activeRun: ActiveChatRun | undefined) => {
      activeRunRef.current = activeRun;
      options.onActiveRunChange?.(activeRun);
    },
    [options.onActiveRunChange]
  );

  const setClaudeSessionId = useCallback(
    (sessionId: string | undefined) => {
      if (claudeSessionIdRef.current === sessionId) return;
      claudeSessionIdRef.current = sessionId;
      emitSessionIds();
    },
    [emitSessionIds]
  );

  const setCodexSessionId = useCallback(
    (sessionId: string | undefined) => {
      if (codexSessionIdRef.current === sessionId) return;
      codexSessionIdRef.current = sessionId;
      emitSessionIds();
    },
    [emitSessionIds]
  );

  const isStreaming =
    status === 'streaming' ||
    status === 'connecting' ||
    status === 'reconnecting' ||
    activeRunRef.current !== undefined;

  const updateMessages = useCallback((updater: (prev: ChatMessage[]) => ChatMessage[]) => {
    setMessages((prev) => {
      const next = updater(prev);
      messagesRef.current = next;
      return next;
    });
  }, []);

  /**
   * Persist the conversation, writing only the rows that changed since the
   * last save for this chat (during streaming that's just the active
   * assistant message). Falls back to a full rewrite when the snapshot cache
   * belongs to another chat or a write failed. Calls are serialized.
   */
  const persistMessages = useCallback(
    (msgs?: ChatMessage[]) => {
      const run = async () => {
        const messages = msgs ?? messagesRef.current;
        const payloads = messages.map((m) => JSON.stringify(m));
        const cache = persistedPayloadsRef.current;
        const prev = cache?.chatId === chatId ? cache.payloads : null;
        persistedPayloadsRef.current = { chatId, payloads };
        try {
          const firstDiff = prev ? firstDivergentIndex(prev, payloads) : 0;
          if (prev && firstDiff === prev.length && firstDiff === payloads.length) return;
          await chatRepository.replaceMessagesFrom(chatId, payloads, firstDiff);
        } catch (error) {
          // Unknown DB state — force a full rewrite on the next save.
          persistedPayloadsRef.current = null;
          throw error;
        }
      };
      const next = persistChainRef.current.then(run, run);
      persistChainRef.current = next.then(
        () => undefined,
        () => undefined
      );
      return next;
    },
    [chatId]
  );

  const clearPersistTimer = useCallback(() => {
    if (persistTimerRef.current) {
      clearTimeout(persistTimerRef.current);
      persistTimerRef.current = null;
    }
  }, []);

  /** Throttled persist while a turn streams — at most one write per 3s. */
  const schedulePersist = useCallback(() => {
    if (persistTimerRef.current) return;
    persistTimerRef.current = setTimeout(() => {
      persistTimerRef.current = null;
      // The timer may outlive a chat switch; never write another chat's
      // in-memory messages under this closure's chat id.
      if (loadedChatIdRef.current !== chatId) return;
      persistMessages().catch(() => {});
    }, 3000);
  }, [chatId, persistMessages]);

  const syncClaudeTranscript = useCallback(
    async (
      loadRequest: number,
      resumeId: string | undefined,
      opts?: { allowReconnecting?: boolean }
    ) => {
      if (provider !== 'claude' || !resumeId) return;

      try {
        const transcript = await readClaudeSessionMessages(spriteName, resumeId);
        if (loadRequest !== loadRequestRef.current) return;
        const statusOk =
          statusRef.current === 'idle' ||
          (opts?.allowReconnecting === true && statusRef.current === 'reconnecting');
        if (!statusOk) return;
        if (transcript.length === 0) return;
        const local = messagesRef.current;
        const transcriptTurns = countUserMessages(transcript);
        const localTurns = countUserMessages(local);
        // The app may already have persisted the user's in-flight turn before
        // it was closed. In that case the turn counts are equal, but the
        // transcript can now contain the completed assistant response.
        if (local.length !== 0 && transcriptTurns < localTurns) return;
        const merged = mergeTranscript(local, transcript);
        if (conversationSignature(merged) === conversationSignature(local)) return;
        messagesRef.current = merged;
        setMessages(merged);
        await persistMessages(merged);
      } catch {
        // Offline / no transcript yet — keep the local copy.
      }
    },
    [persistMessages, provider, spriteName]
  );

  // Codex counterpart of syncClaudeTranscript: pull the on-disk rollout for a
  // resumed Codex thread so turns that finished while the app was away (or ran
  // from a terminal) are recovered — the same history `codex exec resume` sees.
  const syncCodexTranscript = useCallback(
    async (
      loadRequest: number,
      resumeId: string | undefined,
      opts?: { allowReconnecting?: boolean }
    ) => {
      if (!isCodexProvider(provider) || !resumeId) return;

      try {
        const transcript = await readCodexSessionMessages(spriteName, resumeId);
        if (loadRequest !== loadRequestRef.current) return;
        const statusOk =
          statusRef.current === 'idle' ||
          (opts?.allowReconnecting === true && statusRef.current === 'reconnecting');
        if (!statusOk) return;
        if (transcript.length === 0) return;
        const local = messagesRef.current;
        const transcriptTurns = countUserMessages(transcript);
        const localTurns = countUserMessages(local);
        if (local.length !== 0 && transcriptTurns < localTurns) return;
        const merged = mergeTranscript(local, transcript);
        if (conversationSignature(merged) === conversationSignature(local)) return;
        messagesRef.current = merged;
        setMessages(merged);
        await persistMessages(merged);
      } catch {
        // Offline / no rollout yet — keep the local copy.
      }
    },
    [persistMessages, provider, spriteName]
  );

  const clearReconnectTimer = useCallback(() => {
    if (reconnectTimerRef.current) {
      clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = null;
    }
  }, []);

  /** Clear all active-turn state and pull the final on-disk transcript. */
  const finishActiveRun = useCallback(
    async (
      activeRun: ActiveChatRun,
      loadRequest: number,
      setIdle: boolean,
      opts?: { autoSendQueued?: boolean }
    ) => {
      execSessionIdRef.current = undefined;
      activeUserMessageIdRef.current = undefined;
      activeAssistantMessageIdRef.current = undefined;
      assistantTextSeenRef.current = false;
      if (activeRunRef.current?.execSessionId === activeRun.execSessionId) {
        setActiveRun(undefined);
      }
      if (setIdle) setStatusTracked('idle');
      await syncClaudeTranscript(loadRequest, claudeSessionIdRef.current);
      await syncCodexTranscript(loadRequest, codexSessionIdRef.current);
      await persistMessages();
      if (opts?.autoSendQueued) maybeSendNextQueued();
    },
    [maybeSendNextQueued, persistMessages, setActiveRun, setStatusTracked, syncClaudeTranscript, syncCodexTranscript]
  );

  /**
   * Keep trying to get back to a still-running turn. Each tick first probes
   * the exec-session list over HTTP: API unreachable → back off and try again
   * (the network is down); session gone → the run finished while we were away,
   * finalize from the on-disk transcript; session alive → reattach the socket.
   */
  const scheduleReconnect = useCallback(
    (activeRun: ActiveChatRun, loadRequest: number) => {
      clearReconnectTimer();
      const attempt = reconnectAttemptRef.current + 1;
      reconnectAttemptRef.current = attempt;
      const delayMs = Math.min(30_000, 1000 * 2 ** Math.min(attempt - 1, 5));
      debugChat('reconnect scheduled', provider, `attempt=${attempt}`, `delayMs=${delayMs}`);
      setStatusTracked('reconnecting');
      reconnectTimerRef.current = setTimeout(async () => {
        reconnectTimerRef.current = null;
        if (loadRequest !== loadRequestRef.current) return;
        if (activeRunRef.current?.execSessionId !== activeRun.execSessionId) return;

        let sessions: api.ExecSession[];
        try {
          sessions = await api.listExecSessionsStrict(spriteName);
        } catch (err: any) {
          if (err?.code === 'notFound' || err?.code === 'unauthorized' || err?.code === 'noToken') {
            // The sprite (or our access to it) is gone — stop retrying.
            setErrorMessage(err?.message ?? 'Sprite unreachable');
            await finishActiveRun(activeRun, loadRequest, true);
            return;
          }
          scheduleReconnect(activeRun, loadRequest);
          return;
        }
        if (loadRequest !== loadRequestRef.current) return;
        if (activeRunRef.current?.execSessionId !== activeRun.execSessionId) return;

        if (!sessions.some((s) => s.id === activeRun.execSessionId)) {
          debugChat('reconnect: run finished while away', provider, activeRun.execSessionId);
          await finishActiveRun(activeRun, loadRequest, true, { autoSendQueued: true });
          return;
        }
        attachToRunRef.current(activeRun, loadRequest);
      }, delayMs);
    },
    [clearReconnectTimer, finishActiveRun, provider, setStatusTracked, spriteName]
  );

  /**
   * (Re)attach to a running turn's exec session. Pulls the on-disk transcript
   * first so output that streamed while we were disconnected renders
   * immediately — the attach socket only carries output from now on.
   */
  const attachToRun = useCallback(
    async (activeRun: ActiveChatRun, loadRequest: number) => {
      if (abortRef.current) {
        debugChat('attach skipped: a stream is already active', provider);
        return;
      }
      activeUserMessageIdRef.current = activeRun.userMessageId;
      activeAssistantMessageIdRef.current = activeRun.assistantMessageId;
      execSessionIdRef.current = activeRun.execSessionId;
      processedUUIDsRef.current = new Set();
      claudeParserRef.current.reset();
      codexParserRef.current.reset();
      codexStderrRef.current = '';
      codexSawAssistantRef.current = false;
      agentTurnCompleteRef.current = false;
      partialDeltaCountRef.current = 0;
      partialBlockOpenRef.current = false;
      partialFlagRejectedRef.current = false;
      serviceEventsSeenRef.current = 0;
      turnTimingRef.current = { startedAt: Date.now() };
      setStatusTracked('reconnecting');

      await syncClaudeTranscript(loadRequest, claudeSessionIdRef.current, {
        allowReconnecting: true,
      });
      await syncCodexTranscript(loadRequest, codexSessionIdRef.current, {
        allowReconnecting: true,
      });
      if (activeRunRef.current?.execSessionId !== activeRun.execSessionId) return;
      if (abortRef.current) return;

      const controller = new AbortController();
      let disconnectedBeforeExit = false;
      abortRef.current = controller;
      try {
        await api.streamExec(
          spriteName,
          [],
          (event) => {
            if (abortRef.current !== controller) return;
            if (reconnectAttemptRef.current !== 0) reconnectAttemptRef.current = 0;
            processServiceEventRef.current(event);
          },
          controller.signal,
          {
            attachSessionId: activeRun.execSessionId,
            onDisconnectBeforeExit: () => {
              disconnectedBeforeExit = true;
            },
          }
        );
      } catch (err: any) {
        if (err.name !== 'AbortError') {
          debugChat('active exec attach failed', provider, err.message ?? err);
          // Attach errors get the same treatment as mid-stream drops: the
          // probe in scheduleReconnect decides whether the run is still alive.
          disconnectedBeforeExit = true;
        }
      } finally {
        const wasDetaching = detachingControllersRef.current.delete(controller);
        const isCurrentStream = abortRef.current === controller;
        if (isCurrentStream) {
          abortRef.current = null;
        }
        if (wasDetaching) {
          if (!agentTurnCompleteRef.current) {
            debugChat('active exec detached', provider, activeRun.execSessionId);
            if (isCurrentStream) setStatusTracked('idle');
          }
          await persistMessages();
          return;
        }
        if (
          disconnectedBeforeExit &&
          activeRunRef.current?.execSessionId === activeRun.execSessionId &&
          !agentTurnCompleteRef.current
        ) {
          await persistMessages();
          scheduleReconnect(activeRun, loadRequestRef.current);
          return;
        }
        await finishActiveRun(activeRun, loadRequest, isCurrentStream, {
          autoSendQueued: agentTurnCompleteRef.current,
        });
      }
    },
    [
      finishActiveRun,
      persistMessages,
      provider,
      scheduleReconnect,
      setStatusTracked,
      spriteName,
      syncClaudeTranscript,
      syncCodexTranscript,
    ]
  );
  attachToRunRef.current = attachToRun;

  const loadSession = useCallback(async () => {
    const loadRequest = ++loadRequestRef.current;
    const isDifferentChat = loadedChatIdRef.current !== chatId;
    if (isDifferentChat && statusRef.current === 'idle') {
      messagesRef.current = [];
      setMessages([]);
      toolUseIndexRef.current = new Map();
      activeUserMessageIdRef.current = undefined;
      activeAssistantMessageIdRef.current = undefined;
      assistantTextSeenRef.current = false;
      serviceEventsSeenRef.current = 0;
      claudeParserRef.current.reset();
      codexParserRef.current.reset();
      codexStderrRef.current = '';
      codexSawAssistantRef.current = false;
      partialDeltaCountRef.current = 0;
      partialBlockOpenRef.current = false;
      partialFlagRejectedRef.current = false;
      turnTimingRef.current = {};
      setErrorMessage(undefined);
      setCodexAuthIssue(undefined);
      setFailedSend(undefined);
      setQueuedPrompts([]);
      clearPersistTimer();
      persistedPayloadsRef.current = null;
      claudeSessionIdRef.current = options.initialClaudeSessionId;
      codexSessionIdRef.current = options.initialCodexSessionId;
      activeRunRef.current = options.initialActiveRun;
      execSessionIdRef.current = undefined;
    }
    const initialMessageCount = messagesRef.current.length;
    const saved = await chatRepository.getMessages(chatId);
    if (loadRequest !== loadRequestRef.current) return;

    // Avoid clobbering live in-memory messages if a send started while loading persisted history.
    if (messagesRef.current.length > initialMessageCount || statusRef.current !== 'idle') {
      // Reload while waiting between reconnect attempts (e.g. the app came back
      // to the foreground): retry immediately instead of waiting out the backoff.
      const pendingRun = activeRunRef.current;
      if (statusRef.current === 'reconnecting' && pendingRun && !abortRef.current) {
        clearReconnectTimer();
        reconnectAttemptRef.current = 0;
        attachToRunRef.current(pendingRun, loadRequest);
      }
      return;
    }

    messagesRef.current = saved;
    loadedChatIdRef.current = chatId;
    setMessages(saved);
    // The DB is the source we just read — seed the diff cache from it.
    persistedPayloadsRef.current = { chatId, payloads: saved.map((m) => JSON.stringify(m)) };
    activeRunRef.current = options.initialActiveRun;
    activeUserMessageIdRef.current = undefined;
    activeAssistantMessageIdRef.current = undefined;
    assistantTextSeenRef.current = false;
    agentTurnCompleteRef.current = false;

    setClaudeSessionId(options.initialClaudeSessionId);
    setCodexSessionId(options.initialCodexSessionId);

    const index = new Map<string, { messageIndex: number; toolName: string }>();
    saved.forEach((msg, idx) => {
      msg.content.forEach((item) => {
        if (item.type === 'toolUse') {
          index.set(item.card.toolUseId, { messageIndex: idx, toolName: item.card.toolName });
        }
      });
    });
    toolUseIndexRef.current = index;

    if (saved.length === 0) {
      processedUUIDsRef.current = new Set();
      claudeParserRef.current.reset();
      codexParserRef.current.reset();
    }

    const activeRun = options.initialActiveRun;
    if (activeRun && activeRun.provider === provider) {
      clearReconnectTimer();
      reconnectAttemptRef.current = 0;
      attachToRun(activeRun, loadRequest);
      return;
    }

    if (activeRun) {
      setActiveRun(undefined);
    }

    // Source-of-truth sync: if this chat resumes a known Claude session, pull its
    // on-disk transcript from the sprite. Catches turns that finished (or were
    // started from a terminal / another device) while the app was away — the same
    // history `claude --resume` would show. Runs in the background; guarded so it
    // never clobbers a fresh local send.
    syncClaudeTranscript(loadRequest, options.initialClaudeSessionId);
    syncCodexTranscript(loadRequest, options.initialCodexSessionId);
  }, [
    attachToRun,
    chatId,
    clearPersistTimer,
    clearReconnectTimer,
    options.initialActiveRun,
    options.initialClaudeSessionId,
    options.initialCodexSessionId,
    provider,
    setClaudeSessionId,
    setCodexSessionId,
    setActiveRun,
    setFailedSend,
    setQueuedPrompts,
    syncClaudeTranscript,
    syncCodexTranscript,
  ]);

  const ensureAssistantTarget = useCallback(
    (source: ChatMessage[]): { messages: ChatMessage[]; index: number } => {
      let messages = source;
      const activeId = activeAssistantMessageIdRef.current;
      const activeUserId = activeUserMessageIdRef.current;

      if (activeId) {
        const byId = messages.findIndex((m) => m.id === activeId && m.role === 'assistant');
        if (byId !== -1) return { messages, index: byId };
      }

      if (activeUserId) {
        const userIndex = messages.findIndex((m) => m.id === activeUserId && m.role === 'user');
        if (userIndex !== -1) {
          const existingAfterUser = nextAssistantAfterUser(messages, userIndex);
          if (existingAfterUser !== -1) {
            activeAssistantMessageIdRef.current = messages[existingAfterUser].id;
            return { messages, index: existingAfterUser };
          }

          const assistant: ChatMessage = {
            id: activeId ?? makeId(),
            timestamp: Date.now(),
            role: 'assistant',
            content: [],
          };
          messages = [...messages];
          messages.splice(userIndex + 1, 0, assistant);
          activeAssistantMessageIdRef.current = assistant.id;
          return { messages, index: userIndex + 1 };
        }
      }

      let lastUserIndex = -1;
      for (let i = messages.length - 1; i >= 0; i--) {
        if (messages[i].role === 'user') {
          lastUserIndex = i;
          break;
        }
      }

      for (let i = messages.length - 1; i > lastUserIndex; i--) {
        if (messages[i].role === 'assistant') {
          activeAssistantMessageIdRef.current = messages[i].id;
          return { messages, index: i };
        }
      }

      const assistant: ChatMessage = {
        id: activeId ?? makeId(),
        timestamp: Date.now(),
        role: 'assistant',
        content: [],
      };
      messages = [...messages, assistant];
      activeAssistantMessageIdRef.current = assistant.id;
      return { messages, index: messages.length - 1 };
    },
    []
  );

  const updateActiveAssistant = useCallback(
    (mutateContent: (content: ChatContent[], targetIndex: number) => ChatContent[]) => {
      updateMessages((prev) => {
        const { messages: resolved, index: targetIndex } = ensureAssistantTarget([...prev]);
        const msgs = [...resolved];
        const target = msgs[targetIndex];
        msgs[targetIndex] = {
          ...target,
          content: mutateContent([...target.content], targetIndex),
        };
        return msgs;
      });
    },
    [ensureAssistantTarget, updateMessages]
  );

  const appendAssistantText = useCallback(
    (text: string) => {
      if (!text) return;
      debugChat('appendAssistantText', provider, 'chars', text.length);
      updateActiveAssistant((newContent) => {
        assistantTextSeenRef.current = true;
        const lastContent = newContent[newContent.length - 1];
        if (lastContent && lastContent.type === 'text') {
          newContent[newContent.length - 1] = {
            type: 'text',
            text: lastContent.text + text,
          };
        } else {
          newContent.push({ type: 'text', text });
        }
        return newContent;
      });
    },
    [provider, updateActiveAssistant]
  );

  const ensureTurnAssistantText = useCallback(
    (text: string) => {
      if (!text.trim()) return;
      updateMessages((prev) => {
        const activeUserId = activeUserMessageIdRef.current;
        if (!activeUserId) return prev;

        const msgs = [...prev];
        const userIndex = msgs.findIndex((m) => m.id === activeUserId && m.role === 'user');
        if (userIndex === -1) return prev;

        let assistantIndex = nextAssistantAfterUser(msgs, userIndex);
        if (assistantIndex === -1) {
          debugChat('ensureTurnAssistantText insert', provider, 'userIndex', userIndex);
          const assistant: ChatMessage = {
            id: makeId(),
            timestamp: Date.now(),
            role: 'assistant',
            content: [{ type: 'text', text }],
          };
          msgs.splice(userIndex + 1, 0, assistant);
          activeAssistantMessageIdRef.current = assistant.id;
          assistantTextSeenRef.current = true;
          return msgs;
        }

        const assistant = msgs[assistantIndex];
        const hasVisibleText = assistant.content.some(
          (item) => item.type === 'text' && item.text.trim().length > 0
        );
        if (hasVisibleText) return msgs;

        debugChat('ensureTurnAssistantText append', provider, 'assistantIndex', assistantIndex);
        msgs[assistantIndex] = {
          ...assistant,
          content: [...assistant.content, { type: 'text', text }],
        };
        activeAssistantMessageIdRef.current = msgs[assistantIndex].id;
        assistantTextSeenRef.current = true;
        return msgs;
      });
    },
    [provider, updateMessages]
  );

  /**
   * Render a token-streaming delta. Delta-built blocks are a live preview of
   * the in-flight API message; handleClaudeEvent's `assistant` case swaps them
   * for the authoritative blocks when the message completes.
   */
  const appendPartialDelta = useCallback(
    (kind: 'text' | 'reasoning', text: string) => {
      if (!text) return;
      updateActiveAssistant((newContent) => {
        if (kind === 'text') assistantTextSeenRef.current = true;
        const last = newContent[newContent.length - 1];
        const appendable =
          partialDeltaCountRef.current > 0 && partialBlockOpenRef.current && last?.type === kind;
        if (appendable && last?.type === 'text') {
          newContent[newContent.length - 1] = { type: 'text', text: last.text + text };
        } else if (appendable && last?.type === 'reasoning') {
          newContent[newContent.length - 1] = { type: 'reasoning', text: last.text + text };
        } else {
          newContent.push(kind === 'text' ? { type: 'text', text } : { type: 'reasoning', text });
          partialDeltaCountRef.current += 1;
        }
        partialBlockOpenRef.current = true;
        return newContent;
      });
    },
    [updateActiveAssistant]
  );

  // A turn has exactly one outcome; replace rather than stack when a merge or
  // replay already recorded one.
  const appendTurnOutcome = useCallback(
    (outcome: TurnOutcome) => {
      updateActiveAssistant((newContent) => {
        const existing = newContent.findIndex((item) => item.type === 'turnOutcome');
        if (existing !== -1) {
          newContent[existing] = { type: 'turnOutcome', outcome };
        } else {
          newContent.push({ type: 'turnOutcome', outcome });
        }
        return newContent;
      });
    },
    [updateActiveAssistant]
  );

  /**
   * A provider's terminal event is authoritative. Close the local stream and
   * clear the persisted run immediately instead of keeping a stale Stop button
   * visible until the WebSocket happens to close.
   */
  const completeTurnFromEvent = useCallback(
    (opts?: { terminateProcess?: boolean; autoSendQueued?: boolean }) => {
      clearPersistTimer();
      const run = activeRunRef.current;
      const sessionId = execSessionIdRef.current ?? run?.execSessionId;

      if (opts?.terminateProcess && sessionId) {
        api.killExecSession(spriteName, sessionId).catch(() => {});
      }
      if (opts?.terminateProcess && run?.taskName) {
        api.runExec(spriteName, buildProcessGroupKillCommand(run.taskName), 15).catch(() => {});
      }

      const controller = abortRef.current;
      if (controller) {
        detachingControllersRef.current.add(controller);
        controller.abort();
        if (abortRef.current === controller) abortRef.current = null;
      }

      execSessionIdRef.current = undefined;
      activeUserMessageIdRef.current = undefined;
      activeAssistantMessageIdRef.current = undefined;
      assistantTextSeenRef.current = false;
      setActiveRun(undefined);
      setStatusTracked('idle');

      // Let React apply the final content updater before serializing it.
      setTimeout(() => {
        persistMessages()
          .catch(() => {})
          .finally(() => {
            if (opts?.autoSendQueued !== false) maybeSendNextQueued();
          });
      }, 0);
    },
    [
      clearPersistTimer,
      maybeSendNextQueued,
      persistMessages,
      setActiveRun,
      setStatusTracked,
      spriteName,
    ]
  );

  const handleClaudeEvent = useCallback(
    (event: ClaudeStreamEvent) => {
      switch (event.type) {
        case 'system': {
          const sys = event.event as ClaudeSystemEvent;
          setClaudeSessionId(sys.session_id);
          if (sys.model) setModelName(sys.model);
          break;
        }
        case 'assistant': {
          const asst = event.event as ClaudeAssistantEvent;
          debugChat('claude assistant event', asst.message.content.map((b) => b.type));
          updateActiveAssistant((newContent, targetIndex) => {
            // Swap the delta-built preview of this API message for its
            // authoritative blocks (same text, plus complete tool_use inputs).
            if (partialDeltaCountRef.current > 0) {
              newContent.splice(newContent.length - partialDeltaCountRef.current);
              partialDeltaCountRef.current = 0;
              partialBlockOpenRef.current = false;
            }
            for (const block of asst.message.content) {
              if (block.type === 'text' && 'text' in block) {
                if (block.text) assistantTextSeenRef.current = true;
                const lastContent = newContent[newContent.length - 1];
                if (lastContent && lastContent.type === 'text') {
                  newContent[newContent.length - 1] = {
                    type: 'text',
                    text: lastContent.text + block.text,
                  };
                } else {
                  newContent.push({ type: 'text', text: block.text });
                }
              } else if (block.type === 'thinking' && 'thinking' in block) {
                // Extended-thinking blocks — surface Claude's reasoning live.
                const thinkingText = (block as { thinking?: string }).thinking ?? '';
                if (thinkingText) {
                  const lastContent = newContent[newContent.length - 1];
                  if (lastContent && lastContent.type === 'reasoning') {
                    newContent[newContent.length - 1] = {
                      type: 'reasoning',
                      text: lastContent.text + thinkingText,
                    };
                  } else {
                    newContent.push({ type: 'reasoning', text: thinkingText });
                  }
                }
              } else if (block.type === 'tool_use' && 'id' in block && 'name' in block) {
                const card: ToolUseCard = {
                  toolUseId: block.id,
                  toolName: block.name,
                  input: block.input,
                  startedAt: Date.now(),
                };
                newContent.push({ type: 'toolUse', card });
                toolUseIndexRef.current.set(block.id, {
                  messageIndex: targetIndex,
                  toolName: block.name,
                });
              }
            }
            return newContent;
          });
          break;
        }
        case 'user': {
          const toolResult = event.event as ClaudeToolResultEvent;
          updateActiveAssistant((newContent) => {
            for (const result of toolResult.message.content) {
              const toolName = toolUseIndexRef.current.get(result.tool_use_id)?.toolName ?? 'Unknown';
              const resultCard: ToolResultCard = {
                toolUseId: result.tool_use_id,
                toolName,
                content: result.content ?? null,
                completedAt: Date.now(),
              };

              newContent.push({ type: 'toolResult', card: resultCard });

              for (let i = 0; i < newContent.length; i++) {
                const item = newContent[i];
                if (item.type === 'toolUse' && item.card.toolUseId === result.tool_use_id) {
                  newContent[i] = {
                    type: 'toolUse',
                    card: { ...item.card, result: resultCard },
                  };
                  break;
                }
              }
            }
            return newContent;
          });
          break;
        }
        case 'result': {
          const res = event.event as ClaudeResultEvent;
          agentTurnCompleteRef.current = true;
          setClaudeSessionId(res.session_id);
          if (typeof res.result === 'string' && res.result.trim()) {
            debugChat('claude result event', 'len', res.result.length);
            ensureTurnAssistantText(res.result);
          }
          appendTurnOutcome({
            status:
              res.subtype === 'error_max_turns'
                ? 'maxTurns'
                : res.is_error
                  ? 'error'
                  : 'success',
            subtype: res.subtype,
            durationMs: res.duration_ms,
            numTurns: res.num_turns,
            completedAt: Date.now(),
          });
          completeTurnFromEvent();
          break;
        }
        case 'streamEvent': {
          const stream = event.event as ClaudePartialStreamEvent;
          const inner = stream.event;
          if (!inner) break;
          if (inner.type === 'content_block_start') {
            // Block boundary — the next delta starts a fresh content item.
            partialBlockOpenRef.current = false;
          } else if (inner.type === 'content_block_delta') {
            const delta = inner.delta;
            if (delta?.type === 'text_delta' && typeof delta.text === 'string') {
              appendPartialDelta('text', delta.text);
            } else if (delta?.type === 'thinking_delta' && typeof delta.thinking === 'string') {
              appendPartialDelta('reasoning', delta.thinking);
            }
            // input_json_delta (tool inputs) is intentionally ignored — tool
            // cards come from the complete assistant event.
          }
          break;
        }
        case 'unknown':
          break;
      }
    },
    [appendAssistantText, appendPartialDelta, appendTurnOutcome, completeTurnFromEvent, ensureTurnAssistantText, setClaudeSessionId, updateActiveAssistant]
  );

  const handleCodexEvent = useCallback(
    (event: CodexStreamEvent) => {
      switch (event.type) {
        case 'threadStarted':
          debugChat('codex thread started', elapsedSince(turnTimingRef.current.startedAt), event.threadId);
          setCodexSessionId(event.threadId);
          setModelName((prev) => prev ?? CODEX_DEFAULT_MODEL_LABEL);
          break;
        case 'assistantDelta':
          codexSawAssistantRef.current = true;
          if (!turnTimingRef.current.firstAssistantAt) {
            turnTimingRef.current.firstAssistantAt = Date.now();
          }
          debugChat(
            'codex assistant delta',
            elapsedSince(turnTimingRef.current.startedAt),
            'chars',
            event.text.length
          );
          appendAssistantText(event.text);
          break;
        case 'reasoning':
          debugChat(
            'codex reasoning',
            elapsedSince(turnTimingRef.current.startedAt),
            'chars',
            event.text.length
          );
          updateActiveAssistant((newContent) => {
            const last = newContent[newContent.length - 1];
            if (last && last.type === 'reasoning') {
              newContent[newContent.length - 1] = {
                type: 'reasoning',
                text: `${last.text}\n${event.text}`,
              };
            } else {
              newContent.push({ type: 'reasoning', text: event.text });
            }
            return newContent;
          });
          break;
        case 'commandBegin':
          updateActiveAssistant((newContent, targetIndex) => {
            const card: ToolUseCard = {
              toolUseId: event.commandId,
              toolName: 'Bash',
              input: { command: event.command },
              startedAt: Date.now(),
            };
            newContent.push({ type: 'toolUse', card });
            toolUseIndexRef.current.set(event.commandId, {
              messageIndex: targetIndex,
              toolName: 'Bash',
            });
            return newContent;
          });
          break;
        case 'commandEnd':
          updateActiveAssistant((newContent) => {
            const toolName = toolUseIndexRef.current.get(event.commandId)?.toolName ?? 'Bash';
            const resultCard: ToolResultCard = {
              toolUseId: event.commandId,
              toolName,
              content: event.output ?? null,
              completedAt: Date.now(),
            };

            newContent.push({ type: 'toolResult', card: resultCard });

            for (let i = 0; i < newContent.length; i++) {
              const item = newContent[i];
              if (item.type === 'toolUse' && item.card.toolUseId === event.commandId) {
                newContent[i] = {
                  type: 'toolUse',
                  card: { ...item.card, result: resultCard },
                };
                break;
              }
            }
            return newContent;
          });
          break;
        case 'fileChange':
          updateActiveAssistant((newContent, targetIndex) => {
            const paths = event.files.map((f) => f.path);
            const filePath = paths.length === 1 ? paths[0] : `${paths.length} files`;
            const summary = event.files.map((f) => `${f.kind}: ${f.path}`).join('\n');
            const resultCard: ToolResultCard = {
              toolUseId: event.changeId,
              toolName: 'Edit',
              content: summary || null,
              completedAt: Date.now(),
            };
            const card: ToolUseCard = {
              toolUseId: event.changeId,
              toolName: 'Edit',
              input: { file_path: filePath },
              startedAt: Date.now(),
              result: resultCard,
            };
            newContent.push({ type: 'toolUse', card });
            toolUseIndexRef.current.set(event.changeId, {
              messageIndex: targetIndex,
              toolName: 'Edit',
            });
            return newContent;
          });
          break;
        case 'mcpToolBegin':
          updateActiveAssistant((newContent, targetIndex) => {
            const toolName = event.server ? `${event.server}.${event.tool}` : event.tool;
            const card: ToolUseCard = {
              toolUseId: event.callId,
              toolName,
              input: event.args,
              startedAt: Date.now(),
            };
            newContent.push({ type: 'toolUse', card });
            toolUseIndexRef.current.set(event.callId, { messageIndex: targetIndex, toolName });
            return newContent;
          });
          break;
        case 'mcpToolEnd':
          updateActiveAssistant((newContent) => {
            const toolName =
              toolUseIndexRef.current.get(event.callId)?.toolName ??
              (event.server ? `${event.server}.${event.tool}` : event.tool);
            const resultCard: ToolResultCard = {
              toolUseId: event.callId,
              toolName,
              content: event.output ?? (event.isError ? 'MCP tool error' : null),
              completedAt: Date.now(),
            };
            newContent.push({ type: 'toolResult', card: resultCard });
            for (let i = 0; i < newContent.length; i++) {
              const item = newContent[i];
              if (item.type === 'toolUse' && item.card.toolUseId === event.callId) {
                newContent[i] = { type: 'toolUse', card: { ...item.card, result: resultCard } };
                break;
              }
            }
            return newContent;
          });
          break;
        case 'webSearch':
          updateActiveAssistant((newContent) => {
            const id = `web-${makeId()}`;
            const resultCard: ToolResultCard = {
              toolUseId: id,
              toolName: 'WebSearch',
              content: null,
              completedAt: Date.now(),
            };
            const card: ToolUseCard = {
              toolUseId: id,
              toolName: 'WebSearch',
              input: { query: event.query },
              startedAt: Date.now(),
              result: resultCard,
            };
            newContent.push({ type: 'toolUse', card });
            return newContent;
          });
          break;
        case 'todoList':
          updateActiveAssistant((newContent, targetIndex) => {
            const todos = event.items.map((entry, i) => ({
              id: `todo-${i}`,
              content: entry.text,
              status: entry.completed ? 'completed' : 'pending',
            }));
            const input = { todos } as unknown as ToolUseCard['input'];
            for (let i = 0; i < newContent.length; i++) {
              const item = newContent[i];
              if (item.type === 'toolUse' && item.card.toolUseId === event.listId) {
                newContent[i] = { type: 'toolUse', card: { ...item.card, input } };
                return newContent;
              }
            }
            const card: ToolUseCard = {
              toolUseId: event.listId,
              toolName: 'TodoWrite',
              input,
              startedAt: Date.now(),
            };
            newContent.push({ type: 'toolUse', card });
            toolUseIndexRef.current.set(event.listId, {
              messageIndex: targetIndex,
              toolName: 'TodoWrite',
            });
            return newContent;
          });
          break;
        case 'turnCompleted':
          debugChat('codex turn completed', elapsedSince(turnTimingRef.current.startedAt));
          agentTurnCompleteRef.current = true;
          appendTurnOutcome({
            status: 'success',
            durationMs: turnTimingRef.current.startedAt
              ? Date.now() - turnTimingRef.current.startedAt
              : undefined,
            completedAt: Date.now(),
          });
          completeTurnFromEvent();
          break;
        case 'error':
          debugChat('codex error event', elapsedSince(turnTimingRef.current.startedAt), event.message);
          agentTurnCompleteRef.current = true;
          setErrorMessage(event.message);
          appendTurnOutcome({ status: 'error', completedAt: Date.now() });
          completeTurnFromEvent({
            terminateProcess: activeRunRef.current?.transport === 'codexAppServer',
            autoSendQueued: false,
          });
          break;
        case 'unknown':
          debugChat('codex unknown event', elapsedSince(turnTimingRef.current.startedAt), codexEventDebugLabel(event));
          break;
      }
    },
    [appendAssistantText, appendTurnOutcome, completeTurnFromEvent, updateActiveAssistant, setCodexSessionId]
  );

  const reportCodexAuthIssue = useCallback(
    (raw: string) => {
      const issue = classifyCodexAuthIssue(raw);
      if (!issue) return;
      setCodexAuthIssue(issue);
      options.onCodexAuthIssue?.(issue);
    },
    [options.onCodexAuthIssue]
  );

  const processServiceEvent = useCallback(
    (event: ServiceLogEvent) => {
      serviceEventsSeenRef.current += 1;
      debugChat('exec event', provider, event.type, elapsedSince(turnTimingRef.current.startedAt));
      switch (event.type) {
        case 'stdout': {
          if (!event.data) return;
          if (statusRef.current === 'connecting') setStatusTracked('streaming');
          if (!turnTimingRef.current.firstStdoutAt) {
            turnTimingRef.current.firstStdoutAt = Date.now();
            debugChat('first stdout', provider, elapsedSince(turnTimingRef.current.startedAt));
          }

          const dataStr = stripLogTimestamps(event.data);

          if (provider === 'claude') {
            const events = claudeParserRef.current.parse(dataStr);
            if (events.length > 0) {
              if (!turnTimingRef.current.firstParsedAt) {
                turnTimingRef.current.firstParsedAt = Date.now();
              }
              debugChat(
                'stdout parsed',
                provider,
                elapsedSince(turnTimingRef.current.startedAt),
                events.map((e) => e.type).join(',')
              );
            }
            for (const parsed of events) {
              if (parsed.uuid && processedUUIDsRef.current.has(parsed.uuid)) continue;
              if (parsed.uuid) processedUUIDsRef.current.add(parsed.uuid);
              handleClaudeEvent(parsed);
            }
            if (events.length > 0) schedulePersist();
          } else {
            const events = codexParserRef.current.parse(dataStr);
            if (events.length > 0) {
              if (!turnTimingRef.current.firstParsedAt) {
                turnTimingRef.current.firstParsedAt = Date.now();
              }
              debugChat(
                'stdout parsed',
                provider,
                elapsedSince(turnTimingRef.current.startedAt),
                events.map(codexEventDebugLabel).join(', ')
              );
            }
            for (const parsed of events) {
              handleCodexEvent(parsed);
            }
            if (events.length > 0) schedulePersist();
          }
          break;
        }
        case 'stderr': {
          if (statusRef.current === 'connecting') setStatusTracked('streaming');
          if (!turnTimingRef.current.firstStderrAt) {
            turnTimingRef.current.firstStderrAt = Date.now();
            debugChat('first stderr', provider, elapsedSince(turnTimingRef.current.startedAt));
          }
          if (isCodexProvider(provider) && event.data) {
            codexStderrRef.current += `\n${event.data}`;
          }
          if (
            provider === 'claude' &&
            event.data &&
            /unknown option/i.test(event.data) &&
            event.data.includes('include-partial-messages')
          ) {
            partialFlagRejectedRef.current = true;
          }
          if (event.data) {
            if (isHeartbeatStderr(event.data)) {
              debugChat('stderr heartbeat', provider, elapsedSince(turnTimingRef.current.startedAt));
            } else {
              debugChat(
                'stderr',
                provider,
                elapsedSince(turnTimingRef.current.startedAt),
                compactDebugChunk(event.data)
              );
            }
          }
          break;
        }
        case 'exit': {
          const remaining =
            provider === 'claude'
              ? claudeParserRef.current.flush()
              : codexParserRef.current.flush();

          if (provider === 'claude') {
            for (const parsed of remaining as ClaudeStreamEvent[]) {
              if (parsed.uuid && processedUUIDsRef.current.has(parsed.uuid)) continue;
              if (parsed.uuid) processedUUIDsRef.current.add(parsed.uuid);
              handleClaudeEvent(parsed);
            }
          } else {
            for (const parsed of remaining as CodexStreamEvent[]) {
              handleCodexEvent(parsed);
            }
          }
          break;
        }
        case 'error':
          if (event.data) setErrorMessage(event.data);
          break;
        case 'complete':
        case 'started':
        case 'stopping':
        case 'stopped':
          break;
      }
    },
    [handleClaudeEvent, handleCodexEvent, provider, schedulePersist, setStatusTracked]
  );
  processServiceEventRef.current = processServiceEvent;

  /**
   * Launch the agent process for one turn and stream it back. Shared by
   * sendMessage and retryFailedSend — the turn's user/assistant messages must
   * already exist in the conversation.
   */
  const executeTurn = useCallback(
    async (
      prompt: string,
      userMessageId: string,
      assistantMessageId: string,
      historyForFallback: ChatMessage[]
    ) => {
      activeUserMessageIdRef.current = userMessageId;
      activeAssistantMessageIdRef.current = assistantMessageId;
      assistantTextSeenRef.current = false;
      turnTimingRef.current = { startedAt: Date.now() };
      setFailedSend(undefined);
      debugChat('executeTurn', provider, 'user', userMessageId, 'assistant', assistantMessageId);

      const commandParts: string[] = [];
      let codexAppServerPrompt: string | undefined;
      let codexAppServerModel: string | undefined;
      let codexAppServerEffort: AgentEffort | undefined;
      let transport: ActiveChatRun['transport'] = 'exec';

      // Credentials (git identity, GitHub HTTPS auth, Claude OAuth) are written
      // to the sprite once — at creation, or lazily here on first use this
      // session — so they aren't re-sent on every chat command.
      await ensureProvisionedOnce(spriteName);

      commandParts.push(`mkdir -p ${shellQuote(workingDirectory)}`);
      commandParts.push(`cd ${shellQuote(workingDirectory)}`);
      // Load the persisted Claude OAuth token (env-var path); harmless no-op when
      // a captured login credentials file is used instead.
      commandParts.push('. ~/.sprite_env 2>/dev/null || true');

      if (provider === 'claude') {
        const claudePrompt = claudeSessionIdRef.current
          ? prompt
          : buildFallbackPrompt(historyForFallback, prompt);

        commandParts.push('export NO_DNA=1');

        let claudeCmd =
          'claude -p --verbose --output-format stream-json --dangerously-skip-permissions';
        if (!partialMessagesUnsupportedRef.current) {
          // Token-level streaming; old CLIs that reject the flag are sniffed
          // from stderr and the turn retried once without it.
          claudeCmd += ' --include-partial-messages';
        }

        const [globalModel, globalEffort, maxTurns, customInstructions] = await Promise.all([
          getSetting('claudeModel'),
          getSetting('claudeEffort'),
          getSetting('maxTurns'),
          getSetting('customInstructions'),
        ]);

        const modelId = model?.trim() || globalModel || 'sonnet';
        const selectedEffort =
          normalizeAgentEffortForProvider(provider, effort ?? globalEffort) ?? 'high';

        claudeCmd += ` --model ${shellQuote(modelId)}`;
        claudeCmd += ` --effort ${shellQuote(selectedEffort)}`;
        setModelName(modelId);

        if (maxTurns && maxTurns !== '0') {
          claudeCmd += ` --max-turns ${shellQuote(maxTurns)}`;
        }

        if (customInstructions && customInstructions.trim()) {
          claudeCmd += ` --append-system-prompt ${shellQuote(customInstructions)}`;
        }

        if (claudeSessionIdRef.current) {
          claudeCmd += ` --resume ${shellQuote(claudeSessionIdRef.current)}`;
        }
        claudeCmd += ` ${shellQuote(claudePrompt)}`;

        commandParts.push(claudeCmd);
      } else {
        const [codexModelSetting, codexEffortSetting] = await Promise.all([
          getSetting('codexModel'),
          getSetting('codexEffort'),
        ]);
        const codexModel = model?.trim() || codexModelSetting?.trim();
        const selectedEffort =
          normalizeAgentEffortForProvider(provider, effort ?? codexEffortSetting) ?? 'high';
        setModelName(codexModel || CODEX_DEFAULT_MODEL_LABEL);
        const codexPrompt = codexSessionIdRef.current
          ? prompt
          : buildFallbackPrompt(historyForFallback, prompt);

        if (provider === 'codexAppServer') {
          codexAppServerPrompt = codexPrompt;
          codexAppServerModel = codexModel || undefined;
          codexAppServerEffort = selectedEffort;
          transport = 'codexAppServer';
          commandParts.push(buildCodexAppServerCommand());
        } else {
          let codexCmd = codexSessionIdRef.current
            ? 'codex exec resume --json --skip-git-repo-check --dangerously-bypass-approvals-and-sandbox'
            : 'codex exec --json --skip-git-repo-check --dangerously-bypass-approvals-and-sandbox';
          if (codexModel) {
            codexCmd += ` --model ${shellQuote(codexModel)}`;
          }
          codexCmd += ` -c ${shellQuote(`model_reasoning_effort="${selectedEffort}"`)}`;
          if (codexSessionIdRef.current) {
            codexCmd += ` ${shellQuote(codexSessionIdRef.current)}`;
          }
          codexCmd += ` ${shellQuote(codexPrompt)}`;
          commandParts.push(codexCmd);
        }
      }

      const taskName = safeTaskName(`wisp-chat-${provider}-${userMessageId}`);
      const [ntfyTopic, ntfyServer] = await Promise.all([
        getSetting('ntfyTopic'),
        getSetting('ntfyServer'),
      ]);
      let turnCommand = commandParts.join(' && ');
      if (ntfyTopic?.trim()) {
        // Push a phone notification from the sprite when the turn ends, so
        // "send and walk away" doesn't require reopening the app to find out.
        turnCommand += buildTurnNotifySuffix({
          server: ntfyServer ?? '',
          topic: ntfyTopic,
          title: `${spriteName} · ${providerDisplayName(provider)}`,
          promptPreview: prompt,
        });
      }
      const fullCommand = withSpriteTaskHeartbeat(turnCommand, taskName);

      processedUUIDsRef.current = new Set();
      claudeParserRef.current.reset();
      codexParserRef.current.reset();
      codexStderrRef.current = '';
      codexSawAssistantRef.current = false;
      agentTurnCompleteRef.current = false;
      partialDeltaCountRef.current = 0;
      partialBlockOpenRef.current = false;
      partialFlagRejectedRef.current = false;
      turnTimingRef.current = { startedAt: turnTimingRef.current.startedAt ?? Date.now() };
      setStatusTracked('connecting');
      setErrorMessage(undefined);
      setCodexAuthIssue(undefined);
      serviceEventsSeenRef.current = 0;

      const abortController = new AbortController();
      abortRef.current = abortController;
      execSessionIdRef.current = undefined;
      let disconnectedBeforeExit = false;
      let sendError: string | undefined;
      const streamActiveRunRef: { current?: ActiveChatRun } = {};

      try {
        const onSessionId = (sessionId: string) => {
          execSessionIdRef.current = sessionId;
          const nextRun: ActiveChatRun = {
            execSessionId: sessionId,
            taskName,
            provider,
            transport,
            userMessageId,
            assistantMessageId,
            workingDirectory,
            startedAt: Date.now(),
          };
          streamActiveRunRef.current = nextRun;
          setActiveRun(nextRun);
        };

        const onDisconnectBeforeExit = () => {
          disconnectedBeforeExit = true;
        };

        const onEvent = (event: ServiceLogEvent) => {
          if (abortRef.current !== abortController) return;
          processServiceEvent(event);
        };

        if (provider === 'codexAppServer' && codexAppServerPrompt !== undefined) {
          await streamCodexAppServerTurn({
            spriteName,
            command: ['bash', '-c', fullCommand],
            path: '/bin/bash',
            workingDirectory,
            prompt: codexAppServerPrompt,
            threadId: codexSessionIdRef.current,
            model: codexAppServerModel,
            effort: codexAppServerEffort,
            maxRunAfterDisconnect: CHAT_MAX_RUN_AFTER_DISCONNECT,
            signal: abortController.signal,
            onEvent,
            onDisconnectBeforeExit,
            onSessionId,
          });
        } else {
          await api.streamExec(
            spriteName,
            ['bash', '-c', fullCommand],
            onEvent,
            abortController.signal,
            {
              path: '/bin/bash',
              maxRunAfterDisconnect: CHAT_MAX_RUN_AFTER_DISCONNECT,
              onDisconnectBeforeExit,
              onSessionId,
            }
          );
        }
      } catch (err: any) {
        if (err.name !== 'AbortError') {
          const message = err.message ?? 'Stream error';
          debugChat('stream error', provider, message);
          if (
            streamActiveRunRef.current &&
            !agentTurnCompleteRef.current &&
            err?.terminal !== true
          ) {
            // The exec session may still be running on the sprite — treat the
            // dropped stream like a disconnect and let the reconnect loop decide.
            disconnectedBeforeExit = true;
          } else {
            sendError = message;
            setErrorMessage(message);
            if (err?.terminal === true) {
              agentTurnCompleteRef.current = true;
              appendTurnOutcome({ status: 'error', completedAt: Date.now() });
              completeTurnFromEvent({ terminateProcess: true, autoSendQueued: false });
            }
          }
          if (isCodexProvider(provider)) {
            reportCodexAuthIssue(`${message}\n${codexStderrRef.current}`);
          }
        }
      } finally {
        const wasDetaching = detachingControllersRef.current.delete(abortController);
        const isCurrentStream = abortRef.current === abortController;
        if (isCurrentStream) {
          abortRef.current = null;
        }
        const streamActiveRun = streamActiveRunRef.current;
        if (wasDetaching) {
          if (streamActiveRun) {
            debugChat('stream detached', provider, streamActiveRun.execSessionId);
          } else {
            debugChat('stream detached before session id', provider);
          }
          if (isCurrentStream) setStatusTracked('idle');
          await persistMessages();
          return;
        }

        const remaining =
          provider === 'claude' ? claudeParserRef.current.flush() : codexParserRef.current.flush();

        if (provider === 'claude') {
          for (const parsed of remaining as ClaudeStreamEvent[]) {
            if (parsed.uuid && processedUUIDsRef.current.has(parsed.uuid)) continue;
            if (parsed.uuid) processedUUIDsRef.current.add(parsed.uuid);
            handleClaudeEvent(parsed);
          }
        } else {
          for (const parsed of remaining as CodexStreamEvent[]) {
            handleCodexEvent(parsed);
          }
        }

        if (isCodexProvider(provider) && !codexSawAssistantRef.current) {
          reportCodexAuthIssue(codexStderrRef.current);
        }

        if (disconnectedBeforeExit && streamActiveRun && !agentTurnCompleteRef.current) {
          await persistMessages();
          const runNow = activeRunRef.current as ActiveChatRun | undefined;
          if (runNow?.execSessionId === streamActiveRun.execSessionId) {
            scheduleReconnect(streamActiveRun, loadRequestRef.current);
          } else if (isCurrentStream) {
            setStatusTracked('idle');
          }
          return;
        }
        const streamExecSessionId = streamActiveRunRef.current?.execSessionId;
        const currentActiveRun = activeRunRef.current as ActiveChatRun | undefined;
        if (!streamExecSessionId || currentActiveRun?.execSessionId === streamExecSessionId) {
          setActiveRun(undefined);
        }
        const neverStarted =
          !streamActiveRunRef.current &&
          turnTimingRef.current.firstStdoutAt === undefined &&
          turnTimingRef.current.firstStderrAt === undefined;
        if (sendError && neverStarted && !agentTurnCompleteRef.current) {
          // Nothing launched on the sprite, so re-running the same send is safe.
          setFailedSend({ prompt, userMessageId, assistantMessageId });
        }
        execSessionIdRef.current = undefined;
        activeUserMessageIdRef.current = undefined;
        activeAssistantMessageIdRef.current = undefined;
        assistantTextSeenRef.current = false;
        if (isCurrentStream) setStatusTracked('idle');
        await persistMessages();
        if (
          partialFlagRejectedRef.current &&
          !agentTurnCompleteRef.current &&
          provider === 'claude' &&
          isCurrentStream
        ) {
          // The installed claude CLI predates --include-partial-messages: the
          // process exited on argument parsing, so nothing ran. Remember that
          // for the rest of the session and repeat this turn without the flag.
          partialFlagRejectedRef.current = false;
          partialMessagesUnsupportedRef.current = true;
          debugChat('claude CLI rejected --include-partial-messages; retrying without it');
          setErrorMessage(undefined);
          await executeTurn(prompt, userMessageId, assistantMessageId, historyForFallback);
          return;
        }
        if (agentTurnCompleteRef.current && !sendError) maybeSendNextQueued();
      }
    },
    [
      maybeSendNextQueued,
      persistMessages,
      processServiceEvent,
      provider,
      reportCodexAuthIssue,
      scheduleReconnect,
      setActiveRun,
      setFailedSend,
      setStatusTracked,
      spriteName,
      handleClaudeEvent,
      handleCodexEvent,
      appendTurnOutcome,
      completeTurnFromEvent,
      effort,
      model,
      workingDirectory,
    ]
  );

  const sendMessage = useCallback(
    async (text?: string) => {
      const prompt = (text ?? inputText).trim();
      if (!prompt) return;

      if (statusRef.current !== 'idle' || activeRunRef.current) {
        // A turn is in flight — queue the message; it auto-sends when the
        // current turn completes.
        if (!text) setInputText('');
        setQueuedPrompts([...queuedPromptsRef.current, { id: makeId(), text: prompt }]);
        return;
      }

      if (!text) setInputText('');

      // Invalidate any in-flight history load to prevent clobbering this turn.
      loadRequestRef.current += 1;
      const historyBeforeSend = messagesRef.current;

      const userMessage: ChatMessage = {
        id: makeId(),
        timestamp: Date.now(),
        role: 'user',
        content: [{ type: 'text', text: prompt }],
      };

      const assistantMessage: ChatMessage = {
        id: makeId(),
        timestamp: Date.now(),
        role: 'assistant',
        content: [],
      };

      const pendingMessages = [...historyBeforeSend, userMessage, assistantMessage];
      updateMessages(() => pendingMessages);
      await persistMessages(pendingMessages);
      await executeTurn(prompt, userMessage.id, assistantMessage.id, historyBeforeSend);
    },
    [executeTurn, inputText, persistMessages, setQueuedPrompts, updateMessages]
  );
  sendMessageRef.current = sendMessage;

  const removeQueuedPrompt = useCallback(
    (id: string) => {
      setQueuedPrompts(queuedPromptsRef.current.filter((q) => q.id !== id));
    },
    [setQueuedPrompts]
  );

  /** Send a queued message immediately (only when the chat is idle). */
  const sendQueuedNow = useCallback(
    (id: string) => {
      if (statusRef.current !== 'idle' || activeRunRef.current) return;
      const target = queuedPromptsRef.current.find((q) => q.id === id);
      if (!target) return;
      setQueuedPrompts(queuedPromptsRef.current.filter((q) => q.id !== id));
      sendMessageRef.current(target.text);
    },
    [setQueuedPrompts]
  );

  /**
   * Re-run a send that failed before anything launched on the sprite, reusing
   * the already-rendered user/assistant messages.
   */
  const retryFailedSend = useCallback(async () => {
    const failed = failedSendRef.current;
    if (!failed) return;
    if (statusRef.current !== 'idle' || activeRunRef.current) return;
    setErrorMessage(undefined);
    loadRequestRef.current += 1;
    const msgs = messagesRef.current;
    const userIndex = msgs.findIndex((m) => m.id === failed.userMessageId);
    const historyForFallback = userIndex > 0 ? msgs.slice(0, userIndex) : [];
    await executeTurn(
      failed.prompt,
      failed.userMessageId,
      failed.assistantMessageId,
      historyForFallback
    );
  }, [executeTurn]);

  const interrupt = useCallback(() => {
    clearReconnectTimer();
    clearPersistTimer();
    reconnectAttemptRef.current = 0;
    const sessionId = execSessionIdRef.current ?? activeRunRef.current?.execSessionId;
    if (sessionId) {
      api.killExecSession(spriteName, sessionId).catch(() => {});
      execSessionIdRef.current = undefined;
    }
    // killExecSession SIGTERMs the bash wrapper, which defers its trap while
    // the agent runs in the foreground — the agent itself can survive. Also
    // kill the turn's whole process group, found via its task-name marker.
    const taskName = activeRunRef.current?.taskName;
    if (taskName) {
      api.runExec(spriteName, buildProcessGroupKillCommand(taskName), 15).catch(() => {});
    }
    if (abortRef.current) {
      abortRef.current.abort();
      abortRef.current = null;
    }
    // Mark the aborted turn before the active-message refs are cleared.
    const hadActiveTurn =
      activeUserMessageIdRef.current !== undefined || activeRunRef.current !== undefined;
    if (hadActiveTurn && !agentTurnCompleteRef.current) {
      appendTurnOutcome({ status: 'interrupted', completedAt: Date.now() });
    }
    activeUserMessageIdRef.current = undefined;
    activeAssistantMessageIdRef.current = undefined;
    assistantTextSeenRef.current = false;
    setActiveRun(undefined);
    setStatusTracked('idle');
    // Persist after React has flushed the outcome into messagesRef.
    setTimeout(() => {
      persistMessages().catch(() => {});
    }, 0);
  }, [appendTurnOutcome, clearPersistTimer, clearReconnectTimer, persistMessages, setActiveRun, setStatusTracked, spriteName]);

  const detachStream = useCallback(() => {
    clearReconnectTimer();
    clearPersistTimer();
    const controller = abortRef.current;
    if (controller) {
      detachingControllersRef.current.add(controller);
      controller.abort();
      abortRef.current = null;
    }
    setStatusTracked('idle');
  }, [clearPersistTimer, clearReconnectTimer, setStatusTracked]);

  const clearCodexAuthIssue = useCallback(() => {
    setCodexAuthIssue(undefined);
  }, []);

  return {
    messages,
    status,
    isStreaming,
    modelName,
    errorMessage,
    inputText,
    setInputText,
    sendMessage,
    interrupt,
    detachStream,
    loadSession,
    sessionId: isCodexProvider(provider) ? codexSessionIdRef.current : claudeSessionIdRef.current,
    codexAuthIssue,
    clearCodexAuthIssue,
    failedSend,
    retryFailedSend,
    queuedPrompts,
    removeQueuedPrompt,
    sendQueuedNow,
  };
}
