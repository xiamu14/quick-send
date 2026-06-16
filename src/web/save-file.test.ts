import { afterEach, expect, test } from "bun:test";
import { prepareReceivedFile } from "./save-file";

const navigatorDescriptor = Object.getOwnPropertyDescriptor(
  globalThis,
  "navigator"
);

afterEach(() => {
  if (navigatorDescriptor) {
    Object.defineProperty(globalThis, "navigator", navigatorDescriptor);
  } else {
    Reflect.deleteProperty(globalThis, "navigator");
  }
});

test("mobile images wait for an explicit save action", () => {
  setNavigator({
    maxTouchPoints: 1,
  });
  const file = new File(["image"], "photo.jpg", { type: "image/jpeg" });

  expect(prepareReceivedFile(file)).toEqual({
    file,
    needsUserSave: true,
  });
});

test("mobile images do not depend on Web Share support", () => {
  setNavigator({
    maxTouchPoints: 1,
  });
  const file = new File(["image"], "photo.jpg", { type: "image/jpeg" });
  const result = prepareReceivedFile(file);

  expect(result.needsUserSave).toBe(true);
});

function setNavigator(value: Partial<Navigator>) {
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value,
  });
}
