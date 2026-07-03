import AsyncStorage from '@react-native-async-storage/async-storage';

/**
 * Settings persistence (AsyncStorage).
 *
 * The chat domain (chats, messages, active runs) now lives in SQLite — see
 * `chat-repository.ts` and `database.ts`. Tokens remain in SecureStore
 * (`auth.ts`). Only non-secret user settings stay here.
 *
 * Keys are namespaced with the prefix below so they never collide with the
 * legacy `sprite_chats_*` / `chat_meta_*` keys that were migrated to SQLite.
 */

const SETTINGS_PREFIX = 'setting_';

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
