import type { Context, Next } from "hono";
import { getCookie, setCookie } from "hono/cookie";
import { db, getOrCreateConfig, setConfig } from "./db";

const sessionCookie = "quick_session";
const sessionTtlMs = 7 * 24 * 60 * 60 * 1000;

export function getAccessCode() {
  const fromEnv = process.env.ACCESS_CODE?.trim();
  if (fromEnv) {
    setConfig("access_code", fromEnv);
    return fromEnv;
  }
  return getOrCreateConfig("access_code", () => String(Math.floor(100000 + Math.random() * 900000)));
}

export function createSession(c: Context) {
  const now = Date.now();
  const id = crypto.randomUUID();
  db.query("insert into sessions(id, expires_at, created_at) values(?, ?, ?)").run(id, now + sessionTtlMs, now);
  setCookie(c, sessionCookie, id, {
    httpOnly: true,
    sameSite: "Lax",
    path: "/",
    maxAge: sessionTtlMs / 1000,
  });
}

export function hasSession(c: Context) {
  const id = getCookie(c, sessionCookie);
  if (!id) return false;
  const row = db.query<{ expires_at: number }, [string]>("select expires_at from sessions where id = ?").get(id);
  if (!row) return false;
  if (row.expires_at < Date.now()) {
    db.query("delete from sessions where id = ?").run(id);
    return false;
  }
  return true;
}

export async function requireSession(c: Context, next: Next) {
  if (!hasSession(c)) {
    return c.json({ error: "Unauthorized" }, 401);
  }
  await next();
}

