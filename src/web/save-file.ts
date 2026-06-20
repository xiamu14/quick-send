export type ReceivedFilePreview = {
  close: () => void;
  show: (file: File) => void;
};

export function reserveReceivedFilePreview(
  openWindow: () => Window | null = () => window.open("", "_blank")
): ReceivedFilePreview | undefined {
  const opened = openWindow();
  if (!opened) {
    return;
  }
  opened.opener = null;
  return {
    close: () => opened.close(),
    show: (file) => {
      const url = URL.createObjectURL(file);
      opened.location.href = url;
      window.setTimeout(() => URL.revokeObjectURL(url), 10 * 60_000);
    },
  };
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
