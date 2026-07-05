import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";

export function isTauriApp() {
  return "__TAURI_INTERNALS__" in window;
}

export async function pickNativePath(options?: { imageOnly?: boolean }) {
  const selected = await open({
    multiple: false,
    directory: false,
    ...(options?.imageOnly
      ? {
          filters: [
            {
              name: "Images",
              extensions: ["png", "jpg", "jpeg", "gif", "webp"],
            },
          ],
        }
      : {}),
  });
  return typeof selected === "string" ? selected : undefined;
}

export function startNativeShare(path: string) {
  return invoke<string>("send_items", {
    paths: [path],
    relay: null,
  });
}
