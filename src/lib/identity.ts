import FingerprintJS from "@fingerprintjs/fingerprintjs";
import { nanoid } from "nanoid";
import type { BootstrapPayload, User } from "@/shared/types";
import { ApiError, api, post } from "./api";
import { getCredential, setCredential } from "./credential";
import { disconnectSocket } from "./socket";

const fingerprintPromise = FingerprintJS.load();
let ensuring: Promise<User> | undefined;
const fallbackIdentityKey = "quick-send.fallback-identity";

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
  const visitorId = await getVisitorId();
  const identity = await post<{ user: User; credentialToken: string }>(
    "/api/identity/ensure",
    { visitorId }
  );
  setCredential(identity.credentialToken);
  disconnectSocket();
  return identity.user;
}

async function getVisitorId() {
  return (
    (await Promise.race([
      fingerprintPromise.then((fingerprint) =>
        fingerprint.get().then((result) => result.visitorId)
      ),
      new Promise<undefined>((resolve) =>
        window.setTimeout(resolve, 1500, undefined)
      ),
    ])) ?? getFallbackVisitorId()
  );
}

function getFallbackVisitorId() {
  try {
    const existing = window.localStorage.getItem(fallbackIdentityKey);
    if (existing) {
      return existing;
    }
    const created = `device_${nanoid()}`;
    window.localStorage.setItem(fallbackIdentityKey, created);
    return created;
  } catch {
    return `device_${nanoid()}`;
  }
}
