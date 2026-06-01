import {
  Button,
  Card,
  Chip,
  CloseButton,
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@heroui/react";
import {
  FileIcon,
  ImageIcon,
  QrCodeIcon,
  SendIcon,
  UsersIcon,
  XIcon,
} from "lucide-react";
import { AnimatePresence, motion } from "framer-motion";
import QRCode from "qrcode";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { VariableSizeList } from "react-window";
import type { ClientEvent, ServerEvent } from "../shared/protocol";
import type {
  ChatMessage,
  FileOffer,
  Peer,
  TimelineItem,
} from "../shared/types";
import {
  createClientId,
  dayKey,
  dateLabel,
  formatBytes,
  getDeviceId,
} from "./device";
import { apiBase, wsUrl } from "./env";
import { createImagePreview } from "./preview";
import { FileTransferManager } from "./rtc/fileTransfer";

const maxHistoryDays = 7;
type Notice = { text: string; tone: "neutral" | "danger" | "success" };

export function App() {
  const [authenticated, setAuthenticated] = useState<boolean | null>(null);

  useEffect(() => {
    fetch(`${apiBase}/api/session`, { credentials: "include" })
      .then((res) => res.json())
      .then((data) => setAuthenticated(Boolean(data.authenticated)))
      .catch(() => setAuthenticated(false));
  }, []);

  if (authenticated === null)
    return (
      <div className="grid min-h-screen place-items-center text-sm text-default-500">
        Loading
      </div>
    );
  if (!authenticated)
    return <AccessCodeScreen onDone={() => setAuthenticated(true)} />;
  return <ChatApp />;
}

function AccessCodeScreen({ onDone }: { onDone: () => void }) {
  const [code, setCode] = useState("");
  const [error, setError] = useState("");

  async function join() {
    const res = await fetch(`${apiBase}/api/auth/join`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      credentials: "include",
      body: JSON.stringify({ code }),
    });
    if (res.ok) {
      onDone();
      return;
    }
    setError("Invalid code");
  }

  return (
    <main className="grid min-h-screen place-items-center px-5">
      <div className="w-full max-w-sm space-y-5">
        <div>
          <h1 className="text-2xl font-semibold tracking-normal text-default-900">
            Quick Send
          </h1>
          <p className="mt-1 text-sm text-default-500">Enter code</p>
        </div>
        <div className="flex gap-2">
          <input
            autoFocus
            value={code}
            onChange={(event) => setCode(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") void join();
            }}
            className="min-h-11 flex-1 rounded-2xl border border-default-200 bg-white px-4 text-sm outline-none focus:border-primary"
          />
          <Button variant="primary" onPress={join}>
            Join
          </Button>
        </div>
        {error && <p className="text-sm text-danger">{error}</p>}
      </div>
    </main>
  );
}

function ChatApp() {
  const [self, setSelf] = useState<Peer | null>(null);
  const [peers, setPeers] = useState<Peer[]>([]);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [publicUrl, setPublicUrl] = useState("http://quick.local:1355");
  const [qr, setQr] = useState("");
  const [loadedDates, setLoadedDates] = useState<string[]>([]);
  const [hasEarlierMessages, setHasEarlierMessages] = useState(false);
  const [loadingEarlier, setLoadingEarlier] = useState(false);
  const [progress, setProgress] = useState<Record<string, number>>({});
  const [notice, setNotice] = useState<Notice | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const transferRef = useRef<FileTransferManager | null>(null);
  const listRef = useRef<VariableSizeList<any> | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const imageInputRef = useRef<HTMLInputElement | null>(null);
  const peerListReadyRef = useRef(false);
  const selfIdRef = useRef<string | undefined>(undefined);

  const send = useCallback((event: ClientEvent) => {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify(event));
  }, []);

  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => setNotice(null), 2200);
    return () => window.clearTimeout(timer);
  }, [notice]);

  useEffect(() => {
    let alive = true;
    fetch(`${apiBase}/api/bootstrap`, { credentials: "include" })
      .then((res) => res.json())
      .then((data) => {
        if (!alive) return;
        setMessages(data.messages ?? []);
        setPeers(data.peers ?? []);
        setPublicUrl(data.publicUrl ?? "http://quick.local:1355");
        setHasEarlierMessages(Boolean(data.hasEarlierMessages));
        setLoadedDates([dayKey(new Date())]);
      });
    return () => {
      alive = false;
    };
  }, []);

  useEffect(() => {
    QRCode.toDataURL(publicUrl, { margin: 1, width: 196 })
      .then(setQr)
      .catch(() => setQr(""));
  }, [publicUrl]);

  useEffect(() => {
    const deviceId = getDeviceId();
    const ws = new WebSocket(wsUrl());
    wsRef.current = ws;
    ws.onopen = () => {
      ws.send(
        JSON.stringify({
          type: "peer:hello",
          deviceId,
          userAgent: navigator.userAgent,
        } satisfies ClientEvent),
      );
    };
    ws.onmessage = (event) => {
      const data = JSON.parse(event.data) as ServerEvent;
      if (data.type === "peer:self") {
        setSelf(data.peer);
        selfIdRef.current = data.peer.id;
        transferRef.current = new FileTransferManager(
          data.peer.id,
          send,
          (offerId, value) => {
            setProgress((current) => ({ ...current, [offerId]: value }));
          },
          (offerId) => {
            setNotice({ text: "Failed", tone: "danger" });
            send({ type: "transfer:fail", offerId });
          },
          (_offerId, fileName) => {
            setNotice({ text: `Saved ${fileName}`, tone: "success" });
          },
        );
        return;
      }
      if (data.type === "peer:list") {
        setPeers((current) => {
          if (peerListReadyRef.current) {
            const known = new Set(current.map((peer) => peer.id));
            const selfId = selfIdRef.current ?? deviceId;
            const joined = data.peers.find(
              (peer) => peer.id !== selfId && !known.has(peer.id),
            );
            if (joined)
              setNotice({ text: `${joined.nickname} joined`, tone: "neutral" });
          }
          peerListReadyRef.current = true;
          return data.peers;
        });
        return;
      }
      if (data.type === "message:created") {
        if (data.tempId && data.message.fileOfferId) {
          transferRef.current?.bindOffer(data.tempId, data.message.fileOfferId);
        }
        setMessages((current) => mergeMessage(current, data.message));
        scrollToBottom();
        return;
      }
      if (data.type === "message:deleted") {
        setMessages((current) =>
          current.filter((message) => message.id !== data.messageId),
        );
        return;
      }
      if (data.type === "file-offer:updated") {
        setMessages((current) => updateOffer(current, data.offer));
        return;
      }
      if (data.type === "transfer:busy") {
        setNotice({ text: "Busy", tone: "danger" });
        return;
      }
      if (data.type === "transfer:locked") {
        transferRef.current?.handleLocked(
          data.offer,
          data.senderPeerId,
          data.receiverPeerId,
        );
        return;
      }
      if (
        data.type === "rtc:offer" ||
        data.type === "rtc:answer" ||
        data.type === "rtc:candidate"
      ) {
        transferRef.current?.handleRtc(data);
      }
    };
    ws.onclose = () => setNotice({ text: "Connection failed", tone: "danger" });
    return () => ws.close();
  }, [send]);

  const items = useMemo(() => buildItems(messages), [messages]);

  async function sendText(body: string) {
    send({ type: "message:text:create", body, tempId: createClientId() });
  }

  async function chooseFile(file: File | undefined) {
    if (!file) return;
    const tempId = createClientId();
    transferRef.current?.remember(tempId, file);
    const previewDataUrl = await createImagePreview(file).catch(
      () => undefined,
    );
    send({
      type: "message:file:create",
      tempId,
      file: {
        name: file.name,
        size: file.size,
        mime: file.type || "application/octet-stream",
        previewDataUrl,
      },
    });
  }

  async function loadEarlier() {
    if (
      loadingEarlier ||
      !hasEarlierMessages ||
      loadedDates.length >= maxHistoryDays
    )
      return;
    setLoadingEarlier(true);
    const loaded = new Set(loadedDates);
    let cursor = new Date(`${loadedDates[loadedDates.length - 1]}T00:00:00`);
    for (let i = loadedDates.length; i < maxHistoryDays; i += 1) {
      cursor.setDate(cursor.getDate() - 1);
      const key = dayKey(cursor);
      if (loaded.has(key)) continue;
      const res = await fetch(`${apiBase}/api/messages/day/${key}`, {
        credentials: "include",
      });
      const data = await res.json();
      setLoadedDates((current) => [...current, key]);
      setHasEarlierMessages(Boolean(data.hasEarlierMessages));
      if (data.messages?.length) {
        setMessages((current) => mergeMessages(data.messages, current));
        break;
      }
      if (!data.hasEarlierMessages) break;
    }
    setLoadingEarlier(false);
  }

  return (
    <main className="fixed inset-0 flex flex-col overflow-hidden bg-white">
      <TopBar self={self} peers={peers} publicUrl={publicUrl} qr={qr} />
      <section className="mx-auto flex min-h-0 w-full max-w-4xl flex-1 flex-col overflow-hidden">
        <div className="min-h-0 flex-1 px-4 sm:px-6">
          <Timeline
            ref={listRef}
            items={items}
            selfId={self?.id}
            progress={progress}
            canLoadEarlier={
              hasEarlierMessages && loadedDates.length < maxHistoryDays
            }
            loadingEarlier={loadingEarlier}
            onLoadEarlier={loadEarlier}
            onReceive={(offerId) => send({ type: "transfer:receive", offerId })}
            onDelete={(messageId) =>
              send({ type: "message:delete", messageId })
            }
          />
        </div>
        <ToastSlot notice={notice} />
        <Composer
          onSend={sendText}
          onFile={() => fileInputRef.current?.click()}
          onImage={() => imageInputRef.current?.click()}
        />
      </section>
      <input
        ref={fileInputRef}
        hidden
        type="file"
        onChange={(event) => void chooseFile(event.target.files?.[0])}
      />
      <input
        ref={imageInputRef}
        hidden
        type="file"
        accept="image/*"
        onChange={(event) => void chooseFile(event.target.files?.[0])}
      />
    </main>
  );

  function scrollToBottom() {
    requestAnimationFrame(() =>
      listRef.current?.scrollToItem(items.length, "end"),
    );
  }
}

function TopBar({
  self,
  peers,
  publicUrl,
  qr,
}: {
  self: Peer | null;
  peers: Peer[];
  publicUrl: string;
  qr: string;
}) {
  return (
    <header className=" bg-white px-4 py-3">
      <div className="mx-auto flex max-w-4xl items-center justify-between gap-3 border-b border-default-200 pb-3">
        <div>
          <div className="text-xl font-semibold text-default-900">
            Quick Send
          </div>
          <div className="text-xs text-default-500">
            {self ? self.nickname : "Connecting"}
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Popover>
            <PopoverTrigger>
              <Button isIconOnly variant="ghost" aria-label="Peers">
                <UsersIcon size={18} />
              </Button>
            </PopoverTrigger>
            <PopoverContent className="w-56 p-3">
              <div className="w-full space-y-2">
                {peers.map((peer) => (
                  <div key={peer.id} className="flex items-center gap-2">
                    <div className="grid h-8 w-8 flex-none place-items-center rounded-full bg-default-100 text-xs font-semibold">
                      {peer.nickname.slice(0, 1)}
                    </div>
                    <div className="min-w-0">
                      <div className="truncate text-sm font-medium">
                        {peer.nickname}
                      </div>
                      <div className="truncate text-xs text-default-500">
                        {peer.id === self?.id ? "This device" : "Online"}
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </PopoverContent>
          </Popover>
          <Popover>
            <PopoverTrigger>
              <Button isIconOnly variant="ghost" aria-label="QR code">
                <QrCodeIcon size={18} />
              </Button>
            </PopoverTrigger>
            <PopoverContent className="p-4">
              <div className="space-y-3 text-center">
                {qr && <img alt="QR code" className="h-44 w-44" src={qr} />}
                <div className="text-xs text-default-500">{publicUrl}</div>
              </div>
            </PopoverContent>
          </Popover>
        </div>
      </div>
    </header>
  );
}

function ToastSlot({ notice }: { notice: Notice | null }) {
  return (
    <div className="flex h-10 flex-none items-center justify-center px-3">
      <AnimatePresence mode="wait">
        {notice && (
          <NoticePill key={`${notice.tone}-${notice.text}`} notice={notice} />
        )}
      </AnimatePresence>
    </div>
  );
}

function NoticePill({ notice }: { notice: Notice }) {
  const toneClass = {
    neutral: "bg-[oklch(90%_0.012_255)] text-default-700",
    danger: "bg-[oklch(94%_0.045_25)] text-[oklch(45%_0.18_25)]",
    success: "bg-[oklch(93%_0.045_155)] text-[oklch(38%_0.12_155)]",
  }[notice.tone];

  return (
    <motion.div
      initial={{ opacity: 0, y: 8, scale: 0.98 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      exit={{ opacity: 0, y: 6, scale: 0.98 }}
      transition={{ duration: 0.2, ease: [0.16, 1, 0.3, 1] }}
      className={`rounded-full px-3 py-1 text-sm font-medium ${toneClass}`}
    >
      {notice.text}
    </motion.div>
  );
}

const Timeline = function Timeline(
  {
    items,
    selfId,
    progress,
    canLoadEarlier,
    loadingEarlier,
    onLoadEarlier,
    onReceive,
    onDelete,
  }: {
    items: TimelineItem[];
    selfId?: string;
    progress: Record<string, number>;
    canLoadEarlier: boolean;
    loadingEarlier: boolean;
    onLoadEarlier: () => void;
    onReceive: (offerId: string) => void;
    onDelete: (messageId: string) => void;
  },
  ref: React.Ref<VariableSizeList<any>>,
) {
  const rowHeights = useRef<Record<number, number>>({});
  const scrollAreaRef = useRef<HTMLDivElement | null>(null);
  const listInstanceRef = useRef<VariableSizeList<any> | null>(null);
  const [listHeight, setListHeight] = useState(360);
  const setRowHeight = useCallback((index: number, height: number) => {
    if (rowHeights.current[index] === height) return;
    rowHeights.current[index] = height;
    listInstanceRef.current?.resetAfterIndex(index);
  }, []);
  const setListRef = useCallback(
    (node: VariableSizeList<any> | null) => {
      listInstanceRef.current = node;
      if (typeof ref === "function") ref(node);
      else if (ref) ref.current = node;
    },
    [ref],
  );
  const itemData = useMemo(
    () => ({ items, selfId, progress, onReceive, onDelete, setRowHeight }),
    [items, selfId, progress, onReceive, onDelete, setRowHeight],
  );

  useEffect(() => {
    const node = scrollAreaRef.current;
    if (!node) return;
    const update = () =>
      setListHeight(
        Math.max(220, Math.floor(node.getBoundingClientRect().height)),
      );
    update();
    const observer = new ResizeObserver(update);
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex h-11 flex-none items-center justify-center">
        {canLoadEarlier ? (
          <Button size="sm" variant="outline" onPress={onLoadEarlier}>
            {loadingEarlier ? "Loading" : "Earlier"}
          </Button>
        ) : null}
      </div>
      <div ref={scrollAreaRef} className="min-h-0 flex-1 overflow-hidden">
        <VariableSizeList
          ref={setListRef}
          className="chat-scrollbar"
          height={listHeight}
          itemCount={items.length}
          itemData={itemData}
          itemSize={(index) =>
            rowHeights.current[index] ?? estimatedRowHeight(items[index])
          }
          width="100%"
        >
          {Row}
        </VariableSizeList>
      </div>
    </div>
  );
} as unknown as React.ForwardRefExoticComponent<
  {
    items: TimelineItem[];
    selfId?: string;
    progress: Record<string, number>;
    canLoadEarlier: boolean;
    loadingEarlier: boolean;
    onLoadEarlier: () => void;
    onReceive: (offerId: string) => void;
    onDelete: (messageId: string) => void;
  } & React.RefAttributes<VariableSizeList<any>>
>;

function Row({
  index,
  style,
  data,
}: {
  index: number;
  style: React.CSSProperties;
  data: {
    items: TimelineItem[];
    selfId?: string;
    progress: Record<string, number>;
    onReceive: (offerId: string) => void;
    onDelete: (messageId: string) => void;
    setRowHeight: (index: number, height: number) => void;
  };
}) {
  const rowRef = useRef<HTMLDivElement | null>(null);
  const item = data.items[index];
  useEffect(() => {
    const node = rowRef.current;
    if (!node) return;
    const update = () =>
      data.setRowHeight(index, Math.ceil(node.getBoundingClientRect().height));
    update();
    const observer = new ResizeObserver(update);
    observer.observe(node);
    return () => observer.disconnect();
  }, [data, index]);

  if (item.type === "date") {
    return (
      <div style={style}>
        <div ref={rowRef} className="flex h-10 items-center justify-center">
          <Chip size="sm" variant="soft">
            {item.label}
          </Chip>
        </div>
      </div>
    );
  }
  return (
    <div style={style}>
      <div ref={rowRef} className="px-1 py-2">
        <MessageBubble
          message={item.message}
          isSelf={item.message.senderPeerId === data.selfId}
          progress={
            item.message.fileOfferId
              ? data.progress[item.message.fileOfferId]
              : undefined
          }
          onReceive={data.onReceive}
          onDelete={data.onDelete}
        />
      </div>
    </div>
  );
}

function MessageBubble({
  message,
  isSelf,
  progress,
  onReceive,
  onDelete,
}: {
  message: ChatMessage;
  isSelf: boolean;
  progress?: number;
  onReceive: (offerId: string) => void;
  onDelete: (messageId: string) => void;
}) {
  return (
    <div className={`flex ${isSelf ? "justify-end" : "justify-start"}`}>
      <div
        className={`max-w-[82%] ${isSelf ? "items-end" : "items-start"} flex flex-col gap-1`}
      >
        <div
          className={`px-1 text-xs text-default-500 ${isSelf ? "text-right" : "text-left"}`}
        >
          {isSelf
            ? "You"
            : (message.senderNickname ?? message.senderPeerId.slice(0, 8))}
        </div>
        {message.kind === "text" ? (
          <button
            title="Copy"
            onClick={() => copyText(message.body ?? "")}
            className={`max-w-full whitespace-pre-wrap rounded-2xl px-4 py-3 text-left text-[15px] leading-6 shadow-sm transition-transform active:scale-[0.99] ${
              isSelf
                ? " bg-(--quick-primary) text-white"
                : " bg-white text-default-900"
            }`}
          >
            {message.body}
          </button>
        ) : (
          message.fileOffer && (
            <FileCard
              messageId={message.id}
              offer={message.fileOffer}
              isSelf={isSelf}
              progress={progress}
              onReceive={onReceive}
              onDelete={onDelete}
            />
          )
        )}
      </div>
    </div>
  );
}

function FileCard({
  messageId,
  offer,
  isSelf,
  progress,
  onReceive,
  onDelete,
}: {
  messageId: string;
  offer: FileOffer;
  isSelf: boolean;
  progress?: number;
  onReceive: (offerId: string) => void;
  onDelete: (messageId: string) => void;
}) {
  const canReceive =
    !isSelf && offer.status === "available" && offer.expiresAt > Date.now();
  const label = statusLabel(offer);
  const tone = statusTone(offer);
  return (
    <Card
      className={`items-stretch flex-row w-fit max-w-[min(82vw,300px)] min-w-80 rounded-2xl bg-white shadow-sm }`}
    >
      <div className="relative shrink-0 overflow-hidden rounded-2xl">
        {offer.previewDataUrl ? (
          <img
            alt=""
            className="h-20 w-20 flex-none rounded-xl bg-white object-cover"
            src={offer.previewDataUrl}
          />
        ) : (
          <div className="grid h-20 w-20 flex-none place-items-center rounded-xl bg-white">
            <FileIcon className="text-default-400" size={30} />
          </div>
        )}
      </div>
      <div className="flex flex-1 flex-col gap-3">
        <Card.Header className="gap-1">
          <Card.Title className="pr-8">{offer.name}</Card.Title>

          <CloseButton
            onClick={() => onDelete(messageId)}
            aria-label="Close banner"
            className="absolute top-3 right-3"
          />
        </Card.Header>
        <Card.Footer className="mt-auto flex w-full flex-col items-start gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex flex-col">
            {offer.status === "transferring" && (
              <div
                className="absolute inset-x-3 bottom-2 h-1 overflow-hidden rounded-full bg-default-100"
                aria-label="Progress"
              >
                <div
                  className="h-full rounded-full bg-(--quick-primary)"
                  style={{ width: `${Math.round((progress ?? 0) * 100)}%` }}
                />
              </div>
            )}

            <Chip color="warning" variant="primary">
              <Chip.Label>{label}</Chip.Label>
            </Chip>
          </div>
          {canReceive && (
            <Button className="w-full sm:w-auto">Apply Now</Button>
          )}
        </Card.Footer>
      </div>
    </Card>
  );
}

function Composer({
  onSend,
  onFile,
  onImage,
}: {
  onSend: (body: string) => void;
  onFile: () => void;
  onImage: () => void;
}) {
  const [body, setBody] = useState("");
  function submit() {
    const text = body.trim();
    if (!text) return;
    onSend(text);
    setBody("");
  }
  return (
    <footer
      className="bg-white px-3 pt-2 sm:px-6"
      style={{ paddingBottom: "calc(10px + env(safe-area-inset-bottom))" }}
    >
      <div className="relative mx-auto max-w-4xl rounded-lg border-2 border-[var(--quick-primary)] bg-white shadow-sm">
        <textarea
          value={body}
          onChange={(event) => setBody(event.target.value)}
          placeholder="Message"
          rows={2}
          className="block max-h-32 min-h-[76px] w-full resize-none bg-transparent px-3 pb-8 pt-2 text-[15px] leading-5 text-default-900 outline-none"
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              submit();
            }
          }}
        />
        <div className="pointer-events-none absolute inset-x-0 bottom-0 flex h-8 items-center justify-between px-3">
          <div className="pointer-events-auto flex items-center gap-1">
            <button
              type="button"
              className="composer-icon-button grid h-7 w-7 place-items-center rounded-md transition-colors active:bg-default-100"
              aria-label="Image"
              onClick={onImage}
            >
              <ImageIcon size={18} />
            </button>
            <button
              type="button"
              className="composer-icon-button grid h-7 w-7 place-items-center rounded-md transition-colors active:bg-default-100"
              aria-label="File"
              onClick={onFile}
            >
              <FileIcon size={18} />
            </button>
          </div>
          <button
            type="button"
            className="pointer-events-auto grid h-7 w-7 place-items-center rounded-full bg-[var(--quick-primary)] text-white transition-colors active:bg-[var(--quick-primary-pressed)]"
            aria-label="Send"
            onClick={submit}
          >
            <SendIcon size={15} />
          </button>
        </div>
      </div>
    </footer>
  );
}

function estimatedRowHeight(item: TimelineItem) {
  if (item.type === "date") return 40;
  if (item.message.kind === "file") return 104;
  const length = item.message.body?.length ?? 0;
  return Math.max(64, Math.min(144, 52 + Math.ceil(length / 30) * 22));
}

async function copyText(text: string) {
  if (!text) return;
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text).catch(() => fallbackCopy(text));
    return;
  }
  fallbackCopy(text);
}

function fallbackCopy(text: string) {
  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.style.position = "fixed";
  textarea.style.opacity = "0";
  document.body.appendChild(textarea);
  textarea.select();
  document.execCommand("copy");
  document.body.removeChild(textarea);
}

function buildItems(messages: ChatMessage[]): TimelineItem[] {
  const items: TimelineItem[] = [];
  let lastDay = "";
  for (const message of messages
    .slice()
    .sort((a, b) => a.createdAt - b.createdAt)) {
    const key = dayKey(new Date(message.createdAt));
    if (key !== lastDay) {
      items.push({ type: "date", id: `date-${key}`, label: dateLabel(key) });
      lastDay = key;
    }
    items.push({ type: "message", id: message.id, message });
  }
  return items;
}

function mergeMessage(messages: ChatMessage[], message: ChatMessage) {
  if (messages.some((item) => item.id === message.id)) return messages;
  return [...messages, message].sort((a, b) => a.createdAt - b.createdAt);
}

function mergeMessages(next: ChatMessage[], current: ChatMessage[]) {
  const byId = new Map<string, ChatMessage>();
  for (const message of [...next, ...current]) byId.set(message.id, message);
  return [...byId.values()].sort((a, b) => a.createdAt - b.createdAt);
}

function updateOffer(messages: ChatMessage[], offer: FileOffer) {
  return messages.map((message) => {
    if (message.fileOfferId !== offer.id) return message;
    return { ...message, fileOffer: offer };
  });
}

function statusLabel(offer: FileOffer) {
  if (offer.status === "available" && offer.expiresAt < Date.now())
    return "Expired";
  const labels: Record<FileOffer["status"], string> = {
    available: "Ready",
    transferring: "Sending",
    done: "Sent",
    cancelled: "Cancelled",
    failed: "Failed",
    expired: "Expired",
    sender_offline: "Sender left",
  };
  return labels[offer.status];
}

function statusTone(offer: FileOffer) {
  const status =
    offer.status === "available" && offer.expiresAt < Date.now()
      ? "expired"
      : offer.status;
  if (status === "failed") return "font-medium text-[oklch(50%_0.2_25)]";
  if (status === "expired" || status === "sender_offline")
    return "font-medium text-[oklch(55%_0.12_75)]";
  if (status === "transferring")
    return "font-medium text-[var(--quick-primary)]";
  if (status === "done") return "font-medium text-[oklch(42%_0.13_155)]";
  return "text-default-500";
}
