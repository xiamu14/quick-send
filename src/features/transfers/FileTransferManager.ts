import type { AppSocket } from "@/lib/socket";
import type { RtcServerPayload } from "@/shared/protocol";
import type { FileOffer } from "@/shared/types";

const chunkSize = 64 * 1024;

export class FileTransferManager {
  private readonly files = new Map<string, File>();
  private readonly peers = new Map<string, RTCPeerConnection>();
  private readonly lastProgressAt = new Map<string, number>();

  constructor(
    private readonly selfUserId: string,
    private readonly socket: AppSocket,
    private readonly onProgress: (offerId: string, progress: number) => void,
    private readonly onError: (offerId: string) => void,
    private readonly onComplete: (offerId: string, fileName: string) => void
  ) {}

  remember(clientMessageId: string, file: File) {
    this.files.set(clientMessageId, file);
  }

  bindOffer(clientMessageId: string, offerId: string) {
    const file = this.files.get(clientMessageId);
    if (file) {
      this.files.delete(clientMessageId);
      this.files.set(offerId, file);
    }
  }

  async handleLocked(payload: {
    offer: FileOffer;
    senderUserId: string;
    receiverUserId: string;
  }) {
    if (payload.senderUserId === this.selfUserId) {
      await this.startSender(payload.offer, payload.receiverUserId);
    }
  }

  async handleRtc(
    type: "rtc:offer" | "rtc:answer" | "rtc:candidate",
    event: RtcServerPayload
  ) {
    if (type === "rtc:offer") {
      const peer = this.createPeer(
        event.roomId,
        event.offerId,
        event.fromUserId
      );
      peer.ondatachannel = ({ channel }) => {
        this.receiveFile(event.roomId, event.offerId, channel);
      };
      await peer.setRemoteDescription(
        event.payload as RTCSessionDescriptionInit
      );
      const answer = await peer.createAnswer();
      await peer.setLocalDescription(answer);
      this.socket.emit("rtc:answer", {
        roomId: event.roomId,
        offerId: event.offerId,
        toUserId: event.fromUserId,
        payload: answer,
      });
      return;
    }
    const peer = this.peers.get(event.offerId);
    if (!peer) {
      return;
    }
    if (type === "rtc:answer") {
      await peer.setRemoteDescription(
        event.payload as RTCSessionDescriptionInit
      );
      return;
    }
    await peer.addIceCandidate(event.payload as RTCIceCandidateInit);
  }

  private async startSender(offer: FileOffer, receiverUserId: string) {
    const file = this.files.get(offer.id);
    if (!file) {
      this.fail(offer.roomId, offer.id);
      return;
    }
    const peer = this.createPeer(offer.roomId, offer.id, receiverUserId);
    const channel = peer.createDataChannel("file", { ordered: true });
    channel.binaryType = "arraybuffer";
    channel.bufferedAmountLowThreshold = 1024 * 1024;
    channel.onopen = () => {
      void this.sendFile(offer, file, channel).catch(() => {
        this.fail(offer.roomId, offer.id);
      });
    };
    const description = await peer.createOffer();
    await peer.setLocalDescription(description);
    this.socket.emit("rtc:offer", {
      roomId: offer.roomId,
      offerId: offer.id,
      toUserId: receiverUserId,
      payload: description,
    });
  }

  private createPeer(roomId: string, offerId: string, toUserId: string) {
    const peer = new RTCPeerConnection({ iceServers: [] });
    this.peers.set(offerId, peer);
    peer.onicecandidate = ({ candidate }) => {
      if (candidate) {
        this.socket.emit("rtc:candidate", {
          roomId,
          offerId,
          toUserId,
          payload: candidate.toJSON(),
        });
      }
    };
    peer.onconnectionstatechange = () => {
      if (
        peer.connectionState === "failed" ||
        peer.connectionState === "disconnected"
      ) {
        this.fail(roomId, offerId);
      }
    };
    return peer;
  }

  private async sendFile(
    offer: FileOffer,
    file: File,
    channel: RTCDataChannel
  ) {
    channel.send(
      JSON.stringify({
        type: "meta",
        name: file.name,
        size: file.size,
        mime: file.type,
      })
    );
    let offset = 0;
    while (offset < file.size) {
      if (channel.bufferedAmount > channel.bufferedAmountLowThreshold) {
        await new Promise<void>((resolve) => {
          channel.onbufferedamountlow = () => resolve();
        });
      }
      const chunk = await file.slice(offset, offset + chunkSize).arrayBuffer();
      channel.send(chunk);
      offset += chunk.byteLength;
      this.progress(offer.id, offset / file.size);
    }
    channel.send(JSON.stringify({ type: "done" }));
    this.socket.emit("transfer:complete", {
      roomId: offer.roomId,
      offerId: offer.id,
    });
    channel.close();
  }

  private receiveFile(
    roomId: string,
    offerId: string,
    channel: RTCDataChannel
  ) {
    const chunks: ArrayBuffer[] = [];
    let meta: { name: string; size: number; mime: string } | undefined;
    let received = 0;
    channel.binaryType = "arraybuffer";
    channel.onmessage = ({ data }) => {
      if (typeof data === "string") {
        const message = JSON.parse(data) as {
          type: string;
          name?: string;
          size?: number;
          mime?: string;
        };
        if (
          message.type === "meta" &&
          message.name &&
          message.size &&
          message.mime !== undefined
        ) {
          meta = {
            name: message.name,
            size: message.size,
            mime: message.mime,
          };
          return;
        }
        if (message.type === "done" && meta) {
          const blob = new Blob(chunks, {
            type: meta.mime || "application/octet-stream",
          });
          const url = URL.createObjectURL(blob);
          const link = document.createElement("a");
          link.href = url;
          link.download = meta.name;
          link.click();
          window.setTimeout(() => URL.revokeObjectURL(url), 1000);
          this.onComplete(offerId, meta.name);
          this.socket.emit("transfer:complete", { roomId, offerId });
        }
        return;
      }
      const chunk = data as ArrayBuffer;
      chunks.push(chunk);
      received += chunk.byteLength;
      if (meta) {
        this.progress(offerId, received / meta.size);
      }
    };
  }

  private progress(offerId: string, value: number) {
    const now = Date.now();
    if (value < 1 && now - (this.lastProgressAt.get(offerId) ?? 0) < 100) {
      return;
    }
    this.lastProgressAt.set(offerId, now);
    this.onProgress(offerId, Math.min(1, value));
  }

  private fail(roomId: string, offerId: string) {
    this.onError(offerId);
    this.socket.emit("transfer:fail", { roomId, offerId });
  }
}
