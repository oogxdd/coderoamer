import AsyncStorage from '@react-native-async-storage/async-storage';
import { ChatMessage } from '@/models/chat';

const CHATS_PREFIX = 'sprite_chats_';
const CHAT_META_PREFIX = 'chat_meta_';
const SETTINGS_PREFIX = 'setting_';

// Chat persistence

export interface PersistedChat {
  id: string;
  spriteName: string;
  chatNumber: number;
  customName?: string;
  claudeSessionId?: string;
  currentServiceName?: string;
  workingDirectory: string;
  createdAt: number;
  lastUsed: number;
  isClosed: boolean;
  firstMessagePreview?: string;
  lastSessionComplete: boolean;
  processedEventUUIDs: string[];
}

export async function loadChatList(spriteName: string): Promise<PersistedChat[]> {
  try {
    const raw = await AsyncStorage.getItem(CHATS_PREFIX + spriteName);
    if (!raw) return [];
    return JSON.parse(raw);
  } catch {
    return [];
  }
}

export async function saveChatList(spriteName: string, chats: PersistedChat[]): Promise<void> {
  await AsyncStorage.setItem(CHATS_PREFIX + spriteName, JSON.stringify(chats));
}

export async function loadChatMessages(chatId: string): Promise<ChatMessage[]> {
  try {
    const raw = await AsyncStorage.getItem(CHAT_META_PREFIX + chatId);
    if (!raw) return [];
    return JSON.parse(raw);
  } catch {
    return [];
  }
}

export async function saveChatMessages(chatId: string, messages: ChatMessage[]): Promise<void> {
  await AsyncStorage.setItem(CHAT_META_PREFIX + chatId, JSON.stringify(messages));
}

export async function deleteChatMessages(chatId: string): Promise<void> {
  await AsyncStorage.removeItem(CHAT_META_PREFIX + chatId);
}

// Settings persistence

export async function getSetting(key: string): Promise<string | null> {
  return AsyncStorage.getItem(SETTINGS_PREFIX + key);
}

export async function setSetting(key: string, value: string): Promise<void> {
  await AsyncStorage.setItem(SETTINGS_PREFIX + key, value);
}

export async function getSettingBool(key: string): Promise<boolean> {
  const val = await AsyncStorage.getItem(SETTINGS_PREFIX + key);
  return val === 'true';
}

export async function setSettingBool(key: string, value: boolean): Promise<void> {
  await AsyncStorage.setItem(SETTINGS_PREFIX + key, value ? 'true' : 'false');
}
