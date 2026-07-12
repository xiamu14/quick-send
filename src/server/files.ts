import { createHash } from "node:crypto";
import { createWriteStream, existsSync } from "node:fs";
import { link, mkdir, readdir, stat, unlink } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { nanoid } from "nanoid";
import type { AppDatabase } from "./db";
import { AppError } from "./errors";
import { hasRoomMembership, limits } from "./rooms";

const md5Pattern = /^[a-f0-9]{32}$/;
const temporaryFileTtlMs = 60 * 60 * 1000;
const defaultFilesRoot = join(process.cwd(), "data", "files");

export async function storeUploadedFile(
  database: AppDatabase,
  request: Request,
  input: {
    roomId: string;
    userId: string;
    fileId: string;
    expectedSize: number;
  },
  filesRoot = defaultFilesRoot
) {
  validateUploadInput(input.fileId, input.expectedSize);
  if (!hasRoomMembership(database, input.roomId, input.userId)) {
    throw new AppError("FORBIDDEN", "Room membership is required", 403);
  }
  const existing = getStoredFile(database, input.fileId);
  if (existing && existsSync(absoluteStoragePath(existing.storage_path))) {
    if (existing.size !== input.expectedSize) {
      throw hashConflict();
    }
    return { fileId: input.fileId, deduplicated: true };
  }
  if (!request.body) {
    throw new AppError("EMPTY_FILE", "File body is required");
  }
  const contentLength = Number(request.headers.get("content-length"));
  if (Number.isFinite(contentLength) && contentLength !== input.expectedSize) {
    throw new AppError("FILE_SIZE_MISMATCH", "File size does not match", 400);
  }

  const temporaryRoot = join(filesRoot, ".tmp");
  await mkdir(temporaryRoot, { recursive: true });
  const temporaryPath = join(temporaryRoot, nanoid());
  const md5 = createHash("md5");
  const sha256 = createHash("sha256");
  let received = 0;
  const verifier = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      received += chunk.byteLength;
      if (received > limits.maxFileBytes || received > input.expectedSize) {
        callback(
          new AppError("FILE_TOO_LARGE", "File must be 200 MB or smaller")
        );
        return;
      }
      md5.update(chunk);
      sha256.update(chunk);
      callback(null, chunk);
    },
  });

  try {
    await pipeline(
      Readable.from(readRequestBody(request.body)),
      verifier,
      createWriteStream(temporaryPath, { flags: "wx" })
    );
    if (received !== input.expectedSize) {
      throw new AppError(
        "FILE_SIZE_MISMATCH",
        `Received ${received} bytes, expected ${input.expectedSize}`,
        400
      );
    }
    const actualMd5 = md5.digest("hex");
    const actualSha256 = sha256.digest("hex");
    if (actualMd5 !== input.fileId) {
      throw new AppError("FILE_HASH_MISMATCH", "File MD5 does not match", 400);
    }
    const current = getStoredFile(database, input.fileId);
    if (
      current &&
      (current.size !== received || current.sha256 !== actualSha256)
    ) {
      throw hashConflict();
    }

    const storagePath = relative(
      process.cwd(),
      join(filesRoot, input.fileId.slice(0, 2), input.fileId)
    );
    const absolutePath = absoluteStoragePath(storagePath);
    await mkdir(dirname(absolutePath), { recursive: true });
    try {
      await link(temporaryPath, absolutePath);
    } catch (error) {
      if (!isFileExistsError(error)) {
        throw error;
      }
    }
    await unlink(temporaryPath).catch(() => undefined);

    database
      .query(
        `insert into server_files(id, sha256, size, storage_path, created_at)
         values(?, ?, ?, ?, ?)
         on conflict(id) do nothing`
      )
      .run(input.fileId, actualSha256, received, storagePath, Date.now());
    const stored = getStoredFile(database, input.fileId);
    if (!stored || stored.size !== received || stored.sha256 !== actualSha256) {
      throw hashConflict();
    }
    return { fileId: input.fileId, deduplicated: Boolean(current) };
  } catch (error) {
    await unlink(temporaryPath).catch(() => undefined);
    throw error;
  }
}

export function isStoredFileAvailable(
  database: AppDatabase,
  fileId: string,
  expectedSize: number
) {
  const file = getStoredFile(database, fileId);
  if (!file) {
    return false;
  }
  if (file.size !== expectedSize) {
    throw hashConflict();
  }
  return existsSync(absoluteStoragePath(file.storage_path));
}

export async function cleanupExpiredFileCache(
  database: AppDatabase,
  filesRoot = defaultFilesRoot
) {
  const now = Date.now();
  const expired = database
    .query<{ message_id: string; room_id: string }, [number]>(
      `select m.id as message_id, m.room_id
       from messages m join message_files mf on mf.message_id = m.id
       where mf.expires_at <= ?`
    )
    .all(now);
  database.transaction(() => {
    database
      .query(
        `delete from messages where id in (
          select message_id from message_files where expires_at <= ?
        )`
      )
      .run(now);
  })();

  const orphaned = database
    .query<{ id: string; storage_path: string }, []>(
      `select sf.id, sf.storage_path from server_files sf
       where not exists (
         select 1 from message_files mf where mf.file_id = sf.id
       )`
    )
    .all();
  for (const file of orphaned) {
    try {
      await unlink(absoluteStoragePath(file.storage_path));
    } catch (error) {
      if (!isFileMissingError(error)) {
        continue;
      }
    }
    database
      .query(
        `delete from server_files where id = ? and not exists (
          select 1 from message_files where file_id = ?
        )`
      )
      .run(file.id, file.id);
  }
  await cleanupTemporaryFiles(join(filesRoot, ".tmp"), now);
  return expired.map((item) => ({
    messageId: item.message_id,
    roomId: item.room_id,
  }));
}

export function absoluteStoragePath(storagePath: string) {
  return join(process.cwd(), storagePath);
}

async function* readRequestBody(body: ReadableStream<Uint8Array>) {
  const reader = body.getReader();
  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      return;
    }
    yield value;
  }
}

function getStoredFile(database: AppDatabase, fileId: string) {
  return database
    .query<
      { id: string; sha256: string; size: number; storage_path: string },
      [string]
    >("select id, sha256, size, storage_path from server_files where id = ?")
    .get(fileId);
}

function validateUploadInput(fileId: string, size: number) {
  if (!md5Pattern.test(fileId)) {
    throw new AppError("INVALID_FILE_ID", "File ID must be an MD5 hash");
  }
  if (!Number.isInteger(size) || size <= 0 || size > limits.maxFileBytes) {
    throw new AppError("FILE_TOO_LARGE", "File must be 200 MB or smaller");
  }
}

async function cleanupTemporaryFiles(temporaryRoot: string, now: number) {
  const entries = await readdir(temporaryRoot).catch(() => []);
  for (const entry of entries) {
    const path = join(temporaryRoot, entry);
    const info = await stat(path).catch(() => undefined);
    if (info && info.mtimeMs <= now - temporaryFileTtlMs) {
      await unlink(path).catch(() => undefined);
    }
  }
}

function hashConflict() {
  return new AppError(
    "FILE_HASH_CONFLICT",
    "This MD5 identifies different file content",
    409
  );
}

function isFileExistsError(error: unknown) {
  return isNodeError(error) && error.code === "EEXIST";
}

function isFileMissingError(error: unknown) {
  return isNodeError(error) && error.code === "ENOENT";
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
