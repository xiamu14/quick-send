import type { ChatMessage, FileOffer, Peer } from "./types";

export type ClientEvent =
  | { type: "peer:hello"; deviceId: string; userAgent: string }
  | { type: "message:text:create"; body: string; tempId?: string }
  | {
      type: "message:file:create";
      tempId: string;
      file: {
        name: string;
        size: number;
        mime: string;
        previewDataUrl?: string;
      };
    }
  | { type: "transfer:receive"; offerId: string }
  | { type: "transfer:complete"; offerId: string }
  | { type: "transfer:fail"; offerId: string }
  | { type: "rtc:offer"; offerId: string; toPeerId: string; sdp: RTCSessionDescriptionInit }
  | { type: "rtc:answer"; offerId: string; toPeerId: string; sdp: RTCSessionDescriptionInit }
  | { type: "rtc:candidate"; offerId: string; toPeerId: string; candidate: RTCIceCandidateInit };

export type ServerEvent =
  | { type: "peer:self"; peer: Peer }
  | { type: "peer:list"; peers: Peer[] }
  | { type: "message:created"; message: ChatMessage; tempId?: string }
  | { type: "file-offer:updated"; offer: FileOffer }
  | { type: "transfer:locked"; offer: FileOffer; senderPeerId: string; receiverPeerId: string }
  | { type: "transfer:busy"; offerId: string }
  | { type: "rtc:offer"; offerId: string; fromPeerId: string; sdp: RTCSessionDescriptionInit }
  | { type: "rtc:answer"; offerId: string; fromPeerId: string; sdp: RTCSessionDescriptionInit }
  | { type: "rtc:candidate"; offerId: string; fromPeerId: string; candidate: RTCIceCandidateInit }
  | { type: "error"; message: string };

