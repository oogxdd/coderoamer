import * as SQLite from 'expo-sqlite';

/**
 * SQLite is the durable store for the chat domain (chats, messages, active runs).
 * Tokens stay in SecureStore (src/services/auth.ts) and settings stay in
 * AsyncStorage (src/services/storage.ts); only chat data lives here.
 *
 * This module owns the single database connection and the schema. The typed
 * repository layer lives in `chat-repository.ts`.
 */

const DB_NAME = 'sprites_chat.db';

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS chats (
  id TEXT PRIMARY KEY,
  sprite_name TEXT NOT NULL,
  chat_number INTEGER NOT NULL DEFAULT 1,
  provider TEXT NOT NULL DEFAULT 'claude',
  custom_name TEXT,
  claude_session_id TEXT,
  codex_session_id TEXT,
  current_service_name TEXT,
  working_directory TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  last_used INTEGER NOT NULL,
  is_closed INTEGER NOT NULL DEFAULT 0,
  first_message_preview TEXT,
  last_session_complete INTEGER NOT NULL DEFAULT 1,
  processed_event_uuids TEXT NOT NULL DEFAULT '[]'
);

CREATE INDEX IF NOT EXISTS idx_chats_sprite ON chats(sprite_name);
CREATE INDEX IF NOT EXISTS idx_chats_last_used ON chats(last_used);

CREATE TABLE IF NOT EXISTS chat_messages (
  chat_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  payload TEXT NOT NULL,
  PRIMARY KEY (chat_id, seq)
);

CREATE INDEX IF NOT EXISTS idx_messages_chat ON chat_messages(chat_id);

CREATE TABLE IF NOT EXISTS active_runs (
  chat_id TEXT PRIMARY KEY,
  exec_session_id TEXT NOT NULL,
  task_name TEXT NOT NULL,
  provider TEXT NOT NULL,
  user_message_id TEXT NOT NULL,
  assistant_message_id TEXT NOT NULL,
  working_directory TEXT NOT NULL,
  started_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS migration_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`;

export type Database = SQLite.SQLiteDatabase;

let dbPromise: Promise<Database> | null = null;

/**
 * Returns the shared database connection, opening it (and running the schema)
 * on first call. Safe to call repeatedly — always returns the same promise.
 */
export function getDatabase(): Promise<Database> {
  if (!dbPromise) {
    dbPromise = (async () => {
      const db = await SQLite.openDatabaseAsync(DB_NAME);
      await db.execAsync('PRAGMA journal_mode = WAL;');
      await db.execAsync('PRAGMA foreign_keys = ON;');
      await db.execAsync(SCHEMA_SQL);
      return db;
    })();
  }
  return dbPromise;
}
