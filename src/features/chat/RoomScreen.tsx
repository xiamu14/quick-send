import {
  Button,
  Card,
  Chip,
  Input,
  Modal,
  ProgressBar,
  TextArea,
} from "@heroui/react";
import { useNavigate } from "@tanstack/react-router";
import { motion } from "framer-motion";
import { useAtomValue } from "jotai";
import {
  ArrowLeftIcon,
  Ban,
  CopyIcon,
  FileIcon,
  ImageIcon,
  InfoIcon,
  LaptopIcon,
  SendIcon,
  Smartphone,
  TabletIcon,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { VariableSizeList } from "react-window";
import {
  RoomSidebar,
  useAuthenticatedBootstrap,
} from "@/features/rooms/RoomList";
import { FileTransferManager } from "@/features/transfers/FileTransferManager";
import { api, post, remove } from "@/lib/api";
import {
  getSocket,
  refreshBootstrap,
  setRoomDeletedHandler,
  setTransferHandlers,
} from "@/lib/socket";
import { toast } from "@/lib/toast";
import type {
  ChatMessage,
  MessagePage,
  RoomDetail,
  RoomMember,
} from "@/shared/types";
import {
  appStore,
  bootstrapAtom,
  messageCursorsAtom,
  messagesAtom,
  socketConnectedAtom,
  transferProgressAtom,
} from "@/store/app";
import { createImagePreview } from "@/web/preview";
import { useMobile } from "@/web/use-mobile";

const mobileUserAgentPattern = /Mobi|Android/i;

export function RoomPage({ roomId }: { roomId: string }) {
  const navigate = useNavigate();
  const { bootstrap, loading } = useAuthenticatedBootstrap();
  const connected = useAtomValue(socketConnectedAtom);
  const messagesByRoom = useAtomValue(messagesAtom);
  const cursors = useAtomValue(messageCursorsAtom);
  const progress = useAtomValue(transferProgressAtom);
  const [room, setRoom] = useState<RoomDetail>();
  const [loadedRoomId, setLoadedRoomId] = useState<string>();
  const [loadingRoom, setLoadingRoom] = useState(true);
  const [loadingEarlier, setLoadingEarlier] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const imageInput = useRef<HTMLInputElement>(null);
  const transfer = useRef<FileTransferManager | undefined>(undefined);
  const messages = messagesByRoom[roomId] ?? [];
  const currentUserId = bootstrap?.user.id;

  const loadRoom = useCallback(async () => {
    setLoadingRoom(true);
    try {
      const detail = await api<RoomDetail | { missing: true }>(
        `/api/rooms/${roomId}`
      );
      if ("missing" in detail) {
        await navigate({ to: "/" });
        return;
      }
      setRoom(detail);
      setLoadedRoomId(roomId);
      if (detail.membership === "member") {
        const page = await api<MessagePage>(`/api/rooms/${roomId}/messages`);
        appStore.set(messagesAtom, (current) => ({
          ...current,
          [roomId]: page.messages,
        }));
        appStore.set(messageCursorsAtom, (current) => ({
          ...current,
          [roomId]: page.nextCursor,
        }));
      }
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "Could not load room"
      );
      await navigate({ to: "/" });
    } finally {
      setLoadingRoom(false);
    }
  }, [navigate, roomId]);

  useEffect(() => {
    if (currentUserId) {
      void loadRoom();
      const socket = getSocket();
      transfer.current = new FileTransferManager(
        currentUserId,
        socket,
        (offerId, value) => {
          appStore.set(transferProgressAtom, (current) => ({
            ...current,
            [offerId]: value,
          }));
        },
        () => toast.error("Direct connection failed"),
        (_offerId, fileName) => toast.success(`Downloaded ${fileName}`)
      );
      setTransferHandlers(
        (payload) => void transfer.current?.handleLocked(payload),
        (type, payload) => void transfer.current?.handleRtc(type, payload)
      );
      setRoomDeletedHandler((deletedRoomId) => {
        if (deletedRoomId === roomId) {
          void navigate({ to: "/" });
        }
      });
    }
    return () => {
      setTransferHandlers(undefined, undefined);
      setRoomDeletedHandler(undefined);
    };
  }, [currentUserId, loadRoom, navigate, roomId]);

  if (loading || !bootstrap) {
    return (
      <main className="grid min-h-dvh place-items-center bg-blue-50 text-default-500 text-sm">
        Loading
      </main>
    );
  }

  if (loadingRoom || !room || loadedRoomId !== roomId) {
    return (
      <main className="flex h-dvh overflow-hidden bg-blue-50">
        <RoomSidebar />
        <section className="flex min-w-0 flex-1 flex-col">
          <div className="h-20 shrink-0 border-default-200 border-b bg-white" />
          <div className="grid flex-1 place-items-center text-default-500 text-sm">
            Loading room
          </div>
        </section>
      </main>
    );
  }

  async function requestJoin() {
    try {
      await post(`/api/rooms/${roomId}/requests`);
      toast.success("Request sent");
      await loadRoom();
      await refreshBootstrap();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Request failed");
    }
  }

  async function loadEarlier() {
    const cursor = cursors[roomId];
    if (!cursor) {
      return;
    }
    setLoadingEarlier(true);
    try {
      const page = await api<MessagePage>(
        `/api/rooms/${roomId}/messages?cursor=${encodeURIComponent(cursor)}`
      );
      appStore.set(messagesAtom, (current) => ({
        ...current,
        [roomId]: [...page.messages, ...(current[roomId] ?? [])],
      }));
      appStore.set(messageCursorsAtom, (current) => ({
        ...current,
        [roomId]: page.nextCursor,
      }));
    } finally {
      setLoadingEarlier(false);
    }
  }

  async function chooseFile(file: File | undefined) {
    if (!file) {
      return;
    }
    if (file.size > (bootstrap?.limits.maxFileBytes ?? 500 * 1024 * 1024)) {
      toast.error("File must be 500 MB or smaller");
      return;
    }
    const socket = getSocket();
    const clientMessageId = crypto.randomUUID();
    transfer.current?.remember(clientMessageId, file);
    const previewDataUrl = file.type.startsWith("image/")
      ? await createImagePreview(file).catch(() => undefined)
      : undefined;
    socket.timeout(5000).emit(
      "file:create",
      {
        roomId,
        clientMessageId,
        file: {
          name: file.name,
          size: file.size,
          mime: file.type || "application/octet-stream",
          ...(previewDataUrl ? { previewDataUrl } : {}),
        },
      },
      (error, result) => {
        if (error || !result.ok || !result.data?.fileOffer) {
          toast.error(
            result?.ok === false ? result.error.message : "File wasn't sent"
          );
          return;
        }
        transfer.current?.bindOffer(clientMessageId, result.data.fileOffer.id);
      }
    );
  }

  return (
    <main className="flex h-dvh overflow-hidden bg-white">
      <RoomSidebar />
      <section className="flex min-w-0 flex-1 flex-col">
        <RoomHeader room={room} />
        {room.membership === "member" ? (
          <>
            <MessageTimeline
              canLoadEarlier={Boolean(cursors[roomId])}
              currentUserId={bootstrap.user.id}
              loadingEarlier={loadingEarlier}
              messages={messages}
              onLoadEarlier={loadEarlier}
              onReceive={(offerId) => {
                getSocket().emit(
                  "transfer:receive",
                  { roomId, offerId },
                  (result) => {
                    if (!result.ok) {
                      toast.error(result.error.message);
                    }
                  }
                );
              }}
              progress={progress}
            />
            <Composer
              connected={connected}
              onFile={() => fileInput.current?.click()}
              onImage={() => imageInput.current?.click()}
              roomId={roomId}
            />
          </>
        ) : (
          <div className="grid flex-1 place-items-center p-6">
            <Card className="max-w-sm rounded-3xl bg-white p-7 text-center shadow-sm">
              <h2 className="font-semibold text-xl">{room.name}</h2>
              <p className="mt-2 text-default-500 text-sm">
                Created by {room.creatorUsername}
              </p>
              {room.membership === "pending" ? (
                <Chip className="mx-auto mt-5" variant="soft">
                  Waiting for confirmation
                </Chip>
              ) : (
                <Button
                  className="mt-6"
                  onPress={requestJoin}
                  variant="primary"
                >
                  Request to join
                </Button>
              )}
            </Card>
          </div>
        )}
      </section>
      <input
        hidden
        onChange={(event) => void chooseFile(event.target.files?.[0])}
        ref={fileInput}
        type="file"
      />
      <input
        accept="image/*"
        hidden
        onChange={(event) => void chooseFile(event.target.files?.[0])}
        ref={imageInput}
        type="file"
      />
    </main>
  );
}

function RoomHeader({ room }: { room: RoomDetail }) {
  const navigate = useNavigate();
  const mobile = useMobile();
  const bootstrap = useAtomValue(bootstrapAtom);
  const [confirmation, setConfirmation] = useState("");
  return (
    <header className="flex h-20 shrink-0 items-center justify-between border-default-200 border-b bg-white px-4 sm:px-6">
      <div className="flex min-w-0 items-center gap-3">
        <Button
          aria-label="Back to rooms"
          className="md:hidden"
          isIconOnly
          onPress={() => navigate({ to: "/" })}
          variant="ghost"
        >
          <ArrowLeftIcon />
        </Button>
        <div
          className="grid size-11 shrink-0 place-items-center bg-accent text-accent-foreground"
          style={{ borderRadius: "calc(var(--radius) * 2 - 6px)" }}
        >
          {room.name[0]}
        </div>
        <div className="min-w-0">
          <h1 className="truncate font-semibold text-lg">{room.name}</h1>
          <p className="text-sm text-success">
            {room.members.filter((member) => member.online).length} online
          </p>
        </div>
      </div>
      <Modal>
        <Modal.Trigger>
          <Button aria-label="Room information" isIconOnly variant="ghost">
            <InfoIcon size={20} />
          </Button>
        </Modal.Trigger>
        <Modal.Backdrop>
          <Modal.Container
            className={mobile ? "p-0" : ""}
            placement={mobile ? "bottom" : "center"}
          >
            <Modal.Dialog
              className={
                mobile ? "max-h-[85dvh] min-h-[40dvh] rounded-b-none" : ""
              }
            >
              <Modal.CloseTrigger />
              <Modal.Header>
                <Modal.Heading>{room.name}</Modal.Heading>
              </Modal.Header>
              <Modal.Body
                className={mobile ? "min-h-0 flex-1 space-y-5" : "space-y-5"}
              >
                <div className="space-y-1">
                  {room.members.map((member) => (
                    <MemberRow key={member.id} member={member} />
                  ))}
                </div>
                {room.creatorId === bootstrap?.user.id ? (
                  <div className="pt-3">
                    <h3 className="font-semibold text-danger">Delete Room</h3>
                    <p className="mt-1 text-default-500 text-sm">
                      Type {room.name} to permanently delete this room.
                    </p>
                    <div className="mt-3 flex flex-col items-center justify-start gap-2">
                      <Input
                        aria-label="Room name confirmation"
                        fullWidth
                        onChange={(event) =>
                          setConfirmation(event.target.value)
                        }
                        placeholder={room.name}
                        value={confirmation}
                        variant="secondary"
                      />
                      <Button
                        fullWidth
                        onPress={async () => {
                          if (confirmation !== room.name) {
                            return;
                          }
                          await remove(`/api/rooms/${room.id}`, {
                            confirmation,
                          });
                          toast.success("Room deleted");
                          await refreshBootstrap();
                          await navigate({ to: "/" });
                        }}
                        variant="danger"
                      >
                        Delete Room
                      </Button>
                    </div>
                  </div>
                ) : null}
              </Modal.Body>
            </Modal.Dialog>
          </Modal.Container>
        </Modal.Backdrop>
      </Modal>
    </header>
  );
}

function MemberRow({ member }: { member: RoomMember }) {
  return (
    <div className="flex items-center gap-3 bg-default-50 p-3">
      <DeviceIcon kind={member.deviceKind} />
      <div className="min-w-0 flex-1">
        <p className="truncate font-medium">{member.username}</p>
        <p className="text-default-500 text-xs">
          {member.isCreator ? "Creator · " : ""}
          {member.online ? "Online" : "Offline"}
        </p>
      </div>
    </div>
  );
}

function MessageTimeline({
  messages,
  currentUserId,
  progress,
  canLoadEarlier,
  loadingEarlier,
  onLoadEarlier,
  onReceive,
}: {
  messages: ChatMessage[];
  currentUserId: string;
  progress: Record<string, number>;
  canLoadEarlier: boolean;
  loadingEarlier: boolean;
  onLoadEarlier: () => void;
  onReceive: (offerId: string) => void;
}) {
  const container = useRef<HTMLDivElement>(null);
  const list = useRef<VariableSizeList>(null);
  const heights = useRef<Record<number, number>>({});
  const [height, setHeight] = useState(500);
  useEffect(() => {
    const element = container.current;
    if (!element) {
      return;
    }
    const update = () => setHeight(element.getBoundingClientRect().height);
    update();
    const observer = new ResizeObserver(update);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    requestAnimationFrame(() =>
      list.current?.scrollToItem(messages.length, "end")
    );
  }, [messages.length]);
  const data = useMemo(
    () => ({
      messages,
      currentUserId,
      progress,
      onReceive,
      setHeight: (index: number, value: number) => {
        if (heights.current[index] !== value) {
          heights.current[index] = value;
          list.current?.resetAfterIndex(index);
        }
      },
    }),
    [currentUserId, messages, onReceive, progress]
  );
  return (
    <div className="flex min-h-0 flex-1 flex-col px-3 sm:px-6">
      <div className="flex h-12 shrink-0 items-center justify-center">
        {canLoadEarlier ? (
          <Button
            isPending={loadingEarlier}
            onPress={onLoadEarlier}
            size="sm"
            variant="outline"
          >
            Load earlier
          </Button>
        ) : null}
      </div>
      <div className="min-h-0 flex-1" ref={container}>
        <VariableSizeList
          height={height}
          itemCount={messages.length}
          itemData={data}
          itemSize={(index) => heights.current[index] ?? 110}
          ref={list}
          width="100%"
        >
          {MessageRow}
        </VariableSizeList>
      </div>
    </div>
  );
}

function MessageRow({
  index,
  style,
  data,
}: {
  index: number;
  style: React.CSSProperties;
  data: {
    messages: ChatMessage[];
    currentUserId: string;
    progress: Record<string, number>;
    onReceive: (offerId: string) => void;
    setHeight: (index: number, value: number) => void;
  };
}) {
  const element = useRef<HTMLDivElement>(null);
  const message = data.messages[index];
  useEffect(() => {
    const node = element.current;
    if (!node) {
      return;
    }
    const update = () =>
      data.setHeight(index, Math.ceil(node.getBoundingClientRect().height) + 8);
    update();
    const observer = new ResizeObserver(update);
    observer.observe(node);
    return () => observer.disconnect();
  }, [data, index]);
  if (!message) {
    return null;
  }
  const self = message.senderUserId === data.currentUserId;
  let content: React.ReactNode = null;
  if (message.kind === "text") {
    content = (
      <motion.button
        className={`group relative whitespace-pre-wrap rounded-2xl px-4 py-3 text-left text-[15px] leading-6 shadow-sm ${
          self
            ? "bg-accent text-accent-foreground"
            : "border border-default-100 bg-white text-foreground"
        }`}
        onClick={async () => {
          await navigator.clipboard.writeText(message.body ?? "");
          toast.success("Copied");
        }}
        title="Copy"
        whileTap={{ scale: 0.97 }}
      >
        {message.body}
        <CopyIcon className="ml-2 inline" size={13} />
      </motion.button>
    );
  } else if (message.fileOffer) {
    content = (
      <FileMessage
        isSelf={self}
        offer={message.fileOffer}
        onReceive={data.onReceive}
        progress={data.progress[message.fileOffer.id]}
      />
    );
  }
  return (
    <div style={style}>
      <div
        className={`flex gap-2 py-2 ${self ? "justify-end" : "justify-start"}`}
        ref={element}
      >
        {self ? null : (
          <DeviceIcon
            kind={message.senderDeviceKind}
            seed={message.senderAvatarSeed}
          />
        )}
        <div
          className={`max-w-[82%] ${self ? "items-end" : "items-start"} flex flex-col gap-1`}
        >
          {self ? null : (
            <div className="flex items-center justify-start gap-1">
              <span className="px-1 text-default-500 text-xs">
                {message.senderUsername}
              </span>
              <span className="px-1 text-default-400 text-xs">
                {new Intl.DateTimeFormat(undefined, {
                  hour: "2-digit",
                  minute: "2-digit",
                }).format(message.createdAt)}
              </span>
            </div>
          )}
          {content}
          {self ? (
            <span className="px-1 text-default-400 text-xs">
              {new Intl.DateTimeFormat(undefined, {
                hour: "2-digit",
                minute: "2-digit",
              }).format(message.createdAt)}
            </span>
          ) : null}
        </div>
      </div>
    </div>
  );
}

function FileMessage({
  offer,
  isSelf,
  progress,
  onReceive,
}: {
  offer: ChatMessage["fileOffer"] & {};
  isSelf: boolean;
  progress: number | undefined;
  onReceive: (offerId: string) => void;
}) {
  const available =
    offer.status === "available" && offer.expiresAt > Date.now();
  let receiveLabel = "Expired";
  if (available) {
    receiveLabel = "Receive";
  } else if (offer.status === "transferring") {
    receiveLabel = "Sender is busy";
  }
  let receiveAction: React.ReactNode = null;
  if (!isSelf) {
    receiveAction = available ? (
      <Button
        className="mt-2"
        onPress={() => onReceive(offer.id)}
        size="sm"
        variant="primary"
      >
        {receiveLabel}
      </Button>
    ) : (
      <Chip color="danger">
        <Ban width={12} />
        <Chip.Label>{receiveLabel}</Chip.Label>
      </Chip>
    );
  }
  return (
    <Card className="w-72 rounded-2xl border border-default-100 bg-white p-3 shadow-sm">
      <div className="flex gap-3">
        {offer.previewDataUrl ? (
          <img
            alt=""
            className="size-18 object-cover"
            src={offer.previewDataUrl}
            style={{ borderRadius: "calc(var(--radius) * 2 - 6px)" }}
          />
        ) : (
          <div className="grid size-16 shrink-0 place-items-center rounded-2xl bg-accent-soft text-accent-soft-foreground">
            <FileIcon />
          </div>
        )}
        <div className="min-w-0 flex-1">
          <p className="truncate font-medium">{offer.name}</p>
          <p className="mt-1 text-default-500 text-xs">
            {formatBytes(offer.size)}
          </p>
          {isSelf ? (
            <p className="mt-2 text-default-500 text-xs">
              {offer.status === "available" ? "Ready" : offer.status}
            </p>
          ) : null}
          {receiveAction}
        </div>
      </div>
      {offer.status === "transferring" ? (
        <ProgressBar
          aria-label="Transfer progress"
          className="mt-3"
          value={Math.round((progress ?? 0) * 100)}
        />
      ) : null}
    </Card>
  );
}

function Composer({
  roomId,
  connected,
  onFile,
  onImage,
}: {
  roomId: string;
  connected: boolean;
  onFile: () => void;
  onImage: () => void;
}) {
  const [value, setValue] = useState("");
  const [sending, setSending] = useState(false);
  function send() {
    const body = value.trim();
    if (!(body && connected)) {
      return;
    }
    setSending(true);
    getSocket()
      .timeout(5000)
      .emit(
        "message:create",
        { roomId, clientMessageId: crypto.randomUUID(), body },
        (error, result) => {
          setSending(false);
          if (error || !result.ok) {
            toast.error(
              result?.ok === false
                ? result.error.message
                : "Message wasn't sent"
            );
            return;
          }
          setValue("");
        }
      );
  }
  return (
    <footer className="shrink-0 border-default-200 border-t bg-white p-3 sm:p-4">
      {connected ? null : (
        <p className="mb-2 text-center text-danger text-xs">
          Connection lost. Reconnecting…
        </p>
      )}
      <div className="mx-auto flex max-w-4xl items-center gap-2">
        <Button
          aria-label="Choose image"
          isDisabled={!connected}
          isIconOnly
          onPress={onImage}
          variant="secondary"
        >
          <ImageIcon />
        </Button>
        <Button
          aria-label="Choose file"
          isDisabled={!connected}
          isIconOnly
          onPress={onFile}
          variant="secondary"
        >
          <FileIcon />
        </Button>
        <TextArea
          aria-label="Message"
          className="max-h-32 min-h-11 flex-1 resize-none rounded-2xl"
          disabled={!connected}
          onChange={(event) => setValue(event.target.value)}
          onKeyDown={(event) => {
            if (
              event.key === "Enter" &&
              !event.shiftKey &&
              !event.nativeEvent.isComposing &&
              !mobileUserAgentPattern.test(navigator.userAgent)
            ) {
              event.preventDefault();
              send();
            }
          }}
          rows={1}
          value={value}
          variant="secondary"
        />
        <motion.div whileTap={{ scale: 0.9 }}>
          <Button
            aria-label="Send message"
            isIconOnly
            isPending={sending}
            onPress={send}
            variant="primary"
            // className={"rounded-2xl"}
          >
            <SendIcon />
          </Button>
        </motion.div>
      </div>
    </footer>
  );
}

function DeviceIcon({
  kind,
  seed = "primary",
}: {
  kind: RoomMember["deviceKind"];
  seed?: string;
}) {
  const index =
    [...seed].reduce((sum, character) => sum + character.charCodeAt(0), 0) % 4;
  const colors = [
    "bg-blue-500",
    "bg-emerald-500",
    "bg-pink-500",
    "bg-violet-500",
  ];
  let Icon = LaptopIcon;
  if (kind === "mobile") {
    Icon = Smartphone;
  } else if (kind === "tablet") {
    Icon = TabletIcon;
  }
  console.log("kind", kind);
  return (
    <div
      className={`grid size-10 shrink-0 place-items-center text-white ${colors[index]}`}
      style={{ borderRadius: "calc(var(--radius) * 2 - 6px)" }}
    >
      <Icon size={18} />
    </div>
  );
}

function formatBytes(value: number) {
  if (value < 1024) {
    return `${value} B`;
  }
  if (value < 1024 * 1024) {
    return `${(value / 1024).toFixed(1)} KB`;
  }
  return `${(value / 1024 / 1024).toFixed(1)} MB`;
}
