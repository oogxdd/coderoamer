import React, { useState, useEffect, useCallback, useRef } from 'react';
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
} from 'react-native';
import { useLocalSearchParams, router } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Sprite, statusColor, statusDisplayName } from '@/models/sprite';
import { AgentProvider, ChatMessage, providerDisplayName, toolUseActivityLabel } from '@/models/chat';
import * as api from '@/services/api';
import { useChat } from '@/hooks/useChat';
import { useTheme } from '@/hooks/use-theme';
import { ChatMessageView } from '@/components/chat/ChatMessageView';
import { ChatInputBar } from '@/components/chat/ChatInputBar';
import { ChatListSheet } from '@/components/chat/ChatListSheet';
import { NewSessionSheet, NewSessionConfig } from '@/components/chat/NewSessionSheet';
import { QuickBashSheet } from '@/components/chat/QuickBashSheet';
import { CheckpointsList } from '@/components/checkpoints/CheckpointsList';
import { PersistedChat, getSetting, loadChatList, saveChatList } from '@/services/storage';
import { FontSize, Spacing } from '@/constants/theme';
import { DEFAULT_WORKING_DIRECTORY, normalizeWorkingDirectory, shortWorkingDirectory } from '@/constants/session';

type Tab = 'overview' | 'chat' | 'checkpoints';

function normalizeProvider(provider: unknown): AgentProvider {
  return provider === 'codex' ? 'codex' : 'claude';
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
  const { name } = useLocalSearchParams<{ name: string }>();
  const colors = useTheme();
  const [tab, setTab] = useState<Tab>('chat');
  const [sprite, setSprite] = useState<Sprite | null>(null);
  const [isLoadingSprite, setIsLoadingSprite] = useState(true);
  const flatListRef = useRef<FlatList>(null);

  // Multi-chat state
  const [chatId, setChatId] = useState<string>('');
  const [chatName, setChatName] = useState<string>('Session 1');
  const [chatProvider, setChatProvider] = useState<AgentProvider>('claude');
  const [claudeSessionId, setClaudeSessionId] = useState<string | undefined>();
  const [codexSessionId, setCodexSessionId] = useState<string | undefined>();
  const [chatListVisible, setChatListVisible] = useState(false);
  const [quickBashVisible, setQuickBashVisible] = useState(false);
  // null = closed. 'new' creates a fresh session; 'edit' changes the current session's directory.
  const [sessionSheetMode, setSessionSheetMode] = useState<'new' | 'edit' | null>(null);
  const chatListRef = useRef<PersistedChat[]>([]);

  const spriteName = name ?? '';
  const [workingDirectory, setWorkingDirectory] = useState(DEFAULT_WORKING_DIRECTORY);
  const [defaultDirectory, setDefaultDirectory] = useState(DEFAULT_WORKING_DIRECTORY);

  const chat = useChat({
    spriteName,
    chatId,
    workingDirectory,
    provider: chatProvider,
    initialClaudeSessionId: claudeSessionId,
    initialCodexSessionId: codexSessionId,
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
      chatListRef.current = updated;
      saveChatList(spriteName, updated);
    },
  });
  const isProviderLocked = chat.messages.some((message) => message.role === 'user');

  // Initialize chat list and current chat on mount
  useEffect(() => {
    let mounted = true;
    (async () => {
      const [chats, savedDefaultDir] = await Promise.all([
        loadChatList(spriteName),
        getSetting('defaultWorkingDirectory'),
      ]);
      if (!mounted) return;

      const fallbackDir = savedDefaultDir
        ? normalizeWorkingDirectory(savedDefaultDir)
        : DEFAULT_WORKING_DIRECTORY;
      setDefaultDirectory(fallbackDir);

      if (chats.length > 0) {
        chatListRef.current = chats;
        // Resume the most recently used session so reopening lands you right back in it.
        const sorted = [...chats].sort((a, b) => b.lastUsed - a.lastUsed);
        const current = sorted[0];
        setChatId(current.id);
        setChatName(current.customName ?? `Session ${current.chatNumber}`);
        setChatProvider(normalizeProvider(current.provider));
        setClaudeSessionId(current.claudeSessionId);
        setCodexSessionId(current.codexSessionId);
        setWorkingDirectory(current.workingDirectory || fallbackDir);
      } else {
        const defaultProvider = normalizeProvider(await getSetting('defaultProvider'));
        // Create the first chat
        const firstChat: PersistedChat = {
          id: `${spriteName}-chat-1`,
          spriteName,
          chatNumber: 1,
          provider: defaultProvider,
          workingDirectory: fallbackDir,
          createdAt: Date.now(),
          lastUsed: Date.now(),
          isClosed: false,
          lastSessionComplete: true,
          processedEventUUIDs: [],
        };
        chatListRef.current = [firstChat];
        await saveChatList(spriteName, [firstChat]);
        setChatId(firstChat.id);
        setChatName('Session 1');
        setChatProvider(defaultProvider);
        setClaudeSessionId(undefined);
        setCodexSessionId(undefined);
        setWorkingDirectory(fallbackDir);
      }
    })();
    return () => { mounted = false; };
  }, [spriteName]);

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

  // Load chat session when chatId changes
  useEffect(() => {
    if (chatId) {
      chat.loadSession();
    }
  }, [chatId]);

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
        chatListRef.current = updated;
        saveChatList(spriteName, updated);
      }
    }
  }, [chat.messages.length, chatId]);

  const handleSend = () => {
    chat.sendMessage();
  };

  const createChat = useCallback(async (config: NewSessionConfig) => {
    const chats = chatListRef.current;
    const maxNumber = chats.reduce((max, c) => Math.max(max, c.chatNumber), 0);
    const newNumber = maxNumber + 1;
    const dir = normalizeWorkingDirectory(config.workingDirectory);
    const newChat: PersistedChat = {
      id: `${spriteName}-chat-${newNumber}`,
      spriteName,
      chatNumber: newNumber,
      provider: config.provider,
      workingDirectory: dir,
      createdAt: Date.now(),
      lastUsed: Date.now(),
      isClosed: false,
      lastSessionComplete: true,
      processedEventUUIDs: [],
    };
    const updated = [...chats, newChat];
    chatListRef.current = updated;
    await saveChatList(spriteName, updated);
    setChatId(newChat.id);
    setChatName(`Session ${newNumber}`);
    setChatProvider(config.provider);
    setWorkingDirectory(dir);
    setClaudeSessionId(undefined);
    setCodexSessionId(undefined);
    setChatListVisible(false);
    setSessionSheetMode(null);
  }, [spriteName]);

  // Change the directory of the *current* session (only allowed before its first message).
  const updateCurrentDirectory = useCallback(async (config: NewSessionConfig) => {
    const dir = normalizeWorkingDirectory(config.workingDirectory);
    setWorkingDirectory(dir);
    const updated = chatListRef.current.map((c) =>
      c.id === chatId ? { ...c, workingDirectory: dir } : c
    );
    chatListRef.current = updated;
    await saveChatList(spriteName, updated);
    setSessionSheetMode(null);
  }, [chatId, spriteName]);

  const handleSelectChat = useCallback((selectedChat: PersistedChat) => {
    setChatId(selectedChat.id);
    setChatName(selectedChat.customName ?? `Session ${selectedChat.chatNumber}`);
    setChatProvider(normalizeProvider(selectedChat.provider));
    setClaudeSessionId(selectedChat.claudeSessionId);
    setCodexSessionId(selectedChat.codexSessionId);
    setWorkingDirectory(selectedChat.workingDirectory || defaultDirectory);
    // Update lastUsed
    const updated = chatListRef.current.map((c) =>
      c.id === selectedChat.id ? { ...c, lastUsed: Date.now() } : c
    );
    chatListRef.current = updated;
    saveChatList(spriteName, updated);
    setChatListVisible(false);
  }, [spriteName, defaultDirectory]);

  const handleProviderChange = useCallback((nextProvider: AgentProvider) => {
    if (!chatId || chat.isStreaming || isProviderLocked) return;
    setChatProvider(nextProvider);
    const updated = chatListRef.current.map((c) =>
      c.id === chatId ? { ...c, provider: nextProvider } : c
    );
    chatListRef.current = updated;
    saveChatList(spriteName, updated);
  }, [chat.isStreaming, chatId, isProviderLocked, spriteName]);

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
              createChat({ workingDirectory, provider: 'claude' });
            } else {
              handleProviderChange('claude');
            }
            chat.clearCodexAuthIssue();
          },
        },
      ]
    );
  }, [chat.codexAuthIssue, chat.clearCodexAuthIssue, createChat, handleProviderChange, isProviderLocked, workingDirectory]);

  const handleInsertBashOutput = useCallback((text: string) => {
    chat.setInputText((prev: string) => (prev ? prev + '\n' + text : text));
  }, [chat.setInputText]);

  // Active tool label for the chat tab
  const activeToolLabel = chat.isStreaming
    ? getActiveToolLabel(chat.messages, workingDirectory)
    : undefined;

  const tabItems: { key: Tab; label: string }[] = [
    { key: 'overview', label: 'Overview' },
    { key: 'chat', label: 'Chat' },
    { key: 'checkpoints', label: 'Checkpoints' },
  ];

  return (
    <SafeAreaView style={[styles.container, { backgroundColor: colors.background }]} edges={['top']}>
      {/* Header */}
      <View style={[styles.header, { borderBottomColor: colors.border }]}>
        <Pressable onPress={() => router.back()} hitSlop={12}>
          <Text style={[styles.backButton, { color: colors.tint }]}>&#x2039; Back</Text>
        </Pressable>
        <View style={styles.headerCenter}>
          <Text style={[styles.headerTitle, { color: colors.text }]} numberOfLines={1}>
            {spriteName}
          </Text>
          {sprite && tab !== 'chat' && (
            <View style={styles.statusRow}>
              <View
                style={[
                  styles.statusDot,
                  { backgroundColor: statusColor(sprite.status) },
                ]}
              />
              <Text style={[styles.statusText, { color: colors.textSecondary }]}>
                {statusDisplayName(sprite.status)}
              </Text>
            </View>
          )}
          {tab === 'chat' && (
            <Text style={[styles.chatSubtitle, { color: colors.textSecondary }]} numberOfLines={1}>
              {chatName} · {providerDisplayName(chatProvider)} · {shortWorkingDirectory(workingDirectory)}
            </Text>
          )}
        </View>
        <View style={styles.headerRight}>
          {tab === 'chat' && (
            <>
              <Pressable onPress={() => setQuickBashVisible(true)} hitSlop={8}>
                <Text style={[styles.headerAction, { color: colors.tint }]}>&#x26A1;</Text>
              </Pressable>
              <Pressable onPress={() => setChatListVisible(true)} hitSlop={8}>
                <Text style={[styles.headerAction, { color: colors.tint }]}>&#x2630;</Text>
              </Pressable>
            </>
          )}
        </View>
      </View>

      {/* Tab Bar */}
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

      {/* Active tool label below tab bar (chat tab only) */}
      {tab === 'chat' && activeToolLabel && (
        <View style={[styles.activeToolBar, { backgroundColor: colors.backgroundSecondary, borderBottomColor: colors.border }]}>
          <ActivityIndicator size="small" color={colors.tint} />
          <Text style={[styles.activeToolText, { color: colors.textSecondary }]} numberOfLines={1}>
            {activeToolLabel}
          </Text>
        </View>
      )}

      {/* Tab Content */}
      {tab === 'overview' && (
        <OverviewTab
          sprite={sprite}
          isLoading={isLoadingSprite}
          spriteName={spriteName}
          isActive={tab === 'overview'}
          onSpriteUpdated={setSprite}
          workingDirectory={workingDirectory}
        />
      )}

      {tab === 'chat' && (
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
                    Send a message to start a Claude Code session on this sprite.
                  </Text>
                  <Pressable
                    style={[
                      styles.cwdChip,
                      { borderColor: colors.border, backgroundColor: colors.backgroundElement },
                    ]}
                    onPress={() => setSessionSheetMode('edit')}
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
          {chat.isStreaming && chat.status === 'connecting' && (
            <View style={styles.connectingBar}>
              <ActivityIndicator size="small" color={colors.tint} />
              <Text style={[styles.connectingText, { color: colors.textSecondary }]}>
                Connecting to {providerDisplayName(chatProvider)}...
              </Text>
            </View>
          )}
          {chat.errorMessage && (
            <View style={[styles.errorBar, { backgroundColor: colors.destructive + '15' }]}>
              <Text style={[styles.errorBarText, { color: colors.destructive }]}>
                {chat.errorMessage}
              </Text>
            </View>
          )}
          <ChatInputBar
            value={chat.inputText}
            onChangeText={chat.setInputText}
            onSend={handleSend}
            onInterrupt={chat.interrupt}
            isStreaming={chat.isStreaming}
            provider={chatProvider}
            providerLocked={isProviderLocked}
            onProviderChange={handleProviderChange}
          />
        </KeyboardAvoidingView>
      )}

      {tab === 'checkpoints' && <CheckpointsList spriteName={spriteName} />}

      {/* Chat List Sheet */}
      {chatListVisible && (
        <ChatListSheet
          spriteName={spriteName}
          currentChatId={chatId}
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
          title={sessionSheetMode === 'edit' ? 'Session Directory' : 'New Session'}
          confirmLabel={sessionSheetMode === 'edit' ? 'Update Directory' : 'Start Session'}
          defaultDirectory={sessionSheetMode === 'edit' ? workingDirectory : defaultDirectory}
          defaultProvider={chatProvider}
          showProviderPicker={sessionSheetMode === 'new'}
          onClose={() => setSessionSheetMode(null)}
          onCreate={sessionSheetMode === 'edit' ? updateCurrentDirectory : createChat}
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
    </SafeAreaView>
  );
}

// Overview Tab Component
function OverviewTab({
  sprite,
  isLoading,
  spriteName,
  isActive,
  onSpriteUpdated,
  workingDirectory,
}: {
  sprite: Sprite | null;
  isLoading: boolean;
  spriteName: string;
  isActive: boolean;
  onSpriteUpdated: (sprite: Sprite) => void;
  workingDirectory: string;
}) {
  const colors = useTheme();
  const [isDeleting, setIsDeleting] = useState(false);

  // Poll sprite status every 5 seconds while on overview tab
  useEffect(() => {
    if (!isActive) return;

    const interval = setInterval(async () => {
      try {
        const s = await api.getSprite(spriteName);
        onSpriteUpdated(s);
      } catch {}
    }, 5000);

    return () => clearInterval(interval);
  }, [isActive, spriteName, onSpriteUpdated]);

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

  if (isLoading) {
    return (
      <View style={styles.centerView}>
        <ActivityIndicator size="large" color={colors.tint} />
      </View>
    );
  }

  if (!sprite) {
    return (
      <View style={styles.centerView}>
        <Text style={[styles.errorBarText, { color: colors.destructive }]}>
          Failed to load sprite info
        </Text>
      </View>
    );
  }

  const infoRows: { label: string; value: string }[] = [
    { label: 'Name', value: sprite.name },
    { label: 'Status', value: statusDisplayName(sprite.status) },
    { label: 'ID', value: sprite.id },
  ];
  if (sprite.url) {
    infoRows.push({ label: 'URL', value: sprite.url });
  }
  if (sprite.created_at) {
    infoRows.push({
      label: 'Created',
      value: new Date(sprite.created_at).toLocaleString(),
    });
  }
  if (sprite.url_settings) {
    infoRows.push({ label: 'Auth', value: sprite.url_settings.auth });
  }
  // Working directory row
  infoRows.push({ label: 'Work Dir', value: workingDirectory });

  return (
    <ScrollView style={styles.overviewContainer} contentContainerStyle={styles.overviewContent}>
      {infoRows.map((row) => (
        <View
          key={row.label}
          style={[styles.infoRow, { borderBottomColor: colors.border }]}
        >
          <Text style={[styles.infoLabel, { color: colors.textSecondary }]}>
            {row.label}
          </Text>
          <Text
            style={[styles.infoValue, { color: colors.text }]}
            numberOfLines={1}
            selectable
          >
            {row.value}
          </Text>
        </View>
      ))}

      {/* More ways to connect */}
      <Text style={[styles.connectHeader, { color: colors.textSecondary }]}>
        MORE WAYS TO CONNECT
      </Text>
      <Pressable
        style={({ pressed }) => [
          styles.connectRow,
          { backgroundColor: colors.card, borderColor: colors.border, opacity: pressed ? 0.7 : 1 },
        ]}
        onPress={() =>
          router.push({
            pathname: '/(app)/exec-poc',
            params: { name: spriteName, cwd: workingDirectory },
          })
        }
      >
        <View style={styles.connectRowText}>
          <Text style={[styles.connectTitle, { color: colors.text }]}>Interactive Terminal</Text>
          <Text style={[styles.connectSubtitle, { color: colors.textSecondary }]}>
            Real TTY over WebSocket — auto-runs claude in your repo. Best for answering prompts
            and watching the live TUI.
          </Text>
        </View>
        <Text style={[styles.connectChevron, { color: colors.tint }]}>›</Text>
      </Pressable>
      <Pressable
        style={({ pressed }) => [
          styles.connectRow,
          { backgroundColor: colors.card, borderColor: colors.border, opacity: pressed ? 0.7 : 1 },
        ]}
        onPress={() =>
          router.push({ pathname: '/(app)/ttyd-terminal', params: { name: spriteName } })
        }
      >
        <View style={styles.connectRowText}>
          <Text style={[styles.connectTitle, { color: colors.text }]}>Web Terminal (ttyd)</Text>
          <Text style={[styles.connectSubtitle, { color: colors.textSecondary }]}>
            Embeds a ttyd server running inside the sprite. Experimental — requires ttyd.
          </Text>
        </View>
        <Text style={[styles.connectChevron, { color: colors.tint }]}>›</Text>
      </Pressable>

      {/* Delete Sprite button */}
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
    width: 50,
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
    width: 50,
    flexDirection: 'row',
    justifyContent: 'flex-end',
    alignItems: 'center',
    gap: Spacing.sm,
  },
  headerAction: {
    fontSize: FontSize.lg,
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
  overviewContainer: {
    flex: 1,
  },
  overviewContent: {
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
  connectHeader: {
    fontSize: FontSize.xs,
    fontWeight: '600',
    letterSpacing: 0.5,
    marginTop: Spacing.xxl,
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
});
