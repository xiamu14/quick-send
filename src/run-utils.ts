import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { spawn } from "bun";

export const serverPort = Number(process.env.QUICK_SEND_PORT ?? 4173);
const lockPath = join(process.cwd(), "data", "quick-send.lock");

if (!Number.isInteger(serverPort) || serverPort < 1 || serverPort > 65_535) {
  throw new Error("QUICK_SEND_PORT must be a valid TCP port");
}

export async function prepareServer() {
  await stopExistingServer(lockPath, serverPort);
}

export async function waitForServer(child: ReturnType<typeof spawn>) {
  const deadline = Date.now() + 30_000;
  const url = `http://127.0.0.1:${serverPort}/`;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`Quick Send exited with code ${child.exitCode}`);
    }
    try {
      const response = await fetch(url);
      if (response.status < 500) {
        return;
      }
    } catch {
      // The server is still starting.
    }
    await delay(100);
  }
  child.kill("SIGTERM");
  throw new Error(`Quick Send did not start on ${url}`);
}

async function stopExistingServer(path: string, port: number) {
  if (!existsSync(path)) {
    return;
  }
  const pid = Number(readFileSync(path, "utf8"));
  if (!(Number.isInteger(pid) && isRunning(pid))) {
    if (existsSync(path)) {
      unlinkSync(path);
    }
    return;
  }
  const response = await fetch(`http://127.0.0.1:${port}/`).catch(
    () => undefined
  );
  if (!response) {
    throw new Error(
      `PID ${pid} owns the Quick Send lock but port ${port} is unavailable`
    );
  }
  console.log(`Stopping existing Quick Send PID ${pid}`);
  process.kill(pid, "SIGTERM");
  const deadline = Date.now() + 5000;
  while (isRunning(pid) && Date.now() < deadline) {
    await delay(100);
  }
  if (isRunning(pid)) {
    throw new Error(`Quick Send PID ${pid} did not stop`);
  }
  if (existsSync(path)) {
    unlinkSync(path);
  }
}

function isRunning(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
