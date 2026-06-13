import { AppError } from "./errors";

const failures = new Map<string, { count: number; lockedUntil: number }>();
const ipAttempts = new Map<string, number[]>();

export function assertVerificationAllowed(ip: string, username: string) {
  const now = Date.now();
  const attempts = (ipAttempts.get(ip) ?? []).filter(
    (timestamp) => timestamp > now - 60_000
  );
  if (attempts.length >= 20) {
    throw new AppError("RATE_LIMITED", "Too many verification attempts", 429);
  }
  attempts.push(now);
  ipAttempts.set(ip, attempts);
  const failure = failures.get(key(ip, username));
  if (failure && failure.lockedUntil > now) {
    throw new AppError(
      "VERIFICATION_LOCKED",
      "Try verification again later",
      429
    );
  }
}

export function recordVerificationFailure(ip: string, username: string) {
  const id = key(ip, username);
  const current = failures.get(id) ?? { count: 0, lockedUntil: 0 };
  const count = current.count + 1;
  failures.set(id, {
    count,
    lockedUntil: count >= 5 ? Date.now() + 5 * 60_000 : 0,
  });
}

export function clearVerificationFailures(ip: string, username: string) {
  failures.delete(key(ip, username));
}

function key(ip: string, username: string) {
  return `${ip}\0${username.trim().toLocaleLowerCase()}`;
}
