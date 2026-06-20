import { type } from "arktype";
import type { ChatMessage, RoomSummary } from "./types";

export const messageCreateSchema = type({
  roomId: "string",
  clientMessageId: "string",
  body: "string",
});

export type SocketAck<T = undefined> =
  | { ok: true; data?: T }
  | { ok: false; error: { code: string; message: string } };

export type ServerToClientEvents = {
  "room:summary": (summary: RoomSummary) => void;
  "room:deleted": (payload: { roomId: string }) => void;
  "room:visibility": (payload: { roomId: string; visible: boolean }) => void;
  "join-request:changed": (payload: { roomId: string }) => void;
  "message:created": (message: ChatMessage) => void;
  "message:deleted": (payload: { roomId: string; messageId: string }) => void;
};

export type ClientToServerEvents = {
  "message:create": (
    payload: typeof messageCreateSchema.infer,
    ack: (result: SocketAck<ChatMessage>) => void
  ) => void;
};
