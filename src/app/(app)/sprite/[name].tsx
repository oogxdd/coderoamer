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
  BackHandler,
  NativeScrollEvent,
  NativeSyntheticEvent,
} from 'react-native';
import { useLocalSearchParams, router, useNavigation } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import * as Clipboard from 'expo-clipboard';
import * as DocumentPicker from 'expo-document-picker';
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
import { MessageAction, MessageActionsSheet } from '@/components/chat/MessageActionsSheet';
import { SelectPartsSheet } from '@/components/chat/SelectPartsSheet';
import { useToast } from '@/components/ui/Toast';
import { BlockingOverlay } from '@/components/ui/BlockingOverlay';
import { SwipeBackView } from '@/components/ui/SwipeBackView';
import {
  formatQuote,
  messageCodeBlocks,
  messageText,
  quotableParts,
} from '@/services/message-text';
import { NewSessionSheet, NewSessionConfig } from '@/components/chat/NewSessionSheet';
import { NewChatSetupPanel } from '@/components/chat/NewChatSetupPanel';
import { QuickBashSheet } from '@/components/chat/QuickBashSheet';
import { AgentSessionSummary, SessionBrowserSheet } from '@/components/chat/SessionBrowserSheet';
import { listClaudeSessions, readClaudeSessionMessages } from '@/services/claude-sessions';
import { listCodexSessions, readCodexSessionMessages } from '@/services/codex-sessions';
import { CheckpointsList } from '@/components/checkpoints/CheckpointsList';
import { SpriteIntegrationsTab } from '@/components/sprite/SpriteIntegrationsTab';
import { FilesystemTab } from '@/components/filesystem/FilesystemTab';
import { ActiveChatRun, PersistedChat, chatRepository } from '@/services/chat-repository';
import {
  ChatAttachment,
  composePromptWithAttachments,
  uploadChatAttachment,
} from '@/services/chat-attachments';
import { reconcileActiveRuns } from '@/services/run-reconcile';
import { WakeProgress, wakeSprite } from '@/services/sprite-wake';
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

/** Distance from the bottom, in points, still counted as "following along". */
const NEAR_BOTTOM_THRESHOLD = 120;

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
  // `session`/`provider`/`cwd` come from the Activity tab: a row there is a
  // coding session, so tapping it opens that conversation, not just the Sprite.
  const {
    name,
    tab: initialTab,
    session: linkedSessionId,
    provider: linkedProvider,
    cwd: linkedCwd,
  } = useLocalSearchParams<{
    name: string;
    tab?: string;
    session?: string;
    provider?: string;
    cwd?: string;
  }>();
  const colors = useTheme();
  const { showToast } = useToast();
  const [tab, setTab] = useState<Tab>(isTab(initialTab) ? initialTab : 'chats');
  // Whether a single conversation is open full-screen (vs. the 3-tab hub).
  const [chatOpen, setChatOpen] = useState(false);
  // Settings sub-view lives here, not in SettingsTab, so the back gesture and
  // the Android back button can step out of it.
  const [settingsView, setSettingsView] = useState<SettingsView>('menu');
  const [sprite, setSprite] = useState<Sprite | null>(null);
  const [isLoadingSprite, setIsLoadingSprite] = useState(true);
  // A cold sprite is woken by this screen, not by the list that linked here.
  // Nothing on the screen works until it's up, so the wake blocks the UI and
  // restarts itself when an attempt overruns (see `sprite-wake.ts`).
  const [isWaking, setIsWaking] = useState(false);
  const [wakeProgress, setWakeProgress] = useState<WakeProgress | null>(null);
  const [wakeFailed, setWakeFailed] = useState(false);
  // Bumped by "Try again" on the wake overlay to re-run the wake effect.
  const [wakeAttemptNonce, setWakeAttemptNonce] = useState(0);
  const flatListRef = useRef<FlatList>(null);
  // Whether the transcript is scrolled to the bottom. A ref because the
  // auto-scroll effect reads it without wanting to re-run when it changes.
  const isNearBottomRef = useRef(true);
  const [showJumpToLatest, setShowJumpToLatest] = useState(false);

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
  // Files uploaded to the sprite for the next message, and the pick in flight.
  const [attachments, setAttachments] = useState<ChatAttachment[]>([]);
  const [isUploadingAttachment, setIsUploadingAttachment] = useState(false);
  // True while a deep link from Activity pulls a session's transcript.
  const [isOpeningLinkedSession, setIsOpeningLinkedSession] = useState(false);
  // Set once the mount effect has bound chat state, so the deep link doesn't
  // race it and create a duplicate conversation for a chat we already have.
  const [chatsLoaded, setChatsLoaded] = useState(false);
  // The ••• chat-settings sheet. Settings become read-only after the first
  // user message; a brand-new conversation edits them inline instead.
  const [settingsSheetVisible, setSettingsSheetVisible] = useState(false);
  // Message whose copy/quote actions sheet is open. The partial select sheet
  // holds a *snapshot* of the parts rather than the message: it selects by
  // index, and a message still streaming would shift them underneath.
  const [actionsMessage, setActionsMessage] = useState<ChatMessage | null>(null);
  const [selectParts, setSelectParts] = useState<string[] | null>(null);
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

  // Load existing chats and current defaults on mount. An empty Sprite stays
  // empty until the user explicitly starts or resumes a conversation.
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
        commitChatList([]);
        setChatId('');
        setChatName('Session 1');
        setChatProvider(defaultProvider);
        setChatModel(defaultModelFor(defaultProvider, defaults));
        setChatEffort(defaultEffortFor(defaultProvider, defaults));
        setClaudeSessionId(undefined);
        setCodexSessionId(undefined);
        setActiveRun(undefined);
        setWorkingDirectory(fallbackDir);
      }
      setChatsLoaded(true);
    })();
    return () => { mounted = false; };
  }, [spriteName, commitChatList]);

  // Load sprite info, then wake it if it's cold.
  //
  // Waking happens here rather than on the dashboard on purpose: the tap that
  // opens a sprite should change route immediately, and this screen is where
  // the progress belongs. Doing it on the list blocked the push behind an exec,
  // so taps queued up and routes arrived one after another.
  useEffect(() => {
    let mounted = true;
    const controller = new AbortController();
    (async () => {
      let current: Sprite | null = null;
      try {
        current = await api.getSprite(spriteName);
        if (mounted) setSprite(current);
      } catch {}
      if (mounted) setIsLoadingSprite(false);

      if (!mounted || current?.status !== 'cold') return;
      setIsWaking(true);
      setWakeFailed(false);
      const result = await wakeSprite(spriteName, {
        signal: controller.signal,
        onProgress: (progress) => {
          if (mounted) setWakeProgress(progress);
        },
      });
      if (!mounted || result.aborted) return;
      if (result.sprite) setSprite(result.sprite);
      // Every attempt overran: the platform isn't bringing this Sprite up right
      // now, so say so instead of spinning forever.
      setWakeFailed(!result.sprite);
      setIsWaking(false);
      setWakeProgress(null);
    })();
    return () => {
      mounted = false;
      controller.abort();
    };
  }, [spriteName, wakeAttemptNonce]);

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

  // Auto-scroll on new output, but only when the user is already at the bottom.
  // Scrolling up during a turn means they are reading something; yanking them
  // back on every token batch made long answers impossible to follow.
  useEffect(() => {
    if (chat.messages.length === 0) return;
    if (!isNearBottomRef.current) return;
    const timer = setTimeout(() => {
      flatListRef.current?.scrollToEnd({ animated: true });
    }, 100);
    return () => clearTimeout(timer);
  }, [chat.messages.length, chat.messages[chat.messages.length - 1]?.content.length]);

  // Opening a conversation always starts pinned to the newest message.
  useEffect(() => {
    if (!chatOpen) return;
    isNearBottomRef.current = true;
    setShowJumpToLatest(false);
  }, [chatOpen, chatId]);

  const handleChatScroll = useCallback((event: NativeSyntheticEvent<NativeScrollEvent>) => {
    const { contentOffset, contentSize, layoutMeasurement } = event.nativeEvent;
    const distanceFromBottom = contentSize.height - contentOffset.y - layoutMeasurement.height;
    const near = distanceFromBottom < NEAR_BOTTOM_THRESHOLD;
    isNearBottomRef.current = near;
    setShowJumpToLatest((prev) => (prev === !near ? prev : !near));
  }, []);

  const scrollToLatest = useCallback(() => {
    isNearBottomRef.current = true;
    setShowJumpToLatest(false);
    flatListRef.current?.scrollToEnd({ animated: true });
  }, []);

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

  /** Point every piece of chat state at `target`, or clear it when there is none. */
  const bindChat = useCallback(
    (target: PersistedChat | undefined) => {
      setAttachments([]);
      if (!target) {
        setChatId('');
        return;
      }
      const nextProvider = normalizeProvider(target.provider);
      setChatId(target.id);
      setChatName(target.customName ?? `Session ${target.chatNumber}`);
      setChatProvider(nextProvider);
      setChatModel(target.model ?? defaultModelFor(nextProvider, agentDefaults));
      setChatEffort(target.effort ?? defaultEffortFor(nextProvider, agentDefaults));
      setClaudeSessionId(target.claudeSessionId);
      setCodexSessionId(target.codexSessionId);
      setActiveRun(target.activeRun);
      setWorkingDirectory(target.workingDirectory || defaultDirectory);
      setReloadNonce((n) => n + 1);
    },
    [agentDefaults, defaultDirectory]
  );

  const handleSend = () => {
    if (attachments.length === 0) {
      chat.sendMessage();
      return;
    }
    // Attachments are already on the sprite; the message carries their paths so
    // the agent can open them, and the bubble shows exactly what it was told.
    const prompt = composePromptWithAttachments(chat.inputText, attachments);
    chat.setInputText('');
    setAttachments([]);
    chat.sendMessage(prompt);
  };

  const handleAttachFile = useCallback(async () => {
    if (!chatId) return;
    try {
      const result = await DocumentPicker.getDocumentAsync({
        copyToCacheDirectory: true,
        multiple: false,
      });
      if (result.canceled) return;
      const asset = result.assets?.[0];
      if (!asset?.uri) return;

      setIsUploadingAttachment(true);
      const attachment = await uploadChatAttachment(spriteName, chatId, {
        uri: asset.uri,
        name: asset.name,
        mimeType: asset.mimeType,
        size: asset.size,
        file: asset.file,
      });
      setAttachments((previous) => [...previous, attachment]);
      showToast(`Uploaded ${attachment.name}`);
    } catch (err) {
      Alert.alert('Upload failed', (err as Error).message || 'Could not upload the file.');
    } finally {
      setIsUploadingAttachment(false);
    }
  }, [chatId, showToast, spriteName]);

  const handleRemoveAttachment = useCallback((id: string) => {
    setAttachments((previous) => previous.filter((attachment) => attachment.id !== id));
  }, []);

  // One-tap recovery when a turn ended on --max-turns.
  const handleContinueTurn = useCallback(() => {
    chat.sendMessage('Continue where you left off.');
  }, [chat.sendMessage]);

  // Long-press a queued follow-up to pull it back into the composer and edit it
  // before the current turn finishes.
  const handleEditQueued = useCallback(
    (id: string, text: string) => {
      chat.removeQueuedPrompt(id);
      chat.setInputText((prev: string) => (prev.trim() ? `${prev.trim()}\n\n${text}` : text));
    },
    [chat.removeQueuedPrompt, chat.setInputText]
  );

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
    setAttachments([]);
    setChatListVisible(false);
    setSettingsSheetVisible(false);
    // Adding a conversation opens it.
    setTab('chats');
    setChatOpen(true);
  }, [chat.detachStream, chat.isStreaming, spriteName, commitChatList]);

  /**
   * The ＋ button. A conversation now opens straight away with the device
   * defaults; its empty state hosts the agent/model/effort/directory controls
   * (see `NewChatSetupPanel`) instead of a modal standing between the tap and
   * the chat. An untouched one is discarded again on the way back out.
   */
  const startNewChat = useCallback(() => {
    createChat({
      workingDirectory: defaultDirectory,
      provider: agentDefaults.provider,
      model: defaultModelFor(agentDefaults.provider, agentDefaults),
      effort: defaultEffortFor(agentDefaults.provider, agentDefaults),
    });
  }, [agentDefaults, createChat, defaultDirectory]);

  // Change the current session configuration before its first message.
  const updateCurrentSettings = useCallback(async (config: NewSessionConfig) => {
    if (isProviderLocked) {
      setSettingsSheetVisible(false);
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
    setSettingsSheetVisible(false);
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
    bindChat(latestChat);
    // Update lastUsed
    const updated = chatListRef.current.map((c) =>
      c.id === latestChat.id ? { ...c, lastUsed: Date.now() } : c
    );
    commitChatList(updated);
    chatRepository.patch(latestChat.id, { lastUsed: Date.now() });
    setChatListVisible(false);
    setChatOpen(true);
  }, [bindChat, chat.detachStream, chat.isStreaming, chatId, commitChatList]);

  const handleDeleteChat = useCallback((target: PersistedChat) => {
    const remaining = chatListRef.current.filter((c) => c.id !== target.id);
    commitChatList(remaining);
    chatRepository.remove(target.id);
    if (target.id !== chatId) return;
    // The current chat was deleted; detach any live stream and fall back to the
    // most recent remaining conversation (or nothing, which shows the empty list).
    if (chat.isStreaming) chat.detachStream();
    bindChat(
      remaining.length > 0
        ? [...remaining].sort((a, b) => b.lastUsed - a.lastUsed)[0]
        : undefined
    );
    setChatOpen(false);
  }, [bindChat, chat.detachStream, chat.isStreaming, chatId, commitChatList]);

  /**
   * A conversation opened by ＋ but never used leaves nothing behind. Without
   * this, backing out of the new-chat screen would litter the list with empty
   * "Session N" rows — the invariant is that a conversation exists once the
   * user actually starts one.
   */
  const discardEmptyDraftChat = useCallback(() => {
    const draftId = chatId;
    if (!draftId) return;
    if (chat.isStreaming || chat.messages.length > 0) return;
    if (claudeSessionId || codexSessionId) return;
    const remaining = chatListRef.current.filter((c) => c.id !== draftId);
    if (remaining.length === chatListRef.current.length) return;
    commitChatList(remaining);
    chatRepository.remove(draftId);
    bindChat(
      remaining.length > 0
        ? [...remaining].sort((a, b) => b.lastUsed - a.lastUsed)[0]
        : undefined
    );
  }, [
    bindChat,
    chat.isStreaming,
    chat.messages.length,
    chatId,
    claudeSessionId,
    codexSessionId,
    commitChatList,
  ]);

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
      setAttachments([]);
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

  // A deep link from the Activity tab: open that exact coding session. If a
  // local chat is already bound to it, that chat is the richer representation
  // and wins; otherwise the sprite's transcript is pulled and resumed. Guarded
  // by a ref so a re-render can't run the import twice.
  const linkedSessionHandledRef = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (!linkedSessionId || !chatsLoaded) return;
    if (linkedSessionHandledRef.current === linkedSessionId) return;
    linkedSessionHandledRef.current = linkedSessionId;

    const wantsCodex = linkedProvider === 'codex' || linkedProvider === 'codexAppServer';
    const existing = chatListRef.current.find((c) =>
      wantsCodex
        ? isCodexProvider(c.provider) && c.codexSessionId === linkedSessionId
        : c.provider === 'claude' && c.claudeSessionId === linkedSessionId
    );
    if (existing) {
      handleSelectChat(existing);
      return;
    }

    (async () => {
      setIsOpeningLinkedSession(true);
      const summary: AgentSessionSummary = {
        id: linkedSessionId,
        provider: wantsCodex ? 'codex' : 'claude',
        cwd: linkedCwd || undefined,
        preview: '',
        messageCount: 0,
        modified: Date.now(),
        live: false,
      };
      try {
        const messages = wantsCodex
          ? await readCodexSessionMessages(spriteName, linkedSessionId)
          : await readClaudeSessionMessages(spriteName, linkedSessionId);
        await handleResumeSession(summary, messages);
      } catch (e: any) {
        Alert.alert('Could not open session', e?.message ?? 'Failed to load transcript.');
      } finally {
        setIsOpeningLinkedSession(false);
      }
    })();
  }, [
    chatsLoaded,
    handleResumeSession,
    handleSelectChat,
    linkedCwd,
    linkedProvider,
    linkedSessionId,
    spriteName,
  ]);

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

  const copyText = useCallback(
    (text: string, confirmation = 'Copied') => {
      if (!text.trim()) {
        showToast('Nothing to copy');
        return;
      }
      Clipboard.setStringAsync(text)
        .then(() => showToast(confirmation))
        .catch(() => showToast('Copy failed'));
    },
    [showToast]
  );

  // Quoting drops a markdown blockquote into the composer and leaves the cursor
  // after it, so the reply reads as a response to that specific passage.
  const quoteText = useCallback(
    (text: string) => {
      const quote = formatQuote(text);
      if (!quote) return;
      chat.setInputText((prev: string) => (prev.trim() ? `${prev.trimEnd()}\n\n${quote}` : quote));
      showToast('Quoted in composer');
    },
    [chat.setInputText, showToast]
  );

  // Built per message: which actions make sense depends on what the message
  // actually contains (code blocks, more than one quotable part).
  const messageActions = useMemo((): MessageAction[] => {
    const message = actionsMessage;
    if (!message) return [];
    const text = messageText(message);
    const codeBlocks = messageCodeBlocks(message);
    const parts = quotableParts(text);
    const actions: MessageAction[] = [];

    if (text) {
      actions.push({
        key: 'copy',
        label: 'Copy message',
        detail: 'The whole message as plain text',
        onPress: () => copyText(text),
      });
    }
    if (codeBlocks.length > 0) {
      actions.push({
        key: 'copy-code',
        label: codeBlocks.length === 1 ? 'Copy code block' : `Copy ${codeBlocks.length} code blocks`,
        detail: 'Code only, without the surrounding prose',
        onPress: () => copyText(codeBlocks.join('\n\n'), 'Code copied'),
      });
    }
    if (text) {
      actions.push({
        key: 'quote',
        label: 'Quote message',
        detail: 'Add it to the composer as a blockquote',
        onPress: () => quoteText(text),
      });
    }
    if (parts.length > 1) {
      actions.push({
        key: 'select',
        label: 'Select part…',
        detail: `Pick from ${parts.length} paragraphs to copy or quote`,
        onPress: () => setSelectParts(parts),
      });
    }
    if (message.role === 'user' && text) {
      actions.push({
        key: 'reuse',
        label: 'Edit as new message',
        detail: 'Put this prompt back in the composer',
        onPress: () => {
          chat.setInputText(text);
          showToast('Copied to composer');
        },
      });
    }
    return actions;
  }, [actionsMessage, chat.setInputText, copyText, quoteText, showToast]);

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

  // This screen has levels the navigator can't see — an open conversation, a
  // settings sub-view. They form one ladder that the header button, the edge
  // swipe and Android's back button all descend together. Kept as a plain
  // value (not a closure) so the effects below don't re-run every render.
  const inScreenLevel: 'chat' | 'settings' | null = chatOpen
    ? 'chat'
    : tab === 'settings' && settingsView !== 'menu'
      ? 'settings'
      : null;

  const popInScreen = useCallback(() => {
    if (chatOpen) {
      discardEmptyDraftChat();
      setChatOpen(false);
    } else {
      setSettingsView('menu');
    }
  }, [chatOpen, discardEmptyDraftChat]);

  const goBack = useCallback(() => {
    if (inScreenLevel) {
      popInScreen();
      return;
    }
    // Pop the stack so this screen slides out to the right, the way back is
    // supposed to look. `replace` used to be unconditional here, which animates
    // as a *push*: the sprite slid left and the dashboard arrived from the
    // right, exactly backwards. Replace stays as the fallback for a directly
    // opened web route, which has no history to pop.
    if (router.canGoBack()) {
      router.back();
      return;
    }
    router.replace('/(app)/(tabs)');
  }, [inScreenLevel, popInScreen]);

  // While an in-screen level is open, the native stack gesture would skip past
  // it and pop the whole sprite. Turn it off and let SwipeBackView handle the
  // edge swipe; restore it once we're back at the top level.
  const navigation = useNavigation();
  useEffect(() => {
    navigation.setOptions({ gestureEnabled: !inScreenLevel });
  }, [navigation, inScreenLevel]);

  useEffect(() => {
    if (!inScreenLevel) return;
    const subscription = BackHandler.addEventListener('hardwareBackPress', () => {
      popInScreen();
      return true;
    });
    return () => subscription.remove();
  }, [inScreenLevel, popInScreen]);

  return (
    <SwipeBackView onSwipeBack={popInScreen} enabled={!!inScreenLevel}>
      <SafeAreaView style={[styles.container, { backgroundColor: colors.background }]} edges={['top']}>
        {/* Header */}
        <View style={[styles.header, { borderBottomColor: colors.border }]}>
          <Pressable
            onPress={goBack}
            hitSlop={12}
            accessibilityRole="button"
            accessibilityLabel="Back"
          >
            <Text style={[styles.backButton, { color: colors.tint }]}>
              &#x2039; {inScreenLevel === 'chat' ? 'Chats' : inScreenLevel ? 'Settings' : 'Back'}
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
                {(sprite || isLoadingSprite) && (
                  <View style={styles.statusRow}>
                    {isWaking || isLoadingSprite ? (
                      <ActivityIndicator
                        size="small"
                        color={colors.textSecondary}
                        style={styles.statusSpinner}
                      />
                    ) : (
                      <View
                        style={[styles.statusDot, { backgroundColor: statusColor(sprite!.status) }]}
                      />
                    )}
                    <Text style={[styles.statusText, { color: colors.textSecondary }]}>
                      {isWaking
                        ? 'Waking…'
                        : isLoadingSprite
                          ? 'Loading…'
                          : statusDisplayName(sprite!.status)}
                    </Text>
                  </View>
                )}
              </>
            )}
          </View>
          <View style={styles.headerRight}>
            {chatOpen ? (
              <Pressable
                onPress={() => setSettingsSheetVisible(true)}
                hitSlop={10}
                accessibilityRole="button"
                accessibilityLabel="Chat settings"
              >
                <Text style={[styles.headerActionMore, { color: colors.tint }]}>•••</Text>
              </Pressable>
            ) : (
              <Pressable
                onPress={startNewChat}
                hitSlop={8}
                accessibilityRole="button"
                accessibilityLabel="New conversation"
              >
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
                  onMessageActions={setActionsMessage}
                  onCopyCode={(code) => copyText(code, 'Code copied')}
                />
              )}
              keyExtractor={(item) => item.id}
              contentContainerStyle={styles.chatContent}
              onScroll={handleChatScroll}
              scrollEventThrottle={64}
              // Drag the transcript down to dismiss the keyboard, and let a tap
              // on a message act without first needing a tap to dismiss it.
              keyboardDismissMode={Platform.OS === 'ios' ? 'interactive' : 'on-drag'}
              keyboardShouldPersistTaps="handled"
              ListEmptyComponent={
                chat.sessionId && chat.messages.length === 0 ? (
                  <View style={styles.emptyChatView}>
                    <ActivityIndicator size="small" color={colors.tint} style={{ marginBottom: Spacing.sm }} />
                    <Text style={[styles.emptyChatSubtitle, { color: colors.textSecondary }]}>
                      Resuming previous session...
                    </Text>
                  </View>
                ) : (
                  // The empty conversation is where its settings live — no modal
                  // stands between pressing ＋ and typing the first message.
                  <NewChatSetupPanel
                    spriteName={spriteName}
                    value={{
                      workingDirectory,
                      provider: chatProvider,
                      model: chatModel,
                      effort: chatEffort,
                    }}
                    onChange={updateCurrentSettings}
                    defaultClaudeModel={agentDefaults.claudeModel}
                    defaultClaudeEffort={agentDefaults.claudeEffort}
                    defaultCodexModel={agentDefaults.codexModel}
                    defaultCodexEffort={agentDefaults.codexEffort}
                  />
                )
              }
            />
            {showJumpToLatest && chat.messages.length > 0 && (
              <Pressable
                style={[
                  styles.jumpToLatest,
                  { backgroundColor: colors.card, borderColor: colors.border },
                ]}
                onPress={scrollToLatest}
                accessibilityRole="button"
                accessibilityLabel="Jump to latest message"
              >
                <Text style={[styles.jumpToLatestText, { color: colors.tint }]}>
                  ↓ Latest{chat.isStreaming ? ' · still working' : ''}
                </Text>
              </Pressable>
            )}
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
                <Text style={[styles.queuedHeader, { color: colors.textSecondary }]}>
                  {chat.queuedPrompts.length} queued ·{' '}
                  {chat.isStreaming ? 'sends when this turn ends' : 'tap to send now'}
                </Text>
                {chat.queuedPrompts.map((q, index) => (
                  <View
                    key={q.id}
                    style={[
                      styles.queuedChip,
                      { borderColor: colors.border, backgroundColor: colors.backgroundElement },
                    ]}
                  >
                    <Text style={[styles.queuedIndex, { color: colors.tint }]}>{index + 1}</Text>
                    <Pressable
                      style={styles.queuedChipBody}
                      // Not `disabled` while streaming: that would also swallow the
                      // long-press, which is the one action that matters mid-turn.
                      onPress={() => {
                        if (!chat.isStreaming) chat.sendQueuedNow(q.id);
                      }}
                      onLongPress={() => handleEditQueued(q.id, q.text)}
                      accessibilityRole="button"
                      accessibilityLabel={`Queued message: ${q.text}`}
                      accessibilityHint="Tap to send now, long-press to move back into the composer"
                    >
                      <Text
                        style={[styles.queuedChipText, { color: colors.textSecondary }]}
                        numberOfLines={1}
                      >
                        {q.text}
                      </Text>
                    </Pressable>
                    <Pressable
                      hitSlop={8}
                      onPress={() => chat.removeQueuedPrompt(q.id)}
                      accessibilityRole="button"
                      accessibilityLabel="Remove queued message"
                    >
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
              attachments={attachments}
              onAttachFile={handleAttachFile}
              onRemoveAttachment={handleRemoveAttachment}
              isUploadingAttachment={isUploadingAttachment}
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
                view={settingsView}
                onViewChange={setSettingsView}
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
              startNewChat();
            }}
            onClose={() => setChatListVisible(false)}
          />
        )}

        {/* Chat settings, from the ••• header action. New conversations are set
            up inline instead (NewChatSetupPanel), so this sheet only edits an
            existing one — read-only once its first message locks it. */}
        {settingsSheetVisible && (
          <NewSessionSheet
            spriteName={spriteName}
            title="Chat Settings"
            confirmLabel="Save Settings"
            defaultDirectory={workingDirectory}
            defaultProvider={chatProvider}
            defaultModel={chatModel}
            defaultEffort={chatEffort}
            defaultClaudeModel={agentDefaults.claudeModel}
            defaultClaudeEffort={agentDefaults.claudeEffort}
            defaultCodexModel={agentDefaults.codexModel}
            defaultCodexEffort={agentDefaults.codexEffort}
            showProviderPicker
            locked={isProviderLocked}
            onClose={() => setSettingsSheetVisible(false)}
            onCreate={updateCurrentSettings}
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

        {/* Long-press a message: copy / quote / pick a part */}
        {actionsMessage && messageActions.length > 0 && (
          <MessageActionsSheet
            title={actionsMessage.role === 'user' ? 'Your message' : providerDisplayName(chatProvider)}
            preview={messageText(actionsMessage)}
            actions={messageActions}
            onClose={() => setActionsMessage(null)}
          />
        )}

        {/* A cold sprite can't run anything — block the screen until it's up. */}
        {(isWaking || wakeFailed) && (
          <BlockingOverlay
            title={wakeFailed ? `${spriteName} is not waking up` : `Waking ${spriteName}…`}
            busy={!wakeFailed}
            subtitle={
              wakeFailed
                ? 'Every attempt timed out. The sprite may still be starting — try again in a moment.'
                : wakeProgress?.restarting
                  ? `Attempt ${wakeProgress.attempt} of ${wakeProgress.attempts} — the previous one stalled, so the wake was restarted.`
                  : 'Nothing can run on a cold sprite, so the screen waits here.'
            }
            actions={[
              ...(wakeFailed
                ? [
                    {
                      label: 'Try again',
                      primary: true,
                      onPress: () => {
                        setWakeFailed(false);
                        setWakeAttemptNonce((nonce) => nonce + 1);
                      },
                    },
                  ]
                : []),
              { label: 'Back', onPress: goBack },
            ]}
          />
        )}

        {isOpeningLinkedSession && !isWaking && !wakeFailed && (
          <BlockingOverlay
            title="Opening session…"
            subtitle={`Pulling this conversation's transcript from ${spriteName}.`}
          />
        )}

        {selectParts && (
          <SelectPartsSheet
            title="Select part"
            parts={selectParts}
            onCopy={(text) => {
              setSelectParts(null);
              copyText(text);
            }}
            onQuote={(text) => {
              setSelectParts(null);
              quoteText(text);
            }}
            onClose={() => setSelectParts(null)}
          />
        )}
      </SafeAreaView>
    </SwipeBackView>
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
// keeps the checkpoints scroller isolated and leaves room for more settings
// later. The sub-view is controlled by the screen so back gestures and the
// Android back button can step out of it.
function SettingsTab({
  sprite,
  isLoading,
  spriteName,
  workingDirectory,
  isActive,
  view,
  onViewChange,
  onSpriteUpdated,
  onQuickBash,
  onBrowseSessions,
}: {
  sprite: Sprite | null;
  isLoading: boolean;
  spriteName: string;
  workingDirectory: string;
  isActive: boolean;
  view: SettingsView;
  onViewChange: (view: SettingsView) => void;
  onSpriteUpdated: (sprite: Sprite) => void;
  onQuickBash: () => void;
  onBrowseSessions: () => void;
}) {
  const colors = useTheme();
  const setView = onViewChange;
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
      <SettingsSubView title="Checkpoints">
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

// Full-height settings sub-screen. Back is owned by the screen header (and the
// edge swipe, and Android back) so there is exactly one back control per level.
function SettingsSubView({ title, children }: { title: string; children: React.ReactNode }) {
  const colors = useTheme();
  return (
    <View style={styles.flex}>
      <View style={[styles.subHeader, { borderBottomColor: colors.border }]}>
        <Text style={[styles.subTitle, { color: colors.text }]}>{title}</Text>
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
    // Pinned so swapping the dot for a spinner can't resize the header.
    height: 16,
  },
  statusDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
  },
  statusSpinner: {
    transform: [{ scale: 0.6 }],
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
  emptyChatSubtitle: {
    fontSize: FontSize.md,
    textAlign: 'center',
    lineHeight: 22,
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
  jumpToLatest: {
    alignSelf: 'center',
    marginBottom: Spacing.sm,
    paddingHorizontal: Spacing.lg,
    paddingVertical: Spacing.sm,
    borderRadius: 18,
    borderWidth: StyleSheet.hairlineWidth,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.15,
    shadowRadius: 5,
    elevation: 4,
  },
  jumpToLatestText: {
    fontSize: FontSize.sm,
    fontWeight: '600',
  },
  queuedBar: {
    paddingHorizontal: Spacing.lg,
    gap: Spacing.xs,
    marginBottom: Spacing.xs,
  },
  queuedHeader: {
    fontSize: FontSize.xs,
    fontWeight: '600',
    marginBottom: 2,
  },
  queuedIndex: {
    fontSize: FontSize.xs,
    fontWeight: '700',
    minWidth: 10,
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
    alignItems: 'center',
    paddingHorizontal: Spacing.lg,
    paddingVertical: Spacing.md,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  subTitle: {
    fontSize: FontSize.md,
    fontWeight: '700',
  },
});
