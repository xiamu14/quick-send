import type { ServerWebSocket } from "bun";
import type { Peer } from "../shared/types";
import type { ServerEvent } from "../shared/protocol";

export type PeerSocketData = {
  peerId?: string;
};

const sockets = new Map<string, ServerWebSocket<PeerSocketData>>();
const onlinePeers = new Map<string, Peer>();

export function registerPeer(peer: Peer, ws: ServerWebSocket<PeerSocketData>) {
  ws.data.peerId = peer.id;
  sockets.set(peer.id, ws);
  onlinePeers.set(peer.id, { ...peer, online: true });
}

export function unregisterPeer(peerId: string) {
  sockets.delete(peerId);
  const peer = onlinePeers.get(peerId);
  if (peer) onlinePeers.set(peerId, { ...peer, online: false, lastSeenAt: Date.now() });
}

export function removePeer(peerId: string) {
  sockets.delete(peerId);
  onlinePeers.delete(peerId);
}

export function getOnlinePeer(peerId: string) {
  return onlinePeers.get(peerId);
}

export function listOnlinePeers() {
  return [...onlinePeers.values()].filter((peer) => peer.online);
}

export function broadcast(event: ServerEvent) {
  const raw = JSON.stringify(event);
  for (const ws of sockets.values()) {
    ws.send(raw);
  }
}

export function sendTo(peerId: string, event: ServerEvent) {
  sockets.get(peerId)?.send(JSON.stringify(event));
}

