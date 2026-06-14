import { spawn } from "bun";
import { renderUnicodeCompact } from "uqr";
import { prepareServer, serverPort, waitForServer } from "./run-utils";

const publicUrlPattern = /Public URL:\s+(https:\/\/[^\s]+)/;

await prepareServer();

const app = spawn(["bun", "run", "start:app"], {
  cwd: process.cwd(),
  env: { ...process.env, PORT: String(serverPort) },
  stdin: "inherit",
  stdout: "inherit",
  stderr: "inherit",
});

await waitForServer(app);

const tunnel = spawn(
  ["bunx", "hostc", String(serverPort), "--local-host", "127.0.0.1"],
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
