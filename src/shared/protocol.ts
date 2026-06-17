import { type } from "arktype";
import type { ChatMessage, FileOffer, RoomSummary } from "./types";

export const messageCreateSchema = type({
  roomId: "string",
  clientMessageId: "string",
  body: "string",
});

export const fileCreateSchema = type({
  roomId: "string",
  clientMessageId: "string",
  file: {
    name: "string",
    size: "number",
    mime: "string",
    "previewDataUrl?": "string",
  },
});

export const transferReceiveSchema = type({
  roomId: "string",
  offerId: "string",
});

export const transferStatusSchema = type({
  roomId: "string",
  offerId: "string",
});

export const rtcSchema = type({
  roomId: "string",
  offerId: "string",
  toUserId: "string",
  payload: "unknown",
});

export type SocketAck<T = undefined> =
  | { ok: true; data?: T }
  | { ok: false; error: { code: string; message: string } };

export type ServerToClientEvents = {
  "room:summary": (summary: RoomSummary) => void;
  "room:deleted": (payload: { roomId: string }) => void;
  "join-request:changed": (payload: { roomId: string }) => void;
  "message:created": (message: ChatMessage) => void;
  "file-offer:updated": (offer: FileOffer) => void;
  "transfer:locked": (payload: {
    offer: FileOffer;
    senderUserId: string;
    receiverUserId: string;
  }) => void;
  "rtc:offer": (payload: RtcServerPayload) => void;
  "rtc:answer": (payload: RtcServerPayload) => void;
  "rtc:candidate": (payload: RtcServerPayload) => void;
};

export type ClientToServerEvents = {
  "message:create": (
    payload: typeof messageCreateSchema.infer,
    ack: (result: SocketAck<ChatMessage>) => void
  ) => void;
  "file:create": (
    payload: typeof fileCreateSchema.infer,
    ack: (result: SocketAck<ChatMessage>) => void
  ) => void;
  "transfer:receive": (
    payload: typeof transferReceiveSchema.infer,
    ack: (result: SocketAck<FileOffer>) => void
  ) => void;
  "transfer:complete": (payload: typeof transferStatusSchema.infer) => void;
  "transfer:fail": (payload: typeof transferStatusSchema.infer) => void;
  "rtc:offer": (payload: typeof rtcSchema.infer) => void;
  "rtc:answer": (payload: typeof rtcSchema.infer) => void;
  "rtc:candidate": (payload: typeof rtcSchema.infer) => void;
};

export type RtcServerPayload = {
  roomId: string;
  offerId: string;
  fromUserId: string;
  payload: unknown;
};
