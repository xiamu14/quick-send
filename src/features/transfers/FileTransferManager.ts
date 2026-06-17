import type { AppSocket } from "@/lib/socket";
import type { RtcServerPayload } from "@/shared/protocol";
import type { FileOffer } from "@/shared/types";
import { prepareReceivedFile, type ReceivedFileResult } from "@/web/save-file";

const chunkSize = 64 * 1024;

export class FileTransferManager {
  private readonly files = new Map<string, File>();
  private readonly peers = new Map<string, RTCPeerConnection>();
  private readonly pendingCandidates = new Map<string, RTCIceCandidateInit[]>();
  private readonly lastProgressAt = new Map<string, number>();

  constructor(
    private readonly selfUserId: string,
    private readonly socket: AppSocket,
    private readonly onProgress: (offerId: string, progress: number) => void,
    private readonly onError: (offerId: string) => void,
    private readonly onComplete: (
      offerId: string,
      result: ReceivedFileResult
    ) => void
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
      await this.flushPendingCandidates(event.offerId, peer);
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
      await this.flushPendingCandidates(event.offerId, peer);
      return;
    }
    await this.addCandidate(event.offerId, peer, event.payload);
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
    channel.onclose = () => {
      peer.close();
      this.peers.delete(offer.id);
      this.pendingCandidates.delete(offer.id);
    };
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
    peer.oniceconnectionstatechange = () => {
      if (peer.iceConnectionState === "failed") {
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
      await this.waitForBuffer(channel);
      const chunk = await file.slice(offset, offset + chunkSize).arrayBuffer();
      channel.send(chunk);
      offset += chunk.byteLength;
      this.progress(offer.id, offset / file.size);
    }
    await this.waitForBuffer(channel);
    channel.send(JSON.stringify({ type: "done" }));
    await this.waitForBuffer(channel, 0);
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
    channel.onmessage = (event) => {
      void this.receiveMessage(event.data, {
        chunks,
        get meta() {
          return meta;
        },
        set meta(value) {
          meta = value;
        },
        get received() {
          return received;
        },
        set received(value) {
          received = value;
        },
        roomId,
        offerId,
      });
    };
    channel.onclose = () => {
      this.peers.get(offerId)?.close();
      this.peers.delete(offerId);
      this.pendingCandidates.delete(offerId);
    };
  }

  private async receiveMessage(
    data: unknown,
    state: {
      chunks: ArrayBuffer[];
      meta: { name: string; size: number; mime: string } | undefined;
      received: number;
      roomId: string;
      offerId: string;
    }
  ) {
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
        typeof message.size === "number" &&
        message.mime !== undefined
      ) {
        state.meta = {
          name: message.name,
          size: message.size,
          mime: message.mime,
        };
        return;
      }
      if (message.type === "done" && state.meta) {
        if (state.received !== state.meta.size) {
          this.fail(state.roomId, state.offerId);
          return;
        }
        const file = new File(state.chunks, state.meta.name, {
          type: state.meta.mime || "application/octet-stream",
        });
        this.progress(state.offerId, 1);
        this.onComplete(state.offerId, prepareReceivedFile(file));
        this.socket.emit("transfer:complete", {
          roomId: state.roomId,
          offerId: state.offerId,
        });
      }
      return;
    }
    const chunk =
      data instanceof Blob ? await data.arrayBuffer() : (data as ArrayBuffer);
    state.chunks.push(chunk);
    state.received += chunk.byteLength;
    if (state.meta) {
      this.progress(state.offerId, state.received / state.meta.size);
    }
  }

  private async addCandidate(
    offerId: string,
    peer: RTCPeerConnection,
    payload: unknown
  ) {
    const candidate = payload as RTCIceCandidateInit;
    if (!peer.remoteDescription) {
      this.pendingCandidates.set(offerId, [
        ...(this.pendingCandidates.get(offerId) ?? []),
        candidate,
      ]);
      return;
    }
    await peer.addIceCandidate(candidate);
  }

  private async flushPendingCandidates(
    offerId: string,
    peer: RTCPeerConnection
  ) {
    const candidates = this.pendingCandidates.get(offerId) ?? [];
    this.pendingCandidates.delete(offerId);
    for (const candidate of candidates) {
      await peer.addIceCandidate(candidate);
    }
  }

  private waitForBuffer(
    channel: RTCDataChannel,
    target = channel.bufferedAmountLowThreshold
  ) {
    if (channel.bufferedAmount <= target) {
      return Promise.resolve();
    }
    return new Promise<void>((resolve, reject) => {
      const timeout = window.setTimeout(() => {
        channel.removeEventListener("bufferedamountlow", onLow);
        reject(new Error("Timed out waiting for data channel buffer"));
      }, 30_000);
      const onLow = () => {
        if (channel.bufferedAmount > target) {
          return;
        }
        window.clearTimeout(timeout);
        channel.removeEventListener("bufferedamountlow", onLow);
        resolve();
      };
      channel.addEventListener("bufferedamountlow", onLow);
    });
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
    this.peers.get(offerId)?.close();
    this.peers.delete(offerId);
    this.pendingCandidates.delete(offerId);
  }
}
