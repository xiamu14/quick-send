import { ApiError, post } from "@/lib/api";
import { getCredential } from "@/lib/credential";
import type { ChatMessage } from "@/shared/types";
import { IncrementalMd5 } from "@/web/md5";

const hashChunkSize = 4 * 1024 * 1024;

type FileMetadata = {
  clientMessageId: string;
  fileId: string;
  name: string;
  size: number;
  mime: string;
  previewDataUrl?: string;
};

type PrepareResult =
  | { uploadRequired: true }
  | { uploadRequired: false; message: ChatMessage };

export async function uploadCachedFile(
  roomId: string,
  file: File,
  metadata: Omit<FileMetadata, "fileId" | "name" | "size" | "mime">,
  onProgress: (progress: number) => void
) {
  const fileId = await hashFile(file, (progress) => onProgress(progress * 0.2));
  const input: FileMetadata = {
    ...metadata,
    fileId,
    name: file.name,
    size: file.size,
    mime: file.type || "application/octet-stream",
  };
  let result = await prepareFile(roomId, input);
  if (result.uploadRequired) {
    await uploadBytes(roomId, fileId, file, (progress) =>
      onProgress(0.2 + progress * 0.8)
    );
    result = await prepareFile(roomId, input);
  }
  if (result.uploadRequired) {
    throw new Error("Server did not retain the uploaded file");
  }
  onProgress(1);
  return result.message;
}

export async function downloadCachedFile(
  message: ChatMessage,
  onProgress: (progress: number) => void
) {
  const attachment = message.fileAttachment;
  if (!attachment) {
    throw new Error("File attachment is missing");
  }
  const credential = getCredential();
  const response = await fetch(`/api/messages/${message.id}/file`, {
    headers: credential ? { authorization: `Bearer ${credential}` } : {},
  });
  if (!response.ok) {
    throw await responseError(response);
  }
  if (!response.body) {
    throw new Error("Download stream is unavailable");
  }
  const reader = response.body.getReader();
  const chunks: ArrayBuffer[] = [];
  let received = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    chunks.push(value.slice().buffer);
    received += value.byteLength;
    onProgress(Math.min(1, received / attachment.size));
  }
  if (received !== attachment.size) {
    throw new Error(`Received ${received} bytes, expected ${attachment.size}`);
  }
  onProgress(1);
  return new File(chunks, attachment.name, { type: attachment.mime });
}

async function hashFile(file: File, onProgress: (progress: number) => void) {
  const hash = new IncrementalMd5();
  let offset = 0;
  while (offset < file.size) {
    const chunk = await file
      .slice(offset, Math.min(file.size, offset + hashChunkSize))
      .arrayBuffer();
    hash.append(chunk);
    offset += chunk.byteLength;
    onProgress(offset / file.size);
  }
  return hash.end();
}

function prepareFile(roomId: string, metadata: FileMetadata) {
  return post<PrepareResult>(`/api/rooms/${roomId}/files/prepare`, metadata);
}

function uploadBytes(
  roomId: string,
  fileId: string,
  file: File,
  onProgress: (progress: number) => void
) {
  return new Promise<void>((resolve, reject) => {
    const request = new XMLHttpRequest();
    request.open(
      "PUT",
      `/api/rooms/${roomId}/files/${fileId}?size=${file.size}`
    );
    const credential = getCredential();
    if (credential) {
      request.setRequestHeader("authorization", `Bearer ${credential}`);
    }
    request.upload.onprogress = (event) => {
      if (event.lengthComputable) {
        onProgress(event.loaded / event.total);
      }
    };
    request.onerror = () => reject(new Error("File upload failed"));
    request.onload = () => {
      if (request.status >= 200 && request.status < 300) {
        resolve();
        return;
      }
      try {
        const payload = JSON.parse(request.responseText) as {
          error?: { code?: string; message?: string };
        };
        reject(
          new ApiError(
            payload.error?.code ?? "UPLOAD_FAILED",
            payload.error?.message ?? "File upload failed",
            request.status
          )
        );
      } catch {
        reject(new Error("File upload failed"));
      }
    };
    request.send(file);
  });
}

async function responseError(response: Response) {
  const payload = (await response.json().catch(() => undefined)) as
    | { error?: { code?: string; message?: string } }
    | undefined;
  return new ApiError(
    payload?.error?.code ?? "DOWNLOAD_FAILED",
    payload?.error?.message ?? "File download failed",
    response.status
  );
}
