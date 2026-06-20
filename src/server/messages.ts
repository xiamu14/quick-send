import type {
  ChatMessage,
  FileAttachment,
  MessagePage,
  User,
} from "@/shared/types";
import type { AppDatabase } from "./db";
import { AppError } from "./errors";
import { hasRoomMembership, limits } from "./rooms";

const messageLimit = 50;
const fileTtlMs = 3 * 24 * 60 * 60 * 1000;
const maxPreviewLength = 280_000;
const md5Pattern = /^[a-f0-9]{32}$/;

export type FileMessageInput = {
  roomId: string;
  clientMessageId: string;
  fileId: string;
  name: string;
  size: number;
  mime: string;
  previewDataUrl?: string;
};

export function createTextMessage(
  database: AppDatabase,
  sender: User,
  input: { roomId: string; clientMessageId: string; body: string }
) {
  requireMembership(database, input.roomId, sender.id);
  const body = input.body.trim();
  if (!body) {
    throw new AppError("EMPTY_MESSAGE", "Message cannot be empty");
  }
  if (new TextEncoder().encode(body).byteLength > 8192) {
    throw new AppError("MESSAGE_TOO_LONG", "Message is too long");
  }
  const existing = getMessageByClientId(
    database,
    sender.id,
    input.clientMessageId
  );
  if (existing) {
    return existing;
  }
  const message: ChatMessage = {
    id: crypto.randomUUID(),
    roomId: input.roomId,
    kind: "text",
    senderUserId: sender.id,
    senderUsername: sender.username,
    senderAvatarSeed: sender.avatarSeed,
    senderDeviceKind: sender.deviceKind,
    body,
    createdAt: Date.now(),
  };
  database
    .query(
      `insert into messages(
        id, room_id, sender_user_id, client_message_id, kind, body, created_at
      ) values(?, ?, ?, ?, 'text', ?, ?)`
    )
    .run(
      message.id,
      message.roomId,
      message.senderUserId,
      input.clientMessageId,
      body,
      message.createdAt
    );
  return message;
}

export function createFileMessage(
  database: AppDatabase,
  sender: User,
  input: FileMessageInput
) {
  requireMembership(database, input.roomId, sender.id);
  validateFileInput(input);
  const existing = getMessageByClientId(
    database,
    sender.id,
    input.clientMessageId
  );
  if (existing) {
    return existing;
  }
  const stored = database
    .query<{ size: number }, [string]>(
      "select size from server_files where id = ?"
    )
    .get(input.fileId);
  if (!stored) {
    return;
  }
  if (stored.size !== input.size) {
    throw new AppError(
      "FILE_HASH_CONFLICT",
      "Stored file size does not match this file ID",
      409
    );
  }
  const now = Date.now();
  const attachment: FileAttachment = {
    fileId: input.fileId,
    name: input.name.slice(0, 255),
    size: input.size,
    mime: input.mime.slice(0, 120) || "application/octet-stream",
    ...(input.previewDataUrl ? { previewDataUrl: input.previewDataUrl } : {}),
    expiresAt: now + fileTtlMs,
  };
  const message: ChatMessage = {
    id: crypto.randomUUID(),
    roomId: input.roomId,
    kind: "file",
    senderUserId: sender.id,
    senderUsername: sender.username,
    senderAvatarSeed: sender.avatarSeed,
    senderDeviceKind: sender.deviceKind,
    fileAttachment: attachment,
    createdAt: now,
  };
  database.transaction(() => {
    database
      .query(
        `insert into messages(
          id, room_id, sender_user_id, client_message_id, kind, created_at
        ) values(?, ?, ?, ?, 'file', ?)`
      )
      .run(message.id, input.roomId, sender.id, input.clientMessageId, now);
    database
      .query(
        `insert into message_files(
          message_id, file_id, name, mime, size, preview_data_url, expires_at
        ) values(?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        message.id,
        attachment.fileId,
        attachment.name,
        attachment.mime,
        attachment.size,
        attachment.previewDataUrl ?? null,
        attachment.expiresAt
      );
  })();
  return message;
}

export function listMessages(
  database: AppDatabase,
  roomId: string,
  userId: string,
  cursor?: string
): MessagePage {
  requireMembership(database, roomId, userId);
  const decoded = cursor ? decodeCursor(cursor) : undefined;
  const now = Date.now();
  const rows = decoded
    ? database
        .query<MessageRow, [string, number, number, number, string, number]>(
          `${messageSelect}
           where m.room_id = ?
           and (m.kind <> 'file' or mf.expires_at > ?)
           and (m.created_at < ? or (m.created_at = ? and m.id < ?))
           order by m.created_at desc, m.id desc limit ?`
        )
        .all(
          roomId,
          now,
          decoded.createdAt,
          decoded.createdAt,
          decoded.id,
          messageLimit + 1
        )
    : database
        .query<MessageRow, [string, number, number]>(
          `${messageSelect}
           where m.room_id = ?
           and (m.kind <> 'file' or mf.expires_at > ?)
           order by m.created_at desc, m.id desc limit ?`
        )
        .all(roomId, now, messageLimit + 1);
  const hasMore = rows.length > messageLimit;
  const pageRows = rows.slice(0, messageLimit);
  const last = pageRows.at(-1);
  return {
    messages: pageRows.reverse().map(mapMessage),
    ...(hasMore && last
      ? { nextCursor: encodeCursor(last.message_created_at, last.message_id) }
      : {}),
  };
}

export function getFileDownload(
  database: AppDatabase,
  messageId: string,
  userId: string
) {
  return database
    .query<
      {
        file_id: string;
        room_id: string;
        storage_path: string;
        name: string;
        mime: string;
        size: number;
      },
      [string, string, number]
    >(
      `select sf.id as file_id, m.room_id, sf.storage_path,
        mf.name, mf.mime, mf.size
       from messages m
       join message_files mf on mf.message_id = m.id
       join server_files sf on sf.id = mf.file_id
       join room_members rm on rm.room_id = m.room_id
       where m.id = ? and rm.user_id = ? and mf.expires_at > ?`
    )
    .get(messageId, userId, Date.now());
}

function validateFileInput(input: FileMessageInput) {
  if (!md5Pattern.test(input.fileId)) {
    throw new AppError("INVALID_FILE_ID", "File ID must be an MD5 hash");
  }
  if (input.size <= 0 || input.size > limits.maxFileBytes) {
    throw new AppError("FILE_TOO_LARGE", "File must be 200 MB or smaller");
  }
  if (input.previewDataUrl && input.previewDataUrl.length > maxPreviewLength) {
    throw new AppError("PREVIEW_TOO_LARGE", "Image preview is too large");
  }
}

function requireMembership(
  database: AppDatabase,
  roomId: string,
  userId: string
) {
  if (!hasRoomMembership(database, roomId, userId)) {
    throw new AppError("FORBIDDEN", "Room membership is required", 403);
  }
}

function getMessageByClientId(
  database: AppDatabase,
  senderId: string,
  clientMessageId: string
) {
  const row = database
    .query<MessageRow, [string, string]>(
      `${messageSelect}
       where m.sender_user_id = ? and m.client_message_id = ?`
    )
    .get(senderId, clientMessageId);
  return row ? mapMessage(row) : undefined;
}

function encodeCursor(createdAt: number, id: string) {
  return Buffer.from(JSON.stringify({ createdAt, id })).toString("base64url");
}

function decodeCursor(value: string) {
  try {
    const parsed = JSON.parse(
      Buffer.from(value, "base64url").toString("utf8")
    ) as unknown;
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      "createdAt" in parsed &&
      "id" in parsed &&
      typeof parsed.createdAt === "number" &&
      typeof parsed.id === "string"
    ) {
      return { createdAt: parsed.createdAt, id: parsed.id };
    }
  } catch {
    // Invalid cursors return the same public error.
  }
  throw new AppError("INVALID_CURSOR", "Message cursor is invalid");
}

const messageSelect = `
  select
    m.id as message_id, m.room_id, m.kind, m.body,
    m.created_at as message_created_at,
    u.id as sender_user_id, u.username as sender_username,
    u.avatar_seed as sender_avatar_seed, u.device_kind as sender_device_kind,
    mf.file_id, mf.name as file_name, mf.size as file_size,
    mf.mime as file_mime, mf.preview_data_url, mf.expires_at
  from messages m
  join users u on u.id = m.sender_user_id
  left join message_files mf on mf.message_id = m.id
`;

type MessageRow = {
  message_id: string;
  room_id: string;
  kind: ChatMessage["kind"];
  body: string | null;
  message_created_at: number;
  sender_user_id: string;
  sender_username: string;
  sender_avatar_seed: string;
  sender_device_kind: User["deviceKind"];
  file_id: string | null;
  file_name: string | null;
  file_size: number | null;
  file_mime: string | null;
  preview_data_url: string | null;
  expires_at: number | null;
};

function mapMessage(row: MessageRow): ChatMessage {
  const attachment =
    row.file_id &&
    row.file_name &&
    row.file_size !== null &&
    row.file_mime &&
    row.expires_at !== null
      ? {
          fileId: row.file_id,
          name: row.file_name,
          size: row.file_size,
          mime: row.file_mime,
          ...(row.preview_data_url
            ? { previewDataUrl: row.preview_data_url }
            : {}),
          expiresAt: row.expires_at,
        }
      : undefined;
  return {
    id: row.message_id,
    roomId: row.room_id,
    kind: row.kind,
    senderUserId: row.sender_user_id,
    senderUsername: row.sender_username,
    senderAvatarSeed: row.sender_avatar_seed,
    senderDeviceKind: row.sender_device_kind,
    ...(row.body ? { body: row.body } : {}),
    ...(attachment ? { fileAttachment: attachment } : {}),
    createdAt: row.message_created_at,
  };
}
