import { encodeBase64 } from "@oslojs/encoding";

const encoder = new TextEncoder();

export async function hashToken(value: string) {
  const hash = await crypto.subtle.digest("SHA-256", encoder.encode(value));
  return encodeBase64(new Uint8Array(hash));
}

export function randomToken(byteLength = 32) {
  return encodeBase64(crypto.getRandomValues(new Uint8Array(byteLength)))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
}
