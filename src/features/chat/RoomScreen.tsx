import {
  Button,
  Card,
  Chip,
  Input,
  Modal,
  ProgressBar,
  Spinner,
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
import { useFileCache } from "@/features/transfers/use-file-cache";
import { api, post, remove } from "@/lib/api";
import {
  getSocket,
  refreshBootstrap,
  setRoomDeletedHandler,
  setRoomSummaryHandler,
} from "@/lib/socket";
import { toast } from "@/lib/toast";
import type {
  ChatMessage,
  MessagePage,
  RoomDetail,
  RoomMember,
} from "@/shared/types";
import {
  addMessage,
  appStore,
  bootstrapAtom,
  messageCursorsAtom,
  messagesAtom,
  socketConnectedAtom,
} from "@/store/app";
import { createRandomId } from "@/web/random-id";
import { useMobile } from "@/web/use-mobile";

const mobileUserAgentPattern = /Mobi|Android/i;

export function RoomPage({ roomId }: { roomId: string }) {
  const navigate = useNavigate();
  const { bootstrap, loading } = useAuthenticatedBootstrap();
  const connected = useAtomValue(socketConnectedAtom);
  const messagesByRoom = useAtomValue(messagesAtom);
  const cursors = useAtomValue(messageCursorsAtom);
  const [room, setRoom] = useState<RoomDetail>();
  const [loadedRoomId, setLoadedRoomId] = useState<string>();
  const [loadingRoom, setLoadingRoom] = useState(true);
  const [loadingEarlier, setLoadingEarlier] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const imageInput = useRef<HTMLInputElement>(null);
  const messages = messagesByRoom[roomId] ?? [];
  const currentUserId = bootstrap?.user.id;
  const fileCache = useFileCache(
    roomId,
    bootstrap?.limits.maxFileBytes ?? 200 * 1024 * 1024
  );

  const loadRoomDetail = useCallback(async () => {
    const detail = await api<RoomDetail | { missing: true }>(
      `/api/rooms/${roomId}`
    );
    if ("missing" in detail) {
      await navigate({ to: "/" });
      return;
    }
    setRoom(detail);
    setLoadedRoomId(roomId);
    return detail;
  }, [navigate, roomId]);

  const loadRoom = useCallback(async () => {
    setLoadingRoom(true);
    try {
      const detail = await loadRoomDetail();
      if (!detail) {
        return;
      }
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
  }, [loadRoomDetail, navigate, roomId]);

  useEffect(() => {
    if (currentUserId) {
      void loadRoom();
      getSocket();
      setRoomDeletedHandler((deletedRoomId) => {
        if (deletedRoomId === roomId) {
          void navigate({ to: "/" });
        }
      });
      setRoomSummaryHandler((summary) => {
        if (summary.id === roomId) {
          void loadRoomDetail();
        }
      });
    }
    return () => {
      setRoomDeletedHandler(undefined);
      setRoomSummaryHandler(undefined);
    };
  }, [currentUserId, loadRoom, loadRoomDetail, navigate, roomId]);

  if (loading || !bootstrap) {
    return (
      <main className="grid min-h-dvh place-items-center bg-white text-default-500 text-sm">
        <Spinner />
      </main>
    );
  }

  if (loadingRoom || !room || loadedRoomId !== roomId) {
    return (
      <main className="flex h-dvh overflow-hidden bg-white">
        <RoomSidebar />
        <section className="flex min-w-0 flex-1 flex-col">
          <div className="h-20 shrink-0 border-default-200 border-b bg-white" />
          <div className="grid flex-1 place-items-center text-default-500 text-sm">
            <Spinner />
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
              onDownload={(message) => void fileCache.download(message)}
              onLoadEarlier={loadEarlier}
              onOpen={(message) => void fileCache.open(message)}
              progress={fileCache.progress}
            />
            <Composer
              connected={connected}
              onFile={() =>
                fileCache.shareNativeFile
                  ? void fileCache.shareNativeFile()
                  : fileInput.current?.click()
              }
              onImage={() =>
                fileCache.shareNativeFile
                  ? void fileCache.shareNativeFile({ imageOnly: true })
                  : imageInput.current?.click()
              }
              roomId={roomId}
              uploading={fileCache.uploading}
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
        onChange={(event) => {
          const file = event.currentTarget.files?.[0];
          event.currentTarget.value = "";
          void fileCache.upload(file);
        }}
        ref={fileInput}
        type="file"
      />
      <input
        accept="image/*"
        hidden
        onChange={(event) => {
          const file = event.currentTarget.files?.[0];
          event.currentTarget.value = "";
          void fileCache.upload(file);
        }}
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
          {member.deviceName} · {member.online ? "Online" : "Offline"}
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
  onDownload,
  onOpen,
}: {
  messages: ChatMessage[];
  currentUserId: string;
  progress: Record<string, number>;
  canLoadEarlier: boolean;
  loadingEarlier: boolean;
  onLoadEarlier: () => void;
  onDownload: (message: ChatMessage) => void;
  onOpen: (message: ChatMessage) => void;
}) {
  const container = useRef<HTMLDivElement>(null);
  const list = useRef<VariableSizeList>(null);
  const heights = useRef<Record<string, number>>({});
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
      onDownload,
      onOpen,
      setHeight: (id: string, index: number, value: number) => {
        if (heights.current[id] !== value) {
          heights.current[id] = value;
          list.current?.resetAfterIndex(index);
        }
      },
    }),
    [currentUserId, messages, onDownload, onOpen, progress]
  );
  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-x-hidden px-3 sm:px-6">
      <div className="flex h-6 shrink-0 items-center justify-center">
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
          className="[scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
          height={height}
          itemCount={messages.length}
          itemData={data}
          itemKey={(index) => messages[index]?.id ?? index}
          itemSize={(index) => {
            const message = messages[index];
            return message ? (heights.current[message.id] ?? 110) : 110;
          }}
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
    onDownload: (message: ChatMessage) => void;
    onOpen: (message: ChatMessage) => void;
    setHeight: (id: string, index: number, value: number) => void;
  };
}) {
  const element = useRef<HTMLDivElement>(null);
  const message = data.messages[index];
  useEffect(() => {
    const node = element.current;
    if (!node) {
      return;
    }
    const update = () => {
      if (message) {
        data.setHeight(
          message.id,
          index,
          Math.ceil(node.getBoundingClientRect().height) + 8
        );
      }
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(node);
    return () => observer.disconnect();
  }, [data, index, message]);
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
  } else if (message.fileAttachment) {
    content = (
      <FileMessage
        attachment={message.fileAttachment}
        isSelf={self}
        message={message}
        onDownload={data.onDownload}
        onOpen={data.onOpen}
        progress={data.progress[message.id]}
      />
    );
  }
  return (
    <div style={style}>
      <div
        className={`flex w-full gap-2 py-2 ${self ? "justify-end" : "justify-start"}`}
        ref={element}
      >
        {self ? null : (
          <DeviceIcon
            kind={message.senderDeviceKind}
            seed={message.senderAvatarSeed}
          />
        )}
        <div
          className={`w-[80%] ${self ? "items-end" : "items-start"} flex flex-col gap-1`}
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
  attachment,
  isSelf,
  message,
  progress,
  onDownload,
  onOpen,
}: {
  attachment: NonNullable<ChatMessage["fileAttachment"]>;
  isSelf: boolean;
  message: ChatMessage;
  progress: number | undefined;
  onDownload: (message: ChatMessage) => void;
  onOpen: (message: ChatMessage) => void;
}) {
  const available = attachment.expiresAt > Date.now();
  let receiveAction: React.ReactNode = null;
  if (!isSelf) {
    if (available) {
      receiveAction = (
        <Button
          className="mt-2"
          isDisabled={progress !== undefined}
          isPending={progress !== undefined}
          onPress={() => onDownload(message)}
          size="sm"
          variant="primary"
        >
          {progress === undefined
            ? "Download"
            : `${Math.round(progress * 100)}%`}
        </Button>
      );
    } else {
      receiveAction = (
        <Chip color="danger">
          <Ban width={12} />
          <Chip.Label>Expired</Chip.Label>
        </Chip>
      );
    }
  }
  return (
    <Card className="w-full max-w-60 rounded-2xl border border-default-100 bg-white p-3 shadow-sm">
      <div className="flex gap-3">
        <button
          aria-label={`Open ${attachment.name}`}
          className="shrink-0 cursor-pointer disabled:cursor-not-allowed disabled:opacity-50"
          disabled={!available || progress !== undefined}
          onClick={() => onOpen(message)}
          type="button"
        >
          {attachment.previewDataUrl ? (
            <img
              alt=""
              className="size-18 object-cover"
              src={attachment.previewDataUrl}
              style={{ borderRadius: "calc(var(--radius) * 2 - 6px)" }}
            />
          ) : (
            <span className="grid size-16 place-items-center rounded-2xl bg-accent-soft text-accent-soft-foreground">
              <FileIcon />
            </span>
          )}
        </button>
        <div className="min-w-0 flex-1">
          <p className="truncate font-medium">{attachment.name}</p>
          <p className="mt-1 text-default-500 text-xs">
            {formatBytes(attachment.size)}
          </p>
          {isSelf ? (
            <p className="mt-2 text-default-500 text-xs">Stored for 3 days</p>
          ) : null}
          {receiveAction}
        </div>
      </div>
      {progress === undefined ? null : (
        <ProgressBar
          aria-label="Transfer progress"
          className="mt-3"
          value={Math.round((progress ?? 0) * 100)}
        />
      )}
    </Card>
  );
}

function Composer({
  roomId,
  connected,
  onFile,
  onImage,
  uploading,
}: {
  roomId: string;
  connected: boolean;
  onFile: () => void;
  onImage: () => void;
  uploading: boolean;
}) {
  const [value, setValue] = useState("");
  const [sending, setSending] = useState(false);
  const canSend = Boolean(value.trim() && !sending);
  async function send() {
    const body = value.trim();
    if (!(body && !sending)) {
      return;
    }
    setSending(true);
    try {
      const message = await post<ChatMessage>(`/api/rooms/${roomId}/messages`, {
        clientMessageId: createRandomId(),
        body,
      });
      addMessage(message);
      setValue("");
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "Message wasn't sent"
      );
    } finally {
      setSending(false);
    }
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
          isDisabled={!connected || uploading}
          isIconOnly
          isPending={uploading}
          onPress={onImage}
          variant="secondary"
        >
          <ImageIcon />
        </Button>
        <Button
          aria-label="Choose file"
          isDisabled={!connected || uploading}
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
            isDisabled={!canSend}
            isIconOnly
            isPending={sending}
            onPress={send}
            variant="primary"
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
