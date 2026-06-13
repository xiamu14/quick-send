import { encodeBase64 } from "@oslojs/encoding";

console.log(encodeBase64(crypto.getRandomValues(new Uint8Array(32))));
