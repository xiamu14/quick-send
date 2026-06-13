import type { ChatMessage, FileOffer, MessagePage, User } from "@/shared/types";
import type { AppDatabase } from "./db";
import { AppError } from "./errors";
import { hasRoomMembership, limits } from "./rooms";

const messageLimit = 50;
const offerTtlMs = 30 * 60 * 1000;
const maxPreviewLength = 280_000;

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
  senderSocketId: string,
  input: {
    roomId: string;
    clientMessageId: string;
    file: {
      name: string;
      size: number;
      mime: string;
      previewDataUrl?: string;
    };
  }
) {
  requireMembership(database, input.roomId, sender.id);
  if (input.file.size <= 0 || input.file.size > limits.maxFileBytes) {
    throw new AppError("FILE_TOO_LARGE", "File must be 500 MB or smaller");
  }
  if (
    input.file.previewDataUrl &&
    input.file.previewDataUrl.length > maxPreviewLength
  ) {
    throw new AppError("PREVIEW_TOO_LARGE", "Image preview is too large");
  }
  const existing = getMessageByClientId(
    database,
    sender.id,
    input.clientMessageId
  );
  if (existing) {
    return existing;
  }
  const now = Date.now();
  const offer: FileOffer = {
    id: crypto.randomUUID(),
    roomId: input.roomId,
    senderUserId: sender.id,
    senderSocketId,
    name: input.file.name.slice(0, 255),
    size: input.file.size,
    mime: input.file.mime.slice(0, 120) || "application/octet-stream",
    ...(input.file.previewDataUrl
      ? { previewDataUrl: input.file.previewDataUrl }
      : {}),
    status: "available",
    expiresAt: now + offerTtlMs,
    createdAt: now,
    updatedAt: now,
  };
  const message: ChatMessage = {
    id: crypto.randomUUID(),
    roomId: input.roomId,
    kind: "file",
    senderUserId: sender.id,
    senderUsername: sender.username,
    senderAvatarSeed: sender.avatarSeed,
    senderDeviceKind: sender.deviceKind,
    fileOffer: offer,
    createdAt: now,
  };
  database.transaction(() => {
    database
      .query(
        `insert into file_offers(
          id, room_id, sender_user_id, sender_socket_id, name, size, mime,
          preview_data_url, status, expires_at, created_at, updated_at
        ) values(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        offer.id,
        offer.roomId,
        offer.senderUserId,
        offer.senderSocketId,
        offer.name,
        offer.size,
        offer.mime,
        offer.previewDataUrl ?? null,
        offer.status,
        offer.expiresAt,
        now,
        now
      );
    database
      .query(
        `insert into messages(
          id, room_id, sender_user_id, client_message_id, kind,
          file_offer_id, created_at
        ) values(?, ?, ?, ?, 'file', ?, ?)`
      )
      .run(
        message.id,
        message.roomId,
        message.senderUserId,
        input.clientMessageId,
        offer.id,
        now
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
  const rows = decoded
    ? database
        .query<MessageRow, [string, number, number, string, number]>(
          `${messageSelect}
           where m.room_id = ?
           and (m.created_at < ? or (m.created_at = ? and m.id < ?))
           order by m.created_at desc, m.id desc limit ?`
        )
        .all(
          roomId,
          decoded.createdAt,
          decoded.createdAt,
          decoded.id,
          messageLimit + 1
        )
    : database
        .query<MessageRow, [string, number]>(
          `${messageSelect}
           where m.room_id = ?
           order by m.created_at desc, m.id desc limit ?`
        )
        .all(roomId, messageLimit + 1);
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

export function getFileOffer(
  database: AppDatabase,
  offerId: string
): FileOffer | undefined {
  const row = database
    .query<FileOfferRow, [string]>("select * from file_offers where id = ?")
    .get(offerId);
  return row ? mapOffer(row) : undefined;
}

export function lockTransfer(
  database: AppDatabase,
  offerId: string,
  receiverUserId: string
) {
  const offer = getFileOffer(database, offerId);
  if (offer?.status !== "available" || offer.expiresAt <= Date.now()) {
    throw new AppError("OFFER_UNAVAILABLE", "File is no longer available", 409);
  }
  requireMembership(database, offer.roomId, receiverUserId);
  if (
    hasActiveTransfer(database, offer.senderUserId) ||
    hasActiveTransfer(database, receiverUserId)
  ) {
    throw new AppError("SENDER_BUSY", "Sender is busy", 409);
  }
  database
    .query(
      `update file_offers set
        receiver_user_id = ?, status = 'transferring', updated_at = ?
       where id = ?`
    )
    .run(receiverUserId, Date.now(), offerId);
  return getFileOffer(database, offerId);
}

export function releaseTransfer(database: AppDatabase, offerId: string) {
  const offer = getFileOffer(database, offerId);
  if (!offer || offer.expiresAt <= Date.now()) {
    return expireOffer(database, offerId);
  }
  database
    .query(
      `update file_offers set
        receiver_user_id = null, status = 'available', updated_at = ?
       where id = ?`
    )
    .run(Date.now(), offerId);
  return getFileOffer(database, offerId);
}

export function expireOffersForSocket(database: AppDatabase, socketId: string) {
  const rows = database
    .query<FileOfferRow, [string]>(
      `select * from file_offers
       where sender_socket_id = ? and status in ('available', 'transferring')`
    )
    .all(socketId);
  database
    .query(
      `update file_offers set status = 'sender_offline', updated_at = ?
       where sender_socket_id = ? and status in ('available', 'transferring')`
    )
    .run(Date.now(), socketId);
  return rows.map((row) => ({
    ...mapOffer(row),
    status: "sender_offline" as const,
    updatedAt: Date.now(),
  }));
}

export function cleanupOffers(database: AppDatabase) {
  database
    .query(
      `update file_offers set status = 'expired', updated_at = ?
       where expires_at < ? and status in ('available', 'transferring')`
    )
    .run(Date.now(), Date.now());
}

function expireOffer(database: AppDatabase, offerId: string) {
  database
    .query(
      "update file_offers set status = 'expired', updated_at = ? where id = ?"
    )
    .run(Date.now(), offerId);
  return getFileOffer(database, offerId);
}

function hasActiveTransfer(database: AppDatabase, userId: string) {
  return Boolean(
    database
      .query<{ id: string }, [string, string]>(
        `select id from file_offers where status = 'transferring'
         and (sender_user_id = ? or receiver_user_id = ?) limit 1`
      )
      .get(userId, userId)
  );
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
    f.id as offer_id, f.sender_socket_id, f.receiver_user_id,
    f.name as offer_name, f.size as offer_size, f.mime as offer_mime,
    f.preview_data_url, f.status as offer_status,
    f.expires_at, f.created_at as offer_created_at,
    f.updated_at as offer_updated_at
  from messages m
  join users u on u.id = m.sender_user_id
  left join file_offers f on f.id = m.file_offer_id
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
  offer_id: string | null;
  sender_socket_id: string | null;
  receiver_user_id: string | null;
  offer_name: string | null;
  offer_size: number | null;
  offer_mime: string | null;
  preview_data_url: string | null;
  offer_status: FileOffer["status"] | null;
  expires_at: number | null;
  offer_created_at: number | null;
  offer_updated_at: number | null;
};

type FileOfferRow = {
  id: string;
  room_id: string;
  sender_user_id: string;
  sender_socket_id: string;
  receiver_user_id: string | null;
  name: string;
  size: number;
  mime: string;
  preview_data_url: string | null;
  status: FileOffer["status"];
  expires_at: number;
  created_at: number;
  updated_at: number;
};

function mapMessage(row: MessageRow): ChatMessage {
  const offer =
    row.offer_id &&
    row.sender_socket_id &&
    row.offer_name &&
    row.offer_size !== null &&
    row.offer_mime &&
    row.offer_status &&
    row.expires_at !== null &&
    row.offer_created_at !== null &&
    row.offer_updated_at !== null
      ? {
          id: row.offer_id,
          roomId: row.room_id,
          senderUserId: row.sender_user_id,
          senderSocketId: row.sender_socket_id,
          ...(row.receiver_user_id
            ? { receiverUserId: row.receiver_user_id }
            : {}),
          name: row.offer_name,
          size: row.offer_size,
          mime: row.offer_mime,
          ...(row.preview_data_url
            ? { previewDataUrl: row.preview_data_url }
            : {}),
          status: row.offer_status,
          expiresAt: row.expires_at,
          createdAt: row.offer_created_at,
          updatedAt: row.offer_updated_at,
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
    ...(offer ? { fileOffer: offer } : {}),
    createdAt: row.message_created_at,
  };
}

function mapOffer(row: FileOfferRow): FileOffer {
  return {
    id: row.id,
    roomId: row.room_id,
    senderUserId: row.sender_user_id,
    senderSocketId: row.sender_socket_id,
    ...(row.receiver_user_id ? { receiverUserId: row.receiver_user_id } : {}),
    name: row.name,
    size: row.size,
    mime: row.mime,
    ...(row.preview_data_url ? { previewDataUrl: row.preview_data_url } : {}),
    status: row.status,
    expiresAt: row.expires_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
