import type {
  DiscoverRoom,
  JoinRequest,
  RoomDetail,
  RoomSummary,
  User,
} from "@/shared/types";
import type { AppDatabase } from "./db";
import { AppError } from "./errors";

export const limits = {
  maxOwnedRooms: 5,
  maxRoomMembers: 10,
  maxPendingRequests: 5,
  maxFileBytes: 200 * 1024 * 1024,
} as const;

const requestTtlMs = 7 * 24 * 60 * 60 * 1000;
const requestCooldownMs = 60 * 1000;
const roomNames = [
  "Orbit",
  "Harbor",
  "Maple",
  "Quartz",
  "Meadow",
  "Summit",
  "Beacon",
  "Canvas",
  "Cedar",
  "Comet",
  "Delta",
  "Ember",
  "Fjord",
  "Grove",
  "Horizon",
  "Lagoon",
  "Mosaic",
  "Nimbus",
  "Prairie",
  "Willow",
] as const;

export function createRoom(database: AppDatabase, creator: User) {
  const owned = database
    .query<{ count: number }, [string]>(
      "select count(*) as count from rooms where creator_id = ?"
    )
    .get(creator.id)?.count;
  if ((owned ?? 0) >= limits.maxOwnedRooms) {
    throw new AppError(
      "ROOM_LIMIT_REACHED",
      "You can create up to 5 rooms",
      409
    );
  }
  const used = new Set(
    database
      .query<{ name: string }, [string]>(
        "select name from rooms where creator_id = ?"
      )
      .all(creator.id)
      .map((row) => row.name)
  );
  const available = roomNames.filter((name) => !used.has(name));
  const name = available[Math.floor(Math.random() * available.length)];
  if (!name) {
    throw new AppError("ROOM_LIMIT_REACHED", "No room names available", 409);
  }
  const room = { id: crypto.randomUUID(), name, createdAt: Date.now() };
  database.transaction(() => {
    database
      .query(
        "insert into rooms(id, name, creator_id, created_at) values(?, ?, ?, ?)"
      )
      .run(room.id, room.name, creator.id, room.createdAt);
    database
      .query(
        "insert into room_members(room_id, user_id, joined_at) values(?, ?, ?)"
      )
      .run(room.id, creator.id, room.createdAt);
    writeAudit(database, creator.id, room.id, room.name, "room_created");
  })();
  return room;
}

export function deleteRoom(
  database: AppDatabase,
  actorId: string,
  roomId: string,
  confirmation: string
) {
  const room = database
    .query<{ name: string; creator_id: string }, [string]>(
      "select name, creator_id from rooms where id = ?"
    )
    .get(roomId);
  if (!room) {
    throw new AppError("ROOM_NOT_FOUND", "Room not found", 404);
  }
  if (room.creator_id !== actorId) {
    throw new AppError(
      "FORBIDDEN",
      "Only the creator can delete this room",
      403
    );
  }
  if (confirmation !== room.name) {
    throw new AppError("INVALID_CONFIRMATION", "Room name does not match");
  }
  database.transaction(() => {
    writeAudit(database, actorId, roomId, room.name, "room_deleted");
    database.query("delete from rooms where id = ?").run(roomId);
  })();
}

export function listRoomSummaries(
  database: AppDatabase,
  userId: string,
  onlineUserIds: ReadonlySet<string>
): RoomSummary[] {
  const rows = database
    .query<
      {
        id: string;
        name: string;
        creator_id: string;
        creator_username: string;
        created_at: number;
        member_count: number;
        pending_count: number;
        last_kind: "text" | "file" | null;
        last_body: string | null;
        last_file_name: string | null;
        last_created_at: number | null;
      },
      [string]
    >(
      `select
        r.id, r.name, r.creator_id, creator.username as creator_username,
        r.created_at,
        (select count(*) from room_members rm2 where rm2.room_id = r.id) as member_count,
        (select count(*) from join_requests jr
          where jr.room_id = r.id and jr.status = 'pending') as pending_count,
        m.kind as last_kind, m.body as last_body,
        f.name as last_file_name, m.created_at as last_created_at
       from rooms r
       join room_members rm on rm.room_id = r.id
       join users creator on creator.id = r.creator_id
       left join messages m on m.id = (
         select id from messages
         where room_id = r.id
         order by created_at desc, id desc limit 1
       )
       left join message_files f on f.message_id = m.id
       where rm.user_id = ?
       order by coalesce(m.created_at, r.created_at) desc, r.id desc`
    )
    .all(userId);
  return rows
    .filter(
      (row) => row.creator_id === userId || onlineUserIds.has(row.creator_id)
    )
    .map((row): RoomSummary => {
      const memberIds = database
        .query<{ user_id: string }, [string]>(
          "select user_id from room_members where room_id = ?"
        )
        .all(row.id);
      const lastMessage = lastMessageSummary(row);
      return {
        id: row.id,
        name: row.name,
        creatorId: row.creator_id,
        creatorUsername: row.creator_username,
        isOwner: row.creator_id === userId,
        onlineCount: memberIds.filter((member) =>
          onlineUserIds.has(member.user_id)
        ).length,
        memberCount: row.member_count,
        pendingCount: row.creator_id === userId ? row.pending_count : 0,
        ...(lastMessage ? { lastMessage } : {}),
        lastActivityAt: row.last_created_at ?? row.created_at,
        createdAt: row.created_at,
      };
    });
}

export function listDiscoverRooms(
  database: AppDatabase,
  userId: string,
  onlineUserIds: ReadonlySet<string>
): DiscoverRoom[] {
  return database
    .query<
      {
        id: string;
        name: string;
        creator_id: string;
        creator_username: string;
        member_count: number;
        created_at: number;
      },
      [string, string, number]
    >(
      `select r.id, r.name, r.creator_id,
        u.username as creator_username, r.created_at,
        (select count(*) from room_members rm2 where rm2.room_id = r.id) as member_count
       from rooms r join users u on u.id = r.creator_id
       where not exists (
         select 1 from room_members rm
         where rm.room_id = r.id and rm.user_id = ?
       )
       and not exists (
         select 1 from join_requests jr
         where jr.room_id = r.id and jr.requester_id = ? and jr.status = 'pending'
       )
       and (select count(*) from room_members rm3 where rm3.room_id = r.id) < ?
       order by r.created_at desc`
    )
    .all(userId, userId, limits.maxRoomMembers)
    .filter((row) => onlineUserIds.has(row.creator_id))
    .sort(
      (left, right) =>
        Number(onlineUserIds.has(right.creator_id)) -
          Number(onlineUserIds.has(left.creator_id)) ||
        right.created_at - left.created_at
    )
    .map((row) => ({
      id: row.id,
      name: row.name,
      creatorUsername: row.creator_username,
      creatorOnline: onlineUserIds.has(row.creator_id),
      memberCount: row.member_count,
      createdAt: row.created_at,
    }));
}

export function getRoomDetail(
  database: AppDatabase,
  roomId: string,
  userId: string,
  onlineUserIds: ReadonlySet<string>
): RoomDetail | undefined {
  const room = database
    .query<
      {
        id: string;
        name: string;
        creator_id: string;
        creator_username: string;
        created_at: number;
      },
      [string]
    >(
      `select r.*, u.username as creator_username
       from rooms r join users u on u.id = r.creator_id
       where r.id = ?`
    )
    .get(roomId);
  if (
    !room ||
    (room.creator_id !== userId && !onlineUserIds.has(room.creator_id))
  ) {
    return;
  }
  const isMember = hasRoomMembership(database, roomId, userId);
  const isPending = Boolean(
    database
      .query<{ id: string }, [string, string]>(
        `select id from join_requests
         where room_id = ? and requester_id = ? and status = 'pending'`
      )
      .get(roomId, userId)
  );
  const members = isMember
    ? database
        .query<
          {
            id: string;
            username: string;
            avatar_seed: string;
            device_kind: User["deviceKind"];
            created_at: number;
          },
          [string]
        >(
          `select u.id, u.username, u.avatar_seed, u.device_kind, u.created_at
           from room_members rm join users u on u.id = rm.user_id
           where rm.room_id = ? order by rm.joined_at`
        )
        .all(roomId)
        .map((member) => ({
          id: member.id,
          username: member.username,
          avatarSeed: member.avatar_seed,
          deviceKind: member.device_kind,
          createdAt: member.created_at,
          online: onlineUserIds.has(member.id),
          isCreator: member.id === room.creator_id,
        }))
    : [];
  let membership: RoomDetail["membership"] = "none";
  if (isMember) {
    membership = "member";
  } else if (isPending) {
    membership = "pending";
  }
  return {
    id: room.id,
    name: room.name,
    creatorId: room.creator_id,
    creatorUsername: room.creator_username,
    createdAt: room.created_at,
    membership,
    members,
    pendingRequests:
      userId === room.creator_id ? listPendingRequests(database, roomId) : [],
  };
}

export function requestToJoin(
  database: AppDatabase,
  roomId: string,
  requester: User
) {
  if (hasRoomMembership(database, roomId, requester.id)) {
    throw new AppError("ALREADY_MEMBER", "You are already a member", 409);
  }
  const room = database
    .query<{ name: string }, [string]>("select name from rooms where id = ?")
    .get(roomId);
  if (!room) {
    throw new AppError("ROOM_NOT_FOUND", "Room not found", 404);
  }
  const pendingCount =
    database
      .query<{ count: number }, [string]>(
        `select count(*) as count from join_requests
         where requester_id = ? and status = 'pending'`
      )
      .get(requester.id)?.count ?? 0;
  if (pendingCount >= limits.maxPendingRequests) {
    throw new AppError(
      "REQUEST_LIMIT_REACHED",
      "You can have up to 5 pending requests",
      409
    );
  }
  const memberCount =
    database
      .query<{ count: number }, [string]>(
        "select count(*) as count from room_members where room_id = ?"
      )
      .get(roomId)?.count ?? 0;
  if (memberCount >= limits.maxRoomMembers) {
    throw new AppError("ROOM_FULL", "Room is full", 409);
  }
  const previous = database
    .query<{ status: string; resolved_at: number | null }, [string, string]>(
      "select status, resolved_at from join_requests where room_id = ? and requester_id = ?"
    )
    .get(roomId, requester.id);
  if (previous?.status === "pending") {
    throw new AppError("REQUEST_PENDING", "Request is already pending", 409);
  }
  if (
    previous?.status === "rejected" &&
    (previous.resolved_at ?? 0) > Date.now() - requestCooldownMs
  ) {
    throw new AppError(
      "REQUEST_COOLDOWN",
      "Wait before requesting to join again",
      409
    );
  }
  const requestId = crypto.randomUUID();
  database
    .query(
      `insert into join_requests(
        id, room_id, requester_id, status, created_at
      ) values(?, ?, ?, 'pending', ?)
      on conflict(room_id, requester_id) do update set
        id = excluded.id,
        status = 'pending',
        created_at = excluded.created_at,
        resolved_at = null`
    )
    .run(requestId, roomId, requester.id, Date.now());
  writeAudit(database, requester.id, roomId, room.name, "join_requested");
  return requestId;
}

export function resolveJoinRequest(
  database: AppDatabase,
  requestId: string,
  actorId: string,
  decision: "approved" | "rejected"
) {
  const request = database
    .query<
      {
        room_id: string;
        room_name: string;
        creator_id: string;
        requester_id: string;
        status: string;
      },
      [string]
    >(
      `select jr.room_id, r.name as room_name, r.creator_id,
        jr.requester_id, jr.status
       from join_requests jr join rooms r on r.id = jr.room_id
       where jr.id = ?`
    )
    .get(requestId);
  if (!request) {
    throw new AppError("REQUEST_NOT_FOUND", "Join request not found", 404);
  }
  if (request.creator_id !== actorId) {
    throw new AppError(
      "FORBIDDEN",
      "Only the creator can resolve requests",
      403
    );
  }
  if (request.status !== "pending") {
    throw new AppError(
      "REQUEST_RESOLVED",
      "Join request was already resolved",
      409
    );
  }
  if (decision === "approved") {
    const count =
      database
        .query<{ count: number }, [string]>(
          "select count(*) as count from room_members where room_id = ?"
        )
        .get(request.room_id)?.count ?? 0;
    if (count >= limits.maxRoomMembers) {
      throw new AppError("ROOM_FULL", "Room is full", 409);
    }
  }
  database.transaction(() => {
    database
      .query(
        "update join_requests set status = ?, resolved_at = ? where id = ?"
      )
      .run(decision, Date.now(), requestId);
    if (decision === "approved") {
      database
        .query(
          "insert into room_members(room_id, user_id, joined_at) values(?, ?, ?)"
        )
        .run(request.room_id, request.requester_id, Date.now());
    }
    writeAudit(
      database,
      actorId,
      request.room_id,
      request.room_name,
      decision === "approved" ? "join_approved" : "join_rejected"
    );
  })();
  return {
    roomId: request.room_id,
    requesterId: request.requester_id,
    decision,
  };
}

export function listPendingRequests(
  database: AppDatabase,
  roomId?: string,
  requesterId?: string
): JoinRequest[] {
  const conditions = ["jr.status = 'pending'"];
  const values: string[] = [];
  if (roomId) {
    conditions.push("jr.room_id = ?");
    values.push(roomId);
  }
  if (requesterId) {
    conditions.push("jr.requester_id = ?");
    values.push(requesterId);
  }
  return database
    .query<
      {
        id: string;
        room_id: string;
        room_name: string;
        requester_id: string;
        requester_username: string;
        requester_device_kind: User["deviceKind"];
        status: JoinRequest["status"];
        created_at: number;
      },
      string[]
    >(
      `select jr.id, jr.room_id, r.name as room_name,
        jr.requester_id, u.username as requester_username,
        u.device_kind as requester_device_kind, jr.status, jr.created_at
       from join_requests jr
       join rooms r on r.id = jr.room_id
       join users u on u.id = jr.requester_id
       where ${conditions.join(" and ")}
       order by jr.created_at desc`
    )
    .all(...values)
    .map((row) => ({
      id: row.id,
      roomId: row.room_id,
      roomName: row.room_name,
      requesterId: row.requester_id,
      requesterUsername: row.requester_username,
      requesterDeviceKind: row.requester_device_kind,
      status: row.status,
      createdAt: row.created_at,
    }));
}

export function listRelevantPendingRequests(
  database: AppDatabase,
  userId: string,
  onlineUserIds: ReadonlySet<string>
) {
  const ownedRoomIds = new Set(
    database
      .query<{ id: string }, [string]>(
        "select id from rooms where creator_id = ?"
      )
      .all(userId)
      .map((room) => room.id)
  );
  return listPendingRequests(database).filter(
    (request) =>
      ownedRoomIds.has(request.roomId) ||
      (request.requesterId === userId &&
        isRoomVisibleToUser(database, request.roomId, userId, onlineUserIds))
  );
}

export function hasRoomMembership(
  database: AppDatabase,
  roomId: string,
  userId: string
) {
  return Boolean(
    database
      .query<{ room_id: string }, [string, string]>(
        "select room_id from room_members where room_id = ? and user_id = ?"
      )
      .get(roomId, userId)
  );
}

export function isRoomVisibleToUser(
  database: AppDatabase,
  roomId: string,
  userId: string,
  onlineUserIds: ReadonlySet<string>
) {
  const room = database
    .query<{ creator_id: string }, [string]>(
      "select creator_id from rooms where id = ?"
    )
    .get(roomId);
  return Boolean(
    room && (room.creator_id === userId || onlineUserIds.has(room.creator_id))
  );
}

export function cleanupRoomState(database: AppDatabase) {
  database
    .query(
      `update join_requests set status = 'expired', resolved_at = ?
       where status = 'pending' and created_at < ?`
    )
    .run(Date.now(), Date.now() - requestTtlMs);
}

function lastMessageSummary(row: {
  last_kind: "text" | "file" | null;
  last_body: string | null;
  last_file_name: string | null;
}) {
  if (row.last_kind === "text") {
    return row.last_body?.slice(0, 80);
  }
  if (row.last_kind === "file") {
    return `File · ${row.last_file_name ?? "Attachment"}`;
  }
  return;
}

function writeAudit(
  database: AppDatabase,
  actorUserId: string,
  roomId: string,
  roomName: string,
  action: string
) {
  database
    .query(
      `insert into audit_logs(
        id, actor_user_id, room_id, room_name_snapshot, action, created_at
      ) values(?, ?, ?, ?, ?, ?)`
    )
    .run(
      crypto.randomUUID(),
      actorUserId,
      roomId,
      roomName,
      action,
      Date.now()
    );
}
