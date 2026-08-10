import React from 'react';
import {
  View,
  Text,
  StyleSheet,
  Pressable,
  FlatList,
  Alert,
  ActivityIndicator,
  RefreshControl,
  StyleProp,
  ViewStyle,
} from 'react-native';
import { useTheme } from '@/hooks/use-theme';
import { FontSize, Spacing } from '@/constants/theme';
import { PersistedChat } from '@/services/chat-repository';
import { providerDisplayName, RemoteAgentSession } from '@/models/chat';
import { shortWorkingDirectory } from '@/constants/session';

interface ChatListProps {
  chats: PersistedChat[];
  currentChatId: string;
  onSelectChat: (chat: PersistedChat) => void;
  /** Called after the user confirms deletion of a chat via long-press. */
  onDeleteChat: (chat: PersistedChat) => void;
  /**
   * Conversations discovered on the sprite (started from the "sprite console" CLI
   * on a computer) that aren't yet mirrored by a local chat. Interleaved into the
   * list by recency; tapping one calls `onSelectRemote` to resume it in chat.
   */
  remoteSessions?: RemoteAgentSession[];
  onSelectRemote?: (session: RemoteAgentSession) => void;
  /** Id of a remote session currently being opened (shows a spinner on its row). */
  remoteBusyId?: string;
  /** Pull-to-refresh: re-scan the sprite for computer-started conversations. */
  onRefresh?: () => void;
  refreshing?: boolean;
  contentContainerStyle?: StyleProp<ViewStyle>;
  ListHeaderComponent?: React.ComponentProps<typeof FlatList>['ListHeaderComponent'];
  emptyText?: string;
}

/** Green used for the "still running" indicator, shared with the session browser. */
const LIVE_COLOR = '#3fb950';

type Row =
  | { kind: 'local'; chat: PersistedChat; t: number }
  | { kind: 'remote'; session: RemoteAgentSession; t: number };

function formatTime(timestamp: number): string {
  const now = Date.now();
  const diff = now - timestamp;
  const minutes = Math.floor(diff / 60000);
  if (minutes < 1) return 'Just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  return new Date(timestamp).toLocaleDateString();
}

/** A short title for a computer-started session, from its first prompt. */
function remoteTitle(session: RemoteAgentSession): string {
  const firstLine = session.preview.split('\n').map((l) => l.trim()).find(Boolean);
  if (firstLine) return firstLine.length > 48 ? `${firstLine.slice(0, 47)}…` : firstLine;
  return `${providerDisplayName(session.provider)} session`;
}

/**
 * Presentational list of a sprite's conversations. Used both inline (the Chats
 * tab on the sprite screen) and inside ChatListSheet. Purely controlled: the
 * parent owns the arrays and persistence. Local chats (started on the phone) and
 * remote sessions (started from the sprite console on a computer) are merged into
 * one list, newest first. Long-press on a local chat confirms deletion; remote
 * rows are tap-to-resume only.
 */
export function ChatList({
  chats,
  currentChatId,
  onSelectChat,
  onDeleteChat,
  remoteSessions,
  onSelectRemote,
  remoteBusyId,
  onRefresh,
  refreshing,
  contentContainerStyle,
  ListHeaderComponent,
  emptyText = 'No conversations yet. Tap ＋ to start one.',
}: ChatListProps) {
  const colors = useTheme();

  const confirmDelete = (chat: PersistedChat) => {
    Alert.alert(
      'Delete Conversation',
      `Delete "${chat.customName ?? `Session ${chat.chatNumber}`}"? This cannot be undone.`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Delete',
          style: 'destructive',
          onPress: () => onDeleteChat(chat),
        },
      ]
    );
  };

  const rows: Row[] = [
    ...chats.map((chat) => ({ kind: 'local' as const, chat, t: chat.lastUsed })),
    ...(remoteSessions ?? []).map((session) => ({
      kind: 'remote' as const,
      session,
      t: session.modified,
    })),
  ].sort((a, b) => b.t - a.t);

  const renderLocal = (item: PersistedChat) => {
    const isActive = item.id === currentChatId;
    const chatName = item.customName ?? `Session ${item.chatNumber}`;
    return (
      <Pressable
        style={[
          styles.chatRow,
          {
            backgroundColor: isActive ? colors.backgroundSelected : colors.background,
            borderBottomColor: colors.border,
          },
        ]}
        onPress={() => onSelectChat(item)}
        onLongPress={() => confirmDelete(item)}
        accessibilityRole="button"
        accessibilityLabel={chatName}
        accessibilityHint="Long press to delete this conversation"
      >
        <View style={styles.chatRowContent}>
          <View style={styles.chatRowTop}>
            <Text
              style={[styles.chatName, { color: colors.text }, isActive && { color: colors.tint }]}
              numberOfLines={1}
            >
              {chatName}
            </Text>
            <Text style={[styles.chatTime, { color: colors.textSecondary }]}>
              {formatTime(item.lastUsed)}
            </Text>
          </View>
          {item.firstMessagePreview ? (
            <Text style={[styles.chatPreview, { color: colors.textSecondary }]} numberOfLines={2}>
              {item.firstMessagePreview}
            </Text>
          ) : (
            <Text style={[styles.chatPreview, { color: colors.textSecondary }]}>No messages</Text>
          )}
          <View style={styles.chatMetaRow}>
            {/* A turn in flight is the most important thing a row can say, so it
                gets the same live badge the computer-started sessions use. */}
            {item.activeRun && (
              <View style={styles.liveBadge}>
                <View style={[styles.liveDot, { backgroundColor: LIVE_COLOR }]} />
                <Text style={[styles.liveBadgeText, { color: LIVE_COLOR }]}>RUNNING</Text>
              </View>
            )}
            <Text
              style={[styles.chatProvider, { color: colors.textSecondary }]}
              numberOfLines={1}
            >
              {providerDisplayName(item.provider)}
              {item.workingDirectory ? ` · ${shortWorkingDirectory(item.workingDirectory)}` : ''}
            </Text>
          </View>
        </View>
        {isActive && <View style={[styles.activeDot, { backgroundColor: colors.tint }]} />}
      </Pressable>
    );
  };

  const renderRemote = (session: RemoteAgentSession) => {
    const busy = remoteBusyId === session.id;
    return (
      <Pressable
        style={[styles.chatRow, { backgroundColor: colors.background, borderBottomColor: colors.border }]}
        onPress={() => !busy && onSelectRemote?.(session)}
      >
        <View style={styles.chatRowContent}>
          <View style={styles.chatRowTop}>
            <Text style={[styles.chatName, { color: colors.text }]} numberOfLines={1}>
              {remoteTitle(session)}
            </Text>
            <Text style={[styles.chatTime, { color: colors.textSecondary }]}>
              {formatTime(session.modified)}
            </Text>
          </View>
          <View style={styles.remoteMetaRow}>
            <Text style={[styles.fromComputerTag, { color: colors.tint, borderColor: colors.border }]}>
              From computer
            </Text>
            {session.live && (
              <View style={styles.liveBadge}>
                <View style={[styles.liveDot, { backgroundColor: LIVE_COLOR }]} />
                <Text style={[styles.liveBadgeText, { color: LIVE_COLOR }]}>LIVE</Text>
              </View>
            )}
          </View>
          <Text style={[styles.chatProvider, { color: colors.textSecondary }]} numberOfLines={1}>
            {providerDisplayName(session.provider)}
            {session.cwd ? ` · ${shortWorkingDirectory(session.cwd)}` : ''}
            {` · ${session.messageCount} events`}
          </Text>
        </View>
        {busy ? (
          <ActivityIndicator size="small" color={colors.tint} style={styles.remoteSpinner} />
        ) : (
          <Text style={[styles.chevron, { color: colors.tint }]}>›</Text>
        )}
      </Pressable>
    );
  };

  return (
    <FlatList
      data={rows}
      keyExtractor={(item) =>
        item.kind === 'local'
          ? `local:${item.chat.id}`
          : `remote:${item.session.provider}:${item.session.id}`
      }
      contentContainerStyle={[styles.listContent, contentContainerStyle]}
      ListHeaderComponent={ListHeaderComponent}
      refreshControl={
        onRefresh ? (
          <RefreshControl refreshing={!!refreshing} onRefresh={onRefresh} tintColor={colors.tint} />
        ) : undefined
      }
      renderItem={({ item }) =>
        item.kind === 'local' ? renderLocal(item.chat) : renderRemote(item.session)
      }
      ListEmptyComponent={
        <View style={styles.emptyView}>
          <Text style={[styles.emptyText, { color: colors.textSecondary }]}>{emptyText}</Text>
        </View>
      }
    />
  );
}

const styles = StyleSheet.create({
  listContent: {
    flexGrow: 1,
  },
  chatRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: Spacing.lg,
    paddingVertical: Spacing.md,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  chatRowContent: {
    flex: 1,
  },
  chatRowTop: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: Spacing.xs,
  },
  chatName: {
    fontSize: FontSize.md,
    fontWeight: '600',
    flex: 1,
    marginRight: Spacing.sm,
  },
  chatTime: {
    fontSize: FontSize.xs,
  },
  chatPreview: {
    fontSize: FontSize.sm,
    lineHeight: 18,
  },
  chatProvider: {
    fontSize: FontSize.xs,
    flexShrink: 1,
  },
  chatMetaRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.sm,
    marginTop: 4,
  },
  remoteMetaRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.xs,
    marginBottom: 2,
  },
  fromComputerTag: {
    fontSize: FontSize.xs,
    fontWeight: '700',
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 6,
    paddingHorizontal: 6,
    paddingVertical: 2,
  },
  liveBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
  },
  liveDot: {
    width: 7,
    height: 7,
    borderRadius: 4,
  },
  liveBadgeText: {
    fontSize: FontSize.xs,
    fontWeight: '700',
    letterSpacing: 0.5,
  },
  activeDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    marginLeft: Spacing.sm,
  },
  chevron: {
    fontSize: FontSize.xl,
    fontWeight: '400',
    marginLeft: Spacing.sm,
  },
  remoteSpinner: {
    marginLeft: Spacing.sm,
  },
  emptyView: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    paddingVertical: 80,
    paddingHorizontal: Spacing.xxl,
  },
  emptyText: {
    fontSize: FontSize.md,
    textAlign: 'center',
    lineHeight: 22,
  },
});
