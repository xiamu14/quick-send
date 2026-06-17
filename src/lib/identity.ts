import FingerprintJS from "@fingerprintjs/fingerprintjs";
import type { BootstrapPayload, User } from "@/shared/types";
import { ApiError, api, post } from "./api";
import { getCredential, setCredential } from "./credential";
import { disconnectSocket } from "./socket";

const fingerprintPromise = FingerprintJS.load();
let ensuring: Promise<User> | undefined;

export async function ensureLocalIdentity() {
  if (getCredential()) {
    return;
  }
  ensuring ??= createLocalIdentity().finally(() => {
    ensuring = undefined;
  });
  await ensuring;
}

export async function bootstrapWithIdentity() {
  await ensureLocalIdentity();
  try {
    return await api<BootstrapPayload>("/api/bootstrap");
  } catch (error) {
    if (error instanceof ApiError && error.code === "UNAUTHORIZED") {
      await createLocalIdentity();
      return api<BootstrapPayload>("/api/bootstrap");
    }
    throw error;
  }
}

async function createLocalIdentity() {
  const fingerprint = await fingerprintPromise;
  const result = await fingerprint.get();
  const identity = await post<{ user: User; credentialToken: string }>(
    "/api/identity/ensure",
    { visitorId: result.visitorId }
  );
  setCredential(identity.credentialToken);
  disconnectSocket();
  return identity.user;
}
