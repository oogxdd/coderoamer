import { useCallback, useRef, useState } from 'react';
import {
  AgentProvider,
  ChatContent,
  ChatMessage,
  ChatStatus,
  ToolResultCard,
  ToolUseCard,
  makeId,
} from '@/models/chat';
import {
  ClaudeAssistantEvent,
  ClaudeResultEvent,
  ClaudeStreamEvent,
  ClaudeSystemEvent,
  ClaudeToolResultEvent,
} from '@/models/claude-events';
import { CodexStreamEvent } from '@/models/codex-events';
import { ServiceLogEvent, ServiceRequest } from '@/models/service';
import { ClaudeStreamParser, stripLogTimestamps } from '@/services/claude-stream';
import { CodexStreamParser } from '@/services/codex-stream';
import * as api from '@/services/api';
import { loadToken } from '@/services/auth';
import { getSetting, loadChatMessages, saveChatMessages } from '@/services/storage';

const CODEX_MODEL = 'gpt-5-codex';

interface SessionIds {
  claudeSessionId?: string;
  codexSessionId?: string;
}

interface UseChatOptions {
  spriteName: string;
  chatId: string;
  workingDirectory: string;
  provider: AgentProvider;
  initialClaudeSessionId?: string;
  initialCodexSessionId?: string;
  initialServiceName?: string;
  onSessionIdsChange?: (sessionIds: SessionIds) => void;
  onCodexAuthIssue?: (message: string) => void;
}

function makeServiceName(provider: AgentProvider): string {
  return `wisp-${provider}-${makeId()}`;
}

function classifyCodexAuthIssue(raw: string): string | undefined {
  const text = raw.toLowerCase();
  const matchesAuthIssue =
    text.includes('codex login') ||
    text.includes('not logged') ||
    text.includes('authentication') ||
    text.includes('unauthorized') ||
    text.includes('forbidden') ||
    text.includes('openai_api_key') ||
    text.includes('api key') ||
    text.includes('login required') ||
    text.includes('chatgpt login') ||
    text.includes('status code: 401') ||
    text.includes('status code: 403');

  if (!matchesAuthIssue) return undefined;

  return [
    'Codex is not authenticated in this sprite environment.',
    'Run `codex login status` and then `codex login` inside the sprite shell, or switch this chat to Claude.',
  ].join(' ');
}

function messagePlainText(message: ChatMessage): string {
  return message.content
    .filter((item): item is Extract<ChatContent, { type: 'text' }> => item.type === 'text')
    .map((item) => item.text)
    .join('\n\n')
    .trim();
}

function buildFallbackPrompt(history: ChatMessage[], prompt: string): string {
  const transcript = history
    .filter((message) => message.role === 'user' || message.role === 'assistant')
    .map((message) => {
      const text = messagePlainText(message);
      if (!text) return null;
      const role = message.role === 'user' ? 'User' : 'Assistant';
      const clipped = text.length > 1200 ? `${text.slice(0, 1200)}...` : text;
      return `${role}: ${clipped}`;
    })
    .filter((line): line is string => line !== null)
    .slice(-12);

  if (transcript.length === 0) return prompt;

  return [
    'Continue this conversation. Here is the prior transcript:',
    transcript.join('\n\n'),
    `User: ${prompt}`,
    'Assistant:',
  ].join('\n\n');
}

function nextAssistantAfterUser(messages: ChatMessage[], userIndex: number): number {
  for (let i = userIndex + 1; i < messages.length; i++) {
    if (messages[i].role === 'user') break;
    if (messages[i].role === 'assistant') return i;
  }
  return -1;
}

function debugChat(...args: unknown[]) {
  if (!__DEV__) return;
  // eslint-disable-next-line no-console
  console.log('[chat-debug]', ...args);
}

export function useChat(options: UseChatOptions) {
  const { spriteName, chatId, workingDirectory, provider } = options;

  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [status, setStatus] = useState<ChatStatus>('idle');
  const [modelName, setModelName] = useState<string | undefined>();
  const [errorMessage, setErrorMessage] = useState<string | undefined>();
  const [inputText, setInputText] = useState('');
  const [codexAuthIssue, setCodexAuthIssue] = useState<string | undefined>();

  const claudeSessionIdRef = useRef<string | undefined>(options.initialClaudeSessionId);
  const codexSessionIdRef = useRef<string | undefined>(options.initialCodexSessionId);
  const serviceNameRef = useRef<string>(options.initialServiceName ?? makeServiceName(provider));
  const abortRef = useRef<AbortController | null>(null);
  const claudeParserRef = useRef(new ClaudeStreamParser());
  const codexParserRef = useRef(new CodexStreamParser());
  const loadRequestRef = useRef(0);
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

  const isStreaming = status === 'streaming' || status === 'connecting' || status === 'reconnecting';

  const updateMessages = useCallback((updater: (prev: ChatMessage[]) => ChatMessage[]) => {
    setMessages((prev) => {
      const next = updater(prev);
      messagesRef.current = next;
      return next;
    });
  }, []);

  const persistMessages = useCallback(
    async (msgs?: ChatMessage[]) => {
      await saveChatMessages(chatId, msgs ?? messagesRef.current);
    },
    [chatId]
  );

  const loadSession = useCallback(async () => {
    const loadRequest = ++loadRequestRef.current;
    const initialMessageCount = messagesRef.current.length;
    const saved = await loadChatMessages(chatId);
    if (loadRequest !== loadRequestRef.current) return;

    // Avoid clobbering live in-memory messages if a send started while loading persisted history.
    if (messagesRef.current.length > initialMessageCount || statusRef.current !== 'idle') return;

    messagesRef.current = saved;
    setMessages(saved);
    activeUserMessageIdRef.current = undefined;
    activeAssistantMessageIdRef.current = undefined;
    assistantTextSeenRef.current = false;

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
  }, [chatId, options.initialClaudeSessionId, options.initialCodexSessionId, setClaudeSessionId, setCodexSessionId]);

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
    [updateActiveAssistant]
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
          setClaudeSessionId(res.session_id);
          if (typeof res.result === 'string' && res.result.trim()) {
            debugChat('claude result event', 'len', res.result.length);
            ensureTurnAssistantText(res.result);
          }
          break;
        }
        case 'unknown':
          break;
      }
    },
    [appendAssistantText, ensureTurnAssistantText, setClaudeSessionId, updateActiveAssistant]
  );

  const handleCodexEvent = useCallback(
    (event: CodexStreamEvent) => {
      switch (event.type) {
        case 'threadStarted':
          setCodexSessionId(event.threadId);
          setModelName((prev) => prev ?? CODEX_MODEL);
          break;
        case 'assistantDelta':
          codexSawAssistantRef.current = true;
          debugChat('codex assistant delta', 'len', event.text.length);
          appendAssistantText(event.text);
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
        case 'turnCompleted':
          if (event.text && event.text.trim()) {
            debugChat('codex turn completed text', 'len', event.text.length);
            ensureTurnAssistantText(event.text);
          }
          if (event.model) setModelName(event.model);
          break;
        case 'error':
          setErrorMessage(event.message);
          break;
        case 'unknown':
          break;
      }
    },
    [appendAssistantText, ensureTurnAssistantText, updateActiveAssistant, setCodexSessionId]
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
      debugChat('service event', provider, event.type);
      switch (event.type) {
        case 'stdout': {
          if (!event.data) return;
          if (statusRef.current === 'connecting') setStatusTracked('streaming');

          let dataStr = stripLogTimestamps(event.data);
          if (!dataStr.endsWith('\n')) dataStr += '\n';

          if (provider === 'claude') {
            const events = claudeParserRef.current.parse(dataStr);
            if (events.length > 0) {
              debugChat('stdout parsed', provider, events.map((e) => e.type).join(','));
            }
            for (const parsed of events) {
              if (parsed.uuid && processedUUIDsRef.current.has(parsed.uuid)) continue;
              if (parsed.uuid) processedUUIDsRef.current.add(parsed.uuid);
              handleClaudeEvent(parsed);
            }
          } else {
            const events = codexParserRef.current.parse(dataStr);
            if (events.length > 0) {
              debugChat('stdout parsed', provider, events.map((e) => e.type).join(','));
            }
            for (const parsed of events) {
              handleCodexEvent(parsed);
            }
          }
          break;
        }
        case 'stderr': {
          if (statusRef.current === 'connecting') setStatusTracked('streaming');
          if (provider === 'codex' && event.data) {
            codexStderrRef.current += `\n${event.data}`;
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
    [handleClaudeEvent, handleCodexEvent, provider, setStatusTracked]
  );

  const sendMessage = useCallback(
    async (text?: string) => {
      if (statusRef.current !== 'idle') return;

      const prompt = (text ?? inputText).trim();
      if (!prompt) return;

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

      activeUserMessageIdRef.current = userMessage.id;
      activeAssistantMessageIdRef.current = assistantMessage.id;
      assistantTextSeenRef.current = false;
      updateMessages((prev) => [...prev, userMessage, assistantMessage]);
      debugChat('sendMessage', provider, 'user', userMessage.id, 'assistant', assistantMessage.id);

      const commandParts: string[] = [];

      commandParts.push(`mkdir -p ${workingDirectory}`);
      commandParts.push(`cd ${workingDirectory}`);

      const [gitName, gitEmail] = await Promise.all([getSetting('gitName'), getSetting('gitEmail')]);

      if (gitName) {
        const escapedName = gitName.replace(/'/g, "'\\''");
        commandParts.push(`git config --global user.name '${escapedName}'`);
      }
      if (gitEmail) {
        const escapedEmail = gitEmail.replace(/'/g, "'\\''");
        commandParts.push(`git config --global user.email '${escapedEmail}'`);
      }

      if (provider === 'claude') {
        const claudePrompt = claudeSessionIdRef.current
          ? prompt
          : buildFallbackPrompt(historyBeforeSend, prompt);
        const escapedClaudePrompt = claudePrompt.replace(/'/g, "'\\''");

        const claudeToken = await loadToken('claudeToken');
        if (claudeToken) {
          commandParts.push(`export CLAUDE_CODE_OAUTH_TOKEN='${claudeToken}'`);
        }
        commandParts.push('export NO_DNA=1');

        let claudeCmd =
          'claude -p --verbose --output-format stream-json --dangerously-skip-permissions';

        const [modelId, maxTurns, customInstructions] = await Promise.all([
          getSetting('claudeModel'),
          getSetting('maxTurns'),
          getSetting('customInstructions'),
        ]);

        claudeCmd += ` --model ${modelId ?? 'sonnet'}`;

        if (maxTurns && maxTurns !== '0') {
          claudeCmd += ` --max-turns ${maxTurns}`;
        }

        if (customInstructions && customInstructions.trim()) {
          const escapedInstructions = customInstructions.replace(/'/g, "'\\''");
          claudeCmd += ` --append-system-prompt '${escapedInstructions}'`;
        }

        if (claudeSessionIdRef.current) {
          claudeCmd += ` --resume ${claudeSessionIdRef.current}`;
        }
        claudeCmd += ` '${escapedClaudePrompt}'`;

        commandParts.push(
          `{ (while true; do sleep 20; printf . >&2; done) & HBEAT=$!; trap "kill $HBEAT 2>/dev/null" EXIT; ${claudeCmd}; kill $HBEAT 2>/dev/null; }`
        );
      } else {
        setModelName(CODEX_MODEL);
        const codexPrompt = codexSessionIdRef.current
          ? prompt
          : buildFallbackPrompt(historyBeforeSend, prompt);
        const escapedCodexPrompt = codexPrompt.replace(/'/g, "'\\''");
        const escapedSessionId = codexSessionIdRef.current?.replace(/'/g, "'\\''");

        const codexCmd = codexSessionIdRef.current
          ? `codex exec resume '${escapedSessionId}' --json --model ${CODEX_MODEL} --skip-git-repo-check --dangerously-bypass-approvals-and-sandbox '${escapedCodexPrompt}'`
          : `codex exec --json --model ${CODEX_MODEL} --skip-git-repo-check --dangerously-bypass-approvals-and-sandbox '${escapedCodexPrompt}'`;

        commandParts.push(
          `{ (while true; do sleep 20; printf . >&2; done) & HBEAT=$!; trap "kill $HBEAT 2>/dev/null" EXIT; ${codexCmd}; kill $HBEAT 2>/dev/null; }`
        );
      }

      const fullCommand = commandParts.join(' && ');

      processedUUIDsRef.current = new Set();
      claudeParserRef.current.reset();
      codexParserRef.current.reset();
      codexStderrRef.current = '';
      codexSawAssistantRef.current = false;
      setStatusTracked('connecting');
      setErrorMessage(undefined);
      setCodexAuthIssue(undefined);
      serviceEventsSeenRef.current = 0;

      const abortController = new AbortController();
      abortRef.current = abortController;

      const serviceName = makeServiceName(provider);
      serviceNameRef.current = serviceName;

      const config: ServiceRequest = {
        cmd: 'bash',
        args: ['-c', fullCommand],
      };

      try {
        await api.streamService(
          spriteName,
          serviceName,
          config,
          processServiceEvent,
          abortController.signal
        );
        if (serviceEventsSeenRef.current === 0) {
          debugChat('no events from service stream; fallback to logs stream', provider);
          await api.streamServiceLogs(
            spriteName,
            serviceName,
            processServiceEvent,
            abortController.signal
          );
        }
      } catch (err: any) {
        if (err.name !== 'AbortError') {
          const message = err.message ?? 'Stream error';
          debugChat('stream error', provider, message);
          setErrorMessage(message);
          if (provider === 'codex') {
            reportCodexAuthIssue(`${message}\n${codexStderrRef.current}`);
          }
        }
      } finally {
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

        if (provider === 'codex' && !codexSawAssistantRef.current) {
          reportCodexAuthIssue(codexStderrRef.current);
        }

        if (abortRef.current === abortController) {
          abortRef.current = null;
        }
        activeUserMessageIdRef.current = undefined;
        activeAssistantMessageIdRef.current = undefined;
        assistantTextSeenRef.current = false;
        setStatusTracked('idle');
        persistMessages();
      }
    },
    [
      inputText,
      persistMessages,
      processServiceEvent,
      provider,
      reportCodexAuthIssue,
      setStatusTracked,
      spriteName,
      handleClaudeEvent,
      handleCodexEvent,
      updateMessages,
      workingDirectory,
    ]
  );

  const interrupt = useCallback(() => {
    if (abortRef.current) {
      abortRef.current.abort();
      abortRef.current = null;
    }
    activeUserMessageIdRef.current = undefined;
    activeAssistantMessageIdRef.current = undefined;
    assistantTextSeenRef.current = false;
    setStatusTracked('idle');

    const svcName = serviceNameRef.current;
    api.deleteService(spriteName, svcName).catch(() => {});
  }, [setStatusTracked, spriteName]);

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
    loadSession,
    sessionId: provider === 'codex' ? codexSessionIdRef.current : claudeSessionIdRef.current,
    codexAuthIssue,
    clearCodexAuthIssue,
  };
}
