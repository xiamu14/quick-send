import { atom, createStore } from "jotai";
import type {
  BootstrapPayload,
  ChatMessage,
  FileOffer,
  RoomDetail,
  RoomSummary,
} from "@/shared/types";

export const appStore = createStore();

export const bootstrapAtom = atom<BootstrapPayload | null>(null);
export const bootstrapLoadingAtom = atom(true);
export const socketConnectedAtom = atom(false);
export const currentRoomAtom = atom<RoomDetail | null>(null);
export const messagesAtom = atom<Record<string, ChatMessage[]>>({});
export const messageCursorsAtom = atom<Record<string, string | undefined>>({});
export const transferProgressAtom = atom<Record<string, number>>({});
export const selectedRoomIdAtom = atom<string | null>(null);

export function upsertRoomSummary(summary: RoomSummary) {
  appStore.set(bootstrapAtom, (current) =>
    current
      ? {
          ...current,
          rooms: [
            ...current.rooms.filter((room) => room.id !== summary.id),
            summary,
          ].sort((left, right) => right.lastActivityAt - left.lastActivityAt),
        }
      : current
  );
}

export function removeRoom(roomId: string) {
  appStore.set(bootstrapAtom, (current) =>
    current
      ? {
          ...current,
          rooms: current.rooms.filter((room) => room.id !== roomId),
          pendingRequests: current.pendingRequests.filter(
            (request) => request.roomId !== roomId
          ),
        }
      : current
  );
  appStore.set(messagesAtom, (current) => {
    const next = { ...current };
    delete next[roomId];
    return next;
  });
}

export function addMessage(message: ChatMessage) {
  appStore.set(messagesAtom, (current) => {
    const roomMessages = current[message.roomId] ?? [];
    if (roomMessages.some((item) => item.id === message.id)) {
      return current;
    }
    return {
      ...current,
      [message.roomId]: [...roomMessages, message],
    };
  });
}

export function updateOffer(offer: FileOffer) {
  appStore.set(messagesAtom, (current) => ({
    ...current,
    [offer.roomId]: (current[offer.roomId] ?? []).map((message) =>
      message.fileOffer?.id === offer.id
        ? { ...message, fileOffer: offer }
        : message
    ),
  }));
}
