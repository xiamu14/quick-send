import FingerprintJS from "@fingerprintjs/fingerprintjs";
import { Button, Spinner } from "@heroui/react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { Copy, LogOut, Send, Upload } from "lucide-react";
import { nanoid } from "nanoid";
import { useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";

export const Route = createFileRoute("/")({
  component: V3App,
});

type Device = {
  id: string;
  displayName: string;
  kind: "desktop" | "mobile" | "tablet";
  lastSeenAt: string;
  revokedAt: string | null;
};

type Bootstrap = {
  user: { id: string; email: string; name: string };
  currentDevice: Device;
  devices: Device[];
};

type Message = {
  id: string;
  senderDeviceId: string;
  senderDeviceNameSnapshot: string;
  kind: "text" | "image";
  body: string | null;
  localDate: string;
  createdAt: string;
  image?: { id: string; name: string; mime: string; size: number } | null;
};

function V3App() {
  const session = useQuery({
    queryKey: ["session"],
    queryFn: () =>
      authApi<{ user?: { email: string } } | null>("/api/auth/get-session"),
    staleTime: 60_000,
    retry: false,
  });
  if (session.isLoading) {
    return <FullScreenSpinner />;
  }
  if (!session.data?.user) {
    return <LoginScreen onDone={() => session.refetch()} />;
  }
  return <InboxScreen />;
}

function LoginScreen({ onDone }: { onDone: () => void }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const continueWithPassword = useMutation({
    mutationFn: async () => {
      const normalizedEmail = email.trim().toLowerCase();
      const { exists } = await authApi<{ exists: boolean }>(
        "/api/auth/email-exists",
        {
          method: "POST",
          body: { email: normalizedEmail },
        }
      );
      return authApi(
        exists ? "/api/auth/sign-in/email" : "/api/auth/sign-up/email",
        {
          method: "POST",
          body: exists
            ? { email: normalizedEmail, password, rememberMe: true }
            : {
                email: normalizedEmail,
                password,
                name: normalizedEmail.split("@")[0] || "Quick Send",
                rememberMe: true,
              },
        }
      );
    },
    onSuccess: onDone,
    onError: showError,
  });
  const busy = continueWithPassword.isPending;
  return (
    <main className="grid min-h-screen place-items-center bg-slate-100 px-4 text-slate-950">
      <section className="w-full max-w-sm rounded-lg border border-slate-200 bg-white p-5 shadow-sm">
        <h1 className="font-semibold text-xl">Quick Send</h1>
        <p className="mt-1 text-slate-500 text-sm">
          Sign in to sync text and images across your devices.
        </p>
        <div className="mt-5 space-y-3">
          <input
            className="w-full rounded-md border border-slate-200 px-3 py-2 text-sm outline-none focus:border-blue-500"
            onChange={(event) => setEmail(event.currentTarget.value)}
            placeholder="Email"
            type="email"
            value={email}
          />
          <input
            className="w-full rounded-md border border-slate-200 px-3 py-2 text-sm outline-none focus:border-blue-500"
            onChange={(event) => setPassword(event.currentTarget.value)}
            placeholder="Password"
            type="password"
            value={password}
          />
          <Button
            className="w-full"
            isDisabled={busy || !email || password.length < 8}
            onPress={() => continueWithPassword.mutate()}
            variant="primary"
          >
            {busy ? "Please wait" : "Continue"}
          </Button>
        </div>
      </section>
    </main>
  );
}

function InboxScreen() {
  const queryClient = useQueryClient();
  const [selectedDeviceId, setSelectedDeviceId] = useState<string>();
  const [selectedDate, setSelectedDate] = useState<string>();
  const timelineEnd = useRef<HTMLDivElement>(null);
  const bootstrap = useQuery({
    queryKey: ["bootstrap"],
    queryFn: () => api<Bootstrap>("/api/bootstrap"),
    refetchInterval: 5000,
    refetchIntervalInBackground: false,
    staleTime: 5000,
  });
  const devices = bootstrap.data?.devices ?? [];
  const currentDevice = bootstrap.data?.currentDevice;
  const activeDeviceId =
    selectedDeviceId ?? currentDevice?.id ?? devices[0]?.id;
  const dates = useMemo(() => recentDates(), []);
  const activeDate = selectedDate ?? dates[0];
  const messages = useQuery({
    enabled: Boolean(activeDeviceId),
    queryKey: ["messages", activeDeviceId, activeDate],
    queryFn: () =>
      api<{ messages: Message[] }>(
        `/api/messages?sourceDeviceId=${activeDeviceId}&localDate=${activeDate}&timezone=${encodeURIComponent(Intl.DateTimeFormat().resolvedOptions().timeZone)}`
      ),
    refetchInterval: 5000,
    refetchIntervalInBackground: false,
    placeholderData: (previous) => previous,
  });
  useEffect(() => {
    if (!selectedDeviceId && currentDevice?.id) {
      setSelectedDeviceId(currentDevice.id);
    }
  }, [currentDevice?.id, selectedDeviceId]);
  useEffect(() => {
    timelineEnd.current?.scrollIntoView({ block: "end" });
  });
  const signOut = useMutation({
    mutationFn: () => authApi("/api/auth/sign-out", { method: "POST" }),
    onSuccess: () => location.reload(),
  });
  return (
    <main className="flex h-screen bg-slate-100 text-slate-950">
      <aside className="hidden w-72 border-slate-200 border-r bg-white md:block">
        <div className="flex h-16 items-center justify-between border-slate-200 border-b px-4">
          <div>
            <div className="font-semibold">Devices</div>
            <div className="text-slate-500 text-xs">
              {bootstrap.data?.user.email}
            </div>
          </div>
          <Button
            isIconOnly
            onPress={() => signOut.mutate()}
            size="sm"
            variant="ghost"
          >
            <LogOut size={16} />
          </Button>
        </div>
        <div className="p-2">
          {devices.map((device) => (
            <button
              className={`flex w-full items-center gap-3 rounded-md px-3 py-2 text-left ${
                device.id === activeDeviceId
                  ? "bg-blue-50 text-blue-700"
                  : "hover:bg-slate-100"
              }`}
              key={device.id}
              onClick={() => setSelectedDeviceId(device.id)}
              type="button"
            >
              <span className="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-slate-200 text-xs">
                {device.displayName.slice(0, 2).toUpperCase()}
              </span>
              <span className="min-w-0 flex-1 truncate">
                {device.displayName}
              </span>
            </button>
          ))}
        </div>
      </aside>
      <section className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-16 items-center justify-between border-slate-200 border-b bg-white px-4">
          <div>
            <div className="font-semibold">
              {devices.find((device) => device.id === activeDeviceId)
                ?.displayName ?? "Current device"}
            </div>
            <div className="text-slate-500 text-xs">
              Source device conversation
            </div>
          </div>
        </header>
        <div className="border-slate-200 border-b bg-white px-4 py-3 md:hidden">
          <select
            className="h-10 w-full rounded-md border border-slate-200 bg-white px-3 text-sm outline-none focus:border-blue-500"
            onChange={(event) => setSelectedDeviceId(event.currentTarget.value)}
            value={activeDeviceId ?? ""}
          >
            {devices.map((device) => (
              <option key={device.id} value={device.id}>
                {device.displayName}
              </option>
            ))}
          </select>
        </div>
        <div className="border-slate-200 border-b bg-white px-4">
          <div className="flex gap-2 overflow-x-auto">
            {dates.map((date) => (
              <button
                className={`border-b-2 px-1 py-3 text-sm ${
                  activeDate === date
                    ? "border-blue-600 text-blue-700"
                    : "border-transparent text-slate-500"
                }`}
                key={date}
                onClick={() => setSelectedDate(date)}
                type="button"
              >
                {dateLabel(date)}
              </button>
            ))}
          </div>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto p-4">
          {messages.isLoading ? (
            <FullScreenSpinner />
          ) : (
            <div className="mx-auto flex max-w-3xl flex-col gap-3">
              {(messages.data?.messages ?? []).map((message) => (
                <MessageItem key={message.id} message={message} />
              ))}
              <div ref={timelineEnd} />
              {messages.data?.messages.length === 0 ? (
                <div className="pt-24 text-center text-slate-500">
                  No messages yet
                </div>
              ) : null}
            </div>
          )}
        </div>
        <Composer
          activeDate={activeDate}
          activeDeviceId={activeDeviceId}
          disabled={!currentDevice}
          onSent={async (message) => {
            syncLog("invalidate_start", {
              activeDeviceId,
              activeDate,
              messageId: message?.id,
              messageLocalDate: message?.localDate,
              messageDeviceId: message?.senderDeviceId,
            });
            await queryClient.invalidateQueries({
              queryKey: ["messages", activeDeviceId],
            });
            const cached = queryClient.getQueryData<{ messages: Message[] }>([
              "messages",
              activeDeviceId,
              activeDate,
            ]);
            syncLog("invalidate_done", {
              activeDeviceId,
              activeDate,
              messageId: message?.id,
              cachedCount: cached?.messages.length,
              cachedHasMessage: Boolean(
                message &&
                  cached?.messages.some((item) => item.id === message.id)
              ),
            });
          }}
        />
      </section>
    </main>
  );
}

function MessageItem({ message }: { message: Message }) {
  const content = messageContent(message);
  return (
    <article className="rounded-lg border border-slate-200 bg-white p-3 shadow-sm">
      <div className="mb-2 flex items-center justify-end gap-1 text-slate-500 text-xs">
        <span>{new Date(message.createdAt).toLocaleTimeString()}</span>
        {message.kind === "text" && message.body ? (
          <Button
            isIconOnly
            onPress={() => copyMessageText(message.body ?? "")}
            size="sm"
            variant="ghost"
          >
            <Copy size={14} />
          </Button>
        ) : null}
      </div>
      {content}
    </article>
  );
}

function messageContent(message: Message) {
  if (message.kind === "text") {
    return <p className="whitespace-pre-wrap text-sm">{message.body}</p>;
  }
  if (!message.image) {
    return (
      <div className="flex h-40 items-center justify-center rounded-md border border-slate-300 border-dashed bg-slate-50 text-slate-500 text-sm">
        Uploading image…
      </div>
    );
  }
  return (
    <a
      href={`/api/images/${message.image.id}?size=original`}
      rel="noreferrer"
      target="_blank"
    >
      <img
        alt={message.image.name}
        className="max-h-96 rounded-md object-contain"
        src={`/api/images/${message.image.id}`}
      />
    </a>
  );
}

async function copyMessageText(text: string) {
  try {
    await navigator.clipboard.writeText(text);
    toast.success("Copied");
  } catch {
    toast.error("Copy failed");
  }
}

function Composer({
  activeDate,
  activeDeviceId,
  disabled,
  onSent,
}: {
  activeDate: string | undefined;
  activeDeviceId: string | undefined;
  disabled: boolean;
  onSent: (message?: Message) => void | Promise<void>;
}) {
  const [body, setBody] = useState("");
  const text = useMutation({
    mutationFn: () =>
      api("/api/messages", {
        method: "POST",
        body: {
          body,
          timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        },
      }),
    onSuccess: () => {
      setBody("");
      onSent();
    },
  });
  const image = useMutation({
    mutationFn: async (file: File) => {
      const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
      syncLog("image_upload_start", {
        activeDeviceId,
        activeDate,
        name: file.name,
        size: file.size,
        type: file.type,
        timezone,
      });
      const pending = await api<{ message: Message }>("/api/messages/image", {
        method: "POST",
        body: {
          mime: file.type,
          name: file.name || "image",
          size: file.size,
          timezone,
        },
      });
      await onSent(pending.message);
      const form = new FormData();
      form.set("image", file);
      form.set("thumbnail", file);
      form.set("timezone", timezone);
      const response = await fetch(
        `/api/messages/${pending.message.id}/image`,
        {
          method: "POST",
          headers: await deviceHeaders(),
          credentials: "include",
          body: form,
        }
      );
      if (!response.ok) {
        throw new Error(await errorMessage(response));
      }
      const payload = (await response.json()) as { message: Message };
      syncLog("image_upload_done", {
        activeDeviceId,
        activeDate,
        messageId: payload.message.id,
        messageLocalDate: payload.message.localDate,
        messageDeviceId: payload.message.senderDeviceId,
      });
      return payload;
    },
    onSuccess: (payload) => onSent(payload.message),
    onError: (error) => {
      syncLog("image_upload_error", {
        message: error instanceof Error ? error.message : String(error),
      });
      showError(error);
    },
  });
  return (
    <footer className="border-slate-200 border-t bg-white p-3">
      <div className="mx-auto flex max-w-3xl items-end gap-2">
        <textarea
          className="max-h-32 min-h-10 flex-1 resize-none rounded-md border border-slate-200 px-3 py-2 text-sm outline-none focus:border-blue-500"
          onChange={(event) => setBody(event.currentTarget.value)}
          placeholder="Send text to your devices"
          rows={1}
          value={body}
        />
        <label
          className={`grid h-10 w-10 place-items-center rounded-md border border-slate-200 ${
            disabled || image.isPending ? "opacity-50" : "cursor-pointer"
          }`}
        >
          <Upload size={18} />
          <input
            accept="image/jpeg,image/png,image/webp,image/gif"
            className="hidden"
            onChange={(event) => {
              const file = event.currentTarget.files?.[0];
              if (file) {
                image.mutate(file);
              }
              event.currentTarget.value = "";
            }}
            type="file"
          />
        </label>
        <Button
          isDisabled={disabled || !body.trim()}
          isIconOnly
          onPress={() => text.mutate()}
          variant="primary"
        >
          <Send size={18} />
        </Button>
      </div>
    </footer>
  );
}

function FullScreenSpinner() {
  return (
    <div className="grid min-h-40 place-items-center">
      <Spinner />
    </div>
  );
}

function showError(error: Error) {
  toast.error(error.message || "Request failed");
}

function syncLog(event: string, data: Record<string, unknown> = {}) {
  if (!syncDebugEnabled()) {
    return;
  }
  console.log("[sync]", { event, ...data });
}

function syncDebugEnabled() {
  if (import.meta.env.DEV) {
    return true;
  }
  try {
    const params = new URLSearchParams(window.location.search);
    if (params.get("debug") === "true") {
      window.localStorage.setItem("quick-send.debug", "true");
      return true;
    }
    return window.localStorage.getItem("quick-send.debug") === "true";
  } catch {
    return false;
  }
}

async function api<T>(
  path: string,
  init: { method?: string; body?: unknown } = {}
) {
  return request<T>(path, init, await deviceHeaders());
}

function authApi<T>(
  path: string,
  init: { method?: string; body?: unknown } = {}
) {
  return request<T>(path, init);
}

async function request<T>(
  path: string,
  init: { method?: string; body?: unknown } = {},
  headers: Record<string, string> = {}
) {
  const initRequest: RequestInit = {
    method: init.method ?? "GET",
    headers: {
      "content-type": "application/json",
      ...headers,
    },
    credentials: "include",
  };
  if (init.body) {
    initRequest.body = JSON.stringify(init.body);
  }
  const response = await fetch(path, initRequest);
  if (!response.ok) {
    throw new Error(await errorMessage(response));
  }
  if (headers["x-quick-send-previous-device-id"]) {
    localStorage.removeItem("quick-send-previous-device-id");
  }
  return response.json() as Promise<T>;
}

async function errorMessage(response: Response) {
  const text = await response.text();
  try {
    const data = JSON.parse(text) as { message?: string; error?: string };
    return data.message ?? data.error ?? text;
  } catch {
    return text;
  }
}

async function deviceHeaders() {
  const previous = await previousDeviceId();
  return {
    "x-quick-send-device-id": await getDeviceId(),
    ...(previous ? { "x-quick-send-previous-device-id": previous } : {}),
  };
}

const fingerprintPromise = FingerprintJS.load();
let deviceIdPromise: Promise<string> | undefined;

function getDeviceId() {
  deviceIdPromise ??= resolveDeviceId();
  return deviceIdPromise;
}

async function resolveDeviceId() {
  const key = "quick-send-device-id";
  try {
    const visitorId = await Promise.race([
      fingerprintPromise.then((fingerprint) =>
        fingerprint.get().then((result) => result.visitorId)
      ),
      new Promise<undefined>((resolve) =>
        window.setTimeout(resolve, 1500, undefined)
      ),
    ]);
    if (visitorId) {
      const id = `fp_${visitorId}`;
      const previous = localStorage.getItem(key);
      if (previous && previous !== id) {
        localStorage.setItem("quick-send-previous-device-id", previous);
      }
      localStorage.setItem(key, id);
      return id;
    }
  } catch {
    // fallback below
  }
  const existing = localStorage.getItem(key);
  if (existing) {
    return existing;
  }
  const id = `device_${nanoid()}`;
  localStorage.setItem(key, id);
  return id;
}

async function previousDeviceId() {
  const previous = localStorage.getItem("quick-send-previous-device-id");
  const current = await getDeviceId();
  return previous && previous !== current ? previous : undefined;
}

function recentDates() {
  return Array.from({ length: 7 }, (_, index) => {
    const date = new Date();
    date.setDate(date.getDate() - index);
    return date.toISOString().slice(0, 10);
  });
}

function dateLabel(date: string) {
  const today = new Date().toISOString().slice(0, 10);
  const yesterday = new Date();
  yesterday.setDate(yesterday.getDate() - 1);
  if (date === today) {
    return "Today";
  }
  if (date === yesterday.toISOString().slice(0, 10)) {
    return "Yesterday";
  }
  return date.slice(5);
}
