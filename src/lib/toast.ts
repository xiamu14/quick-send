import { toast as sonnerToast } from "sonner";

const toastId = "quick-send-toast";
type Message = Parameters<typeof sonnerToast>[0];
type Options = Parameters<typeof sonnerToast>[1];

function singleToastOptions(options?: Options): Options {
  return { ...options, id: toastId };
}

export const toast = Object.assign(
  (message: Message, options?: Options) =>
    sonnerToast(message, singleToastOptions(options)),
  {
    error: (message: Message, options?: Options) =>
      sonnerToast.error(message, singleToastOptions(options)),
    success: (message: Message, options?: Options) =>
      sonnerToast.success(message, singleToastOptions(options)),
  }
);
