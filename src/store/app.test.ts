import { describe, expect, test } from "bun:test";
import type { BootstrapPayload, RoomSummary } from "@/shared/types";
import { appStore, bootstrapAtom, upsertRoomSummary } from "./app";

describe("app store", () => {
  test("updates the same store consumed by the React provider", () => {
    const bootstrap: BootstrapPayload = {
      user: {
        id: "user-1",
        username: "Ada",
        avatarSeed: "seed",
        deviceKind: "desktop",
        createdAt: 1,
      },
      rooms: [],
      pendingRequests: [],
      limits: {
        maxOwnedRooms: 5,
        maxRoomMembers: 10,
        maxPendingRequests: 5,
        maxFileBytes: 500,
      },
    };
    const room: RoomSummary = {
      id: "room-1",
      name: "Orbit",
      creatorId: "user-1",
      creatorUsername: "Ada",
      isOwner: true,
      onlineCount: 1,
      memberCount: 1,
      pendingCount: 0,
      lastActivityAt: 2,
      createdAt: 2,
    };

    appStore.set(bootstrapAtom, bootstrap);
    upsertRoomSummary(room);

    expect(appStore.get(bootstrapAtom)?.rooms).toEqual([room]);
    appStore.set(bootstrapAtom, null);
  });
});
