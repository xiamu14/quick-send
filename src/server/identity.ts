import type { DeviceKind, User } from "@/shared/types";
import { hashToken, randomToken } from "./crypto";
import type { AppDatabase } from "./db";

const credentialMaxIdleMs = 90 * 24 * 60 * 60 * 1000;
const shortIdAlphabet = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";
const tabletPattern = /ipad|tablet/i;
const mobilePattern = /mobile|iphone|android/i;
const androidPattern = /android/i;
const androidModelPattern = /android[^;)]*;\s*([^;)]+?)(?:\s+build\/|[;)])/i;
const androidBrandPattern =
  /\b(vivo|oppo|oneplus|xiaomi|redmi|huawei|honor|samsung|realme|pixel)\b/i;
const iphonePattern = /iphone/i;
const ipadPattern = /ipad/i;
const macPattern = /macintosh|mac os x/i;
const windowsPattern = /windows/i;
const linuxPattern = /linux/i;
const localePrefixPattern = /^[a-z]{2}[-_][a-z]{2};\s*/i;

export type IdentityResult = {
  user: User;
  credentialToken: string;
};
type IdentitySource = "browser" | "device";

export function deviceKindFromUserAgent(userAgent: string): DeviceKind {
  if (tabletPattern.test(userAgent)) {
    return "tablet";
  }
  if (mobilePattern.test(userAgent)) {
    return "mobile";
  }
  return "desktop";
}

export function deviceNameFromUserAgent(userAgent: string) {
  if (iphonePattern.test(userAgent)) {
    return "iPhone";
  }
  if (ipadPattern.test(userAgent)) {
    return "iPad";
  }
  if (macPattern.test(userAgent)) {
    return "Mac OS";
  }
  if (windowsPattern.test(userAgent)) {
    return "Windows";
  }
  if (androidPattern.test(userAgent)) {
    const brand = userAgent.match(androidBrandPattern)?.[1];
    const model = userAgent
      .match(androidModelPattern)?.[1]
      ?.replace(localePrefixPattern, "")
      .trim();
    if (brand && model && !model.toLowerCase().includes(brand.toLowerCase())) {
      return `${brand} ${model}`;
    }
    return model || (brand ? `${brand} Android` : "Android");
  }
  if (linuxPattern.test(userAgent)) {
    return "Linux";
  }
  return "Unknown device";
}

export async function ensureIdentity(
  database: AppDatabase,
  identityId: string,
  deviceKind: DeviceKind,
  deviceName = "Unknown device",
  identitySource: IdentitySource = "browser"
): Promise<IdentityResult> {
  const normalizedIdentity = identityId.trim();
  const fingerprintHash =
    identitySource === "browser" ? await hashToken(normalizedIdentity) : null;
  const deviceIdHash =
    identitySource === "device"
      ? await hashToken(`device:${normalizedIdentity}`)
      : await hashToken(normalizedIdentity);
  const existing = database
    .query<
      {
        id: string;
        username: string;
        avatar_seed: string;
        device_kind: DeviceKind;
        device_name: string;
        created_at: number;
      },
      [string]
    >("select * from users where device_id_hash = ?")
    .get(deviceIdHash);
  const user = existing
    ? mapUser(existing)
    : createIdentityUser(
        database,
        fingerprintHash,
        deviceIdHash,
        deviceKind,
        deviceName
      );
  if (
    existing &&
    (existing.device_kind !== deviceKind || existing.device_name !== deviceName)
  ) {
    database
      .query("update users set device_kind = ?, device_name = ? where id = ?")
      .run(deviceKind, deviceName, existing.id);
    user.deviceKind = deviceKind;
    user.deviceName = deviceName;
  }
  const credentialToken = randomToken();
  const credentialHash = await hashToken(credentialToken);
  const now = Date.now();
  database.query("delete from credentials where user_id = ?").run(user.id);
  database
    .query(
      `insert into credentials(
        id, user_id, token_hash, created_at, last_used_at
      ) values(?, ?, ?, ?, ?)`
    )
    .run(crypto.randomUUID(), user.id, credentialHash, now, now);
  return { user, credentialToken };
}

export async function resolveCredential(
  database: AppDatabase,
  token: string | undefined
) {
  if (!token) {
    return;
  }
  const tokenHash = await hashToken(token);
  const now = Date.now();
  const row = database
    .query<
      {
        credential_id: string;
        last_used_at: number;
        id: string;
        username: string;
        avatar_seed: string;
        device_kind: DeviceKind;
        device_name: string;
        created_at: number;
      },
      [string]
    >(
      `select c.id as credential_id, c.last_used_at, u.*
       from credentials c join users u on u.id = c.user_id
       where c.token_hash = ?`
    )
    .get(tokenHash);
  if (!row) {
    return;
  }
  if (row.last_used_at < now - credentialMaxIdleMs) {
    database
      .query("delete from credentials where id = ?")
      .run(row.credential_id);
    return;
  }
  database
    .query("update credentials set last_used_at = ? where id = ?")
    .run(now, row.credential_id);
  return mapUser(row);
}

export function cleanupIdentityState(database: AppDatabase) {
  database
    .query("delete from credentials where last_used_at < ?")
    .run(Date.now() - credentialMaxIdleMs);
}

export function updateUserDeviceFromUserAgent(
  database: AppDatabase,
  user: User,
  userAgent: string
) {
  const deviceKind = deviceKindFromUserAgent(userAgent);
  const deviceName = deviceNameFromUserAgent(userAgent);
  if (user.deviceKind === deviceKind && user.deviceName === deviceName) {
    return user;
  }
  database
    .query("update users set device_kind = ?, device_name = ? where id = ?")
    .run(deviceKind, deviceName, user.id);
  user.deviceKind = deviceKind;
  user.deviceName = deviceName;
  return user;
}

function createIdentityUser(
  database: AppDatabase,
  fingerprintHash: string | null,
  deviceIdHash: string,
  deviceKind: DeviceKind,
  deviceName: string
) {
  const now = Date.now();
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const shortId = createShortId();
    const user: User = {
      id: shortId,
      username: shortId,
      avatarSeed: randomToken(9),
      deviceKind,
      deviceName,
      createdAt: now,
    };
    try {
      insertUser(database, user, fingerprintHash, deviceIdHash);
      audit(database, user.id, "user_auto_created");
      return user;
    } catch (error) {
      if (String(error).includes("UNIQUE")) {
        continue;
      }
      throw error;
    }
  }
  throw new Error("Could not create identity");
}

function insertUser(
  database: AppDatabase,
  user: User,
  fingerprintHash: string | null,
  deviceIdHash: string
) {
  if (hasUserColumn(database, "totp_ciphertext")) {
    database
      .query(
        `insert into users(
          id, username, avatar_seed, device_kind, totp_ciphertext,
          device_id_hash, fingerprint_hash, device_name, created_at
        ) values(?, ?, ?, ?, '', ?, ?, ?, ?)`
      )
      .run(
        user.id,
        user.username,
        user.avatarSeed,
        user.deviceKind,
        deviceIdHash,
        fingerprintHash,
        user.deviceName,
        user.createdAt
      );
    return;
  }
  database
    .query(
      `insert into users(
        id, username, avatar_seed, device_kind, device_id_hash, fingerprint_hash,
        device_name, created_at
      ) values(?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      user.id,
      user.username,
      user.avatarSeed,
      user.deviceKind,
      deviceIdHash,
      fingerprintHash,
      user.deviceName,
      user.createdAt
    );
}

function hasUserColumn(database: AppDatabase, name: string) {
  return database
    .query<{ name: string }, []>("pragma table_info(users)")
    .all()
    .some((column) => column.name === name);
}

function createShortId() {
  const length = 4 + ((crypto.getRandomValues(new Uint8Array(1))[0] ?? 0) % 3);
  const bytes = crypto.getRandomValues(new Uint8Array(length));
  return Array.from(
    bytes,
    (value) => shortIdAlphabet[value % shortIdAlphabet.length]
  ).join("");
}

function mapUser(row: {
  id: string;
  username: string;
  avatar_seed: string;
  device_kind: DeviceKind;
  device_name: string;
  created_at: number;
}) {
  return {
    id: row.id,
    username: row.username,
    avatarSeed: row.avatar_seed,
    deviceKind: row.device_kind,
    deviceName: row.device_name,
    createdAt: row.created_at,
  } satisfies User;
}

function audit(database: AppDatabase, actorUserId: string, action: string) {
  database
    .query(
      `insert into audit_logs(
        id, actor_user_id, action, created_at
      ) values(?, ?, ?, ?)`
    )
    .run(crypto.randomUUID(), actorUserId, action, Date.now());
}
