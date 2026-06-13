import { decodeBase64, encodeBase64 } from "@oslojs/encoding";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export function readEncryptionKey() {
  const value = process.env.IDENTITY_ENCRYPTION_KEY?.trim();
  if (!value) {
    throw new Error("IDENTITY_ENCRYPTION_KEY is required");
  }
  const key = decodeBase64(value);
  if (key.byteLength !== 32) {
    throw new Error("IDENTITY_ENCRYPTION_KEY must be a Base64 32-byte key");
  }
  return key;
}

export async function encryptText(value: string, rawKey: Uint8Array) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const keyBytes = new Uint8Array(rawKey);
  const key = await crypto.subtle.importKey("raw", keyBytes, "AES-GCM", false, [
    "encrypt",
  ]);
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    key,
    encoder.encode(value)
  );
  return `${encodeBase64(iv)}.${encodeBase64(new Uint8Array(ciphertext))}`;
}

export async function decryptText(value: string, rawKey: Uint8Array) {
  const [encodedIv, encodedCiphertext] = value.split(".");
  if (!(encodedIv && encodedCiphertext)) {
    throw new Error("Invalid encrypted value");
  }
  const keyBytes = new Uint8Array(rawKey);
  const key = await crypto.subtle.importKey("raw", keyBytes, "AES-GCM", false, [
    "decrypt",
  ]);
  const plaintext = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: new Uint8Array(decodeBase64(encodedIv)) },
    key,
    new Uint8Array(decodeBase64(encodedCiphertext))
  );
  return decoder.decode(plaintext);
}

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
