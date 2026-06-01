import type { ClientEvent, ServerEvent } from "../../shared/protocol";
import type { FileOffer } from "../../shared/types";

const chunkSize = 64 * 1024;

export type RtcSender = (event: ClientEvent) => void;

export class FileTransferManager {
  private files = new Map<string, File>();
  private peers = new Map<string, RTCPeerConnection>();
  private channels = new Map<string, RTCDataChannel>();

  constructor(
    private selfPeerId: string,
    private send: RtcSender,
    private onProgress: (offerId: string, progress: number) => void,
    private onError: (offerId: string) => void,
    private onComplete: (offerId: string, fileName: string) => void,
  ) {}

  remember(tempId: string, file: File) {
    this.files.set(tempId, file);
  }

  bindOffer(tempId: string, offerId: string) {
    const file = this.files.get(tempId);
    if (!file) return;
    this.files.delete(tempId);
    this.files.set(offerId, file);
  }

  async handleLocked(offer: FileOffer, senderPeerId: string, receiverPeerId: string) {
    if (this.selfPeerId === senderPeerId) {
      await this.startSender(offer, receiverPeerId);
    }
  }

  async handleRtc(event: Extract<ServerEvent, { type: "rtc:offer" | "rtc:answer" | "rtc:candidate" }>) {
    if (event.type === "rtc:offer") {
      const pc = this.createPeer(event.offerId, event.fromPeerId);
      pc.ondatachannel = (channelEvent) => {
        this.receiveFile(event.offerId, channelEvent.channel);
      };
      await pc.setRemoteDescription(event.sdp);
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      this.send({ type: "rtc:answer", offerId: event.offerId, toPeerId: event.fromPeerId, sdp: answer });
      return;
    }

    const pc = this.peers.get(event.offerId);
    if (!pc) return;
    if (event.type === "rtc:answer") {
      await pc.setRemoteDescription(event.sdp);
      return;
    }
    if (event.candidate) {
      await pc.addIceCandidate(event.candidate);
    }
  }

  private async startSender(offer: FileOffer, receiverPeerId: string) {
    const file = this.files.get(offer.id);
    if (!file) {
      this.onError(offer.id);
      this.send({ type: "transfer:fail", offerId: offer.id });
      return;
    }
    const pc = this.createPeer(offer.id, receiverPeerId);
    const channel = pc.createDataChannel("file", { ordered: true });
    this.channels.set(offer.id, channel);
    channel.binaryType = "arraybuffer";
    channel.bufferedAmountLowThreshold = 1024 * 1024;
    channel.onopen = () => {
      this.sendFile(offer.id, file, channel).catch(() => {
        this.onError(offer.id);
        this.send({ type: "transfer:fail", offerId: offer.id });
      });
    };
    const offerSdp = await pc.createOffer();
    await pc.setLocalDescription(offerSdp);
    this.send({ type: "rtc:offer", offerId: offer.id, toPeerId: receiverPeerId, sdp: offerSdp });
  }

  private createPeer(offerId: string, toPeerId: string) {
    const pc = new RTCPeerConnection({ iceServers: [] });
    this.peers.set(offerId, pc);
    pc.onicecandidate = (event) => {
      if (event.candidate) {
        this.send({ type: "rtc:candidate", offerId, toPeerId, candidate: event.candidate.toJSON() });
      }
    };
    pc.onconnectionstatechange = () => {
      if (pc.connectionState === "failed" || pc.connectionState === "disconnected") {
        this.onError(offerId);
      }
    };
    return pc;
  }

  private async sendFile(offerId: string, file: File, channel: RTCDataChannel) {
    channel.send(JSON.stringify({ type: "meta", name: file.name, size: file.size, mime: file.type }));
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
      this.onProgress(offerId, Math.min(1, offset / file.size));
    }
    channel.send(JSON.stringify({ type: "done" }));
    this.send({ type: "transfer:complete", offerId });
    channel.close();
  }

  private receiveFile(offerId: string, channel: RTCDataChannel) {
    const chunks: ArrayBuffer[] = [];
    let meta: { name: string; size: number; mime: string } | undefined;
    let received = 0;
    channel.binaryType = "arraybuffer";
    channel.onmessage = (event) => {
      if (typeof event.data === "string") {
        const message = JSON.parse(event.data);
        if (message.type === "meta") {
          meta = message;
          return;
        }
        if (message.type === "done" && meta) {
          const blob = new Blob(chunks, { type: meta.mime || "application/octet-stream" });
          const url = URL.createObjectURL(blob);
          const link = document.createElement("a");
          link.href = url;
          link.download = meta.name;
          document.body.appendChild(link);
          link.click();
          link.remove();
          window.setTimeout(() => URL.revokeObjectURL(url), 1000);
          this.onComplete(offerId, meta.name);
          this.send({ type: "transfer:complete", offerId });
        }
        return;
      }
      chunks.push(event.data);
      received += event.data.byteLength;
      if (meta?.size) this.onProgress(offerId, Math.min(1, received / meta.size));
    };
  }
}
