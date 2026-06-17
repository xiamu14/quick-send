import { io, type Socket } from "socket.io-client";
import type {
  ClientToServerEvents,
  ServerToClientEvents,
} from "@/shared/protocol";
import type { BootstrapPayload } from "@/shared/types";
import {
  addMessage,
  appStore,
  bootstrapAtom,
  removeRoom,
  socketConnectedAtom,
  updateOffer,
  upsertRoomSummary,
} from "@/store/app";
import { ApiError, api } from "./api";
import { getCredential } from "./credential";
import { toast } from "./toast";

export type AppSocket = Socket<ServerToClientEvents, ClientToServerEvents>;

let socket: AppSocket | undefined;
let socketCredential: string | undefined;
let onRoomDeleted: ((roomId: string) => void) | undefined;
let onRoomSummary:
  | ((summary: BootstrapPayload["rooms"][number]) => void)
  | undefined;
let onTransferLocked:
  | ((payload: Parameters<ServerToClientEvents["transfer:locked"]>[0]) => void)
  | undefined;
let onRtc:
  | ((
      type: "rtc:offer" | "rtc:answer" | "rtc:candidate",
      payload: Parameters<ServerToClientEvents["rtc:offer"]>[0]
    ) => void)
  | undefined;

export function getSocket() {
  const credential = getCredential();
  if (socket) {
    if (socketCredential !== credential) {
      socket.disconnect();
      socket.auth = { credential };
      socketCredential = credential;
    }
    if (!socket.connected) {
      socket.connect();
    }
    return socket;
  }
  socketCredential = credential;
  socket = io({
    auth: { credential },
    transports: ["websocket"],
    reconnectionDelay: 1000,
    reconnectionDelayMax: 10_000,
  });
  socket.on("connect", () => {
    appStore.set(socketConnectedAtom, true);
    void refreshBootstrap();
  });
  socket.on("disconnect", () => {
    appStore.set(socketConnectedAtom, false);
  });
  socket.on("connect_error", () => {
    appStore.set(socketConnectedAtom, false);
  });
  socket.on("room:summary", (summary) => {
    upsertRoomSummary(summary);
    onRoomSummary?.(summary);
  });
  socket.on("room:deleted", ({ roomId }) => {
    removeRoom(roomId);
    onRoomDeleted?.(roomId);
    toast("Room was deleted");
  });
  socket.on("join-request:changed", () => void refreshBootstrap());
  socket.on("message:created", addMessage);
  socket.on("file-offer:updated", updateOffer);
  socket.on("transfer:locked", (payload) => onTransferLocked?.(payload));
  for (const eventName of [
    "rtc:offer",
    "rtc:answer",
    "rtc:candidate",
  ] as const) {
    socket.on(eventName, (payload) => onRtc?.(eventName, payload));
  }
  return socket;
}

export function disconnectSocket() {
  socket?.disconnect();
  socket = undefined;
  socketCredential = undefined;
}

export function setRoomDeletedHandler(
  handler: ((roomId: string) => void) | undefined
) {
  onRoomDeleted = handler;
}

export function setRoomSummaryHandler(
  handler: ((summary: BootstrapPayload["rooms"][number]) => void) | undefined
) {
  onRoomSummary = handler;
}

export function setTransferHandlers(
  locked:
    | ((
        payload: Parameters<ServerToClientEvents["transfer:locked"]>[0]
      ) => void)
    | undefined,
  rtc:
    | ((
        type: "rtc:offer" | "rtc:answer" | "rtc:candidate",
        payload: Parameters<ServerToClientEvents["rtc:offer"]>[0]
      ) => void)
    | undefined
) {
  onTransferLocked = locked;
  onRtc = rtc;
}

export async function refreshBootstrap() {
  try {
    const bootstrap = await api<BootstrapPayload>("/api/bootstrap");
    appStore.set(bootstrapAtom, bootstrap);
    return bootstrap;
  } catch (error) {
    if (error instanceof ApiError && error.code === "UNAUTHORIZED") {
      appStore.set(bootstrapAtom, null);
      return null;
    }
    return;
  }
}
