import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { join } from "node:path";
import type { User } from "@/shared/types";
import { type AppDatabase, openDatabase } from "./db";
import {
  deviceNameFromUserAgent,
  ensureIdentity,
  resolveCredential,
} from "./identity";
import { createTextMessage, listMessages } from "./messages";
import {
  createRoom,
  deleteRoom,
  getRoomDetail,
  listDiscoverRooms,
  listRoomSummaries,
  requestToJoin,
  resolveJoinRequest,
} from "./rooms";

const databases: Array<{ database: AppDatabase; path: string }> = [];
const shortIdPattern = /^[2-9A-HJ-NP-Z]{4,6}$/;

afterEach(() => {
  for (const item of databases.splice(0)) {
    item.database.close();
    rmSync(item.path, { force: true });
    rmSync(`${item.path}-shm`, { force: true });
    rmSync(`${item.path}-wal`, { force: true });
  }
});

describe("identity", () => {
  test.each([
    [
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36",
      "Mac OS",
    ],
    [
      "Mozilla/5.0 (Linux; Android 14; vivo V2338A Build/UP1A) AppleWebKit/537.36 Mobile",
      "vivo V2338A",
    ],
    ["Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)", "iPhone"],
  ])("extracts a readable device name from UA", (userAgent, expected) => {
    expect(deviceNameFromUserAgent(userAgent)).toBe(expected);
  });

  test("creates a fingerprint identity and resolves its credential", async () => {
    const { database } = createTestDatabase();
    const result = await ensureIdentity(database, "visitor-a", "desktop");
    expect(result.user.id).toMatch(shortIdPattern);
    expect(result.user.username).toBe(result.user.id);
    expect(
      await resolveCredential(database, result.credentialToken)
    ).toMatchObject({
      id: result.user.id,
      username: result.user.username,
    });
  });

  test("returns the same user for the same fingerprint", async () => {
    const { database } = createTestDatabase();
    const first = await ensureIdentity(
      database,
      "visitor-a",
      "desktop",
      "Mac OS"
    );
    const second = await ensureIdentity(
      database,
      "visitor-a",
      "mobile",
      "vivo V2338A"
    );

    expect(
      await resolveCredential(database, first.credentialToken)
    ).toBeUndefined();
    expect(
      await resolveCredential(database, second.credentialToken)
    ).toMatchObject({
      id: first.user.id,
      deviceKind: "mobile",
      deviceName: "vivo V2338A",
    });
  });

  test("uses native device ids as stable identities", async () => {
    const { database } = createTestDatabase();
    const browser = await ensureIdentity(
      database,
      "shared-id",
      "desktop",
      "Mac OS"
    );
    const device = await ensureIdentity(
      database,
      "shared-id",
      "mobile",
      "iPhone",
      "device"
    );
    const sameDevice = await ensureIdentity(
      database,
      "shared-id",
      "mobile",
      "iPhone",
      "device"
    );

    expect(device.user.id).not.toBe(browser.user.id);
    expect(sameDevice.user.id).toBe(device.user.id);
  });

  test("prunes legacy MFA identities and rooms during migration", () => {
    const path = testDatabasePath();
    seedLegacyV2Database(path);
    const database = openDatabase(path);
    databases.push({ database, path });

    expect(
      database
        .query<{ count: number }, []>(
          "select count(*) as count from users where fingerprint_hash is null"
        )
        .get()?.count
    ).toBe(0);
    expect(
      database
        .query<{ name: string }, []>("select name from rooms")
        .all()
        .map((room) => room.name)
    ).toEqual(["New room"]);
  });

  test("prunes orphaned identity records during migration", () => {
    const path = testDatabasePath();
    seedOrphanedV3Database(path);
    const database = openDatabase(path);
    databases.push({ database, path });

    expect(database.query("pragma foreign_key_check").all()).toEqual([]);
    expect(
      database
        .query<{ actor_user_id: string | null }, []>(
          "select actor_user_id from audit_logs where id = 'orphan-audit'"
        )
        .get()?.actor_user_id
    ).toBeNull();
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

    const online = new Set([creator.id]);
    expect(listRoomSummaries(database, creator.id, online).length).toBe(1);
    expect(listRoomSummaries(database, guest.id, online).length).toBe(1);
  });

  test("hides a room from other devices while its creator is offline", () => {
    const { database } = createTestDatabase();
    const creator = insertUser(database, "OnlineOwner");
    const guest = insertUser(database, "Visitor");
    const room = createRoom(database, creator);

    expect(listDiscoverRooms(database, guest.id, new Set())).toEqual([]);
    expect(
      getRoomDetail(database, room.id, guest.id, new Set())
    ).toBeUndefined();
    expect(listRoomSummaries(database, creator.id, new Set()).length).toBe(1);

    const online = new Set([creator.id]);
    expect(listDiscoverRooms(database, guest.id, online).length).toBe(1);
    expect(getRoomDetail(database, room.id, guest.id, online)?.id).toBe(
      room.id
    );
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
  const path = testDatabasePath();
  const database = openDatabase(path);
  databases.push({ database, path });
  return { database, path };
}

function testDatabasePath() {
  return join(
    process.env.TMPDIR ?? "/tmp",
    `quick-send-${crypto.randomUUID()}.sqlite`
  );
}

function seedLegacyV2Database(path: string) {
  const database = new Database(path, { create: true });
  database.exec(`
    pragma foreign_keys = ON;

    create table schema_migrations (
      version integer primary key,
      applied_at integer not null
    );
    insert into schema_migrations(version, applied_at) values(1, 1), (2, 2);

    create table users (
      id text primary key,
      username text not null collate nocase unique,
      avatar_seed text not null,
      device_kind text not null,
      fingerprint_hash text unique,
      created_at integer not null
    );

    create table credentials (
      id text primary key,
      user_id text not null unique references users(id) on delete cascade,
      token_hash text not null unique,
      created_at integer not null,
      last_used_at integer not null
    );

    create table rooms (
      id text primary key,
      name text not null,
      creator_id text not null references users(id),
      created_at integer not null
    );

    create table room_members (
      room_id text not null references rooms(id) on delete cascade,
      user_id text not null references users(id) on delete cascade,
      joined_at integer not null,
      primary key(room_id, user_id)
    );

    create table join_requests (
      id text primary key,
      room_id text not null references rooms(id) on delete cascade,
      requester_id text not null references users(id) on delete cascade,
      status text not null,
      created_at integer not null,
      resolved_at integer,
      unique(room_id, requester_id)
    );

    create table file_offers (
      id text primary key,
      room_id text not null references rooms(id) on delete cascade,
      sender_user_id text not null references users(id),
      receiver_user_id text references users(id),
      status text not null,
      updated_at integer not null
    );

    create table messages (
      id text primary key,
      room_id text not null references rooms(id) on delete cascade,
      sender_user_id text not null references users(id),
      client_message_id text not null,
      kind text not null,
      body text,
      file_offer_id text references file_offers(id) on delete cascade,
      created_at integer not null,
      unique(sender_user_id, client_message_id)
    );

    create table audit_logs (
      id text primary key,
      actor_user_id text references users(id) on delete set null,
      room_id text references rooms(id) on delete set null,
      action text not null,
      created_at integer not null
    );

    insert into users(
      id, username, avatar_seed, device_kind, fingerprint_hash, created_at
    ) values
      ('legacy-user', 'mac-air', 'legacy-seed', 'desktop', null, 1),
      ('fingerprint-user', 'ABCD', 'fingerprint-seed', 'desktop', 'hash', 2);

    insert into rooms(id, name, creator_id, created_at) values
      ('legacy-room', 'Old room', 'legacy-user', 1),
      ('fingerprint-room', 'New room', 'fingerprint-user', 2);

    insert into room_members(room_id, user_id, joined_at) values
      ('legacy-room', 'legacy-user', 1),
      ('fingerprint-room', 'fingerprint-user', 2);
  `);
  database.close();
}

function seedOrphanedV3Database(path: string) {
  const database = new Database(path, { create: true });
  database.exec(`
    pragma foreign_keys = OFF;

    create table schema_migrations (
      version integer primary key,
      applied_at integer not null
    );
    insert into schema_migrations(version, applied_at)
    values(1, 1), (2, 2), (3, 3);

    create table users (
      id text primary key,
      username text not null collate nocase unique,
      avatar_seed text not null,
      device_kind text not null,
      fingerprint_hash text unique,
      created_at integer not null
    );

    create table credentials (
      id text primary key,
      user_id text not null unique references users(id) on delete cascade,
      token_hash text not null unique,
      created_at integer not null,
      last_used_at integer not null
    );

    create table rooms (
      id text primary key,
      name text not null,
      creator_id text not null references users(id),
      created_at integer not null
    );

    create table room_members (
      room_id text not null references rooms(id) on delete cascade,
      user_id text not null references users(id) on delete cascade,
      joined_at integer not null,
      primary key(room_id, user_id)
    );

    create table file_offers (
      id text primary key,
      room_id text not null references rooms(id) on delete cascade,
      sender_user_id text not null references users(id),
      receiver_user_id text references users(id),
      status text not null,
      updated_at integer not null
    );

    create table messages (
      id text primary key,
      room_id text not null references rooms(id) on delete cascade,
      sender_user_id text not null references users(id),
      client_message_id text not null,
      kind text not null,
      body text,
      file_offer_id text references file_offers(id) on delete cascade,
      created_at integer not null,
      unique(sender_user_id, client_message_id)
    );

    create table audit_logs (
      id text primary key,
      actor_user_id text references users(id) on delete set null,
      room_id text references rooms(id) on delete set null,
      action text not null,
      created_at integer not null
    );

    insert into credentials(
      id, user_id, token_hash, created_at, last_used_at
    ) values('orphan-credential', 'missing-user', 'token', 1, 1);

    insert into room_members(room_id, user_id, joined_at)
    values('missing-room', 'missing-user', 1);

    insert into audit_logs(
      id, actor_user_id, action, created_at
    ) values('orphan-audit', 'missing-user', 'user_registered', 1);
  `);
  database.close();
}

function insertUser(database: AppDatabase, username: string): User {
  const user: User = {
    id: crypto.randomUUID(),
    username,
    avatarSeed: crypto.randomUUID(),
    deviceKind: "desktop",
    deviceName: "Mac OS",
    createdAt: Date.now(),
  };
  database
    .query(
      `insert into users(
        id, username, avatar_seed, device_kind, device_name,
        fingerprint_hash, created_at
      ) values(?, ?, ?, ?, ?, null, ?)`
    )
    .run(
      user.id,
      user.username,
      user.avatarSeed,
      user.deviceKind,
      user.deviceName,
      user.createdAt
    );
  return user;
}
