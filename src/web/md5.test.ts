import { describe, expect, test } from "bun:test";
import { IncrementalMd5 } from "./md5";

describe("IncrementalMd5", () => {
  test.each([
    ["", "d41d8cd98f00b204e9800998ecf8427e"],
    ["a", "0cc175b9c0f1b6a831c399e269772661"],
    ["message digest", "f96b697d7cb7938d525a2f31aaf161d0"],
  ])("hashes %j", (input, expected) => {
    const hash = new IncrementalMd5();
    hash.append(new TextEncoder().encode(input).buffer);
    expect(hash.end()).toBe(expected);
  });

  test("keeps hash state across chunk boundaries", () => {
    const bytes = new TextEncoder().encode("abcdefghijklmnopqrstuvwxyz");
    const hash = new IncrementalMd5();
    hash.append(bytes.slice(0, 7).buffer);
    hash.append(bytes.slice(7).buffer);
    expect(hash.end()).toBe("c3fcd3d76192e4007dfb496cca67e13b");
  });
});
