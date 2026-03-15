import AsyncStorage from '@react-native-async-storage/async-storage';
import { AgentProvider, ChatMessage } from '@/models/chat';

const CHATS_PREFIX = 'sprite_chats_';
const CHAT_META_PREFIX = 'chat_meta_';
const SETTINGS_PREFIX = 'setting_';

// Chat persistence

export interface PersistedChat {
  id: string;
  spriteName: string;
  chatNumber: number;
  customName?: string;
  provider: AgentProvider;
  claudeSessionId?: string;
  codexSessionId?: string;
  currentServiceName?: string;
  workingDirectory: string;
  createdAt: number;
  lastUsed: number;
  isClosed: boolean;
  firstMessagePreview?: string;
  lastSessionComplete: boolean;
  processedEventUUIDs: string[];
}

function normalizeProvider(value: unknown): AgentProvider {
  return value === 'codex' ? 'codex' : 'claude';
}

function normalizePersistedChat(value: unknown): { chat: PersistedChat; changed: boolean } {
  const raw = (value ?? {}) as Partial<PersistedChat> & Record<string, unknown>;
  const provider = normalizeProvider(raw.provider);
  const changed =
    raw.provider !== provider ||
    ('codexSessionId' in raw && raw.codexSessionId !== undefined && typeof raw.codexSessionId !== 'string');
  return {
    chat: {
      id: String(raw.id ?? ''),
      spriteName: String(raw.spriteName ?? ''),
      chatNumber: Number(raw.chatNumber ?? 1),
      customName: typeof raw.customName === 'string' ? raw.customName : undefined,
      provider,
      claudeSessionId: typeof raw.claudeSessionId === 'string' ? raw.claudeSessionId : undefined,
      codexSessionId: typeof raw.codexSessionId === 'string' ? raw.codexSessionId : undefined,
      currentServiceName:
        typeof raw.currentServiceName === 'string' ? raw.currentServiceName : undefined,
      workingDirectory: String(raw.workingDirectory ?? ''),
      createdAt: Number(raw.createdAt ?? Date.now()),
      lastUsed: Number(raw.lastUsed ?? Date.now()),
      isClosed: Boolean(raw.isClosed),
      firstMessagePreview:
        typeof raw.firstMessagePreview === 'string' ? raw.firstMessagePreview : undefined,
      lastSessionComplete: raw.lastSessionComplete !== false,
      processedEventUUIDs: Array.isArray(raw.processedEventUUIDs)
        ? raw.processedEventUUIDs.filter((x): x is string => typeof x === 'string')
        : [],
    },
    changed,
  };
}

export async function loadChatList(spriteName: string): Promise<PersistedChat[]> {
  try {
    const raw = await AsyncStorage.getItem(CHATS_PREFIX + spriteName);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    const normalized = parsed.map(normalizePersistedChat);
    const chats = normalized.map((x) => x.chat);
    if (normalized.some((x) => x.changed)) {
      await saveChatList(spriteName, chats);
    }
    return chats;
  } catch {
    return [];
  }
}

export async function saveChatList(spriteName: string, chats: PersistedChat[]): Promise<void> {
  // Defensive sanitize to avoid persisting invalid/cyclic structures from transient UI objects.
  const serialized = chats.map((chat) => normalizePersistedChat(chat).chat);
  await AsyncStorage.setItem(CHATS_PREFIX + spriteName, JSON.stringify(serialized));
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
