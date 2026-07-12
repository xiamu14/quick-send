import { expect, test } from "bun:test";
import { createRandomId } from "./random-id";

const nanoidPattern = /^[\w-]{21}$/;

test("creates nanoid client message IDs", () => {
  expect(createRandomId()).toMatch(nanoidPattern);
});

test("creates unique client message IDs", () => {
  expect(createRandomId()).not.toBe(createRandomId());
});
