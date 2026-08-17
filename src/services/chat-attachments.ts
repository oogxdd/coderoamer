import { makeId } from '@/models/chat';
import {
  LocalPickedFile,
  formatBytes,
  joinRemotePath,
  remoteFileName,
  uploadFileToSpriteDir,
} from './sprite-filesystem';

/**
 * Files attached to a chat message.
 *
 * The agent runs *inside* the Sprite, so "attaching" a file means putting it on
 * the Sprite's disk and telling the agent where it landed — there is no vision
 * payload or upload channel in the CLI protocols. A picked file is uploaded as
 * soon as it's chosen (so sending stays instant), and the prompt gets a short
 * header listing the absolute paths, which the agent can then read, unzip, or
 * open like any other file in its workspace.
 *
 * Uploads live outside the working directory so an attachment never turns up as
 * an unexpected untracked file in the user's repo.
 */

export const CHAT_UPLOAD_ROOT = '/home/sprite/uploads';

export interface ChatAttachment {
  /** Local list key; not meaningful on the Sprite. */
  id: string;
  /** File name as picked on the device. */
  name: string;
  /** Absolute path on the Sprite, the value handed to the agent. */
  remotePath: string;
  size?: number;
  mimeType?: string;
}

/** Per-chat upload directory, so two conversations can't collide on a name. */
export function chatUploadDir(chatId: string): string {
  const safeChatId = (chatId || 'chat').replace(/[^A-Za-z0-9._-]/g, '-');
  return `${CHAT_UPLOAD_ROOT}/${safeChatId}`;
}

/**
 * Upload one picked file into the chat's upload directory on the Sprite and
 * describe where it went.
 */
export async function uploadChatAttachment(
  spriteName: string,
  chatId: string,
  file: LocalPickedFile
): Promise<ChatAttachment> {
  const dir = chatUploadDir(chatId);
  const name = remoteFileName(file.name);
  const result = await uploadFileToSpriteDir(spriteName, dir, file);
  return {
    id: makeId(),
    name,
    // The write endpoint echoes the path it used; fall back to the path we asked
    // for when an older server omits it.
    remotePath: result?.path || joinRemotePath(dir, name),
    size: result?.size ?? file.size ?? undefined,
    mimeType: file.mimeType ?? undefined,
  };
}

/**
 * The block prepended to a prompt that carries attachments. Kept in the visible
 * message on purpose: what the agent was told is what the transcript shows.
 */
export function buildAttachmentPreamble(attachments: ChatAttachment[]): string {
  if (attachments.length === 0) return '';
  const lines = attachments.map((attachment) => {
    const details = [attachment.mimeType, attachment.size ? formatBytes(attachment.size) : '']
      .filter(Boolean)
      .join(', ');
    return `- ${attachment.remotePath}${details ? ` (${details})` : ''}`;
  });
  return [
    attachments.length === 1
      ? 'Attached file (already uploaded to this sprite):'
      : 'Attached files (already uploaded to this sprite):',
    ...lines,
  ].join('\n');
}

/** Compose the message actually sent: attachment header first, then the text. */
export function composePromptWithAttachments(
  text: string,
  attachments: ChatAttachment[]
): string {
  const preamble = buildAttachmentPreamble(attachments);
  const body = text.trim();
  if (!preamble) return body;
  return body ? `${preamble}\n\n${body}` : preamble;
}
