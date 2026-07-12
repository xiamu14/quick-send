import type { ClientRequest, IncomingMessage } from "node:http";
import { fileURLToPath, URL } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import { tanstackRouter } from "@tanstack/router-plugin/vite";
import react from "@vitejs/plugin-react";
import { defineConfig, type ProxyOptions } from "vite";

const serverPort = Number(process.env.QUICK_SEND_API_PORT ?? 8787);
const serverTarget = `http://127.0.0.1:${serverPort}`;

function proxyOptions(options: ProxyOptions = {}): ProxyOptions {
  return {
    target: serverTarget,
    ...options,
    configure(proxy) {
      const preserveHost = (
        proxyRequest: ClientRequest,
        request: IncomingMessage
      ) => {
        if (request.headers.host) {
          proxyRequest.setHeader("x-forwarded-host", request.headers.host);
        }
      };
      proxy.on("proxyReq", preserveHost);
      proxy.on("proxyReqWs", preserveHost);
    },
  };
}

export default defineConfig({
  build: {
    outDir: "dist/client",
  },
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  server: {
    host: "0.0.0.0",
    port: 5173,
    strictPort: true,
    watch: {
      ignored: [
        "**/.wrangler/**",
        "**/data/**",
        "**/dist/**",
        "**/src-tauri/gen/**",
      ],
    },
    proxy: {
      "/api": proxyOptions(),
    },
  },
  plugins: [tailwindcss(), tanstackRouter(), react()],
});
