export type DeviceKind = "desktop" | "mobile" | "tablet";

export type User = {
  id: string;
  username: string;
  avatarSeed: string;
  deviceKind: DeviceKind;
  createdAt: number;
};

export type RoomSummary = {
  id: string;
  name: string;
  creatorId: string;
  creatorUsername: string;
  isOwner: boolean;
  onlineCount: number;
  memberCount: number;
  pendingCount: number;
  lastMessage?: string;
  lastActivityAt: number;
  createdAt: number;
};

export type DiscoverRoom = {
  id: string;
  name: string;
  creatorUsername: string;
  creatorOnline: boolean;
  memberCount: number;
  createdAt: number;
};

export type JoinRequest = {
  id: string;
  roomId: string;
  roomName: string;
  requesterId: string;
  requesterUsername: string;
  requesterDeviceKind: DeviceKind;
  status: "pending" | "approved" | "rejected" | "expired";
  createdAt: number;
};

export type RoomMember = User & {
  online: boolean;
  isCreator: boolean;
};

export type RoomDetail = {
  id: string;
  name: string;
  creatorId: string;
  creatorUsername: string;
  createdAt: number;
  membership: "member" | "pending" | "none";
  members: RoomMember[];
  pendingRequests: JoinRequest[];
};

export type FileOfferStatus =
  | "available"
  | "transferring"
  | "expired"
  | "sender_offline";

export type FileOffer = {
  id: string;
  roomId: string;
  senderUserId: string;
  senderSocketId: string;
  receiverUserId?: string;
  name: string;
  size: number;
  mime: string;
  previewDataUrl?: string;
  status: FileOfferStatus;
  expiresAt: number;
  createdAt: number;
  updatedAt: number;
};

export type ChatMessage = {
  id: string;
  roomId: string;
  kind: "text" | "file";
  senderUserId: string;
  senderUsername: string;
  senderAvatarSeed: string;
  senderDeviceKind: DeviceKind;
  body?: string;
  fileOffer?: FileOffer;
  createdAt: number;
};

export type BootstrapPayload = {
  user: User;
  rooms: RoomSummary[];
  pendingRequests: JoinRequest[];
  limits: {
    maxOwnedRooms: number;
    maxRoomMembers: number;
    maxPendingRequests: number;
    maxFileBytes: number;
  };
};

export type MessagePage = {
  messages: ChatMessage[];
  nextCursor?: string;
};
