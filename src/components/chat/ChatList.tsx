import React from 'react';
import {
  View,
  Text,
  StyleSheet,
  Pressable,
  FlatList,
  Alert,
  StyleProp,
  ViewStyle,
} from 'react-native';
import { useTheme } from '@/hooks/use-theme';
import { FontSize, Spacing } from '@/constants/theme';
import { PersistedChat } from '@/services/chat-repository';
import { providerDisplayName } from '@/models/chat';
import { shortWorkingDirectory } from '@/constants/session';

interface ChatListProps {
  chats: PersistedChat[];
  currentChatId: string;
  onSelectChat: (chat: PersistedChat) => void;
  /** Called after the user confirms deletion of a chat via long-press. */
  onDeleteChat: (chat: PersistedChat) => void;
  contentContainerStyle?: StyleProp<ViewStyle>;
  ListHeaderComponent?: React.ComponentProps<typeof FlatList>['ListHeaderComponent'];
  emptyText?: string;
}

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

/**
 * Presentational list of a sprite's conversations. Used both inline (the Chats
 * tab on the sprite screen) and inside ChatListSheet. Purely controlled: the
 * parent owns the `chats` array and persistence; long-press shows a confirm and
 * then delegates removal to `onDeleteChat`.
 */
export function ChatList({
  chats,
  currentChatId,
  onSelectChat,
  onDeleteChat,
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

  const sortedChats = [...chats].sort((a, b) => b.lastUsed - a.lastUsed);

  return (
    <FlatList
      data={sortedChats}
      keyExtractor={(item) => item.id}
      contentContainerStyle={[styles.listContent, contentContainerStyle]}
      ListHeaderComponent={ListHeaderComponent}
      renderItem={({ item }) => {
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
          >
            <View style={styles.chatRowContent}>
              <View style={styles.chatRowTop}>
                <Text
                  style={[
                    styles.chatName,
                    { color: colors.text },
                    isActive && { color: colors.tint },
                  ]}
                  numberOfLines={1}
                >
                  {chatName}
                </Text>
                <Text style={[styles.chatTime, { color: colors.textSecondary }]}>
                  {formatTime(item.lastUsed)}
                </Text>
              </View>
              {item.firstMessagePreview ? (
                <Text
                  style={[styles.chatPreview, { color: colors.textSecondary }]}
                  numberOfLines={2}
                >
                  {item.firstMessagePreview}
                </Text>
              ) : (
                <Text style={[styles.chatPreview, { color: colors.textSecondary }]}>
                  No messages
                </Text>
              )}
              <Text
                style={[styles.chatProvider, { color: colors.textSecondary }]}
                numberOfLines={1}
              >
                {providerDisplayName(item.provider)}
                {item.workingDirectory ? ` · ${shortWorkingDirectory(item.workingDirectory)}` : ''}
                {item.activeRun ? ' · Running' : ''}
              </Text>
            </View>
            {isActive && <View style={[styles.activeDot, { backgroundColor: colors.tint }]} />}
          </Pressable>
        );
      }}
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
    marginTop: 4,
  },
  activeDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
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
