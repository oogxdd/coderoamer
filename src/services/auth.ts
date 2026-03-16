import { Platform } from 'react-native';
import * as SecureStore from 'expo-secure-store';

const KEYS = {
  spritesToken: 'sprites_api_token',
  claudeToken: 'claude_oauth_token',
  githubToken: 'github_token',
} as const;

export type TokenKey = keyof typeof KEYS;

export async function saveToken(key: TokenKey, value: string): Promise<void> {
  if (Platform.OS === 'web') {
    localStorage.setItem(KEYS[key], value);
  } else {
    await SecureStore.setItemAsync(KEYS[key], value);
  }
}

export async function loadToken(key: TokenKey): Promise<string | null> {
  if (Platform.OS === 'web') {
    return localStorage.getItem(KEYS[key]);
  }
  return SecureStore.getItemAsync(KEYS[key]);
}

export async function deleteToken(key: TokenKey): Promise<void> {
  if (Platform.OS === 'web') {
    localStorage.removeItem(KEYS[key]);
  } else {
    await SecureStore.deleteItemAsync(KEYS[key]);
  }
}

export async function hasToken(key: TokenKey): Promise<boolean> {
  const val = await loadToken(key);
  return val !== null && val.length > 0;
}

export async function loadAllTokens() {
  const [spritesToken, claudeToken, githubToken] = await Promise.all([
    loadToken('spritesToken'),
    loadToken('claudeToken'),
    loadToken('githubToken'),
  ]);
  return { spritesToken, claudeToken, githubToken };
}

export async function clearAllTokens(): Promise<void> {
  await Promise.all([
    deleteToken('spritesToken'),
    deleteToken('claudeToken'),
    deleteToken('githubToken'),
  ]);
}
