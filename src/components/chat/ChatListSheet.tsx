import React, { useEffect, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  Pressable,
  FlatList,
  Modal,
  Alert,
} from 'react-native';
import { useTheme } from '@/hooks/use-theme';
import { FontSize, Spacing } from '@/constants/theme';
import { PersistedChat, chatRepository } from '@/services/chat-repository';
import { providerDisplayName } from '@/models/chat';
import { shortWorkingDirectory } from '@/constants/session';

interface ChatListSheetProps {
  spriteName: string;
  currentChatId: string;
  chats?: PersistedChat[];
  onSelectChat: (chat: PersistedChat) => void;
  onNewChat: () => void;
  onClose: () => void;
}

export function ChatListSheet({
  spriteName,
  currentChatId,
  chats: providedChats,
  onSelectChat,
  onNewChat,
  onClose,
}: ChatListSheetProps) {
  const colors = useTheme();
  const [chats, setChats] = useState<PersistedChat[]>([]);

  useEffect(() => {
    if (providedChats) {
      setChats(providedChats);
      return;
    }
    chatRepository.listBySprite(spriteName).then(setChats);
  }, [providedChats, spriteName]);

  const handleDelete = (chat: PersistedChat) => {
    Alert.alert(
      'Delete Session',
      `Delete "${chat.customName ?? `Session ${chat.chatNumber}`}"? This cannot be undone.`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Delete',
          style: 'destructive',
          onPress: async () => {
            const updated = chats.filter((c) => c.id !== chat.id);
            setChats(updated);
            await chatRepository.remove(chat.id);
          },
        },
      ]
    );
  };

  const formatTime = (timestamp: number): string => {
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
  };

  const sortedChats = [...chats].sort((a, b) => b.lastUsed - a.lastUsed);

  return (
    <Modal visible animationType="slide" presentationStyle="pageSheet" onRequestClose={onClose}>
      <View style={[styles.container, { backgroundColor: colors.background }]}>
        <View style={[styles.header, { borderBottomColor: colors.border }]}>
          <Pressable onPress={onClose} hitSlop={12}>
            <Text style={[styles.closeButton, { color: colors.tint }]}>Close</Text>
          </Pressable>
          <Text style={[styles.title, { color: colors.text }]}>Sessions</Text>
          <Pressable onPress={onNewChat} hitSlop={12}>
            <Text style={[styles.newButton, { color: colors.tint }]}>+ New</Text>
          </Pressable>
        </View>

        <FlatList
          data={sortedChats}
          keyExtractor={(item) => item.id}
          contentContainerStyle={styles.listContent}
          renderItem={({ item }) => {
            const isActive = item.id === currentChatId;
            const chatName = item.customName ?? `Session ${item.chatNumber}`;

            return (
              <Pressable
                style={[
                  styles.chatRow,
                  {
                    backgroundColor: isActive
                      ? colors.backgroundSelected
                      : colors.background,
                    borderBottomColor: colors.border,
                  },
                ]}
                onPress={() => onSelectChat(item)}
                onLongPress={() => handleDelete(item)}
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
                {isActive && (
                  <View style={[styles.activeDot, { backgroundColor: colors.tint }]} />
                )}
              </Pressable>
            );
          }}
          ListEmptyComponent={
            <View style={styles.emptyView}>
              <Text style={[styles.emptyText, { color: colors.textSecondary }]}>
                No sessions yet. Tap "+ New" to start one.
              </Text>
            </View>
          }
        />
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: Spacing.lg,
    paddingVertical: Spacing.md,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  title: {
    fontSize: FontSize.lg,
    fontWeight: '700',
  },
  closeButton: {
    fontSize: FontSize.md,
    fontWeight: '600',
  },
  newButton: {
    fontSize: FontSize.md,
    fontWeight: '600',
  },
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
