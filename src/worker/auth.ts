import { drizzleAdapter } from "@better-auth/drizzle-adapter";
import { betterAuth } from "better-auth";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import { schema } from "./schema";

export type AuthDatabase = DrizzleD1Database<typeof schema>;

const privateLan192Pattern = /^192\.168\.\d{1,3}\.\d{1,3}$/;
const privateLan10Pattern = /^10\.\d{1,3}\.\d{1,3}\.\d{1,3}$/;
const privateLan172Pattern = /^172\.(1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}$/;

export function createAuth(
  env: Env,
  database: AuthDatabase,
  request?: Request
) {
  const baseURL = authBaseURL(env, request);
  return betterAuth({
    baseURL,
    secret: env.BETTER_AUTH_SECRET,
    trustedOrigins: (request) => trustedOrigins(env, request),
    database: drizzleAdapter(database, {
      provider: "sqlite",
      schema,
    }),
    emailAndPassword: {
      enabled: true,
      minPasswordLength: 8,
    },
  });
}

function authBaseURL(env: Env, request: Request | undefined) {
  const origin = request?.headers.get("origin");
  if (origin && isDevOrigin(origin)) {
    return origin;
  }
  const host = request?.headers.get("host");
  if (host && isDevHost(host)) {
    return `http://${host}`;
  }
  return env.BETTER_AUTH_URL;
}

function trustedOrigins(env: Env, request: Request | undefined) {
  const origins = [
    env.BETTER_AUTH_URL,
    "http://localhost:5173",
    "http://localhost:5174",
    "http://127.0.0.1:5173",
    "http://127.0.0.1:5174",
  ];
  const origin = request?.headers.get("origin");
  if (origin && isDevOrigin(origin)) {
    origins.push(origin);
  }
  return origins;
}

function isDevOrigin(origin: string) {
  try {
    const url = new URL(origin);
    if (url.protocol !== "http:") {
      return false;
    }
    if (!["5173", "5174"].includes(url.port)) {
      return false;
    }
    return (
      url.hostname === "localhost" ||
      url.hostname === "127.0.0.1" ||
      privateLan192Pattern.test(url.hostname) ||
      privateLan10Pattern.test(url.hostname) ||
      privateLan172Pattern.test(url.hostname)
    );
  } catch {
    return false;
  }
}

function isDevHost(host: string) {
  try {
    return isDevOrigin(`http://${host}`);
  } catch {
    return false;
  }
}
