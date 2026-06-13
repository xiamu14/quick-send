import { setTimeout as delay } from "node:timers/promises";
import { spawn } from "bun";
import { renderUnicodeCompact } from "uqr";

const publicUrlPattern = /Public URL:\s+(https:\/\/[^\s]+)/;
const port = Number(process.env.QUICK_SEND_PORT ?? 4173);
if (!Number.isInteger(port) || port < 1 || port > 65_535) {
  throw new Error("QUICK_SEND_PORT must be a valid TCP port");
}

const app = spawn(["bun", "run", "dev:app"], {
  cwd: process.cwd(),
  env: { ...process.env, PORT: String(port) },
  stdin: "inherit",
  stdout: "inherit",
  stderr: "inherit",
});

await waitForServer(app, port);

const tunnel = spawn(
  ["bunx", "hostc", String(port), "--local-host", "127.0.0.1"],
  {
    cwd: process.cwd(),
    stdin: "inherit",
    stdout: "pipe",
    stderr: "inherit",
  }
);
const tunnelOutput = forwardTunnelOutput(tunnel.stdout);

let stopping = false;
function stop(signal: NodeJS.Signals) {
  if (stopping) {
    return;
  }
  stopping = true;
  tunnel.kill(signal);
  app.kill(signal);
}

process.on("SIGINT", () => stop("SIGINT"));
process.on("SIGTERM", () => stop("SIGTERM"));

const result = await Promise.race([
  app.exited.then((exitCode) => ({ source: "app", exitCode })),
  tunnel.exited.then((exitCode) => ({ source: "tunnel", exitCode })),
]);
stop("SIGTERM");
await Promise.all([app.exited, tunnel.exited, tunnelOutput]);
process.exit(result.exitCode);

async function waitForServer(
  child: ReturnType<typeof spawn>,
  serverPort: number
) {
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
      // The build runs before the server starts.
    }
    await delay(100);
  }
  child.kill("SIGTERM");
  throw new Error(`Quick Send did not start on ${url}`);
}

async function forwardTunnelOutput(
  output: ReadableStream<Uint8Array<ArrayBuffer>>
) {
  const decoder = new TextDecoder();
  const reader = output.getReader();
  let searchable = "";
  let printedQr = false;
  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      process.stdout.write(decoder.decode());
      return;
    }
    const text = decoder.decode(value, { stream: true });
    process.stdout.write(text);
    if (printedQr) {
      continue;
    }
    searchable = `${searchable}${text}`.slice(-2048);
    const publicUrl = searchable.match(publicUrlPattern)?.[1];
    if (publicUrl) {
      printedQr = true;
      console.log(renderUnicodeCompact(publicUrl, { border: 2 }));
    }
  }
}
