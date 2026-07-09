import React, { useEffect, useState } from 'react';
import { View, Text, StyleSheet, Pressable, Modal } from 'react-native';
import { useTheme } from '@/hooks/use-theme';
import { FontSize, Spacing } from '@/constants/theme';
import { PersistedChat, chatRepository } from '@/services/chat-repository';
import { ChatList } from '@/components/chat/ChatList';

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
    setChats((prev) => prev.filter((c) => c.id !== chat.id));
    chatRepository.remove(chat.id);
  };

  return (
    <Modal visible animationType="slide" presentationStyle="pageSheet" onRequestClose={onClose}>
      <View style={[styles.container, { backgroundColor: colors.background }]}>
        <View style={[styles.header, { borderBottomColor: colors.border }]}>
          <Pressable onPress={onClose} hitSlop={12}>
            <Text style={[styles.closeButton, { color: colors.tint }]}>Close</Text>
          </Pressable>
          <Text style={[styles.title, { color: colors.text }]}>Conversations</Text>
          <Pressable onPress={onNewChat} hitSlop={12}>
            <Text style={[styles.newButton, { color: colors.tint }]}>+ New</Text>
          </Pressable>
        </View>

        <ChatList
          chats={chats}
          currentChatId={currentChatId}
          onSelectChat={onSelectChat}
          onDeleteChat={handleDelete}
          emptyText='No conversations yet. Tap "+ New" to start one.'
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
});
