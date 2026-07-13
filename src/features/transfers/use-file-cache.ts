import { useState } from "react";
import { post } from "@/lib/api";
import { isTauriApp, pickNativePath, startNativeShare } from "@/lib/tauri";
import { toast } from "@/lib/toast";
import type { ChatMessage } from "@/shared/types";
import { addMessage } from "@/store/app";
import { createImagePreview } from "@/web/preview";
import { createRandomId } from "@/web/random-id";
import {
  downloadReceivedFile,
  reserveReceivedFilePreview,
} from "@/web/save-file";
import { downloadCachedFile, uploadCachedFile } from "./file-cache-service";

export function useFileCache(roomId: string, maxFileBytes: number) {
  const [progress, setProgress] = useState<Record<string, number>>({});
  const [uploading, setUploading] = useState(false);

  async function upload(file: File | undefined) {
    debugUpload("input_change", file);
    if (!file) {
      return;
    }
    if (file.size <= 0 || file.size > maxFileBytes) {
      toast.error("File must be 200 MB or smaller");
      return;
    }
    setUploading(true);
    try {
      const previewDataUrl = file.type.startsWith("image/")
        ? await createImagePreview(file).catch(() => undefined)
        : undefined;
      debugUpload("preview_ready", file, {
        hasPreview: Boolean(previewDataUrl),
      });
      const message = await uploadCachedFile(
        roomId,
        file,
        {
          clientMessageId: createRandomId(),
          ...(previewDataUrl ? { previewDataUrl } : {}),
        },
        (value) => setProgress((current) => ({ ...current, upload: value }))
      );
      addMessage(message);
      toast.success("File uploaded");
    } catch (error) {
      debugUpload("failed", file, {
        message: error instanceof Error ? error.message : String(error),
      });
      toast.error(
        error instanceof Error ? error.message : "File upload failed"
      );
    } finally {
      setUploading(false);
      setProgress((current) => {
        const { upload: _upload, ...next } = current;
        return next;
      });
    }
  }

  async function shareNativeFile(options?: { imageOnly?: boolean }) {
    setUploading(true);
    try {
      const path = await pickNativePath(options);
      if (!path) {
        return;
      }
      const ticket = await startNativeShare(path);
      const message = await post<ChatMessage>(`/api/rooms/${roomId}/messages`, {
        clientMessageId: createRandomId(),
        body: `altsendme:${ticket}`,
      });
      addMessage(message);
      toast.success("File ticket shared");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "File share failed");
    } finally {
      setUploading(false);
    }
  }

  async function download(message: ChatMessage) {
    setProgress((current) => ({ ...current, [message.id]: 0 }));
    try {
      const file = await downloadCachedFile(message, (value) =>
        setProgress((current) => ({ ...current, [message.id]: value }))
      );
      downloadReceivedFile(file);
      toast.success(`Downloaded ${file.name}`);
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "File download failed"
      );
    } finally {
      setProgress((current) => {
        const next = Object.fromEntries(
          Object.entries(current).filter(([key]) => key !== message.id)
        );
        return next;
      });
    }
  }

  async function open(message: ChatMessage) {
    const preview = reserveReceivedFilePreview();
    if (!preview) {
      toast.error("Allow popups to open this file");
      return;
    }
    setProgress((current) => ({ ...current, [message.id]: 0 }));
    try {
      const file = await downloadCachedFile(message, (value) =>
        setProgress((current) => ({ ...current, [message.id]: value }))
      );
      preview.show(file);
    } catch (error) {
      preview.close();
      toast.error(error instanceof Error ? error.message : "File open failed");
    } finally {
      setProgress((current) =>
        Object.fromEntries(
          Object.entries(current).filter(([key]) => key !== message.id)
        )
      );
    }
  }

  return {
    download,
    open,
    progress,
    shareNativeFile: isTauriApp() ? shareNativeFile : undefined,
    upload,
    uploading,
  };
}

function debugUpload(
  event: string,
  file?: File,
  extra: Record<string, unknown> = {}
) {
  if (!import.meta.env.DEV) {
    return;
  }
  console.debug("[upload]", {
    event,
    file: file
      ? { name: file.name, size: file.size, type: file.type }
      : undefined,
    ...extra,
  });
}
