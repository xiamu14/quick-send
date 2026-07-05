import {
  Avatar,
  Button,
  Card,
  Chip,
  Modal,
  Popover,
  PopoverContent,
  PopoverTrigger,
  ScrollShadow,
  Spinner,
} from "@heroui/react";
import { Link, useNavigate } from "@tanstack/react-router";
import { motion } from "framer-motion";
import { useAtomValue } from "jotai";
import { BellIcon, CompassIcon, PlusIcon, UserRoundIcon } from "lucide-react";
import type { ReactNode } from "react";
import { useEffect, useMemo, useState } from "react";
import { api, post } from "@/lib/api";
import { bootstrapWithIdentity } from "@/lib/identity";
import { getSocket, refreshBootstrap } from "@/lib/socket";
import { toast } from "@/lib/toast";
import type { DiscoverRoom, JoinRequest, RoomSummary } from "@/shared/types";
import { appStore, bootstrapAtom, bootstrapLoadingAtom } from "@/store/app";
import { useMobile } from "@/web/use-mobile";

export function useAuthenticatedBootstrap() {
  const navigate = useNavigate();
  const bootstrap = useAtomValue(bootstrapAtom);
  const loading = useAtomValue(bootstrapLoadingAtom);
  useEffect(() => {
    let alive = true;
    if (bootstrap) {
      appStore.set(bootstrapLoadingAtom, false);
      getSocket();
    } else {
      void bootstrapWithIdentity()
        .then((result) => {
          if (!alive) {
            return;
          }
          appStore.set(bootstrapLoadingAtom, false);
          if (result) {
            appStore.set(bootstrapAtom, result);
            getSocket();
          }
        })
        .catch(() => {
          if (alive) {
            appStore.set(bootstrapLoadingAtom, false);
            void navigate({ to: "/" });
          }
        });
    }
    return () => {
      alive = false;
    };
  }, [bootstrap, navigate]);
  return { bootstrap, loading };
}

export function RoomsPage() {
  const { bootstrap, loading } = useAuthenticatedBootstrap();
  if (loading || !bootstrap) {
    return <LoadingScreen />;
  }
  return (
    <main className="min-h-dvh bg-white">
      <div className="flex h-dvh w-full flex-col overflow-hidden bg-white">
        <RoomListHeader />
        <RoomList rooms={bootstrap.rooms} />
      </div>
    </main>
  );
}

export function RoomSidebar() {
  const bootstrap = useAtomValue(bootstrapAtom);
  if (!bootstrap) {
    return null;
  }
  return (
    <aside className="hidden h-dvh w-96 shrink-0 flex-col overflow-hidden border-default-200 border-r bg-white md:flex">
      <RoomListHeader compact />
      <RoomList compact rooms={bootstrap.rooms} />
    </aside>
  );
}

function RoomListHeader({ compact = false }: { compact?: boolean }) {
  const navigate = useNavigate();
  const bootstrap = useAtomValue(bootstrapAtom);
  const [creating, setCreating] = useState(false);
  const pending = bootstrap?.rooms.reduce(
    (count, room) => count + room.pendingCount,
    0
  );

  async function create() {
    setCreating(true);
    try {
      const room = await post<{ id: string }>("/api/rooms");
      await refreshBootstrap();
      await navigate({ to: "/rooms/$roomId", params: { roomId: room.id } });
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "Room creation failed"
      );
    } finally {
      setCreating(false);
    }
  }

  return (
    <header
      className={`flex h-20 shrink-0 items-center justify-between border-default-200 border-b ${compact ? "px-4" : "px-5 sm:px-7"}`}
    >
      <div>
        <h1 className="font-semibold text-2xl tracking-tight">Quick Send</h1>
      </div>
      <div className="flex items-center gap-1">
        <motion.div whileTap={{ scale: 0.9 }}>
          <Button
            aria-label="Create room"
            isDisabled={
              creating ||
              (bootstrap?.rooms.filter((room) => room.isOwner).length ?? 0) >= 5
            }
            isIconOnly
            isPending={creating}
            onPress={create}
            size="sm"
            variant="primary"
          >
            <PlusIcon size={21} />
          </Button>
        </motion.div>
        <RequestPopover />
        <DiscoverPopover />
        <IdentityPopover />
      </div>
      {pending ? (
        <span className="sr-only">{pending} pending join requests</span>
      ) : null}
    </header>
  );
}

function RoomList({
  rooms,
  compact = false,
}: {
  rooms: RoomSummary[];
  compact?: boolean;
}) {
  const roomAvatars = [
    {
      id: 1,
      image:
        "https://heroui-assets.nyc3.cdn.digitaloceanspaces.com/avatars/blue.jpg",
      name: "John Doe",
    },
    {
      id: 2,
      image:
        "https://heroui-assets.nyc3.cdn.digitaloceanspaces.com/avatars/green.jpg",
      name: "Kate Wilson",
    },
    {
      id: 3,
      image:
        "https://heroui-assets.nyc3.cdn.digitaloceanspaces.com/avatars/purple.jpg",
      name: "Emily Chen",
    },
    {
      id: 4,
      image:
        "https://heroui-assets.nyc3.cdn.digitaloceanspaces.com/avatars/orange.jpg",
      name: "Michael Brown",
    },
    {
      id: 5,
      image:
        "https://heroui-assets.nyc3.cdn.digitaloceanspaces.com/avatars/red.jpg",
      name: "Olivia Davis",
    },
  ];
  if (!rooms.length) {
    return (
      <div className="grid min-h-0 flex-1 place-items-center px-8 text-center">
        <div>
          <div className="mx-auto grid size-16 place-items-center bg-accent-soft text-accent-soft-foreground">
            <PlusIcon size={28} />
          </div>
          <h2 className="mt-5 font-semibold text-lg">Create your first room</h2>
          <p className="mt-2 text-default-500 text-sm">
            Use the plus button to start a room on this network.
          </p>
        </div>
      </div>
    );
  }
  return (
    <ScrollShadow
      className={`min-h-0 flex-1 space-y-2 overflow-y-auto ${compact ? "p-3" : "p-4 sm:p-6"}`}
      hideScrollBar
    >
      {rooms.map((room, index) => (
        <motion.div
          animate={{ opacity: 1 }}
          initial={{ opacity: 0 }}
          key={room.id}
          layout
        >
          <Link
            className="block outline-none ring-accent focus-visible:ring-2"
            params={{ roomId: room.id }}
            to="/rooms/$roomId"
          >
            <Card className="rounded-2xl border border-default-200 bg-white p-4 shadow-none transition-colors hover:bg-default-50">
              <div className="flex items-center gap-4">
                {/*<div
                  className="grid size-12 shrink-0 place-items-center bg-accent font-semibold text-accent-foreground text-lg"
                  style={{ borderRadius: "calc(var(--radius) * 2 - 6px)" }}
                >
                  {room.name.slice(0, 1)}
                </div>*/}
                <Avatar
                  className="grid size-12 shrink-0 place-items-center"
                  style={{ borderRadius: "calc(var(--radius) * 2 - 6px)" }}
                >
                  <Avatar.Image
                    alt="Square Avatar"
                    src={roomAvatars[index % roomAvatars.length]?.image}
                  />
                  <Avatar.Fallback
                    style={{ borderRadius: "calc(var(--radius) * 2 - 6px)" }}
                  >
                    {room.name.slice(0, 1)}
                  </Avatar.Fallback>
                </Avatar>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <h2 className="truncate font-semibold">{room.name}</h2>
                    {room.isOwner ? (
                      <Chip size="sm" variant="soft">
                        Owner
                      </Chip>
                    ) : null}
                    {room.pendingCount ? (
                      <Chip color="accent" size="sm" variant="primary">
                        {room.pendingCount}
                      </Chip>
                    ) : null}
                  </div>
                  <p className="mt-1 truncate text-default-500 text-sm">
                    {room.lastMessage ?? "No messages yet"}
                  </p>
                </div>
                <div className="shrink-0 text-right text-default-400 text-xs">
                  <div>{formatActivity(room.lastActivityAt)}</div>
                  <div className="mt-2 text-success">
                    {room.onlineCount
                      ? `${room.onlineCount} online`
                      : "Offline"}
                  </div>
                </div>
              </div>
            </Card>
          </Link>
        </motion.div>
      ))}
    </ScrollShadow>
  );
}

function RequestPopover() {
  const bootstrap = useAtomValue(bootstrapAtom);
  const requests = useMemo(() => {
    const owned = new Set(
      bootstrap?.rooms.filter((room) => room.isOwner).map((room) => room.id)
    );
    return (bootstrap?.pendingRequests ?? []).filter((request) =>
      owned.has(request.roomId)
    );
  }, [bootstrap]);
  return (
    <ResponsivePopover
      contentClassName="w-80"
      title="Join requests"
      trigger={
        <Button aria-label="Join requests" isIconOnly variant="ghost">
          <span className="relative">
            <BellIcon size={20} />
            {requests.length ? (
              <span className="absolute -top-2 -right-2 grid size-4 place-items-center rounded-full bg-danger text-[10px] text-white">
                {requests.length}
              </span>
            ) : null}
          </span>
        </Button>
      }
    >
      {requests.length ? (
        <div className="space-y-3">
          {requests.map((request) => (
            <RequestRow key={request.id} request={request} />
          ))}
        </div>
      ) : (
        <p className="text-default-500 text-sm">No pending requests</p>
      )}
    </ResponsivePopover>
  );
}

function RequestRow({ request }: { request: JoinRequest }) {
  const [loading, setLoading] = useState(false);
  async function resolve(decision: "approve" | "reject") {
    setLoading(true);
    try {
      await post(`/api/requests/${request.id}/${decision}`);
      await refreshBootstrap();
      toast.success(
        decision === "approve" ? "Request approved" : "Request rejected"
      );
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Request failed");
    } finally {
      setLoading(false);
    }
  }
  return (
    <div className="rounded-2xl bg-default-50 p-3">
      <p className="font-medium">{request.requesterUsername}</p>
      <p className="text-default-500 text-xs">
        {request.roomName} · {request.requesterDeviceName}
      </p>
      <div className="mt-3 flex gap-2">
        <Button
          className="flex-1"
          isPending={loading}
          onPress={() => resolve("approve")}
          size="sm"
          variant="primary"
        >
          Approve
        </Button>
        <Button
          className="flex-1"
          isDisabled={loading}
          onPress={() => resolve("reject")}
          size="sm"
          variant="outline"
        >
          Reject
        </Button>
      </div>
    </div>
  );
}

function IdentityPopover() {
  const bootstrap = useAtomValue(bootstrapAtom);
  return (
    <ResponsivePopover
      contentClassName="w-72"
      title={bootstrap?.user.username ?? "Identity"}
      trigger={
        <Button aria-label="Identity menu" isIconOnly variant="ghost">
          <UserRoundIcon size={20} />
        </Button>
      }
    >
      <div className="space-y-4">
        <div className="rounded-xl bg-default-50 p-3">
          <p className="text-default-500 text-xs">Your short ID</p>
          <p className="mt-1 font-mono font-semibold text-lg">
            {bootstrap?.user.username}
          </p>
        </div>
        <div className="rounded-xl bg-default-50 p-3">
          <p className="text-default-500 text-xs">Device</p>
          <p className="mt-1 font-medium">{bootstrap?.user.deviceName}</p>
          <p className="text-default-500 text-xs capitalize">
            {bootstrap?.user.deviceKind}
          </p>
        </div>
      </div>
    </ResponsivePopover>
  );
}

function DiscoverPopover() {
  const bootstrap = useAtomValue(bootstrapAtom);
  const [rooms, setRooms] = useState<DiscoverRoom[]>([]);
  const [pending, setPending] = useState<string>();
  useEffect(() => {
    if (bootstrap) {
      void api<DiscoverRoom[]>("/api/discover")
        .then(setRooms)
        .catch((error) => {
          toast.error(
            error instanceof Error ? error.message : "Could not load rooms"
          );
        });
    }
  }, [bootstrap]);
  async function request(roomId: string) {
    setPending(roomId);
    try {
      await post(`/api/rooms/${roomId}/requests`);
      toast.success("Request sent");
      setRooms((current) => current.filter((room) => room.id !== roomId));
      await refreshBootstrap();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Request failed");
    } finally {
      setPending(undefined);
    }
  }
  return (
    <ResponsivePopover
      contentClassName="w-96"
      title="Discover rooms"
      trigger={
        <Button aria-label="Discover rooms" isIconOnly variant="ghost">
          <CompassIcon size={20} />
        </Button>
      }
    >
      <ScrollShadow
        className="max-h-96 space-y-2 overflow-y-auto"
        hideScrollBar
      >
        {rooms.map((room) => (
          <div
            className="flex items-center gap-3 rounded-2xl bg-default-50 p-3"
            key={room.id}
          >
            <div className="grid size-11 shrink-0 place-items-center rounded-xl bg-accent font-semibold text-accent-foreground">
              {room.name[0]}
            </div>
            <div className="min-w-0 flex-1">
              <h2 className="truncate font-semibold">{room.name}</h2>
              <p className="truncate text-default-500 text-sm">
                {room.creatorUsername} · {room.memberCount}/10
              </p>
              <p className="text-default-400 text-xs">
                Creator {room.creatorOnline ? "online" : "offline"}
              </p>
            </div>
            <Button
              isPending={pending === room.id}
              onPress={() => request(room.id)}
              size="sm"
              variant="primary"
            >
              Request
            </Button>
          </div>
        ))}
        {rooms.length ? null : (
          <p className="py-12 text-center text-default-500 text-sm">
            No rooms available
          </p>
        )}
      </ScrollShadow>
    </ResponsivePopover>
  );
}

function ResponsivePopover({
  children,
  contentClassName,
  title,
  trigger,
}: {
  children: ReactNode;
  contentClassName: string;
  title: string;
  trigger: ReactNode;
}) {
  const mobile = useMobile();
  if (mobile) {
    return (
      <Modal>
        <Modal.Trigger>{trigger}</Modal.Trigger>
        <Modal.Backdrop>
          <Modal.Container className="p-0" placement="bottom">
            <Modal.Dialog className="max-h-[85dvh] min-h-[40dvh] rounded-b-none">
              <Modal.CloseTrigger />
              <Modal.Header>
                <Modal.Heading>{title}</Modal.Heading>
              </Modal.Header>
              <Modal.Body className="min-h-0 flex-1 pb-2">
                {children}
              </Modal.Body>
            </Modal.Dialog>
          </Modal.Container>
        </Modal.Backdrop>
      </Modal>
    );
  }
  return (
    <Popover>
      <PopoverTrigger>{trigger}</PopoverTrigger>
      <PopoverContent className={`${contentClassName} p-4`}>
        <Popover.Dialog>
          <Popover.Heading className="mb-3 font-semibold">
            {title}
          </Popover.Heading>
          {children}
        </Popover.Dialog>
      </PopoverContent>
    </Popover>
  );
}

export function LoadingScreen() {
  return (
    <main className="grid min-h-dvh place-items-center bg-blue-50 text-default-500 text-sm">
      <Spinner />
    </main>
  );
}

function formatActivity(value: number) {
  const date = new Date(value);
  const today = new Date();
  if (date.toDateString() === today.toDateString()) {
    return new Intl.DateTimeFormat(undefined, {
      hour: "2-digit",
      minute: "2-digit",
    }).format(date);
  }
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
  }).format(date);
}
