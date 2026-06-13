import {
  decodeBase32IgnorePadding,
  encodeBase32UpperCaseNoPadding,
} from "@oslojs/encoding";
import { verifyTOTPWithGracePeriod } from "@oslojs/otp";
import type { DeviceKind, User } from "@/shared/types";
import { decryptText, encryptText, hashToken, randomToken } from "./crypto";
import type { AppDatabase } from "./db";
import { AppError } from "./errors";

const credentialMaxIdleMs = 90 * 24 * 60 * 60 * 1000;
const setupTtlMs = 10 * 60 * 1000;
const recoveryTtlMs = 5 * 60 * 1000;
const recoveryAlphabet = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";
const usernamePattern = /^[\p{L}\p{N} _-]+$/u;
const tabletPattern = /ipad|tablet/i;
const mobilePattern = /mobile|iphone|android/i;

type RegistrationSetup = {
  username: string;
  secret: string;
  deviceKind: DeviceKind;
  expiresAt: number;
};

type RecoverySetup = {
  username: string;
  deviceKind: DeviceKind;
  attempts: number;
  expiresAt: number;
};

const registrations = new Map<string, RegistrationSetup>();
const recoveries = new Map<string, RecoverySetup>();

export type IdentityResult = {
  user: User;
  credentialToken: string;
  recoveryCode?: string;
};

export function normalizeUsername(value: string) {
  const username = value.trim().replace(/\s+/g, " ");
  if (username.length < 2 || username.length > 24) {
    throw new AppError(
      "INVALID_USERNAME",
      "Username must be between 2 and 24 characters"
    );
  }
  if (!usernamePattern.test(username)) {
    throw new AppError(
      "INVALID_USERNAME",
      "Username contains invalid characters"
    );
  }
  return username;
}

export function deviceKindFromUserAgent(userAgent: string): DeviceKind {
  if (tabletPattern.test(userAgent)) {
    return "tablet";
  }
  if (mobilePattern.test(userAgent)) {
    return "mobile";
  }
  return "desktop";
}

export function startRegistration(
  database: AppDatabase,
  usernameInput: string,
  deviceKind: DeviceKind
) {
  const username = normalizeUsername(usernameInput);
  const exists = database
    .query<{ id: string }, [string]>(
      "select id from users where username = ? collate nocase"
    )
    .get(username);
  if (exists) {
    throw new AppError("USERNAME_TAKEN", "Username is already in use", 409);
  }
  const setupToken = randomToken();
  const secret = encodeBase32UpperCaseNoPadding(
    crypto.getRandomValues(new Uint8Array(20))
  );
  registrations.set(setupToken, {
    username,
    secret,
    deviceKind,
    expiresAt: Date.now() + setupTtlMs,
  });
  const label = encodeURIComponent(`${username}@Quick Send`);
  const issuer = encodeURIComponent("Quick Send");
  return {
    setupToken,
    secret,
    otpAuthUrl: `otpauth://totp/${issuer}:${label}?secret=${secret}&issuer=${issuer}&algorithm=SHA1&digits=6&period=30`,
  };
}

export async function confirmRegistration(
  database: AppDatabase,
  encryptionKey: Uint8Array,
  setupToken: string,
  code: string
): Promise<IdentityResult> {
  const setup = registrations.get(setupToken);
  if (!setup || setup.expiresAt < Date.now()) {
    registrations.delete(setupToken);
    throw new AppError("SETUP_EXPIRED", "Registration setup expired", 409);
  }
  if (
    !verifyTOTPWithGracePeriod(
      decodeBase32IgnorePadding(setup.secret),
      30,
      6,
      code,
      30
    )
  ) {
    throw new AppError("INVALID_CODE", "Authenticator code is invalid", 401);
  }
  registrations.delete(setupToken);
  const now = Date.now();
  const user: User = {
    id: crypto.randomUUID(),
    username: setup.username,
    avatarSeed: randomToken(9),
    deviceKind: setup.deviceKind,
    createdAt: now,
  };
  const credentialToken = randomToken();
  const recoveryCode = createRecoveryCode();
  const encryptedSecret = await encryptText(setup.secret, encryptionKey);
  const credentialHash = await hashToken(credentialToken);
  const recoveryHash = await hashToken(recoveryCode);
  database.transaction(() => {
    database
      .query(
        `insert into users(
          id, username, avatar_seed, device_kind, totp_ciphertext, created_at
        ) values(?, ?, ?, ?, ?, ?)`
      )
      .run(
        user.id,
        user.username,
        user.avatarSeed,
        user.deviceKind,
        encryptedSecret,
        now
      );
    database
      .query(
        `insert into credentials(
          id, user_id, token_hash, created_at, last_used_at
        ) values(?, ?, ?, ?, ?)`
      )
      .run(crypto.randomUUID(), user.id, credentialHash, now, now);
    database
      .query(
        "insert into recovery_codes(user_id, code_hash, created_at) values(?, ?, ?)"
      )
      .run(user.id, recoveryHash, now);
    audit(database, user.id, "user_registered");
  })();
  return { user, credentialToken, recoveryCode };
}

export function startRecovery(usernameInput: string, deviceKind: DeviceKind) {
  const challengeId = randomToken();
  recoveries.set(challengeId, {
    username: usernameInput.trim(),
    deviceKind,
    attempts: 0,
    expiresAt: Date.now() + recoveryTtlMs,
  });
  return { challengeId };
}

export async function confirmRecovery(
  database: AppDatabase,
  encryptionKey: Uint8Array,
  challengeId: string,
  code: string
): Promise<IdentityResult> {
  const challenge = recoveries.get(challengeId);
  if (
    !challenge ||
    challenge.expiresAt < Date.now() ||
    challenge.attempts >= 5
  ) {
    recoveries.delete(challengeId);
    throw new AppError("RECOVERY_EXPIRED", "Recovery challenge expired", 409);
  }
  challenge.attempts += 1;
  const row = database
    .query<
      {
        id: string;
        username: string;
        avatar_seed: string;
        device_kind: DeviceKind;
        totp_ciphertext: string;
        created_at: number;
        recovery_hash: string | null;
      },
      [string]
    >(
      `select u.*, rc.code_hash as recovery_hash
       from users u
       left join recovery_codes rc on rc.user_id = u.id
       where u.username = ? collate nocase`
    )
    .get(challenge.username);
  if (!row) {
    throw new AppError(
      "INVALID_RECOVERY",
      "Username or verification code is invalid",
      401
    );
  }
  const normalizedCode = code.trim().toUpperCase();
  const secret = await decryptText(row.totp_ciphertext, encryptionKey);
  const validTotp = verifyTOTPWithGracePeriod(
    decodeBase32IgnorePadding(secret),
    30,
    6,
    normalizedCode,
    30
  );
  const validRecovery =
    row.recovery_hash !== null &&
    (await hashToken(normalizedCode)) === row.recovery_hash;
  if (!(validTotp || validRecovery)) {
    throw new AppError(
      "INVALID_RECOVERY",
      "Username or verification code is invalid",
      401
    );
  }
  recoveries.delete(challengeId);
  const now = Date.now();
  const credentialToken = randomToken();
  const credentialHash = await hashToken(credentialToken);
  database.transaction(() => {
    database.query("delete from credentials where user_id = ?").run(row.id);
    if (validRecovery) {
      database
        .query("delete from recovery_codes where user_id = ?")
        .run(row.id);
    }
    database
      .query(
        `insert into credentials(
          id, user_id, token_hash, created_at, last_used_at
        ) values(?, ?, ?, ?, ?)`
      )
      .run(crypto.randomUUID(), row.id, credentialHash, now, now);
    database
      .query("update users set device_kind = ? where id = ?")
      .run(challenge.deviceKind, row.id);
    audit(database, row.id, "device_migrated");
  })();
  return {
    user: {
      id: row.id,
      username: row.username,
      avatarSeed: row.avatar_seed,
      deviceKind: challenge.deviceKind,
      createdAt: row.created_at,
    },
    credentialToken,
  };
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
  return {
    id: row.id,
    username: row.username,
    avatarSeed: row.avatar_seed,
    deviceKind: row.device_kind,
    createdAt: row.created_at,
  } satisfies User;
}

export async function regenerateRecoveryCode(
  database: AppDatabase,
  encryptionKey: Uint8Array,
  userId: string,
  code: string
) {
  const row = database
    .query<{ totp_ciphertext: string }, [string]>(
      "select totp_ciphertext from users where id = ?"
    )
    .get(userId);
  if (!row) {
    throw new AppError("UNAUTHORIZED", "Authentication required", 401);
  }
  const secret = await decryptText(row.totp_ciphertext, encryptionKey);
  if (
    !verifyTOTPWithGracePeriod(
      decodeBase32IgnorePadding(secret),
      30,
      6,
      code,
      30
    )
  ) {
    throw new AppError("INVALID_CODE", "Authenticator code is invalid", 401);
  }
  const recoveryCode = createRecoveryCode();
  const codeHash = await hashToken(recoveryCode);
  database
    .query(
      `insert into recovery_codes(user_id, code_hash, created_at)
       values(?, ?, ?)
       on conflict(user_id) do update set
         code_hash = excluded.code_hash,
         created_at = excluded.created_at`
    )
    .run(userId, codeHash, Date.now());
  audit(database, userId, "recovery_code_generated");
  return recoveryCode;
}

export function cleanupIdentityState(database: AppDatabase) {
  const now = Date.now();
  for (const [key, value] of registrations) {
    if (value.expiresAt < now) {
      registrations.delete(key);
    }
  }
  for (const [key, value] of recoveries) {
    if (value.expiresAt < now) {
      recoveries.delete(key);
    }
  }
  database
    .query("delete from credentials where last_used_at < ?")
    .run(now - credentialMaxIdleMs);
}

function createRecoveryCode() {
  const bytes = crypto.getRandomValues(new Uint8Array(12));
  const characters = Array.from(
    bytes,
    (value) => recoveryAlphabet[value % recoveryAlphabet.length]
  );
  return [
    characters.slice(0, 4).join(""),
    characters.slice(4, 8).join(""),
    characters.slice(8, 12).join(""),
  ].join("-");
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
