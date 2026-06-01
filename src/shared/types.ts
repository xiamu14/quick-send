export type Peer = {
  id: string;
  nickname: string;
  ip: string;
  userAgent: string;
  online: boolean;
  lastSeenAt: number;
};

export type MessageKind = "text" | "file";

export type FileOfferStatus =
  | "available"
  | "transferring"
  | "done"
  | "cancelled"
  | "failed"
  | "expired"
  | "sender_offline";

export type FileOffer = {
  id: string;
  senderPeerId: string;
  receiverPeerId?: string;
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
  kind: MessageKind;
  senderPeerId: string;
  senderNickname?: string;
  senderIp: string;
  body?: string;
  fileOfferId?: string;
  fileOffer?: FileOffer;
  createdAt: number;
};

export type TimelineItem =
  | { type: "date"; id: string; label: string }
  | { type: "message"; id: string; message: ChatMessage };

export type BootstrapPayload = {
  self: Peer;
  peers: Peer[];
  messages: ChatMessage[];
  hasEarlierMessages: boolean;
  publicUrl: string;
  accessCode?: string;
};
