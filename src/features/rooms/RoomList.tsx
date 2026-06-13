import {
  Button,
  Card,
  Chip,
  Input,
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@heroui/react";
import { Link, useNavigate } from "@tanstack/react-router";
import { motion } from "framer-motion";
import { useAtomValue } from "jotai";
import {
  BellIcon,
  CompassIcon,
  KeyRoundIcon,
  PlusIcon,
  QrCodeIcon,
  UserRoundIcon,
} from "lucide-react";
import QRCode from "qrcode";
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { api, post } from "@/lib/api";
import { getSocket, refreshBootstrap } from "@/lib/socket";
import type { DiscoverRoom, JoinRequest, RoomSummary } from "@/shared/types";
import { appStore, bootstrapAtom, bootstrapLoadingAtom } from "@/store/app";

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
      void refreshBootstrap().then((result) => {
        if (!alive) {
          return;
        }
        appStore.set(bootstrapLoadingAtom, false);
        if (result) {
          getSocket();
        } else if (result === null) {
          void navigate({ to: "/setup" });
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
    <main className="min-h-dvh bg-blue-50">
      <div className="mx-auto min-h-dvh max-w-3xl bg-white shadow-sm">
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
    <aside className="hidden h-dvh w-96 shrink-0 border-default-200 border-r bg-white md:block">
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
        <h1 className="font-semibold text-2xl tracking-tight">Rooms</h1>
        <p className="mt-1 text-default-500 text-sm">
          {bootstrap?.user.username}
        </p>
      </div>
      <div className="flex items-center gap-1">
        <RequestPopover />
        <Button
          aria-label="Discover rooms"
          isIconOnly
          onPress={() => navigate({ to: "/discover" })}
          variant="ghost"
        >
          <CompassIcon size={20} />
        </Button>
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
            variant="primary"
          >
            <PlusIcon size={21} />
          </Button>
        </motion.div>
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
  if (!rooms.length) {
    return (
      <div className="grid min-h-96 place-items-center px-8 text-center">
        <div>
          <div className="mx-auto grid size-16 place-items-center rounded-3xl bg-accent-soft text-accent-soft-foreground">
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
    <div
      className={`space-y-2 overflow-y-auto ${compact ? "p-3" : "p-4 sm:p-6"}`}
    >
      {rooms.map((room) => (
        <motion.div
          animate={{ opacity: 1 }}
          initial={{ opacity: 0 }}
          key={room.id}
          layout
        >
          <Link
            className="block rounded-3xl outline-none ring-accent focus-visible:ring-2"
            params={{ roomId: room.id }}
            to="/rooms/$roomId"
          >
            <Card className="rounded-3xl border border-default-200 bg-white p-4 shadow-none transition-colors hover:bg-default-50">
              <div className="flex items-center gap-4">
                <div className="grid size-12 shrink-0 place-items-center rounded-2xl bg-accent font-semibold text-accent-foreground text-lg">
                  {room.name.slice(0, 1)}
                </div>
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
    </div>
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
    <Popover>
      <PopoverTrigger>
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
      </PopoverTrigger>
      <PopoverContent className="w-80 p-3">
        <Popover.Dialog>
          <Popover.Heading className="mb-3 font-semibold">
            Join requests
          </Popover.Heading>
          {requests.length ? (
            <div className="space-y-3">
              {requests.map((request) => (
                <RequestRow key={request.id} request={request} />
              ))}
            </div>
          ) : (
            <p className="text-default-500 text-sm">No pending requests</p>
          )}
        </Popover.Dialog>
      </PopoverContent>
    </Popover>
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
        {request.roomName} · {request.requesterDeviceKind}
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
  const [qr, setQr] = useState("");
  const [totp, setTotp] = useState("");
  const [recoveryCode, setRecoveryCode] = useState("");
  useEffect(() => {
    void QRCode.toDataURL(window.location.origin, {
      width: 200,
      margin: 1,
    }).then(setQr);
  }, []);
  async function generateRecoveryCode() {
    try {
      const result = await post<{ recoveryCode: string }>(
        "/api/identity/recovery-code",
        { code: totp }
      );
      setRecoveryCode(result.recoveryCode);
      setTotp("");
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "Verification failed"
      );
    }
  }
  return (
    <Popover>
      <PopoverTrigger>
        <Button aria-label="Identity menu" isIconOnly variant="ghost">
          <UserRoundIcon size={20} />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-72 p-4">
        <Popover.Dialog>
          <Popover.Heading className="font-semibold">
            {bootstrap?.user.username}
          </Popover.Heading>
          <div className="mt-4 space-y-4">
            <div className="flex items-center gap-3">
              <QrCodeIcon className="text-default-500" size={18} />
              <span className="text-sm">Share Quick Send</span>
            </div>
            {qr ? (
              <img
                alt="Quick Send QR code"
                className="mx-auto size-44"
                src={qr}
              />
            ) : null}
            <div className="border-default-200 border-t pt-4">
              <div className="mb-3 flex items-center gap-2 font-medium text-sm">
                <KeyRoundIcon size={17} />
                New recovery code
              </div>
              {recoveryCode ? (
                <div className="rounded-xl bg-accent-soft p-3 text-center font-mono text-accent-soft-foreground">
                  {recoveryCode}
                </div>
              ) : (
                <div className="space-y-2">
                  <Input
                    aria-label="Authenticator code"
                    onChange={(event) => setTotp(event.target.value)}
                    placeholder="Authenticator code"
                    value={totp}
                  />
                  <Button
                    fullWidth
                    isDisabled={totp.length !== 6}
                    onPress={generateRecoveryCode}
                    size="sm"
                    variant="outline"
                  >
                    Generate
                  </Button>
                </div>
              )}
            </div>
          </div>
        </Popover.Dialog>
      </PopoverContent>
    </Popover>
  );
}

export function DiscoverPage() {
  const navigate = useNavigate();
  const { bootstrap, loading } = useAuthenticatedBootstrap();
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
  if (loading || !bootstrap) {
    return <LoadingScreen />;
  }
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
    <main className="min-h-dvh bg-blue-50 px-4 py-6">
      <div className="mx-auto max-w-2xl">
        <div className="mb-6 flex items-center justify-between">
          <div>
            <p className="text-accent text-sm">Quick Send</p>
            <h1 className="font-semibold text-2xl">Discover rooms</h1>
          </div>
          <Button onPress={() => navigate({ to: "/" })} variant="ghost">
            Done
          </Button>
        </div>
        <div className="space-y-3">
          {rooms.map((room) => (
            <Card className="rounded-3xl bg-white p-4 shadow-sm" key={room.id}>
              <div className="flex items-center gap-4">
                <div className="grid size-12 place-items-center rounded-2xl bg-accent font-semibold text-accent-foreground text-lg">
                  {room.name[0]}
                </div>
                <div className="min-w-0 flex-1">
                  <h2 className="font-semibold">{room.name}</h2>
                  <p className="text-default-500 text-sm">
                    {room.creatorUsername} · {room.memberCount}/10 members
                  </p>
                  <p className="mt-1 text-default-400 text-xs">
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
            </Card>
          ))}
          {rooms.length ? null : (
            <p className="py-20 text-center text-default-500 text-sm">
              No rooms available
            </p>
          )}
        </div>
      </div>
    </main>
  );
}

export function LoadingScreen() {
  return (
    <main className="grid min-h-dvh place-items-center bg-blue-50 text-default-500 text-sm">
      Loading
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
