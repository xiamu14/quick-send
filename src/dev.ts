import { mkdirSync } from "node:fs";
import { spawn } from "bun";

mkdirSync("dist/client", { recursive: true });

const migration = spawn(["bun", "run", "db:migrate:local"], {
  cwd: process.cwd(),
  env: process.env,
  stdin: "inherit",
  stdout: "inherit",
  stderr: "inherit",
});

const migrationCode = await migration.exited;
if (migrationCode !== 0) {
  process.exit(migrationCode);
}

const worker = spawn(["bun", "run", "dev:worker"], {
  cwd: process.cwd(),
  env: process.env,
  stdin: "inherit",
  stdout: "inherit",
  stderr: "inherit",
});

const vite = spawn(["bunx", "vite"], {
  cwd: process.cwd(),
  env: process.env,
  stdin: "inherit",
  stdout: "inherit",
  stderr: "inherit",
});

let stopping = false;
function stop(signal: NodeJS.Signals) {
  if (stopping) {
    return;
  }
  stopping = true;
  worker.kill(signal);
  vite.kill(signal);
}

process.on("SIGINT", () => stop("SIGINT"));
process.on("SIGTERM", () => stop("SIGTERM"));

const result = await Promise.race([
  worker.exited.then((exitCode) => ({ exitCode })),
  vite.exited.then((exitCode) => ({ exitCode })),
]);

stop("SIGTERM");
await Promise.all([worker.exited, vite.exited]);
process.exit(result.exitCode);
