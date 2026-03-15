import { useCallback, useRef, useState } from 'react';
import {
  ChatMessage,
  ChatContent,
  ChatStatus,
  ToolUseCard,
  ToolResultCard,
  makeId,
} from '@/models/chat';
import {
  ClaudeStreamEvent,
  ClaudeSystemEvent,
  ClaudeAssistantEvent,
  ClaudeToolResultEvent,
  ClaudeResultEvent,
} from '@/models/claude-events';
import { ServiceLogEvent, ServiceRequest } from '@/models/service';
import { ClaudeStreamParser, stripLogTimestamps } from '@/services/claude-stream';
import * as api from '@/services/api';
import { loadToken } from '@/services/auth';
import { saveChatMessages, loadChatMessages, getSetting } from '@/services/storage';

interface UseChatOptions {
  spriteName: string;
  chatId: string;
  workingDirectory: string;
  initialSessionId?: string;
  initialServiceName?: string;
}

function makeClaudeServiceName(): string {
  return `wisp-claude-${makeId()}`;
}

export function useChat(options: UseChatOptions) {
  const { spriteName, chatId, workingDirectory } = options;

  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [status, setStatus] = useState<ChatStatus>('idle');
  const [modelName, setModelName] = useState<string | undefined>();
  const [errorMessage, setErrorMessage] = useState<string | undefined>();
  const [inputText, setInputText] = useState('');

  const sessionIdRef = useRef<string | undefined>(options.initialSessionId);
  const serviceNameRef = useRef<string>(options.initialServiceName ?? makeClaudeServiceName());
  const abortRef = useRef<AbortController | null>(null);
  const parserRef = useRef(new ClaudeStreamParser());
  const messagesRef = useRef<ChatMessage[]>([]);
  const toolUseIndexRef = useRef<Map<string, { messageIndex: number; toolName: string }>>(new Map());
  const processedUUIDsRef = useRef<Set<string>>(new Set());
  const receivedSystemEventRef = useRef(false);
  const receivedResultEventRef = useRef(false);
  const statusRef = useRef<ChatStatus>('idle');

  // Keep statusRef in sync
  const setStatusTracked = useCallback((s: ChatStatus) => {
    statusRef.current = s;
    setStatus(s);
  }, []);

  const isStreaming = status === 'streaming' || status === 'connecting' || status === 'reconnecting';

  // Update both state and ref
  const updateMessages = useCallback((updater: (prev: ChatMessage[]) => ChatMessage[]) => {
    setMessages((prev) => {
      const next = updater(prev);
      messagesRef.current = next;
      return next;
    });
  }, []);

  const persistMessages = useCallback(async (msgs?: ChatMessage[]) => {
    await saveChatMessages(chatId, msgs ?? messagesRef.current);
  }, [chatId]);

  // Load saved messages
  const loadSession = useCallback(async () => {
    const saved = await loadChatMessages(chatId);
    messagesRef.current = saved;
    setMessages(saved);
    // Rebuild tool use index
    const index = new Map<string, { messageIndex: number; toolName: string }>();
    saved.forEach((msg, idx) => {
      msg.content.forEach((item) => {
        if (item.type === 'toolUse') {
          index.set(item.card.toolUseId, { messageIndex: idx, toolName: item.card.toolName });
        }
      });
    });
    toolUseIndexRef.current = index;
    // Reset session state for fresh chats
    if (saved.length === 0) {
      sessionIdRef.current = undefined;
      processedUUIDsRef.current = new Set();
      parserRef.current.reset();
    }
  }, [chatId]);

  // Handle a single Claude stream event
  const handleEvent = useCallback((event: ClaudeStreamEvent) => {
    switch (event.type) {
      case 'system': {
        const sys = event.event as ClaudeSystemEvent;
        receivedSystemEventRef.current = true;
        sessionIdRef.current = sys.session_id;
        if (sys.model) setModelName(sys.model);
        break;
      }

      case 'assistant': {
        const asst = event.event as ClaudeAssistantEvent;
        updateMessages((prev) => {
          const msgs = [...prev];
          const lastMsg = msgs[msgs.length - 1];
          if (!lastMsg || lastMsg.role !== 'assistant') return msgs;

          const newContent = [...lastMsg.content];

          for (const block of asst.message.content) {
            if (block.type === 'text' && 'text' in block) {
              // Merge consecutive text blocks
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
                messageIndex: msgs.length - 1,
                toolName: block.name,
              });
            }
          }

          msgs[msgs.length - 1] = { ...lastMsg, content: newContent };
          return msgs;
        });
        break;
      }

      case 'user': {
        const toolResult = event.event as ClaudeToolResultEvent;
        updateMessages((prev) => {
          const msgs = [...prev];
          const lastMsg = msgs[msgs.length - 1];
          if (!lastMsg || lastMsg.role !== 'assistant') return msgs;

          const newContent = [...lastMsg.content];

          for (const result of toolResult.message.content) {
            const toolName =
              toolUseIndexRef.current.get(result.tool_use_id)?.toolName ?? 'Unknown';
            const resultCard: ToolResultCard = {
              toolUseId: result.tool_use_id,
              toolName,
              content: result.content ?? null,
              completedAt: Date.now(),
            };

            newContent.push({ type: 'toolResult', card: resultCard });

            // Link result to matching tool use card
            for (let i = 0; i < newContent.length; i++) {
              const item = newContent[i];
              if (
                item.type === 'toolUse' &&
                item.card.toolUseId === result.tool_use_id
              ) {
                newContent[i] = {
                  type: 'toolUse',
                  card: { ...item.card, result: resultCard },
                };
                break;
              }
            }
          }

          msgs[msgs.length - 1] = { ...lastMsg, content: newContent };
          return msgs;
        });
        break;
      }

      case 'result': {
        const res = event.event as ClaudeResultEvent;
        receivedResultEventRef.current = true;
        sessionIdRef.current = res.session_id;
        break;
      }
    }
  }, [updateMessages]);

  // Process a single service log event (two-level NDJSON: service wraps Claude)
  const processServiceEvent = useCallback(
    (event: ServiceLogEvent) => {
      switch (event.type) {
        case 'stdout': {
          if (!event.data) return;
          // Use ref to avoid stale closure
          if (statusRef.current === 'connecting') setStatusTracked('streaming');

          let dataStr = stripLogTimestamps(event.data);
          if (!dataStr.endsWith('\n')) dataStr += '\n';

          const events = parserRef.current.parse(dataStr);
          for (const parsed of events) {
            if (parsed.uuid && processedUUIDsRef.current.has(parsed.uuid)) continue;
            if (parsed.uuid) processedUUIDsRef.current.add(parsed.uuid);
            handleEvent(parsed);
          }
          break;
        }
        case 'stderr':
          if (statusRef.current === 'connecting') setStatusTracked('streaming');
          break;
        case 'exit': {
          const remaining = parserRef.current.flush();
          for (const e of remaining) {
            if (e.uuid && processedUUIDsRef.current.has(e.uuid)) continue;
            if (e.uuid) processedUUIDsRef.current.add(e.uuid);
            handleEvent(e);
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
    [handleEvent, setStatusTracked]
  );

  // Send message and start streaming
  const sendMessage = useCallback(
    async (text?: string) => {
      const prompt = (text ?? inputText).trim();
      if (!prompt) return;

      if (!text) setInputText('');

      // Add user message
      const userMessage: ChatMessage = {
        id: makeId(),
        timestamp: Date.now(),
        role: 'user',
        content: [{ type: 'text', text: prompt }],
      };

      // Add assistant placeholder
      const assistantMessage: ChatMessage = {
        id: makeId(),
        timestamp: Date.now(),
        role: 'assistant',
        content: [],
      };

      updateMessages((prev) => [...prev, userMessage, assistantMessage]);

      // Escape prompt for shell
      const escapedPrompt = prompt.replace(/'/g, "'\\''");

      // Build claude command
      const claudeToken = await loadToken('claudeToken');
      const commandParts: string[] = [];

      if (claudeToken) {
        commandParts.push(`export CLAUDE_CODE_OAUTH_TOKEN='${claudeToken}'`);
      }
      commandParts.push('export NO_DNA=1');
      commandParts.push(`mkdir -p ${workingDirectory}`);
      commandParts.push(`cd ${workingDirectory}`);

      let claudeCmd =
        'claude -p --verbose --output-format stream-json --dangerously-skip-permissions';

      const [modelId, maxTurns, customInstructions, gitName, gitEmail] = await Promise.all([
        getSetting('claudeModel'),
        getSetting('maxTurns'),
        getSetting('customInstructions'),
        getSetting('gitName'),
        getSetting('gitEmail'),
      ]);

      claudeCmd += ` --model ${modelId ?? 'sonnet'}`;

      if (maxTurns && maxTurns !== '0') {
        claudeCmd += ` --max-turns ${maxTurns}`;
      }

      if (customInstructions && customInstructions.trim()) {
        const escapedInstructions = customInstructions.replace(/'/g, "'\\''");
        claudeCmd += ` --append-system-prompt '${escapedInstructions}'`;
      }

      if (sessionIdRef.current) {
        claudeCmd += ` --resume ${sessionIdRef.current}`;
      }
      claudeCmd += ` '${escapedPrompt}'`;

      // Configure git identity if set
      if (gitName) {
        const escapedName = gitName.replace(/'/g, "'\\''");
        commandParts.push(`git config --global user.name '${escapedName}'`);
      }
      if (gitEmail) {
        const escapedEmail = gitEmail.replace(/'/g, "'\\''");
        commandParts.push(`git config --global user.email '${escapedEmail}'`);
      }

      // Wrap with heartbeat to keep sprite alive during long API waits
      const wrappedCmd = `{ (while true; do sleep 20; printf . >&2; done) & HBEAT=$!; trap "kill $HBEAT 2>/dev/null" EXIT; ${claudeCmd}; kill $HBEAT 2>/dev/null; }`;
      commandParts.push(wrappedCmd);

      const fullCommand = commandParts.join(' && ');

      // Reset state
      receivedSystemEventRef.current = false;
      receivedResultEventRef.current = false;
      parserRef.current.reset();
      setStatusTracked('connecting');
      setErrorMessage(undefined);

      const abortController = new AbortController();
      abortRef.current = abortController;

      const serviceName = makeClaudeServiceName();
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
      } catch (err: any) {
        if (err.name !== 'AbortError') {
          setErrorMessage(err.message ?? 'Stream error');
        }
      } finally {
        // Flush parser
        const remaining = parserRef.current.flush();
        for (const e of remaining) {
          if (e.uuid && processedUUIDsRef.current.has(e.uuid)) continue;
          if (e.uuid) processedUUIDsRef.current.add(e.uuid);
          handleEvent(e);
        }

        if (abortRef.current === abortController) {
          abortRef.current = null;
        }
        setStatusTracked('idle');
        persistMessages();
      }
    },
    [
      inputText,
      spriteName,
      workingDirectory,
      updateMessages,
      handleEvent,
      processServiceEvent,
      persistMessages,
      setStatusTracked,
    ]
  );

  // Interrupt streaming
  const interrupt = useCallback(() => {
    if (abortRef.current) {
      abortRef.current.abort();
      abortRef.current = null;
    }
    setStatusTracked('idle');

    // Clean up service
    const svcName = serviceNameRef.current;
    api.deleteService(spriteName, svcName).catch(() => {});
  }, [spriteName, setStatusTracked]);

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
    sessionId: sessionIdRef.current,
  };
}
