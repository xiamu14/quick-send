import type { D1Database, R2Bucket } from "@cloudflare/workers-types";

type WorkerEnv = {
  DB: D1Database;
  IMAGES: R2Bucket;
  BETTER_AUTH_URL: string;
  BETTER_AUTH_SECRET: string;
};

declare global {
  type Env = WorkerEnv;
}
