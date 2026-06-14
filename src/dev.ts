import { spawn } from "bun";
import { prepareServer, serverPort, waitForServer } from "./run-utils";

await prepareServer();

const server = spawn(["bun", "run", "src/server/index.ts"], {
  cwd: process.cwd(),
  env: { ...process.env, PORT: String(serverPort) },
  stdin: "inherit",
  stdout: "inherit",
  stderr: "inherit",
});

await waitForServer(server);

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
  vite.kill(signal);
  server.kill(signal);
}

process.on("SIGINT", () => stop("SIGINT"));
process.on("SIGTERM", () => stop("SIGTERM"));

const result = await Promise.race([
  server.exited.then((exitCode) => ({ source: "server", exitCode })),
  vite.exited.then((exitCode) => ({ source: "vite", exitCode })),
]);
stop("SIGTERM");
await Promise.all([server.exited, vite.exited]);
process.exit(result.exitCode);
