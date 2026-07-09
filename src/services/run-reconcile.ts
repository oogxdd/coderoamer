import { isCodexProvider } from '@/models/chat';
import * as api from './api';
import {
  conversationSignature,
  countUserMessages,
  mergeTranscript,
} from './chat-helpers';
import { PersistedChat, chatRepository } from './chat-repository';
import { readClaudeSessionMessages } from './claude-sessions';
import { readCodexSessionMessages } from './codex-sessions';

/**
 * Reconcile persisted active runs for a sprite against the exec sessions that
 * are actually running. A chat whose exec session no longer exists finished
 * (or died) while the app was away — its "Running" state would otherwise stick
 * until the chat was opened. Clear the run flag and recover the completed turn
 * from the agent's on-disk transcript straight into the repository.
 *
 * Never throws. When the probe itself fails (offline, sprite asleep and
 * unreachable) nothing is decided and nothing is touched.
 *
 * @returns ids of chats whose active run was cleared.
 */
export async function reconcileActiveRuns(spriteName: string): Promise<string[]> {
  let withRuns: PersistedChat[];
  try {
    const chats = await chatRepository.listBySprite(spriteName);
    withRuns = chats.filter((chat) => chat.activeRun);
  } catch {
    return [];
  }
  if (withRuns.length === 0) return [];

  let liveIds: Set<string>;
  try {
    const sessions = await api.listExecSessionsStrict(spriteName);
    liveIds = new Set(sessions.map((s) => s.id));
  } catch {
    return [];
  }

  const cleared: string[] = [];
  for (const chat of withRuns) {
    const run = chat.activeRun;
    if (!run || liveIds.has(run.execSessionId)) continue;
    try {
      await chatRepository.setActiveRun(chat.id, undefined);
      cleared.push(chat.id);
    } catch {
      continue;
    }
    await syncFinishedChat(spriteName, chat).catch(() => {});
  }
  return cleared;
}

/** Merge the on-disk transcript of a finished run into the persisted chat. */
async function syncFinishedChat(spriteName: string, chat: PersistedChat): Promise<void> {
  const resumeId = isCodexProvider(chat.provider) ? chat.codexSessionId : chat.claudeSessionId;
  if (!resumeId) return;

  const transcript = isCodexProvider(chat.provider)
    ? await readCodexSessionMessages(spriteName, resumeId)
    : await readClaudeSessionMessages(spriteName, resumeId);
  if (transcript.length === 0) return;

  const local = await chatRepository.getMessages(chat.id);
  if (local.length !== 0 && countUserMessages(transcript) < countUserMessages(local)) return;
  const merged = mergeTranscript(local, transcript);
  if (conversationSignature(merged) === conversationSignature(local)) return;
  await chatRepository.setMessages(chat.id, merged);
}
