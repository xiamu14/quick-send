export type ReceivedFileResult = {
  file: File;
  needsUserSave: boolean;
};

const fileExtensionPattern = /\.[a-z0-9]+$/i;

type SaveFilePicker = (options?: {
  suggestedName?: string;
  types?: Array<{
    description?: string;
    accept: Record<string, string[]>;
  }>;
}) => Promise<{
  createWritable: () => Promise<{
    write: (data: File) => Promise<void>;
    close: () => Promise<void>;
  }>;
}>;

export function prepareReceivedFile(file: File): ReceivedFileResult {
  if (needsExplicitDownload(file)) {
    return { file, needsUserSave: true };
  }
  downloadReceivedFile(file);
  return { file, needsUserSave: false };
}

function needsExplicitDownload(file: File) {
  return file.type.startsWith("image/") && navigator.maxTouchPoints > 0;
}

export async function saveReceivedFile(file: File) {
  const saveFilePicker = (
    window as typeof window & { showSaveFilePicker?: SaveFilePicker }
  ).showSaveFilePicker;
  if (saveFilePicker) {
    try {
      const handle = await saveFilePicker.call(window, {
        suggestedName: file.name,
        types: [
          {
            description: "Image",
            accept: { [file.type]: [fileExtension(file.name)] },
          },
        ],
      });
      const writable = await handle.createWritable();
      await writable.write(file);
      await writable.close();
      return "saved" as const;
    } catch (error) {
      if (isAbortError(error)) {
        return "cancelled" as const;
      }
    }
  }

  if (
    typeof navigator.canShare === "function" &&
    typeof navigator.share === "function" &&
    navigator.canShare({ files: [file] })
  ) {
    try {
      await navigator.share({ files: [file], title: file.name });
      return "shared" as const;
    } catch (error) {
      if (isAbortError(error)) {
        return "cancelled" as const;
      }
    }
  }

  return "unsupported" as const;
}

export function openReceivedFile(file: File) {
  const url = URL.createObjectURL(file);
  const opened = window.open(url, "_blank");
  if (opened) {
    opened.opener = null;
  }
  window.setTimeout(() => URL.revokeObjectURL(url), 10 * 60_000);
}

export function downloadReceivedFile(file: File) {
  const url = URL.createObjectURL(file);
  const link = document.createElement("a");
  link.href = url;
  link.download = file.name;
  link.style.display = "none";
  document.body.append(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

function fileExtension(name: string) {
  const extension = name.match(fileExtensionPattern)?.[0];
  return extension ?? ".jpg";
}

function isAbortError(error: unknown) {
  return error instanceof DOMException && error.name === "AbortError";
}
