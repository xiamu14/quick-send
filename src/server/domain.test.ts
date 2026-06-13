import { afterEach, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { decodeBase32IgnorePadding } from "@oslojs/encoding";
import { generateTOTP } from "@oslojs/otp";
import type { User } from "@/shared/types";
import { type AppDatabase, openDatabase } from "./db";
import {
  confirmRegistration,
  normalizeUsername,
  resolveCredential,
  startRegistration,
} from "./identity";
import { createTextMessage, listMessages } from "./messages";
import {
  createRoom,
  deleteRoom,
  listRoomSummaries,
  requestToJoin,
  resolveJoinRequest,
} from "./rooms";

const databases: Array<{ database: AppDatabase; path: string }> = [];
const recoveryCodePattern = /^[2-9A-HJ-NP-Z]{4}(?:-[2-9A-HJ-NP-Z]{4}){2}$/;

afterEach(() => {
  for (const item of databases.splice(0)) {
    item.database.close();
    rmSync(item.path, { force: true });
    rmSync(`${item.path}-shm`, { force: true });
    rmSync(`${item.path}-wal`, { force: true });
  }
});

describe("identity", () => {
  test("registers a TOTP identity and resolves its credential", async () => {
    const { database } = createTestDatabase();
    const encryptionKey = crypto.getRandomValues(new Uint8Array(32));
    const setup = startRegistration(database, "  Ada  Lovelace ", "desktop");
    const code = generateTOTP(decodeBase32IgnorePadding(setup.secret), 30, 6);
    const result = await confirmRegistration(
      database,
      encryptionKey,
      setup.setupToken,
      code
    );
    expect(result.user.username).toBe("Ada Lovelace");
    expect(result.recoveryCode).toMatch(recoveryCodePattern);
    expect(
      await resolveCredential(database, result.credentialToken)
    ).toMatchObject({
      id: result.user.id,
      username: "Ada Lovelace",
    });
  });

  test("rejects invalid usernames", () => {
    expect(() => normalizeUsername("a")).toThrow();
    expect(() => normalizeUsername("bad/name")).toThrow();
  });
});

describe("rooms and messages", () => {
  test("approves a join request and exposes the room to both users", () => {
    const { database } = createTestDatabase();
    const creator = insertUser(database, "Creator");
    const guest = insertUser(database, "Guest");
    const room = createRoom(database, creator);
    const requestId = requestToJoin(database, room.id, guest);
    resolveJoinRequest(database, requestId, creator.id, "approved");

    expect(listRoomSummaries(database, creator.id, new Set()).length).toBe(1);
    expect(listRoomSummaries(database, guest.id, new Set()).length).toBe(1);
  });

  test("paginates room history with an opaque cursor", () => {
    const { database } = createTestDatabase();
    const creator = insertUser(database, "Writer");
    const room = createRoom(database, creator);
    for (let index = 0; index < 60; index += 1) {
      createTextMessage(database, creator, {
        roomId: room.id,
        clientMessageId: `message-${index}`,
        body: `Message ${index}`,
      });
    }

    const latest = listMessages(database, room.id, creator.id);
    expect(latest.messages.length).toBe(50);
    expect(latest.nextCursor).toBeDefined();
    const earlier = listMessages(
      database,
      room.id,
      creator.id,
      latest.nextCursor
    );
    expect(earlier.messages.length).toBe(10);
  });

  test("deleting a room cascades messages and membership", () => {
    const { database } = createTestDatabase();
    const creator = insertUser(database, "Owner");
    const room = createRoom(database, creator);
    createTextMessage(database, creator, {
      roomId: room.id,
      clientMessageId: "hello",
      body: "Hello",
    });

    deleteRoom(database, creator.id, room.id, room.name);

    expect(
      database
        .query<{ count: number }, []>("select count(*) as count from messages")
        .get()?.count
    ).toBe(0);
    expect(listRoomSummaries(database, creator.id, new Set())).toEqual([]);
  });
});

function createTestDatabase() {
  const path = join(
    process.env.TMPDIR ?? "/tmp",
    `quick-send-${crypto.randomUUID()}.sqlite`
  );
  const database = openDatabase(path);
  databases.push({ database, path });
  return { database, path };
}

function insertUser(database: AppDatabase, username: string): User {
  const user: User = {
    id: crypto.randomUUID(),
    username,
    avatarSeed: crypto.randomUUID(),
    deviceKind: "desktop",
    createdAt: Date.now(),
  };
  database
    .query(
      `insert into users(
        id, username, avatar_seed, device_kind, totp_ciphertext, created_at
      ) values(?, ?, ?, ?, 'test', ?)`
    )
    .run(
      user.id,
      user.username,
      user.avatarSeed,
      user.deviceKind,
      user.createdAt
    );
  return user;
}
