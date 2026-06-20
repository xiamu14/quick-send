import { expect, test } from "bun:test";
import { reserveReceivedFilePreview } from "./save-file";

test("reports a blocked file preview window", () => {
  expect(reserveReceivedFilePreview(() => null)).toBeUndefined();
});

test("reserves the preview window synchronously", () => {
  let closed = false;
  const opened = {
    close: () => {
      closed = true;
    },
    location: { href: "" },
    opener: undefined,
  } as unknown as Window;

  const preview = reserveReceivedFilePreview(() => opened);
  preview?.close();

  expect(closed).toBe(true);
  expect(opened.opener).toBeNull();
});
