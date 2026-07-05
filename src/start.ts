import { networkInterfaces } from "node:os";
import { spawn, spawnSync } from "bun";
import { renderUnicodeCompact } from "uqr";
import { lanUrl, prepareServer, serverPort, waitForServer } from "./run-utils";

await prepareServer();

const parsedLanUrl = new URL(lanUrl);
const proxyPort = parsedLanUrl.port || "80";
const lanIp = process.env.QUICK_SEND_LAN_IP ?? detectLanIp();
const lanIpArgs = lanIp ? ["--ip", lanIp] : [];

runPortless([
  "proxy",
  "start",
  "--no-tls",
  "--lan",
  ...lanIpArgs,
  "-p",
  proxyPort,
]);
runPortless(["alias", "quick", String(serverPort), "--force"]);

run(["bun", "run", "build:web"]);

const app = spawn(["bun", "run", "src/server/index.ts"], {
  cwd: process.cwd(),
  env: {
    ...process.env,
    HOST: "127.0.0.1",
    PORT: String(serverPort),
    PORTLESS_LAN: "1",
    PORTLESS_URL: lanUrl,
  },
  stdin: "inherit",
  stdout: "inherit",
  stderr: "inherit",
});

await waitForServer(app);

console.log(`Quick Send is available at ${lanUrl}`);
if (lanIp) {
  console.log(`Portless LAN IP: ${lanIp}`);
}
console.log(renderUnicodeCompact(lanUrl, { border: 2 }));

let stopping = false;
function stop(signal: NodeJS.Signals) {
  if (stopping) {
    return;
  }
  stopping = true;
  app.kill(signal);
}

process.on("SIGINT", () => stop("SIGINT"));
process.on("SIGTERM", () => stop("SIGTERM"));

const exitCode = await app.exited;
stop("SIGTERM");
process.exit(exitCode);

function detectLanIp() {
  const interfaces = networkInterfaces();
  const candidates = Object.values(interfaces)
    .flatMap((entries) => entries ?? [])
    .filter(
      (entry) =>
        entry.family === "IPv4" &&
        !entry.internal &&
        !entry.address.startsWith("169.254.") &&
        !entry.address.startsWith("198.18.")
    );
  return candidates[0]?.address;
}

function runPortless(args: string[]) {
  const result = spawnSync(["portless", ...args], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      PORTLESS_HTTPS: "0",
      PORTLESS_LAN: "1",
      PORTLESS_PORT: proxyPort,
      ...(lanIp ? { PORTLESS_LAN_IP: lanIp } : {}),
    },
    stdout: "inherit",
    stderr: "inherit",
  });
  if (result.exitCode !== 0) {
    process.exit(result.exitCode);
  }
}

function run(command: string[]) {
  const result = spawnSync(command, {
    cwd: process.cwd(),
    env: process.env,
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  });
  if (result.exitCode !== 0) {
    process.exit(result.exitCode);
  }
}
