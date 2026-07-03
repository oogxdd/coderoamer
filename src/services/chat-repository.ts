import AsyncStorage from '@react-native-async-storage/async-storage';
import { AgentProvider, ChatMessage } from '@/models/chat';
import { Database, getDatabase } from './database';

/**
 * Repository layer for the chat domain.
 *
 * Replaces the old AsyncStorage `loadChatList`/`saveChatList`/`loadChatMessages`
 * calls with a typed, row-oriented API backed by SQLite. Each chat is its own
 * row, so a single chat can be updated atomically without rewriting a whole
 * JSON list — and queries like "all chats with an active run" become trivial.
 *
 * On first launch, existing AsyncStorage data (`sprite_chats_*` / `chat_meta_*`)
 * is imported once, then SQLite is the only read path.
 */

// MARK: - Types

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
  activeRun?: ActiveChatRun;
}

export interface ActiveChatRun {
  execSessionId: string;
  taskName: string;
  provider: AgentProvider;
  userMessageId: string;
  assistantMessageId: string;
  workingDirectory: string;
  startedAt: number;
}

// MARK: - Normalization (defensive load-time sanitization)

function normalizeProvider(value: unknown): AgentProvider {
  return value === 'codex' ? 'codex' : 'claude';
}

export function normalizePersistedChat(value: unknown): PersistedChat {
  const raw = (value ?? {}) as Partial<PersistedChat> & Record<string, unknown>;
  return {
    id: String(raw.id ?? ''),
    spriteName: String(raw.spriteName ?? ''),
    chatNumber: Number(raw.chatNumber ?? 1),
    customName: typeof raw.customName === 'string' ? raw.customName : undefined,
    provider: normalizeProvider(raw.provider),
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
    activeRun: normalizeActiveRun(raw.activeRun),
  };
}

function normalizeActiveRun(value: unknown): ActiveChatRun | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const raw = value as Partial<ActiveChatRun> & Record<string, unknown>;
  if (
    typeof raw.execSessionId !== 'string' ||
    typeof raw.taskName !== 'string' ||
    typeof raw.userMessageId !== 'string' ||
    typeof raw.assistantMessageId !== 'string'
  ) {
    return undefined;
  }
  return {
    execSessionId: raw.execSessionId,
    taskName: raw.taskName,
    provider: normalizeProvider(raw.provider),
    userMessageId: raw.userMessageId,
    assistantMessageId: raw.assistantMessageId,
    workingDirectory: typeof raw.workingDirectory === 'string' ? raw.workingDirectory : '',
    startedAt: Number(raw.startedAt ?? Date.now()),
  };
}

// MARK: - Row <-> object mapping

interface ChatRow {
  id: string;
  sprite_name: string;
  chat_number: number;
  provider: string;
  custom_name: string | null;
  claude_session_id: string | null;
  codex_session_id: string | null;
  current_service_name: string | null;
  working_directory: string;
  created_at: number;
  last_used: number;
  is_closed: number;
  first_message_preview: string | null;
  last_session_complete: number;
  processed_event_uuids: string;
}

interface ActiveRunRow {
  chat_id: string;
  exec_session_id: string;
  task_name: string;
  provider: string;
  user_message_id: string;
  assistant_message_id: string;
  working_directory: string;
  started_at: number;
}

function rowToActiveRun(row: ActiveRunRow): ActiveChatRun {
  return {
    execSessionId: row.exec_session_id,
    taskName: row.task_name,
    provider: normalizeProvider(row.provider),
    userMessageId: row.user_message_id,
    assistantMessageId: row.assistant_message_id,
    workingDirectory: row.working_directory,
    startedAt: row.started_at,
  };
}

function rowToChat(row: ChatRow, activeRun?: ActiveChatRun): PersistedChat {
  return {
    id: row.id,
    spriteName: row.sprite_name,
    chatNumber: row.chat_number,
    provider: normalizeProvider(row.provider),
    customName: row.custom_name ?? undefined,
    claudeSessionId: row.claude_session_id ?? undefined,
    codexSessionId: row.codex_session_id ?? undefined,
    currentServiceName: row.current_service_name ?? undefined,
    workingDirectory: row.working_directory,
    createdAt: row.created_at,
    lastUsed: row.last_used,
    isClosed: Boolean(row.is_closed),
    firstMessagePreview: row.first_message_preview ?? undefined,
    lastSessionComplete: Boolean(row.last_session_complete),
    processedEventUUIDs: safeParseStringArray(row.processed_event_uuids),
    activeRun,
  };
}

function safeParseStringArray(raw: string): string[] {
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

// MARK: - Low-level writers (operate on a live db/txn handle, no migration guard)

const CHAT_UPSERT_SQL = `
INSERT INTO chats (
  id, sprite_name, chat_number, provider, custom_name, claude_session_id,
  codex_session_id, current_service_name, working_directory, created_at,
  last_used, is_closed, first_message_preview, last_session_complete,
  processed_event_uuids
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
ON CONFLICT(id) DO UPDATE SET
  sprite_name = excluded.sprite_name,
  chat_number = excluded.chat_number,
  provider = excluded.provider,
  custom_name = excluded.custom_name,
  claude_session_id = excluded.claude_session_id,
  codex_session_id = excluded.codex_session_id,
  current_service_name = excluded.current_service_name,
  working_directory = excluded.working_directory,
  created_at = excluded.created_at,
  last_used = excluded.last_used,
  is_closed = excluded.is_closed,
  first_message_preview = excluded.first_message_preview,
  last_session_complete = excluded.last_session_complete,
  processed_event_uuids = excluded.processed_event_uuids
`;

function chatParams(chat: PersistedChat) {
  return [
    chat.id,
    chat.spriteName,
    chat.chatNumber,
    chat.provider,
    chat.customName ?? null,
    chat.claudeSessionId ?? null,
    chat.codexSessionId ?? null,
    chat.currentServiceName ?? null,
    chat.workingDirectory,
    chat.createdAt,
    chat.lastUsed,
    chat.isClosed ? 1 : 0,
    chat.firstMessagePreview ?? null,
    chat.lastSessionComplete ? 1 : 0,
    JSON.stringify(chat.processedEventUUIDs ?? []),
  ];
}

const ACTIVE_RUN_UPSERT_SQL = `
INSERT INTO active_runs (
  chat_id, exec_session_id, task_name, provider, user_message_id,
  assistant_message_id, working_directory, started_at
) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
ON CONFLICT(chat_id) DO UPDATE SET
  exec_session_id = excluded.exec_session_id,
  task_name = excluded.task_name,
  provider = excluded.provider,
  user_message_id = excluded.user_message_id,
  assistant_message_id = excluded.assistant_message_id,
  working_directory = excluded.working_directory,
  started_at = excluded.started_at
`;

function activeRunParams(chatId: string, run: ActiveChatRun) {
  return [
    chatId,
    run.execSessionId,
    run.taskName,
    run.provider,
    run.userMessageId,
    run.assistantMessageId,
    run.workingDirectory,
    run.startedAt,
  ];
}

async function writeChat(db: Database, chat: PersistedChat): Promise<void> {
  await db.runAsync(CHAT_UPSERT_SQL, ...chatParams(chat));
  if (chat.activeRun) {
    await db.runAsync(ACTIVE_RUN_UPSERT_SQL, ...activeRunParams(chat.id, chat.activeRun));
  } else {
    await db.runAsync('DELETE FROM active_runs WHERE chat_id = ?', chat.id);
  }
}

async function writeMessages(
  db: Database,
  chatId: string,
  messages: ChatMessage[]
): Promise<void> {
  await db.runAsync('DELETE FROM chat_messages WHERE chat_id = ?', chatId);
  if (messages.length === 0) return;
  for (let seq = 0; seq < messages.length; seq++) {
    await db.runAsync(
      'INSERT INTO chat_messages (chat_id, seq, payload) VALUES (?, ?, ?)',
      chatId,
      seq,
      JSON.stringify(messages[seq])
    );
  }
}

// MARK: - AsyncStorage -> SQLite migration (runs once)

const ASYNC_CHAT_LIST_PREFIX = 'sprite_chats_';
const ASYNC_CHAT_META_PREFIX = 'chat_meta_';
const MIGRATION_FLAG_KEY = 'async_storage_imported';

let migrationDone = false;

async function runAsyncStorageMigration(db: Database): Promise<void> {
  const already = await db.getFirstAsync<{ value: string }>(
    'SELECT value FROM migration_meta WHERE key = ?',
    MIGRATION_FLAG_KEY
  );
  if (already?.value === '1') return;

  await db.withTransactionAsync(async () => {
    const keys = await AsyncStorage.getAllKeys();
    const chatListKeys = keys.filter(
      (k): k is string => typeof k === 'string' && k.startsWith(ASYNC_CHAT_LIST_PREFIX)
    );
    for (const key of chatListKeys) {
      const raw = await AsyncStorage.getItem(key);
      if (!raw) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        continue;
      }
      if (!Array.isArray(parsed)) continue;
      for (const item of parsed) {
        const chat = normalizePersistedChat(item);
        if (!chat.id) continue;
        await writeChat(db, chat);
      }
    }

    const metaKeys = keys.filter(
      (k): k is string => typeof k === 'string' && k.startsWith(ASYNC_CHAT_META_PREFIX)
    );
    for (const key of metaKeys) {
      const chatId = key.slice(ASYNC_CHAT_META_PREFIX.length);
      const raw = await AsyncStorage.getItem(key);
      if (!raw) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        continue;
      }
      if (!Array.isArray(parsed)) continue;
      await writeMessages(db, chatId, parsed as ChatMessage[]);
    }

    await db.runAsync(
      'INSERT INTO migration_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
      MIGRATION_FLAG_KEY,
      '1'
    );
  });
}

/** Ensures the one-time AsyncStorage import has completed. Idempotent. */
async function ensureMigrated(db: Database): Promise<void> {
  if (migrationDone) return;
  try {
    await runAsyncStorageMigration(db);
  } catch (error) {
    // Don't let a migration failure block reads — SQLite is still authoritative
    // for anything already imported. We'll retry on the next launch.
    console.warn('[chat-repository] AsyncStorage migration failed:', error);
  }
  migrationDone = true;
}

// MARK: - Repository

async function loadActiveRuns(
  db: Database,
  chatIds: string[]
): Promise<Map<string, ActiveChatRun>> {
  const out = new Map<string, ActiveChatRun>();
  if (chatIds.length === 0) return out;
  const placeholders = chatIds.map(() => '?').join(',');
  const rows = await db.getAllAsync<ActiveRunRow>(
    `SELECT * FROM active_runs WHERE chat_id IN (${placeholders})`,
    ...chatIds
  );
  for (const row of rows) {
    out.set(row.chat_id, rowToActiveRun(row));
  }
  return out;
}

export const chatRepository = {
  /** All chats for a sprite, most-recently-used first. */
  async listBySprite(spriteName: string): Promise<PersistedChat[]> {
    const db = await getDatabase();
    await ensureMigrated(db);
    const rows = await db.getAllAsync<ChatRow>(
      'SELECT * FROM chats WHERE sprite_name = ? ORDER BY last_used DESC',
      spriteName
    );
    if (rows.length === 0) return [];
    const runs = await loadActiveRuns(db, rows.map((r) => r.id));
    return rows.map((row) => rowToChat(row, runs.get(row.id)));
  },

  /** A single chat by id, or undefined. */
  async getById(chatId: string): Promise<PersistedChat | undefined> {
    const db = await getDatabase();
    await ensureMigrated(db);
    const row = await db.getFirstAsync<ChatRow>('SELECT * FROM chats WHERE id = ?', chatId);
    if (!row) return undefined;
    const runRow = await db.getFirstAsync<ActiveRunRow>(
      'SELECT * FROM active_runs WHERE chat_id = ?',
      chatId
    );
    return rowToChat(row, runRow ? rowToActiveRun(runRow) : undefined);
  },

  /**
   * Insert or update a single chat (and its active run) atomically. This is the
   * preferred write path for one-off mutations — no need to rewrite a list.
   */
  async upsert(chat: PersistedChat): Promise<void> {
    const db = await getDatabase();
    await ensureMigrated(db);
    const sanitized = normalizePersistedChat(chat);
    await db.withTransactionAsync(async () => {
      await writeChat(db, sanitized);
    });
  },

  /**
   * Bulk upsert for a sprite's full chat set, deleting any chats in that sprite
   * that are no longer present. Use for create/delete flows that already hold
   * the whole list; prefer `upsert` for single mutations.
   */
  async replaceForSprite(spriteName: string, chats: PersistedChat[]): Promise<void> {
    const db = await getDatabase();
    await ensureMigrated(db);
    const sanitized = chats.map((c) => normalizePersistedChat(c));
    await db.withTransactionAsync(async () => {
      for (const chat of sanitized) {
        await writeChat(db, chat);
      }
      const keepIds = sanitized.map((c) => c.id);
      if (keepIds.length === 0) {
        await db.runAsync('DELETE FROM chats WHERE sprite_name = ?', spriteName);
        return;
      }
      const placeholders = keepIds.map(() => '?').join(',');
      await db.runAsync(
        `DELETE FROM chats WHERE sprite_name = ? AND id NOT IN (${placeholders})`,
        spriteName,
        ...keepIds
      );
    });
  },

  /** Delete a chat together with its messages and active run. */
  async remove(chatId: string): Promise<void> {
    const db = await getDatabase();
    await ensureMigrated(db);
    await db.withTransactionAsync(async () => {
      await db.runAsync('DELETE FROM chat_messages WHERE chat_id = ?', chatId);
      await db.runAsync('DELETE FROM active_runs WHERE chat_id = ?', chatId);
      await db.runAsync('DELETE FROM chats WHERE id = ?', chatId);
    });
  },

  /** Atomically update a chat's provider/claude/codex session ids. */
  async updateSessionIds(
    chatId: string,
    patch: { claudeSessionId?: string; codexSessionId?: string }
  ): Promise<void> {
    const db = await getDatabase();
    await ensureMigrated(db);
    if (patch.claudeSessionId !== undefined) {
      await db.runAsync('UPDATE chats SET claude_session_id = ? WHERE id = ?', patch.claudeSessionId, chatId);
    }
    if (patch.codexSessionId !== undefined) {
      await db.runAsync('UPDATE chats SET codex_session_id = ? WHERE id = ?', patch.codexSessionId, chatId);
    }
  },

  /**
   * Set (or clear, when undefined) the active run for a chat. A single row
   * update — no full-list rewrite.
   */
  async setActiveRun(chatId: string, run: ActiveChatRun | undefined): Promise<void> {
    const db = await getDatabase();
    await ensureMigrated(db);
    if (run) {
      await db.runAsync(ACTIVE_RUN_UPSERT_SQL, ...activeRunParams(chatId, run));
    } else {
      await db.runAsync('DELETE FROM active_runs WHERE chat_id = ?', chatId);
    }
  },

  /**
   * Apply a partial scalar update to a chat (lastUsed, firstMessagePreview,
   * provider, workingDirectory, isClosed, lastSessionComplete, customName,
   * currentServiceName). Undefined fields are left untouched.
   */
  async patch(
    chatId: string,
    fields: Partial<
      Pick<
        PersistedChat,
        | 'lastUsed'
        | 'firstMessagePreview'
        | 'provider'
        | 'workingDirectory'
        | 'isClosed'
        | 'lastSessionComplete'
        | 'customName'
        | 'currentServiceName'
      >
    >
  ): Promise<void> {
    const db = await getDatabase();
    await ensureMigrated(db);
    const assignments: string[] = [];
    const params: (string | number | null)[] = [];
    const map: Array<[keyof typeof fields, string]> = [
      ['lastUsed', 'last_used'],
      ['firstMessagePreview', 'first_message_preview'],
      ['provider', 'provider'],
      ['workingDirectory', 'working_directory'],
      ['isClosed', 'is_closed'],
      ['lastSessionComplete', 'last_session_complete'],
      ['customName', 'custom_name'],
      ['currentServiceName', 'current_service_name'],
    ];
    for (const [field, column] of map) {
      const value = fields[field];
      if (value === undefined) continue;
      assignments.push(`${column} = ?`);
      if (field === 'isClosed' || field === 'lastSessionComplete') {
        params.push(value ? 1 : 0);
      } else if (value === null) {
        params.push(null);
      } else {
        params.push(value as string | number);
      }
    }
    if (assignments.length === 0) return;
    params.push(chatId);
    await db.runAsync(`UPDATE chats SET ${assignments.join(', ')} WHERE id = ?`, ...params);
  },

  /** All messages for a chat, in order. */
  async getMessages(chatId: string): Promise<ChatMessage[]> {
    const db = await getDatabase();
    await ensureMigrated(db);
    const rows = await db.getAllAsync<{ payload: string }>(
      'SELECT payload FROM chat_messages WHERE chat_id = ? ORDER BY seq',
      chatId
    );
    const messages: ChatMessage[] = [];
    for (const row of rows) {
      try {
        messages.push(JSON.parse(row.payload) as ChatMessage);
      } catch {
        // Skip a corrupted row rather than dropping the whole transcript.
      }
    }
    return messages;
  },

  /** Replace a chat's full message transcript. */
  async setMessages(chatId: string, messages: ChatMessage[]): Promise<void> {
    const db = await getDatabase();
    await ensureMigrated(db);
    await db.withTransactionAsync(async () => {
      await writeMessages(db, chatId, messages);
    });
  },

  /** Remove a chat's message transcript. */
  async removeMessages(chatId: string): Promise<void> {
    const db = await getDatabase();
    await ensureMigrated(db);
    await db.runAsync('DELETE FROM chat_messages WHERE chat_id = ?', chatId);
  },

  /**
   * Every chat that currently has an active run, across all sprites. Used by
   * recovery on app start to reattach to still-running exec sessions.
   */
  async listWithActiveRuns(): Promise<PersistedChat[]> {
    const db = await getDatabase();
    await ensureMigrated(db);
    const rows = await db.getAllAsync<ChatRow>(
      `SELECT chats.* FROM chats
       INNER JOIN active_runs ON active_runs.chat_id = chats.id
       ORDER BY chats.last_used DESC`
    );
    if (rows.length === 0) return [];
    const runs = await loadActiveRuns(db, rows.map((r) => r.id));
    return rows.map((row) => rowToChat(row, runs.get(row.id)));
  },
};
