import { clearCredential, getCredential } from "./credential";

export class ApiError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number
  ) {
    super(message);
  }
}

export async function api<T>(
  path: string,
  options: RequestInit = {}
): Promise<T> {
  const credential = getCredential();
  const response = await fetch(path, {
    ...options,
    headers: {
      ...(options.body ? { "content-type": "application/json" } : {}),
      ...(credential ? { authorization: `Bearer ${credential}` } : {}),
      ...options.headers,
    },
  });
  const payload = (await response.json()) as
    | T
    | { error: { code: string; message: string } };
  if (!response.ok) {
    const error =
      "error" in (payload as { error?: unknown })
        ? (payload as { error: { code: string; message: string } }).error
        : { code: "REQUEST_FAILED", message: "Request failed" };
    if (error.code === "UNAUTHORIZED") {
      clearCredential();
    }
    throw new ApiError(error.code, error.message, response.status);
  }
  return payload as T;
}

export function post<T>(path: string, body?: unknown) {
  return api<T>(path, {
    method: "POST",
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

export function remove<T>(path: string, body: unknown) {
  return api<T>(path, { method: "DELETE", body: JSON.stringify(body) });
}
