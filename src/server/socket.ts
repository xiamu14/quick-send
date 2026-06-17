import type { Server as HttpServer, IncomingHttpHeaders } from "node:http";
import { type } from "arktype";
import { Server } from "socket.io";
import type {
  ClientToServerEvents,
  ServerToClientEvents,
  SocketAck,
} from "@/shared/protocol";
import {
  fileCreateSchema,
  messageCreateSchema,
  rtcSchema,
  transferReceiveSchema,
  transferStatusSchema,
} from "@/shared/protocol";
import type { ChatMessage, User } from "@/shared/types";
import type { AppDatabase } from "./db";
import { AppError } from "./errors";
import { resolveCredential } from "./identity";
import {
  createFileMessage,
  createTextMessage,
  expireOffersForSocket,
  getFileOffer,
  lockTransfer,
  releaseTransfer,
} from "./messages";
import { hasRoomMembership, listRoomSummaries } from "./rooms";

type SocketData = { user: User };

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
    const sockets = userSockets.get(user.id) ?? new Set<string>();
    sockets.add(socket.id);
    userSockets.set(user.id, sockets);
    socket.join(`user:${user.id}`);
    for (const row of database
      .query<{ room_id: string }, [string]>(
        "select room_id from room_members where user_id = ?"
      )
      .all(user.id)) {
      socket.join(`room:${row.room_id}`);
      emitRoomSummary(row.room_id);
    }

    socket.on("message:create", (payload, ack) => {
      handleAck(ack, () => {
        const input = parsePayload(messageCreateSchema, payload);
        const message = createTextMessage(database, user, input);
        publishMessage(input.roomId, message);
        return message;
      });
    });

    socket.on("file:create", (payload, ack) => {
      handleAck(ack, () => {
        const input = parsePayload(fileCreateSchema, payload);
        const message = createFileMessage(database, user, socket.id, input);
        publishMessage(input.roomId, message);
        return message;
      });
    });

    socket.on("transfer:receive", (payload, ack) => {
      handleAck(ack, () => {
        const input = parsePayload(transferReceiveSchema, payload);
        const offer = lockTransfer(database, input.offerId, user.id);
        if (!offer || offer.roomId !== input.roomId) {
          throw new AppError("OFFER_UNAVAILABLE", "File is unavailable", 409);
        }
        io.to(`room:${offer.roomId}`).emit("file-offer:updated", offer);
        io.to(offer.senderSocketId)
          .to(`user:${user.id}`)
          .emit("transfer:locked", {
            offer,
            senderUserId: offer.senderUserId,
            receiverUserId: user.id,
          });
        return offer;
      });
    });

    socket.on("transfer:complete", (payload) => {
      const input = parsePayload(transferStatusSchema, payload);
      const offer = getFileOffer(database, input.offerId);
      if (
        offer?.roomId === input.roomId &&
        (offer.senderUserId === user.id || offer.receiverUserId === user.id)
      ) {
        const next = releaseTransfer(database, offer.id);
        if (next) {
          io.to(`room:${offer.roomId}`).emit("file-offer:updated", next);
        }
      }
    });

    socket.on("transfer:fail", (payload) => {
      const input = parsePayload(transferStatusSchema, payload);
      const offer = getFileOffer(database, input.offerId);
      if (
        offer?.roomId === input.roomId &&
        (offer.senderUserId === user.id || offer.receiverUserId === user.id)
      ) {
        const next = releaseTransfer(database, offer.id);
        if (next) {
          io.to(`room:${offer.roomId}`).emit("file-offer:updated", next);
        }
      }
    });

    for (const eventName of [
      "rtc:offer",
      "rtc:answer",
      "rtc:candidate",
    ] as const) {
      socket.on(eventName, (payload) => {
        const input = parsePayload(rtcSchema, payload);
        if (
          hasRoomMembership(database, input.roomId, user.id) &&
          hasRoomMembership(database, input.roomId, input.toUserId)
        ) {
          io.to(`user:${input.toUserId}`).emit(eventName, {
            roomId: input.roomId,
            offerId: input.offerId,
            fromUserId: user.id,
            payload: input.payload,
          });
        }
      });
    }

    socket.on("disconnect", () => {
      const current = userSockets.get(user.id);
      current?.delete(socket.id);
      if (current?.size === 0) {
        userSockets.delete(user.id);
      }
      for (const offer of expireOffersForSocket(database, socket.id)) {
        io.to(`room:${offer.roomId}`).emit("file-offer:updated", offer);
      }
      setTimeout(() => {
        if (!userSockets.has(user.id)) {
          for (const row of database
            .query<{ room_id: string }, [string]>(
              "select room_id from room_members where user_id = ?"
            )
            .all(user.id)) {
            emitRoomSummary(row.room_id);
          }
        }
      }, 10_000);
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

  function publishMessage(roomId: string, message: ChatMessage) {
    io.to(`room:${roomId}`).emit("message:created", message);
    emitRoomSummary(roomId);
  }

  return {
    io,
    onlineUserIds,
    emitRoomSummary,
    publishMessage,
    notifyJoinRequest,
    joinUserToRoom,
    deleteRoom,
    close: () =>
      new Promise<void>((resolve) => {
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
