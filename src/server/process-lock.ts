import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

export async function acquireProcessLock(
  path = join(process.cwd(), "data", "quick-send.lock")
) {
  mkdirSync(dirname(path), { recursive: true });
  if (existsSync(path)) {
    const pid = Number(readFileSync(path, "utf8"));
    if (Number.isInteger(pid) && isRunning(pid)) {
      await waitForExit(pid);
      if (isRunning(pid)) {
        throw new Error(`Quick Send is already running with PID ${pid}`);
      }
    }
    if (existsSync(path)) {
      unlinkSync(path);
    }
  }
  const descriptor = openSync(path, "wx");
  writeFileSync(descriptor, String(process.pid));
  closeSync(descriptor);
  let released = false;
  const release = () => {
    if (released) {
      return;
    }
    released = true;
    if (
      existsSync(path) &&
      Number(readFileSync(path, "utf8")) === process.pid
    ) {
      unlinkSync(path);
    }
  };
  process.once("exit", release);
  return release;
}

async function waitForExit(pid: number) {
  const deadline = Date.now() + 2000;
  while (isRunning(pid) && Date.now() < deadline) {
    await delay(100);
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
