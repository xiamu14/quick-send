const credentialKey = "quick-send.credential";
let memoryCredential: string | undefined;

export function getCredential() {
  try {
    return window.localStorage.getItem(credentialKey) ?? memoryCredential;
  } catch {
    return memoryCredential;
  }
}

export function setCredential(value: string) {
  memoryCredential = value;
  try {
    window.localStorage.setItem(credentialKey, value);
  } catch {
    // The current browser session can still use the in-memory credential.
  }
}

export function clearCredential() {
  memoryCredential = undefined;
  try {
    window.localStorage.removeItem(credentialKey);
  } catch {
    // Nothing else to clear.
  }
}
