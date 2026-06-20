import { expect, test } from "bun:test";
import { createRandomId } from "./random-id";

const uuidV4Pattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

test("creates UUID-compatible client message IDs", () => {
  expect(createRandomId()).toMatch(uuidV4Pattern);
});

test("falls back when randomUUID is unavailable", () => {
  const id = createRandomId({
    getRandomValues(bytes) {
      bytes.fill(0xff);
      return bytes;
    },
  });

  expect(id).toBe("ffffffff-ffff-4fff-bfff-ffffffffffff");
});

test("creates unique client message IDs", () => {
  expect(createRandomId()).not.toBe(createRandomId());
});
