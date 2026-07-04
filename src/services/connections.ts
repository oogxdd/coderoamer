/**
 * Connection storage.
 *
 * The connection list (which includes per-connection secrets: the Sprites token
 * or AGENT_TOKEN) is stored in expo-secure-store on native and localStorage on
 * web — the same split as src/services/auth.ts. The *active* connection id is a
 * non-secret pointer, kept in AsyncStorage.
 *
 * A single global "sprites account" used to live in the `spritesToken` secure
 * key. On first load we migrate it into a default 'sprite' Connection so existing
 * installs keep working with zero user action.
 */
import { Platform } from 'react-native';
import * as SecureStore from 'expo-secure-store';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { Connection } from '@/models/connection';
import { loadToken } from './auth';

const CONNECTIONS_KEY = 'connections_v1';
const ACTIVE_CONNECTION_KEY = 'active_connection_id';

/** Stable id for the seeded default sprite connection (so re-migration is idempotent). */
export const DEFAULT_SPRITE_CONNECTION_ID = 'sprites-default';

// ---------------------------------------------------------------------------
// Secure blob get/set (mirrors auth.ts's native/web split)
// ---------------------------------------------------------------------------

async function readSecure(key: string): Promise<string | null> {
  if (Platform.OS === 'web') return localStorage.getItem(key);
  return SecureStore.getItemAsync(key);
}

async function writeSecure(key: string, value: string): Promise<void> {
  if (Platform.OS === 'web') {
    localStorage.setItem(key, value);
  } else {
    await SecureStore.setItemAsync(key, value);
  }
}

// ---------------------------------------------------------------------------
// Ids
// ---------------------------------------------------------------------------

/**
 * Local, non-secret connection id. Avoids depending on crypto.randomUUID (absent
 * on some RN runtimes) — collision risk is irrelevant for a single-user app's
 * handful of connections.
 */
export function newConnectionId(): string {
  const rand = Math.random().toString(36).slice(2, 10);
  return `conn_${Date.now().toString(36)}_${rand}`;
}

// ---------------------------------------------------------------------------
// Load / save
// ---------------------------------------------------------------------------

function parseConnections(raw: string | null): Connection[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) return parsed as Connection[];
    return [];
  } catch {
    return [];
  }
}

/**
 * Load all connections, migrating a legacy `spritesToken` into a default sprite
 * connection on first run. Idempotent: the migration only fires when the list is
 * empty and a legacy token exists, and the seeded connection is persisted so it
 * won't be recreated after the user removes it.
 */
export async function loadConnections(): Promise<Connection[]> {
  const existing = parseConnections(await readSecure(CONNECTIONS_KEY));
  if (existing.length > 0) return existing;

  // First run (or freshly cleared): seed from legacy global sprites token.
  const legacy = await loadToken('spritesToken');
  if (legacy) {
    const seeded: Connection[] = [
      {
        id: DEFAULT_SPRITE_CONNECTION_ID,
        backing: 'sprite',
        name: 'Sprites',
        token: legacy,
      },
    ];
    await saveConnections(seeded);
    return seeded;
  }

  return [];
}

export async function saveConnections(connections: Connection[]): Promise<void> {
  await writeSecure(CONNECTIONS_KEY, JSON.stringify(connections));
}

export async function addConnection(conn: Connection): Promise<Connection[]> {
  const list = await loadConnections();
  const next = [...list.filter((c) => c.id !== conn.id), conn];
  await saveConnections(next);
  return next;
}

export async function updateConnection(
  id: string,
  patch: Partial<Connection>
): Promise<Connection[]> {
  const list = await loadConnections();
  const next = list.map((c) => (c.id === id ? { ...c, ...patch, id: c.id } : c));
  await saveConnections(next);
  return next;
}

export async function removeConnection(id: string): Promise<Connection[]> {
  const list = await loadConnections();
  const next = list.filter((c) => c.id !== id);
  await saveConnections(next);
  const active = await loadActiveConnectionId();
  if (active === id) {
    await saveActiveConnectionId(next[0]?.id ?? null);
  }
  return next;
}

export async function getConnection(id: string): Promise<Connection | undefined> {
  const list = await loadConnections();
  return list.find((c) => c.id === id);
}

// ---------------------------------------------------------------------------
// Active connection pointer (non-secret → AsyncStorage)
// ---------------------------------------------------------------------------

export async function loadActiveConnectionId(): Promise<string | null> {
  try {
    return await AsyncStorage.getItem(ACTIVE_CONNECTION_KEY);
  } catch {
    return null;
  }
}

export async function saveActiveConnectionId(id: string | null): Promise<void> {
  try {
    if (id) await AsyncStorage.setItem(ACTIVE_CONNECTION_KEY, id);
    else await AsyncStorage.removeItem(ACTIVE_CONNECTION_KEY);
  } catch {
    // best-effort; a lost active pointer just falls back to the first connection
  }
}

/**
 * Resolve the active connection, defaulting to the first connection when the
 * stored pointer is missing or stale.
 */
export async function loadActiveConnection(): Promise<Connection | null> {
  const list = await loadConnections();
  if (list.length === 0) return null;
  const activeId = await loadActiveConnectionId();
  return list.find((c) => c.id === activeId) ?? list[0];
}
