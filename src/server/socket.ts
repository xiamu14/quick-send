import type { Server as HttpServer, IncomingHttpHeaders } from "node:http";
import { type } from "arktype";
import { Server } from "socket.io";
import type {
  ClientToServerEvents,
  ServerToClientEvents,
  SocketAck,
} from "@/shared/protocol";
import { messageCreateSchema } from "@/shared/protocol";
import type { ChatMessage, User } from "@/shared/types";
import type { AppDatabase } from "./db";
import { AppError } from "./errors";
import { resolveCredential } from "./identity";
import { createTextMessage } from "./messages";
import { isRoomVisibleToUser, listRoomSummaries } from "./rooms";

type SocketData = { user: User };
const creatorOfflineGraceMs = 30_000;

export type RealtimeHub = ReturnType<typeof createRealtimeHub>;

export function createRealtimeHub(
  httpServer: HttpServer,
  database: AppDatabase
) {
  const io = new Server<
    ClientToServerEvents,
    ServerToClientEvents,
    Record<string, never>,
    SocketData
  >(httpServer, {
    transports: ["websocket"],
    allowUpgrades: false,
    cors: { origin: true },
  });
  const userSockets = new Map<string, Set<string>>();
  const offlineTimers = new Map<string, ReturnType<typeof setTimeout>>();

  io.use(async (socket, next) => {
    try {
      if (!hasMatchingOrigin(socket.handshake.headers)) {
        next(new Error("Invalid origin"));
        return;
      }
      const token =
        typeof socket.handshake.auth.credential === "string"
          ? socket.handshake.auth.credential
          : undefined;
      const user = await resolveCredential(database, token);
      if (!user) {
        next(new Error("Unauthorized"));
        return;
      }
      socket.data.user = user;
      next();
    } catch {
      next(new Error("Unauthorized"));
    }
  });

  io.on("connection", (socket) => {
    const user = socket.data.user;
    const wasOnline = userSockets.has(user.id);
    const offlineTimer = offlineTimers.get(user.id);
    if (offlineTimer) {
      clearTimeout(offlineTimer);
      offlineTimers.delete(user.id);
    }
    const sockets = userSockets.get(user.id) ?? new Set<string>();
    sockets.add(socket.id);
    userSockets.set(user.id, sockets);
    socket.join(`user:${user.id}`);
    for (const row of database
      .query<{ room_id: string; creator_id: string }, [string]>(
        `select rm.room_id, r.creator_id
         from room_members rm join rooms r on r.id = rm.room_id
         where rm.user_id = ?`
      )
      .all(user.id)) {
      if (row.creator_id === user.id || userSockets.has(row.creator_id)) {
        socket.join(`room:${row.room_id}`);
        emitRoomSummary(row.room_id);
      }
    }
    if (!wasOnline) {
      showOwnedRooms(user.id);
    }

    socket.on("message:create", (payload, ack) => {
      handleAck(ack, () => {
        const input = parsePayload(messageCreateSchema, payload);
        if (
          !isRoomVisibleToUser(database, input.roomId, user.id, onlineUserIds())
        ) {
          throw new AppError("ROOM_NOT_FOUND", "Room is not available", 404);
        }
        const message = createTextMessage(database, user, input);
        publishMessage(input.roomId, message);
        return message;
      });
    });

    socket.on("disconnect", () => {
      const current = userSockets.get(user.id);
      current?.delete(socket.id);
      if (current?.size === 0) {
        const timer = setTimeout(() => {
          const latest = userSockets.get(user.id);
          if (latest?.size === 0) {
            userSockets.delete(user.id);
            offlineTimers.delete(user.id);
            hideOwnedRooms(user.id);
            updateJoinedRoomSummaries(user.id);
          }
        }, creatorOfflineGraceMs);
        offlineTimers.set(user.id, timer);
      }
    });
  });

  function onlineUserIds() {
    return new Set(userSockets.keys());
  }

  function emitRoomSummary(roomId: string) {
    const members = database
      .query<{ user_id: string }, [string]>(
        "select user_id from room_members where room_id = ?"
      )
      .all(roomId);
    for (const member of members) {
      const summary = listRoomSummaries(
        database,
        member.user_id,
        onlineUserIds()
      ).find((item) => item.id === roomId);
      if (summary) {
        io.to(`user:${member.user_id}`).emit("room:summary", summary);
      }
    }
  }

  function notifyJoinRequest(roomId: string, requesterId: string) {
    const room = database
      .query<{ creator_id: string }, [string]>(
        "select creator_id from rooms where id = ?"
      )
      .get(roomId);
    if (room) {
      io.to(`user:${room.creator_id}`).emit("join-request:changed", { roomId });
      io.to(`user:${requesterId}`).emit("join-request:changed", { roomId });
      emitRoomSummary(roomId);
    }
  }

  function joinUserToRoom(userId: string, roomId: string) {
    for (const socketId of userSockets.get(userId) ?? []) {
      io.sockets.sockets.get(socketId)?.join(`room:${roomId}`);
    }
    emitRoomSummary(roomId);
  }

  function deleteRoom(roomId: string) {
    io.to(`room:${roomId}`).emit("room:deleted", { roomId });
    io.in(`room:${roomId}`).socketsLeave(`room:${roomId}`);
  }

  function hideOwnedRooms(creatorId: string) {
    for (const room of database
      .query<{ id: string }, [string]>(
        "select id from rooms where creator_id = ?"
      )
      .all(creatorId)) {
      io.emit("room:visibility", { roomId: room.id, visible: false });
      io.in(`room:${room.id}`).socketsLeave(`room:${room.id}`);
    }
  }

  function showOwnedRooms(creatorId: string) {
    for (const room of database
      .query<{ id: string }, [string]>(
        "select id from rooms where creator_id = ?"
      )
      .all(creatorId)) {
      io.emit("room:visibility", { roomId: room.id, visible: true });
      for (const member of database
        .query<{ user_id: string }, [string]>(
          "select user_id from room_members where room_id = ?"
        )
        .all(room.id)) {
        for (const socketId of userSockets.get(member.user_id) ?? []) {
          io.sockets.sockets.get(socketId)?.join(`room:${room.id}`);
        }
      }
      emitRoomSummary(room.id);
    }
  }

  function updateJoinedRoomSummaries(userId: string) {
    for (const room of database
      .query<{ id: string; creator_id: string }, [string, string]>(
        `select r.id, r.creator_id
         from rooms r join room_members rm on rm.room_id = r.id
         where rm.user_id = ? and r.creator_id <> ?`
      )
      .all(userId, userId)) {
      if (userSockets.has(room.creator_id)) {
        emitRoomSummary(room.id);
      }
    }
  }

  function publishMessage(roomId: string, message: ChatMessage) {
    io.to(`room:${roomId}`).emit("message:created", message);
    emitRoomSummary(roomId);
  }

  function deleteMessages(
    messages: Array<{ roomId: string; messageId: string }>
  ) {
    for (const message of messages) {
      io.to(`room:${message.roomId}`).emit("message:deleted", message);
      emitRoomSummary(message.roomId);
    }
  }

  return {
    io,
    onlineUserIds,
    emitRoomSummary,
    publishMessage,
    deleteMessages,
    notifyJoinRequest,
    joinUserToRoom,
    deleteRoom,
    close: () =>
      new Promise<void>((resolve) => {
        for (const timer of offlineTimers.values()) {
          clearTimeout(timer);
        }
        io.close(() => resolve());
      }),
  };
}

function hasMatchingOrigin(headers: IncomingHttpHeaders) {
  const origin = headers.origin;
  const forwardedHost = headers["x-forwarded-host"];
  const host =
    (Array.isArray(forwardedHost) ? forwardedHost[0] : forwardedHost) ??
    headers.host;
  if (!(origin && host)) {
    return false;
  }
  try {
    return new URL(origin).host === host.split(",")[0]?.trim();
  } catch {
    return false;
  }
}

function parsePayload<T>(
  schema: (input: unknown) => T | type.errors,
  input: unknown
): T {
  const result = schema(input);
  if (result instanceof type.errors) {
    throw new AppError("INVALID_PAYLOAD", "Request payload is invalid");
  }
  return result;
}

function handleAck<T>(ack: (result: SocketAck<T>) => void, action: () => T) {
  try {
    ack({ ok: true, data: action() });
  } catch (error) {
    if (error instanceof AppError) {
      ack({
        ok: false,
        error: { code: error.code, message: error.message },
      });
      return;
    }
    console.error(error);
    ack({
      ok: false,
      error: { code: "INTERNAL_ERROR", message: "Something went wrong" },
    });
  }
}
