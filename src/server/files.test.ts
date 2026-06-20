import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { User } from "@/shared/types";
import { type AppDatabase, openDatabase } from "./db";
import {
  absoluteStoragePath,
  cleanupExpiredFileCache,
  storeUploadedFile,
} from "./files";
import { createFileMessage } from "./messages";
import { createRoom, limits } from "./rooms";

const resources: Array<{
  database: AppDatabase;
  databasePath: string;
  filesRoot: string;
}> = [];

afterEach(async () => {
  for (const resource of resources.splice(0)) {
    resource.database.close();
    await rm(resource.databasePath, { force: true });
    await rm(resource.filesRoot, { force: true, recursive: true });
  }
});

describe("server file cache", () => {
  test("deduplicates bytes and deletes them after the last message expires", async () => {
    const { database, filesRoot } = await createResources();
    const user = insertUser(database);
    const firstRoom = createRoom(database, user);
    const secondRoom = createRoom(database, user);
    const bytes = new TextEncoder().encode("same file in two rooms");
    const fileId = createHash("md5").update(bytes).digest("hex");

    await storeUploadedFile(
      database,
      uploadRequest(bytes),
      {
        roomId: firstRoom.id,
        userId: user.id,
        fileId,
        expectedSize: bytes.byteLength,
      },
      filesRoot
    );
    const deduplicated = await storeUploadedFile(
      database,
      uploadRequest(bytes),
      {
        roomId: secondRoom.id,
        userId: user.id,
        fileId,
        expectedSize: bytes.byteLength,
      },
      filesRoot
    );
    expect(deduplicated.deduplicated).toBe(true);

    const firstMessage = createFileMessage(database, user, {
      roomId: firstRoom.id,
      clientMessageId: "first",
      fileId,
      name: "first.txt",
      size: bytes.byteLength,
      mime: "text/plain",
    });
    const secondMessage = createFileMessage(database, user, {
      roomId: secondRoom.id,
      clientMessageId: "second",
      fileId,
      name: "second.txt",
      size: bytes.byteLength,
      mime: "text/plain",
    });
    expect(firstMessage).toBeDefined();
    expect(secondMessage).toBeDefined();
    if (!(firstMessage && secondMessage)) {
      throw new Error("Expected file messages");
    }
    expect(rowCount(database, "server_files")).toBe(1);

    const storagePath = database
      .query<{ storage_path: string }, [string]>(
        "select storage_path from server_files where id = ?"
      )
      .get(fileId)?.storage_path;
    expect(storagePath).toBeDefined();
    if (!storagePath) {
      throw new Error("Expected stored file path");
    }
    const absolutePath = absoluteStoragePath(storagePath);

    database
      .query("update message_files set expires_at = 0 where message_id = ?")
      .run(firstMessage.id);
    await cleanupExpiredFileCache(database, filesRoot);
    expect(existsSync(absolutePath)).toBe(true);
    expect(rowCount(database, "server_files")).toBe(1);

    database
      .query("update message_files set expires_at = 0 where message_id = ?")
      .run(secondMessage.id);
    await cleanupExpiredFileCache(database, filesRoot);
    expect(existsSync(absolutePath)).toBe(false);
    expect(rowCount(database, "server_files")).toBe(0);
    expect(rowCount(database, "messages")).toBe(0);
  });

  test("rejects files larger than 200 MB before reading a body", async () => {
    const { database, filesRoot } = await createResources();
    const user = insertUser(database);
    const room = createRoom(database, user);
    expect(
      storeUploadedFile(
        database,
        new Request("http://quick.local/upload", {
          body: new Uint8Array([1]),
          method: "PUT",
        }),
        {
          roomId: room.id,
          userId: user.id,
          fileId: "0".repeat(32),
          expectedSize: limits.maxFileBytes + 1,
        },
        filesRoot
      )
    ).rejects.toMatchObject({ code: "FILE_TOO_LARGE" });
  });
});

async function createResources() {
  const databasePath = join(
    tmpdir(),
    `quick-send-${crypto.randomUUID()}.sqlite`
  );
  const filesRoot = await mkdtemp(join(tmpdir(), "quick-send-files-"));
  const database = openDatabase(databasePath);
  resources.push({ database, databasePath, filesRoot });
  return { database, filesRoot };
}

function insertUser(database: AppDatabase): User {
  const now = Date.now();
  const user: User = {
    id: crypto.randomUUID(),
    username: `User-${crypto.randomUUID().slice(0, 8)}`,
    avatarSeed: crypto.randomUUID(),
    deviceKind: "desktop",
    deviceName: "Mac OS",
    createdAt: now,
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
      now
    );
  return user;
}

function uploadRequest(bytes: Uint8Array) {
  return new Request("http://quick.local/upload", {
    body: bytes.slice().buffer,
    headers: { "content-length": String(bytes.byteLength) },
    method: "PUT",
  });
}

function rowCount(database: AppDatabase, table: "messages" | "server_files") {
  return database
    .query<{ count: number }, []>(`select count(*) as count from ${table}`)
    .get()?.count;
}
