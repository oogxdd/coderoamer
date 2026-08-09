import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import {
  View,
  Text,
  StyleSheet,
  Pressable,
  FlatList,
  KeyboardAvoidingView,
  Platform,
  ActivityIndicator,
  Alert,
  ScrollView,
  AppState,
} from 'react-native';
import { useLocalSearchParams, router } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Sprite, statusColor, statusDisplayName } from '@/models/sprite';
import {
  AgentEffort,
  AgentProvider,
  ChatMessage,
  effortDisplayName,
  isCodexProvider,
  normalizeAgentEffortForProvider,
  providerDisplayName,
  toolUseActivityLabel,
} from '@/models/chat';
import * as api from '@/services/api';
import { useChat } from '@/hooks/useChat';
import { useChatDictation } from '@/hooks/useChatDictation';
import { useTheme } from '@/hooks/use-theme';
import { ChatMessageView } from '@/components/chat/ChatMessageView';
import { ChatInputBar } from '@/components/chat/ChatInputBar';
import { ChatList } from '@/components/chat/ChatList';
import { ChatListSheet } from '@/components/chat/ChatListSheet';
import { NewSessionSheet, NewSessionConfig } from '@/components/chat/NewSessionSheet';
import { QuickBashSheet } from '@/components/chat/QuickBashSheet';
import { AgentSessionSummary, SessionBrowserSheet } from '@/components/chat/SessionBrowserSheet';
import { listClaudeSessions, readClaudeSessionMessages } from '@/services/claude-sessions';
import { listCodexSessions, readCodexSessionMessages } from '@/services/codex-sessions';
import { CheckpointsList } from '@/components/checkpoints/CheckpointsList';
import { SpriteIntegrationsTab } from '@/components/sprite/SpriteIntegrationsTab';
import { FilesystemTab } from '@/components/filesystem/FilesystemTab';
import { ActiveChatRun, PersistedChat, chatRepository } from '@/services/chat-repository';
import { reconcileActiveRuns } from '@/services/run-reconcile';
import { getSetting } from '@/services/storage';
import { TranscriptionProvider } from '@/services/client-transcription';
import { FontSize, Spacing } from '@/constants/theme';
import { DEFAULT_WORKING_DIRECTORY, normalizeWorkingDirectory } from '@/constants/session';

// The sprite screen is a hub with four tabs. "chats" is the default
// and shows the conversation list; opening a conversation switches to a
// full-screen chat view (tracked by `chatOpen`) that hides the tab bar.
type Tab = 'chats' | 'filesystem' | 'integrations' | 'settings';

function isTab(value: unknown): value is Tab {
  return (
    value === 'chats' ||
    value === 'filesystem' ||
    value === 'integrations' ||
    value === 'settings'
  );
}

interface AgentDefaults {
  provider: AgentProvider;
  claudeModel: string;
  claudeEffort: AgentEffort;
  codexModel: string;
  codexEffort: AgentEffort;
}

const INITIAL_AGENT_DEFAULTS: AgentDefaults = {
  provider: 'claude',
  claudeModel: 'sonnet',
  claudeEffort: 'high',
  codexModel: '',
  codexEffort: 'high',
};

function normalizeProvider(provider: unknown): AgentProvider {
  if (provider === 'codexAppServer') return 'codexAppServer';
  return provider === 'codex' ? 'codex' : 'claude';
}

function normalizeTranscriptionProvider(provider: unknown): TranscriptionProvider {
  if (provider === 'sprite' || provider === 'openai') return provider;
  return 'assemblyai';
}

function defaultModelFor(provider: AgentProvider, defaults: AgentDefaults): string {
  return isCodexProvider(provider) ? defaults.codexModel : defaults.claudeModel;
}

function defaultEffortFor(provider: AgentProvider, defaults: AgentDefaults): AgentEffort {
  return isCodexProvider(provider) ? defaults.codexEffort : defaults.claudeEffort;
}

/** Find the active tool label from the last assistant message's content */
function getActiveToolLabel(
  messages: ChatMessage[],
  workingDirectory: string
): string | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg.role !== 'assistant') continue;
    for (let j = msg.content.length - 1; j >= 0; j--) {
      const item = msg.content[j];
      if (item.type === 'toolUse' && !item.card.result) {
        return toolUseActivityLabel(item.card, workingDirectory);
      }
    }
    break;
  }
  return undefined;
}

export default function SpriteDetailScreen() {
  const { name, tab: initialTab } = useLocalSearchParams<{ name: string; tab?: string }>();
  const colors = useTheme();
  const [tab, setTab] = useState<Tab>(isTab(initialTab) ? initialTab : 'chats');
  // Whether a single conversation is open full-screen (vs. the 3-tab hub).
  const [chatOpen, setChatOpen] = useState(false);
  const [sprite, setSprite] = useState<Sprite | null>(null);
  const [isLoadingSprite, setIsLoadingSprite] = useState(true);
  const flatListRef = useRef<FlatList>(null);

  // Multi-chat state
  const [chatId, setChatId] = useState<string>('');
  const [chatName, setChatName] = useState<string>('Session 1');
  const [chatProvider, setChatProvider] = useState<AgentProvider>('claude');
  const [chatModel, setChatModel] = useState('sonnet');
  const [chatEffort, setChatEffort] = useState<AgentEffort>('high');
  const [claudeSessionId, setClaudeSessionId] = useState<string | undefined>();
  const [codexSessionId, setCodexSessionId] = useState<string | undefined>();
  const [activeRun, setActiveRun] = useState<ActiveChatRun | undefined>();
  const [chatListVisible, setChatListVisible] = useState(false);
  const [quickBashVisible, setQuickBashVisible] = useState(false);
  const [sessionBrowserVisible, setSessionBrowserVisible] = useState(false);
  // Conversations started from the "sprite console" CLI on a computer, discovered
  // by scanning the sprite's Claude/Codex transcripts. Merged into the Chats list.
  const [remoteSessions, setRemoteSessions] = useState<AgentSessionSummary[]>([]);
  const [remoteRefreshing, setRemoteRefreshing] = useState(false);
  const [remoteBusyId, setRemoteBusyId] = useState<string | undefined>();
  // Bumped to force the current chat to reload its persisted messages (e.g. after
  // seeding a resumed session's transcript) even when chatId is unchanged.
  const [reloadNonce, setReloadNonce] = useState(0);
  // null = closed. Chat settings become read-only after the first user message.
  const [sessionSheetMode, setSessionSheetMode] = useState<'new' | 'settings' | null>(null);
  // Reactive mirror of chatListRef so the inline Chats tab re-renders on change.
  const [chatList, setChatList] = useState<PersistedChat[]>([]);
  const chatListRef = useRef<PersistedChat[]>([]);
  const appStateRef = useRef(AppState.currentState);

  // Update both the synchronous ref (read inside callbacks to avoid stale
  // closures) and the reactive state (drives the inline Chats list) together.
  const commitChatList = useCallback((next: PersistedChat[]) => {
    chatListRef.current = next;
    setChatList(next);
  }, []);

  const spriteName = name ?? '';
  const [workingDirectory, setWorkingDirectory] = useState(DEFAULT_WORKING_DIRECTORY);
  const [defaultDirectory, setDefaultDirectory] = useState(DEFAULT_WORKING_DIRECTORY);
  const [agentDefaults, setAgentDefaults] =
    useState<AgentDefaults>(INITIAL_AGENT_DEFAULTS);
  const [transcriptionProvider, setTranscriptionProvider] =
    useState<TranscriptionProvider>('assemblyai');

  // Scan the sprite for CLI-started (console) Claude/Codex conversations so they
  // show up alongside the phone's own chats. Best-effort: failure just leaves the
  // list showing local chats.
  const loadRemoteSessions = useCallback(async () => {
    if (!spriteName) return;
    try {
      const [claudeList, codexList] = await Promise.all([
        listClaudeSessions(spriteName),
        listCodexSessions(spriteName),
      ]);
      setRemoteSessions([
        ...claudeList.map((s) => ({ ...s, provider: 'claude' as const })),
        ...codexList.map((s) => ({ ...s, provider: 'codex' as const })),
      ]);
    } catch {
      // Non-fatal — keep whatever we already have.
    }
  }, [spriteName]);

  const handleRefreshRemote = useCallback(async () => {
    setRemoteRefreshing(true);
    await loadRemoteSessions();
    setRemoteRefreshing(false);
  }, [loadRemoteSessions]);

  // Remote sessions already mirrored by a local chat (same resume id) would show
  // twice — drop those; the local chat is the richer, editable representation.
  const unlinkedRemoteSessions = useMemo(() => {
    const linked = new Set<string>();
    for (const c of chatList) {
      if (c.claudeSessionId) linked.add(c.claudeSessionId);
      if (c.codexSessionId) linked.add(c.codexSessionId);
    }
    return remoteSessions.filter((s) => !linked.has(s.id));
  }, [chatList, remoteSessions]);

  // Refresh the computer-started conversations whenever the list is on screen.
  useEffect(() => {
    if (tab === 'chats' && !chatOpen) loadRemoteSessions();
  }, [tab, chatOpen, loadRemoteSessions]);

  const chat = useChat({
    spriteName,
    chatId,
    workingDirectory,
    provider: chatProvider,
    model: chatModel,
    effort: chatEffort,
    initialClaudeSessionId: claudeSessionId,
    initialCodexSessionId: codexSessionId,
    initialActiveRun: activeRun,
    onSessionIdsChange: (sessionIds) => {
      setClaudeSessionId(sessionIds.claudeSessionId);
      setCodexSessionId(sessionIds.codexSessionId);
      if (!chatId) return;
      const updated = chatListRef.current.map((chatMeta) =>
        chatMeta.id === chatId
          ? {
              ...chatMeta,
              claudeSessionId: sessionIds.claudeSessionId,
              codexSessionId: sessionIds.codexSessionId,
            }
          : chatMeta
      );
      commitChatList(updated);
      chatRepository.updateSessionIds(chatId, {
        claudeSessionId: sessionIds.claudeSessionId,
        codexSessionId: sessionIds.codexSessionId,
      });
    },
    onActiveRunChange: (nextActiveRun) => {
      setActiveRun(nextActiveRun);
      if (!chatId) return;
      const updated = chatListRef.current.map((chatMeta) =>
        chatMeta.id === chatId ? { ...chatMeta, activeRun: nextActiveRun } : chatMeta
      );
      commitChatList(updated);
      chatRepository.setActiveRun(chatId, nextActiveRun ?? undefined);
    },
  });
  const dictation = useChatDictation({
    spriteName,
    workingDirectory,
    inputText: chat.inputText,
    setInputText: chat.setInputText,
    transcriptionProvider,
  });
  const isProviderLocked = chat.messages.some((message) => message.role === 'user');

  // Initialize chat list and current chat on mount
  useEffect(() => {
    let mounted = true;
    (async () => {
      // Drop "Running" flags whose exec session is gone (turn finished while
      // the app was away) before binding chat state, so we don't try to attach
      // to dead runs and the list doesn't show stale spinners.
      await reconcileActiveRuns(spriteName).catch(() => {});
      const [
        chats,
        savedDefaultDir,
        savedTranscriptionProvider,
        savedDefaultProvider,
        savedClaudeModel,
        savedClaudeEffort,
        savedCodexModel,
        savedCodexEffort,
      ] = await Promise.all([
        chatRepository.listBySprite(spriteName),
        getSetting('defaultWorkingDirectory'),
        getSetting('transcriptionProvider'),
        getSetting('defaultProvider'),
        getSetting('claudeModel'),
        getSetting('claudeEffort'),
        getSetting('codexModel'),
        getSetting('codexEffort'),
      ]);
      if (!mounted) return;

      const fallbackDir = savedDefaultDir
        ? normalizeWorkingDirectory(savedDefaultDir)
        : DEFAULT_WORKING_DIRECTORY;
      setDefaultDirectory(fallbackDir);
      setTranscriptionProvider(normalizeTranscriptionProvider(savedTranscriptionProvider));
      const defaults: AgentDefaults = {
        provider: normalizeProvider(savedDefaultProvider),
        claudeModel: savedClaudeModel?.trim() || 'sonnet',
        claudeEffort:
          normalizeAgentEffortForProvider('claude', savedClaudeEffort) ?? 'high',
        codexModel: savedCodexModel?.trim() || '',
        codexEffort:
          normalizeAgentEffortForProvider('codexAppServer', savedCodexEffort) ?? 'high',
      };
      setAgentDefaults(defaults);

      if (chats.length > 0) {
        commitChatList(chats);
        // Point at the most recently used session so the hook can reattach to a
        // still-running exec in the background — but stay on the list (chatOpen
        // is false) so opening a sprite lands on the conversation list.
        const sorted = [...chats].sort((a, b) => b.lastUsed - a.lastUsed);
        const current = sorted[0];
        setChatId(current.id);
        setChatName(current.customName ?? `Session ${current.chatNumber}`);
        setChatProvider(normalizeProvider(current.provider));
        setChatModel(current.model ?? defaultModelFor(current.provider, defaults));
        setChatEffort(current.effort ?? defaultEffortFor(current.provider, defaults));
        setClaudeSessionId(current.claudeSessionId);
        setCodexSessionId(current.codexSessionId);
        setActiveRun(current.activeRun);
        setWorkingDirectory(current.workingDirectory || fallbackDir);
      } else {
        const defaultProvider = defaults.provider;
        // Create the first chat
        const firstChat: PersistedChat = {
          id: `${spriteName}-chat-1`,
          spriteName,
          chatNumber: 1,
          provider: defaultProvider,
          model: defaultModelFor(defaultProvider, defaults),
          effort: defaultEffortFor(defaultProvider, defaults),
          workingDirectory: fallbackDir,
          createdAt: Date.now(),
          lastUsed: Date.now(),
          isClosed: false,
          lastSessionComplete: true,
          processedEventUUIDs: [],
        };
        commitChatList([firstChat]);
        await chatRepository.upsert(firstChat);
        setChatId(firstChat.id);
        setChatName('Session 1');
        setChatProvider(defaultProvider);
        setChatModel(firstChat.model ?? 'sonnet');
        setChatEffort(firstChat.effort ?? 'high');
        setClaudeSessionId(undefined);
        setCodexSessionId(undefined);
        setActiveRun(undefined);
        setWorkingDirectory(fallbackDir);
      }
    })();
    return () => { mounted = false; };
  }, [spriteName, commitChatList]);

  // Load sprite info
  useEffect(() => {
    let mounted = true;
    (async () => {
      try {
        const s = await api.getSprite(spriteName);
        if (mounted) setSprite(s);
      } catch {}
      if (mounted) setIsLoadingSprite(false);
    })();
    return () => { mounted = false; };
  }, [spriteName]);

  // Old builds ran chat turns as persistent `wisp-*` services. Clean those up
  // when the sprite opens so they cannot restart and replay prompts into Claude.
  useEffect(() => {
    if (!spriteName) return;
    api.cleanupLegacyChatServices(spriteName).catch(() => {});
  }, [spriteName]);

  // Load chat session when chatId changes (or when forced via reloadNonce).
  useEffect(() => {
    if (chatId) {
      chat.loadSession();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chatId, reloadNonce]);

  // On leaving the sprite screen, detach any live stream (the exec keeps
  // running; reopening the chat reattaches) and stop pending reconnects.
  const detachStreamRef = useRef(chat.detachStream);
  detachStreamRef.current = chat.detachStream;
  useEffect(() => {
    return () => {
      detachStreamRef.current();
    };
  }, []);

  // Re-sync the current chat whenever the app returns from the background or lock screen.
  // The hook will reattach to a still-running exec session, or merge the on-disk transcript
  // if the agent finished while the app was suspended.
  useEffect(() => {
    const subscription = AppState.addEventListener('change', (nextState) => {
      const wasAway =
        appStateRef.current === 'inactive' || appStateRef.current === 'background';
      appStateRef.current = nextState;
      if (nextState === 'active' && wasAway && chatId) {
        (async () => {
          const cleared = await reconcileActiveRuns(spriteName).catch(() => [] as string[]);
          if (cleared.length > 0) {
            commitChatList(
              chatListRef.current.map((c) =>
                cleared.includes(c.id) ? { ...c, activeRun: undefined } : c
              )
            );
            if (cleared.includes(chatId)) setActiveRun(undefined);
          }
          setReloadNonce((n) => n + 1);
        })();
      }
    });

    return () => subscription.remove();
  }, [chatId, commitChatList, spriteName]);

  // Auto-scroll on new messages
  useEffect(() => {
    if (chat.messages.length > 0) {
      setTimeout(() => {
        flatListRef.current?.scrollToEnd({ animated: true });
      }, 100);
    }
  }, [chat.messages.length, chat.messages[chat.messages.length - 1]?.content.length]);

  // Update chat list with first message preview when messages change
  useEffect(() => {
    if (chatId && chat.messages.length > 0) {
      const firstUserMsg = chat.messages.find((m) => m.role === 'user');
      if (firstUserMsg) {
        const preview = firstUserMsg.content
          .filter((c): c is { type: 'text'; text: string } => c.type === 'text')
          .map((c) => c.text)
          .join(' ')
          .slice(0, 100);

        const updated = chatListRef.current.map((c) =>
          c.id === chatId
            ? { ...c, lastUsed: Date.now(), firstMessagePreview: preview || c.firstMessagePreview }
            : c
        );
        commitChatList(updated);
        chatRepository.patch(chatId, {
          lastUsed: Date.now(),
          firstMessagePreview: preview || undefined,
        });
      }
    }
  }, [chat.messages.length, chatId, commitChatList]);

  const handleSend = () => {
    chat.sendMessage();
  };

  // One-tap recovery when a turn ended on --max-turns.
  const handleContinueTurn = useCallback(() => {
    chat.sendMessage('Continue where you left off.');
  }, [chat.sendMessage]);

  const createChat = useCallback(async (config: NewSessionConfig) => {
    // One useChat instance is shared across sessions. Detach the local stream
    // before switching so the remote exec can keep running and be reattached later.
    if (chat.isStreaming) chat.detachStream();
    const chats = chatListRef.current;
    const maxNumber = chats.reduce((max, c) => Math.max(max, c.chatNumber), 0);
    const newNumber = maxNumber + 1;
    const dir = normalizeWorkingDirectory(config.workingDirectory);
    const newChat: PersistedChat = {
      id: `${spriteName}-chat-${newNumber}`,
      spriteName,
      chatNumber: newNumber,
      provider: config.provider,
      model: config.model || undefined,
      effort: config.effort,
      workingDirectory: dir,
      createdAt: Date.now(),
      lastUsed: Date.now(),
      isClosed: false,
      lastSessionComplete: true,
      processedEventUUIDs: [],
    };
    commitChatList([...chats, newChat]);
    await chatRepository.upsert(newChat);
    setChatId(newChat.id);
    setChatName(`Session ${newNumber}`);
    setChatProvider(config.provider);
    setChatModel(config.model);
    setChatEffort(config.effort);
    setWorkingDirectory(dir);
    setClaudeSessionId(undefined);
    setCodexSessionId(undefined);
    setActiveRun(undefined);
    setChatListVisible(false);
    setSessionSheetMode(null);
    // Adding a conversation opens it.
    setTab('chats');
    setChatOpen(true);
  }, [chat.detachStream, chat.isStreaming, spriteName, commitChatList]);

  // Change the current session configuration before its first message.
  const updateCurrentSettings = useCallback(async (config: NewSessionConfig) => {
    if (isProviderLocked) {
      setSessionSheetMode(null);
      return;
    }
    const dir = normalizeWorkingDirectory(config.workingDirectory);
    setWorkingDirectory(dir);
    setChatProvider(config.provider);
    setChatModel(config.model);
    setChatEffort(config.effort);
    const updated = chatListRef.current.map((c) =>
      c.id === chatId
        ? {
            ...c,
            workingDirectory: dir,
            provider: config.provider,
            model: config.model || undefined,
            effort: config.effort,
          }
        : c
    );
    commitChatList(updated);
    await chatRepository.patch(chatId, {
      workingDirectory: dir,
      provider: config.provider,
      model: config.model || undefined,
      effort: config.effort,
    });
    setSessionSheetMode(null);
  }, [chatId, commitChatList, isProviderLocked]);

  const handleSelectChat = useCallback((selectedChat: PersistedChat) => {
    const latestChat = chatListRef.current.find((c) => c.id === selectedChat.id) ?? selectedChat;
    if (latestChat.id === chatId) {
      setReloadNonce((n) => n + 1);
      setChatListVisible(false);
      setChatOpen(true);
      return;
    }
    // One useChat instance is shared across sessions, so detach any in-flight stream
    // before switching. The exec stays alive and is reattached when its chat reopens.
    if (chat.isStreaming) chat.detachStream();
    setChatId(latestChat.id);
    setChatName(latestChat.customName ?? `Session ${latestChat.chatNumber}`);
    const nextProvider = normalizeProvider(latestChat.provider);
    setChatProvider(nextProvider);
    setChatModel(latestChat.model ?? defaultModelFor(nextProvider, agentDefaults));
    setChatEffort(latestChat.effort ?? defaultEffortFor(nextProvider, agentDefaults));
    setClaudeSessionId(latestChat.claudeSessionId);
    setCodexSessionId(latestChat.codexSessionId);
    setActiveRun(latestChat.activeRun);
    setWorkingDirectory(latestChat.workingDirectory || defaultDirectory);
    setReloadNonce((n) => n + 1);
    // Update lastUsed
    const updated = chatListRef.current.map((c) =>
      c.id === latestChat.id ? { ...c, lastUsed: Date.now() } : c
    );
    commitChatList(updated);
    chatRepository.patch(latestChat.id, { lastUsed: Date.now() });
    setChatListVisible(false);
    setChatOpen(true);
  }, [agentDefaults, chat.detachStream, chat.isStreaming, chatId, defaultDirectory, commitChatList]);

  const handleDeleteChat = useCallback((target: PersistedChat) => {
    const remaining = chatListRef.current.filter((c) => c.id !== target.id);
    commitChatList(remaining);
    chatRepository.remove(target.id);
    if (target.id !== chatId) return;
    // The current chat was deleted; detach any live stream and fall back to the
    // most recent remaining conversation (or nothing, which shows the empty list).
    if (chat.isStreaming) chat.detachStream();
    if (remaining.length > 0) {
      const next = [...remaining].sort((a, b) => b.lastUsed - a.lastUsed)[0];
      const nextProvider = normalizeProvider(next.provider);
      setChatId(next.id);
      setChatName(next.customName ?? `Session ${next.chatNumber}`);
      setChatProvider(nextProvider);
      setChatModel(next.model ?? defaultModelFor(nextProvider, agentDefaults));
      setChatEffort(next.effort ?? defaultEffortFor(nextProvider, agentDefaults));
      setClaudeSessionId(next.claudeSessionId);
      setCodexSessionId(next.codexSessionId);
      setActiveRun(next.activeRun);
      setWorkingDirectory(next.workingDirectory || defaultDirectory);
      setReloadNonce((n) => n + 1);
    } else {
      setChatId('');
    }
    setChatOpen(false);
  }, [agentDefaults, chat.detachStream, chat.isStreaming, chatId, defaultDirectory, commitChatList]);

  // Resume a session discovered on the sprite (its on-disk transcript).
  // Reuses an existing local chat bound to the same session id, or creates one,
  // seeds it with the rendered transcript, and points the chat at provider-specific
  // resume id with the session's original cwd when available.
  const handleResumeSession = useCallback(
    async (session: AgentSessionSummary, messages: ChatMessage[]) => {
      if (chat.isStreaming) chat.detachStream();
      const dir = normalizeWorkingDirectory(session.cwd || defaultDirectory);
      const chats = chatListRef.current;
      const existing = chats.find((c) =>
        isCodexProvider(session.provider)
          ? isCodexProvider(c.provider) && c.codexSessionId === session.id
          : c.provider === 'claude' && c.claudeSessionId === session.id
      );

      let target: PersistedChat;
      if (existing) {
        target = {
          ...existing,
          provider: existing.provider,
          claudeSessionId: session.provider === 'claude' ? session.id : existing.claudeSessionId,
          codexSessionId: isCodexProvider(session.provider) ? session.id : existing.codexSessionId,
          workingDirectory: dir,
          lastUsed: Date.now(),
        };
      } else {
        const maxNumber = chats.reduce((max, c) => Math.max(max, c.chatNumber), 0);
        const importedProvider: AgentProvider =
          session.provider === 'claude' ? 'claude' : 'codexAppServer';
        target = {
          id: `${spriteName}-chat-${maxNumber + 1}`,
          spriteName,
          chatNumber: maxNumber + 1,
          provider: importedProvider,
          model: defaultModelFor(importedProvider, agentDefaults),
          effort: defaultEffortFor(importedProvider, agentDefaults),
          claudeSessionId: session.provider === 'claude' ? session.id : undefined,
          codexSessionId: isCodexProvider(session.provider) ? session.id : undefined,
          workingDirectory: dir,
          createdAt: Date.now(),
          lastUsed: Date.now(),
          isClosed: false,
          lastSessionComplete: true,
          processedEventUUIDs: [],
          firstMessagePreview: session.preview ? session.preview.slice(0, 100) : undefined,
        };
      }

      const updated = existing
        ? chats.map((c) => (c.id === target.id ? target : c))
        : [...chats, target];
      commitChatList(updated);
      await chatRepository.upsert(target);
      await chatRepository.setMessages(target.id, messages);

      setChatProvider(target.provider);
      setChatModel(target.model ?? defaultModelFor(target.provider, agentDefaults));
      setChatEffort(target.effort ?? defaultEffortFor(target.provider, agentDefaults));
      setClaudeSessionId(session.provider === 'claude' ? session.id : target.claudeSessionId);
      setCodexSessionId(isCodexProvider(session.provider) ? session.id : target.codexSessionId);
      setActiveRun(undefined);
      setWorkingDirectory(dir);
      setChatName(target.customName ?? `Session ${target.chatNumber}`);
      setChatId(target.id);
      setSessionBrowserVisible(false);
      setTab('chats');
      setChatOpen(true);
      // Force a reload even if chatId didn't change (resuming the open chat).
      setReloadNonce((n) => n + 1);
    },
    [agentDefaults, chat.detachStream, chat.isStreaming, defaultDirectory, spriteName, commitChatList]
  );

  // Tapping a computer-started conversation in the list: pull its transcript, then
  // resume it in the chat UI (same path as the session browser's "Continue").
  const handleOpenRemoteSession = useCallback(
    async (session: AgentSessionSummary) => {
      setRemoteBusyId(session.id);
      try {
        const messages =
          session.provider === 'codex'
            ? await readCodexSessionMessages(spriteName, session.id)
            : await readClaudeSessionMessages(spriteName, session.id);
        await handleResumeSession(session, messages);
      } catch (e: any) {
        Alert.alert('Could not open session', e?.message ?? 'Failed to load transcript.');
      } finally {
        setRemoteBusyId(undefined);
      }
    },
    [spriteName, handleResumeSession]
  );

  const handleProviderChange = useCallback((nextProvider: AgentProvider) => {
    if (!chatId || chat.isStreaming || isProviderLocked) return;
    setChatProvider(nextProvider);
    const nextModel = defaultModelFor(nextProvider, agentDefaults);
    const nextEffort = defaultEffortFor(nextProvider, agentDefaults);
    setChatModel(nextModel);
    setChatEffort(nextEffort);
    const updated = chatListRef.current.map((c) =>
      c.id === chatId
        ? { ...c, provider: nextProvider, model: nextModel || undefined, effort: nextEffort }
        : c
    );
    commitChatList(updated);
    chatRepository.patch(chatId, {
      provider: nextProvider,
      model: nextModel || undefined,
      effort: nextEffort,
    });
  }, [agentDefaults, chat.isStreaming, chatId, isProviderLocked, commitChatList]);

  useEffect(() => {
    if (!chat.codexAuthIssue) return;
    const isLocked = isProviderLocked;
    Alert.alert(
      'Codex Authentication Required',
      isLocked
        ? `${chat.codexAuthIssue}\n\nThis session is locked to Codex. Start a new Claude session now?`
        : `${chat.codexAuthIssue}\n\nSwitch this session to Claude now?`,
      [
        {
          text: 'Cancel',
          style: 'cancel',
          onPress: () => chat.clearCodexAuthIssue(),
        },
        {
          text: isLocked ? 'New Claude Session' : 'Switch to Claude',
          onPress: () => {
            if (isLocked) {
              createChat({
                workingDirectory,
                provider: 'claude',
                model: agentDefaults.claudeModel,
                effort: agentDefaults.claudeEffort,
              });
            } else {
              handleProviderChange('claude');
            }
            chat.clearCodexAuthIssue();
          },
        },
      ]
    );
  }, [agentDefaults, chat.codexAuthIssue, chat.clearCodexAuthIssue, createChat, handleProviderChange, isProviderLocked, workingDirectory]);

  const handleInsertBashOutput = useCallback((text: string) => {
    chat.setInputText((prev: string) => (prev ? prev + '\n' + text : text));
  }, [chat.setInputText]);

  // Active tool label for the chat view
  const activeToolLabel = chat.isStreaming
    ? getActiveToolLabel(chat.messages, workingDirectory)
    : undefined;

  const tabItems: { key: Tab; label: string }[] = [
    { key: 'chats', label: 'Chats' },
    { key: 'filesystem', label: 'Files' },
    { key: 'integrations', label: 'Integrations' },
    { key: 'settings', label: 'Settings' },
  ];

  return (
    <SafeAreaView style={[styles.container, { backgroundColor: colors.background }]} edges={['top']}>
      {/* Header */}
      <View style={[styles.header, { borderBottomColor: colors.border }]}>
        <Pressable onPress={() => (chatOpen ? setChatOpen(false) : router.back())} hitSlop={12}>
          <Text style={[styles.backButton, { color: colors.tint }]}>
            &#x2039; {chatOpen ? 'Chats' : 'Back'}
          </Text>
        </Pressable>
        <View style={styles.headerCenter}>
          {chatOpen ? (
            <>
              <Pressable onPress={() => setChatListVisible(true)} hitSlop={6}>
                <Text style={[styles.headerTitle, { color: colors.text }]} numberOfLines={1}>
                  {chatName} ▾
                </Text>
              </Pressable>
              <Text style={[styles.chatSubtitle, { color: colors.textSecondary }]} numberOfLines={1}>
                {providerDisplayName(chatProvider)} · {chatModel || 'Default'} ·{' '}
                {effortDisplayName(chatEffort)}
              </Text>
            </>
          ) : (
            <>
              <Text style={[styles.headerTitle, { color: colors.text }]} numberOfLines={1}>
                {spriteName}
              </Text>
              {sprite && (
                <View style={styles.statusRow}>
                  <View
                    style={[styles.statusDot, { backgroundColor: statusColor(sprite.status) }]}
                  />
                  <Text style={[styles.statusText, { color: colors.textSecondary }]}>
                    {statusDisplayName(sprite.status)}
                  </Text>
                </View>
              )}
            </>
          )}
        </View>
        <View style={styles.headerRight}>
          {chatOpen ? (
            <Pressable
              onPress={() => setSessionSheetMode('settings')}
              hitSlop={10}
              accessibilityRole="button"
              accessibilityLabel="Chat settings"
            >
              <Text style={[styles.headerActionMore, { color: colors.tint }]}>•••</Text>
            </Pressable>
          ) : (
            <Pressable onPress={() => setSessionSheetMode('new')} hitSlop={8}>
              <Text style={[styles.headerActionAdd, { color: colors.tint }]}>＋</Text>
            </Pressable>
          )}
        </View>
      </View>

      {/* Tab Bar (hub only) */}
      {!chatOpen && (
        <View style={[styles.tabBar, { backgroundColor: colors.backgroundSecondary, borderBottomColor: colors.border }]}>
          {tabItems.map((t) => (
            <Pressable
              key={t.key}
              style={[
                styles.tab,
                tab === t.key && { borderBottomColor: colors.tint, borderBottomWidth: 2 },
              ]}
              onPress={() => setTab(t.key)}
            >
              <Text
                style={[
                  styles.tabText,
                  { color: tab === t.key ? colors.tint : colors.textSecondary },
                ]}
              >
                {t.label}
              </Text>
            </Pressable>
          ))}
        </View>
      )}

      {/* Active tool label below header (chat view only) */}
      {chatOpen && activeToolLabel && (
        <View style={[styles.activeToolBar, { backgroundColor: colors.backgroundSecondary, borderBottomColor: colors.border }]}>
          <ActivityIndicator size="small" color={colors.tint} />
          <Text style={[styles.activeToolText, { color: colors.textSecondary }]} numberOfLines={1}>
            {activeToolLabel}
          </Text>
        </View>
      )}

      {/* Content */}
      {chatOpen ? (
        <KeyboardAvoidingView
          style={styles.flex}
          behavior={Platform.OS === 'ios' ? 'padding' : undefined}
          keyboardVerticalOffset={0}
        >
          <FlatList
            ref={flatListRef}
            data={chat.messages}
            renderItem={({ item, index }) => (
              <ChatMessageView
                message={item}
                workingDirectory={workingDirectory}
                isCurrentlyStreaming={
                  chat.isStreaming &&
                  index === chat.messages.length - 1 &&
                  item.role === 'assistant'
                }
                showTurnActions={index === chat.messages.length - 1 && !chat.isStreaming}
                onContinueTurn={handleContinueTurn}
              />
            )}
            keyExtractor={(item) => item.id}
            contentContainerStyle={styles.chatContent}
            ListEmptyComponent={
              chat.sessionId && chat.messages.length === 0 ? (
                <View style={styles.emptyChatView}>
                  <ActivityIndicator size="small" color={colors.tint} style={{ marginBottom: Spacing.sm }} />
                  <Text style={[styles.emptyChatSubtitle, { color: colors.textSecondary }]}>
                    Resuming previous session...
                  </Text>
                </View>
              ) : (
                <View style={styles.emptyChatView}>
                  <Text style={[styles.emptyChatTitle, { color: colors.text }]}>
                    Chat with {providerDisplayName(chatProvider)}
                  </Text>
                  <Text style={[styles.emptyChatSubtitle, { color: colors.textSecondary }]}>
                    Send a message to start this coding session on the sprite.
                  </Text>
                  <Pressable
                    style={[
                      styles.cwdChip,
                      { borderColor: colors.border, backgroundColor: colors.backgroundElement },
                    ]}
                    onPress={() => setSessionSheetMode('settings')}
                  >
                    <Text
                      style={[styles.cwdChipText, { color: colors.textSecondary }]}
                      numberOfLines={1}
                    >
                      📁 {workingDirectory}  ✎
                    </Text>
                  </Pressable>
                </View>
              )
            }
          />
          {chat.isStreaming && (chat.status === 'connecting' || chat.status === 'reconnecting') && (
            <View style={styles.connectingBar}>
              <ActivityIndicator size="small" color={colors.tint} />
              <Text style={[styles.connectingText, { color: colors.textSecondary }]}>
                {chat.status === 'reconnecting' ? 'Reconnecting to' : 'Connecting to'} {providerDisplayName(chatProvider)}...
              </Text>
            </View>
          )}
          {chat.queuedPrompts.length > 0 && (
            <View style={styles.queuedBar}>
              {chat.queuedPrompts.map((q) => (
                <View
                  key={q.id}
                  style={[
                    styles.queuedChip,
                    { borderColor: colors.border, backgroundColor: colors.backgroundElement },
                  ]}
                >
                  <Pressable
                    style={styles.queuedChipBody}
                    onPress={() => chat.sendQueuedNow(q.id)}
                    disabled={chat.isStreaming}
                  >
                    <Text
                      style={[styles.queuedChipText, { color: colors.textSecondary }]}
                      numberOfLines={1}
                    >
                      ⏳ {q.text}
                    </Text>
                  </Pressable>
                  <Pressable hitSlop={8} onPress={() => chat.removeQueuedPrompt(q.id)}>
                    <Text style={[styles.queuedChipRemove, { color: colors.textSecondary }]}>✕</Text>
                  </Pressable>
                </View>
              ))}
            </View>
          )}
          {chat.errorMessage && (
            <View style={[styles.errorBar, { backgroundColor: colors.destructive + '15' }]}>
              <Text style={[styles.errorBarText, { color: colors.destructive }]}>
                {chat.errorMessage}
              </Text>
              {chat.failedSend && (
                <Pressable
                  style={[styles.retryButton, { borderColor: colors.destructive }]}
                  onPress={chat.retryFailedSend}
                  hitSlop={8}
                >
                  <Text style={[styles.retryButtonText, { color: colors.destructive }]}>
                    Retry send
                  </Text>
                </Pressable>
              )}
            </View>
          )}
          <ChatInputBar
            value={chat.inputText}
            onChangeText={chat.setInputText}
            onSend={handleSend}
            onInterrupt={chat.interrupt}
            isStreaming={chat.isStreaming}
            disabled={dictation.isTranscribing}
            provider={chatProvider}
            onToggleDictation={dictation.toggleSpriteRecording}
            isDictating={dictation.isSpriteRecording}
            isTranscribing={dictation.isTranscribing}
            dictationStatus={dictation.status}
            dictationError={dictation.error}
            onClearDictationError={dictation.clearDictationError}
          />
        </KeyboardAvoidingView>
      ) : (
        <>
          {tab === 'chats' && (
            <ChatList
              chats={chatList}
              currentChatId={chatId}
              onSelectChat={handleSelectChat}
              onDeleteChat={handleDeleteChat}
              remoteSessions={unlinkedRemoteSessions}
              onSelectRemote={handleOpenRemoteSession}
              remoteBusyId={remoteBusyId}
              onRefresh={handleRefreshRemote}
              refreshing={remoteRefreshing}
            />
          )}

          {tab === 'filesystem' && (
            <FilesystemTab spriteName={spriteName} workingDirectory={workingDirectory} />
          )}

          {tab === 'integrations' && (
            <SpriteIntegrationsTab spriteName={spriteName} isActive={tab === 'integrations'} />
          )}

          {tab === 'settings' && (
            <SettingsTab
              sprite={sprite}
              isLoading={isLoadingSprite}
              spriteName={spriteName}
              workingDirectory={workingDirectory}
              isActive={tab === 'settings'}
              onSpriteUpdated={setSprite}
              onQuickBash={() => setQuickBashVisible(true)}
              onBrowseSessions={() => setSessionBrowserVisible(true)}
            />
          )}
        </>
      )}

      {/* Chat List Sheet (in-chat quick switch) */}
      {chatListVisible && (
        <ChatListSheet
          spriteName={spriteName}
          currentChatId={chatId}
          chats={chatList}
          onSelectChat={handleSelectChat}
          onNewChat={() => {
            setChatListVisible(false);
            setSessionSheetMode('new');
          }}
          onClose={() => setChatListVisible(false)}
        />
      )}

      {/* New Session / Edit Directory Sheet */}
      {sessionSheetMode && (
        <NewSessionSheet
          spriteName={spriteName}
          title={sessionSheetMode === 'settings' ? 'Chat Settings' : 'New Session'}
          confirmLabel={sessionSheetMode === 'settings' ? 'Save Settings' : 'Start Session'}
          defaultDirectory={
            sessionSheetMode === 'settings' ? workingDirectory : defaultDirectory
          }
          defaultProvider={
            sessionSheetMode === 'settings' ? chatProvider : agentDefaults.provider
          }
          defaultModel={
            sessionSheetMode === 'settings'
              ? chatModel
              : defaultModelFor(agentDefaults.provider, agentDefaults)
          }
          defaultEffort={
            sessionSheetMode === 'settings'
              ? chatEffort
              : defaultEffortFor(agentDefaults.provider, agentDefaults)
          }
          defaultClaudeModel={agentDefaults.claudeModel}
          defaultClaudeEffort={agentDefaults.claudeEffort}
          defaultCodexModel={agentDefaults.codexModel}
          defaultCodexEffort={agentDefaults.codexEffort}
          showProviderPicker
          locked={sessionSheetMode === 'settings' && isProviderLocked}
          onClose={() => setSessionSheetMode(null)}
          onCreate={sessionSheetMode === 'settings' ? updateCurrentSettings : createChat}
        />
      )}

      {/* Quick Bash Sheet */}
      {quickBashVisible && (
        <QuickBashSheet
          spriteName={spriteName}
          onInsertIntoChat={handleInsertBashOutput}
          onClose={() => setQuickBashVisible(false)}
        />
      )}

      {/* Session Browser (resume Claude/Codex sessions from the sprite's transcripts) */}
      {sessionBrowserVisible && (
        <SessionBrowserSheet
          spriteName={spriteName}
          onResume={handleResumeSession}
          onClose={() => setSessionBrowserVisible(false)}
        />
      )}
    </SafeAreaView>
  );
}

/** A tappable card row used in sprite settings. */
function ConnectRow({
  title,
  subtitle,
  onPress,
  muted,
}: {
  title: string;
  subtitle: string;
  onPress: () => void;
  muted?: boolean;
}) {
  const colors = useTheme();
  return (
    <Pressable
      style={({ pressed }) => [
        styles.connectRow,
        { backgroundColor: colors.card, borderColor: colors.border, opacity: pressed ? 0.7 : 1 },
      ]}
      onPress={onPress}
    >
      <View style={styles.connectRowText}>
        <Text style={[styles.connectTitle, { color: muted ? colors.textSecondary : colors.text }]}>
          {title}
        </Text>
        <Text style={[styles.connectSubtitle, { color: colors.textSecondary }]}>{subtitle}</Text>
      </View>
      <Text style={[styles.connectChevron, { color: colors.tint }]}>›</Text>
    </Pressable>
  );
}

type SettingsView = 'menu' | 'checkpoints';

// Settings Tab — checkpoints, sprite info, and delete. A lightweight sub-view
// keeps the checkpoints scroller isolated and leaves room for more settings later.
function SettingsTab({
  sprite,
  isLoading,
  spriteName,
  workingDirectory,
  isActive,
  onSpriteUpdated,
  onQuickBash,
  onBrowseSessions,
}: {
  sprite: Sprite | null;
  isLoading: boolean;
  spriteName: string;
  workingDirectory: string;
  isActive: boolean;
  onSpriteUpdated: (sprite: Sprite) => void;
  onQuickBash: () => void;
  onBrowseSessions: () => void;
}) {
  const colors = useTheme();
  const [view, setView] = useState<SettingsView>('menu');
  const [isDeleting, setIsDeleting] = useState(false);

  // Poll sprite status every 5 seconds while the Settings menu is showing.
  useEffect(() => {
    if (!isActive || view !== 'menu') return;
    const interval = setInterval(async () => {
      try {
        const s = await api.getSprite(spriteName);
        onSpriteUpdated(s);
      } catch {}
    }, 5000);
    return () => clearInterval(interval);
  }, [isActive, view, spriteName, onSpriteUpdated]);

  const handleDelete = () => {
    Alert.alert(
      'Delete Sprite',
      `Are you sure you want to delete "${spriteName}"? This action cannot be undone.`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Delete',
          style: 'destructive',
          onPress: async () => {
            setIsDeleting(true);
            try {
              await api.deleteSprite(spriteName);
              router.back();
            } catch (err: any) {
              Alert.alert('Error', err.message ?? 'Failed to delete sprite');
              setIsDeleting(false);
            }
          },
        },
      ]
    );
  };

  if (view === 'checkpoints') {
    return (
      <SettingsSubView title="Checkpoints" onBack={() => setView('menu')}>
        <CheckpointsList spriteName={spriteName} />
      </SettingsSubView>
    );
  }

  if (isLoading) {
    return (
      <View style={styles.centerView}>
        <ActivityIndicator size="large" color={colors.tint} />
      </View>
    );
  }

  const infoRows: { label: string; value: string }[] = [];
  if (sprite) {
    infoRows.push(
      { label: 'Name', value: sprite.name },
      { label: 'Status', value: statusDisplayName(sprite.status) },
      { label: 'ID', value: sprite.id }
    );
    if (sprite.url) infoRows.push({ label: 'URL', value: sprite.url });
    if (sprite.created_at) {
      infoRows.push({ label: 'Created', value: new Date(sprite.created_at).toLocaleString() });
    }
    if (sprite.url_settings) infoRows.push({ label: 'Auth', value: sprite.url_settings.auth });
  }
  infoRows.push({ label: 'Work Dir', value: workingDirectory });

  return (
    <ScrollView style={styles.tabScroll} contentContainerStyle={styles.tabScrollContent}>
      <Text style={[styles.sectionHeader, { color: colors.textSecondary }]}>TOOLS</Text>
      <ConnectRow
        title="Fast bash exec"
        subtitle="Run a one-off command and insert its output into the chat composer."
        onPress={onQuickBash}
      />
      <ConnectRow
        title="Previous agent sessions"
        subtitle="Browse on-sprite Claude and Codex transcripts and continue one in chat."
        onPress={onBrowseSessions}
      />
      <ConnectRow
        title="Interactive terminal"
        subtitle="Open a real TTY over the Exec WebSocket."
        onPress={() =>
          router.push({
            pathname: '/(app)/exec-poc',
            params: { name: spriteName, cwd: workingDirectory, engine: 'next-term' },
          })
        }
      />
      <ConnectRow
        title="Web terminal · legacy"
        subtitle="Open ttyd in a WebView. This may make the sprite URL public."
        muted
        onPress={() =>
          router.push({
            pathname: '/(app)/ttyd-terminal',
            params: { name: spriteName, cwd: workingDirectory },
          })
        }
      />

      <Text style={[styles.sectionHeader, { color: colors.textSecondary }]}>CONFIGURATION</Text>
      <ConnectRow
        title="Checkpoints"
        subtitle="Create and restore filesystem checkpoints for this sprite."
        onPress={() => setView('checkpoints')}
      />
      {!sprite ? (
        <Text style={[styles.errorBarText, { color: colors.destructive, marginTop: Spacing.lg }]}>
          Failed to load sprite info
        </Text>
      ) : (
        <>
          <Text style={[styles.sectionHeader, { color: colors.textSecondary }]}>SPRITE INFO</Text>
          {infoRows.map((row) => (
            <View key={row.label} style={[styles.infoRow, { borderBottomColor: colors.border }]}>
              <Text style={[styles.infoLabel, { color: colors.textSecondary }]}>{row.label}</Text>
              <Text
                style={[styles.infoValue, { color: colors.text }]}
                numberOfLines={1}
                selectable
              >
                {row.value}
              </Text>
            </View>
          ))}
        </>
      )}

      <View style={styles.deleteButtonContainer}>
        <Pressable
          style={[styles.deleteButton, { borderColor: colors.destructive }]}
          onPress={handleDelete}
          disabled={isDeleting}
        >
          {isDeleting ? (
            <ActivityIndicator size="small" color={colors.destructive} />
          ) : (
            <Text style={[styles.deleteButtonText, { color: colors.destructive }]}>
              Delete Sprite
            </Text>
          )}
        </Pressable>
      </View>
    </ScrollView>
  );
}

// Full-height settings sub-screen with an in-tab back to the menu.
function SettingsSubView({
  title,
  onBack,
  children,
}: {
  title: string;
  onBack: () => void;
  children: React.ReactNode;
}) {
  const colors = useTheme();
  return (
    <View style={styles.flex}>
      <View style={[styles.subHeader, { borderBottomColor: colors.border }]}>
        <Pressable onPress={onBack} hitSlop={12}>
          <Text style={[styles.subBack, { color: colors.tint }]}>&#x2039; Settings</Text>
        </Pressable>
        <Text style={[styles.subTitle, { color: colors.text }]}>{title}</Text>
        <View style={styles.subHeaderSpacer} />
      </View>
      <View style={styles.flex}>{children}</View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  flex: {
    flex: 1,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: Spacing.lg,
    paddingVertical: Spacing.sm,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  backButton: {
    fontSize: FontSize.xl,
    fontWeight: '400',
    width: 70,
  },
  headerCenter: {
    flex: 1,
    alignItems: 'center',
  },
  headerTitle: {
    fontSize: FontSize.lg,
    fontWeight: '600',
  },
  chatSubtitle: {
    fontSize: FontSize.xs,
    marginTop: 2,
  },
  headerRight: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    alignItems: 'center',
    gap: Spacing.sm,
    width: 70,
  },
  headerActionAdd: {
    fontSize: 26,
    fontWeight: '400',
  },
  headerActionMore: {
    fontSize: FontSize.md,
    fontWeight: '800',
    letterSpacing: 1,
  },
  statusRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    marginTop: 2,
  },
  statusDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
  },
  statusText: {
    fontSize: FontSize.xs,
  },
  tabBar: {
    flexDirection: 'row',
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  tab: {
    flex: 1,
    alignItems: 'center',
    paddingVertical: Spacing.md,
  },
  tabText: {
    fontSize: FontSize.sm,
    fontWeight: '600',
  },
  chatContent: {
    flexGrow: 1,
    paddingVertical: Spacing.sm,
  },
  emptyChatView: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    paddingVertical: 80,
    paddingHorizontal: Spacing.xxl,
  },
  emptyChatTitle: {
    fontSize: FontSize.xl,
    fontWeight: '600',
    marginBottom: Spacing.sm,
  },
  emptyChatSubtitle: {
    fontSize: FontSize.md,
    textAlign: 'center',
    lineHeight: 22,
  },
  cwdChip: {
    marginTop: Spacing.lg,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 8,
    paddingHorizontal: Spacing.md,
    paddingVertical: Spacing.sm,
    maxWidth: '90%',
  },
  cwdChipText: {
    fontSize: FontSize.sm,
  },
  connectingBar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: Spacing.sm,
    paddingVertical: Spacing.sm,
  },
  connectingText: {
    fontSize: FontSize.sm,
  },
  errorBar: {
    padding: Spacing.sm,
    marginHorizontal: Spacing.lg,
    borderRadius: 8,
    marginBottom: Spacing.xs,
  },
  errorBarText: {
    fontSize: FontSize.sm,
    textAlign: 'center',
  },
  retryButton: {
    alignSelf: 'center',
    marginTop: Spacing.sm,
    borderWidth: 1,
    borderRadius: 12,
    paddingHorizontal: Spacing.md,
    paddingVertical: 3,
  },
  retryButtonText: {
    fontSize: FontSize.sm,
    fontWeight: '600',
  },
  queuedBar: {
    paddingHorizontal: Spacing.lg,
    gap: Spacing.xs,
    marginBottom: Spacing.xs,
  },
  queuedChip: {
    flexDirection: 'row',
    alignItems: 'center',
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 14,
    paddingHorizontal: Spacing.md,
    paddingVertical: Spacing.xs,
    gap: Spacing.sm,
  },
  queuedChipBody: {
    flex: 1,
    minWidth: 0,
  },
  queuedChipText: {
    fontSize: FontSize.sm,
  },
  queuedChipRemove: {
    fontSize: FontSize.sm,
    fontWeight: '600',
  },
  centerView: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
  },
  activeToolBar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: Spacing.sm,
    paddingVertical: Spacing.xs,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  activeToolText: {
    fontSize: FontSize.xs,
    flexShrink: 1,
  },
  tabScroll: {
    flex: 1,
  },
  tabScrollContent: {
    paddingTop: Spacing.sm,
    paddingBottom: Spacing.xxl,
  },
  infoRow: {
    flexDirection: 'row',
    paddingHorizontal: Spacing.lg,
    paddingVertical: Spacing.md,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  infoLabel: {
    fontSize: FontSize.md,
    width: 80,
  },
  infoValue: {
    fontSize: FontSize.md,
    flex: 1,
    fontWeight: '500',
  },
  sectionHeader: {
    fontSize: FontSize.xs,
    fontWeight: '600',
    letterSpacing: 0.5,
    marginTop: Spacing.xl,
    marginBottom: Spacing.sm,
    marginHorizontal: Spacing.lg,
  },
  connectRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginHorizontal: Spacing.lg,
    marginBottom: Spacing.sm,
    paddingHorizontal: Spacing.lg,
    paddingVertical: Spacing.md,
    borderRadius: 10,
    borderWidth: StyleSheet.hairlineWidth,
  },
  connectRowText: {
    flex: 1,
    marginRight: Spacing.sm,
  },
  connectTitle: {
    fontSize: FontSize.md,
    fontWeight: '600',
    marginBottom: 2,
  },
  connectSubtitle: {
    fontSize: FontSize.xs,
    lineHeight: 16,
  },
  connectChevron: {
    fontSize: FontSize.xl,
    fontWeight: '400',
  },
  deleteButtonContainer: {
    paddingHorizontal: Spacing.lg,
    paddingTop: Spacing.xxl,
  },
  deleteButton: {
    borderWidth: 1,
    borderRadius: 10,
    paddingVertical: Spacing.md,
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: 44,
  },
  deleteButtonText: {
    fontSize: FontSize.md,
    fontWeight: '600',
  },
  subHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: Spacing.lg,
    paddingVertical: Spacing.md,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  subBack: {
    fontSize: FontSize.md,
    fontWeight: '600',
    width: 90,
  },
  subTitle: {
    fontSize: FontSize.md,
    fontWeight: '700',
  },
  subHeaderSpacer: {
    width: 90,
  },
});
