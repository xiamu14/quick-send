import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import type { ChatMessage, FileOffer, Peer } from "../shared/types";

const dbPath = join(process.cwd(), "data", "quick-send.sqlite");
mkdirSync(dirname(dbPath), { recursive: true });

export const db = new Database(dbPath);
db.exec("pragma journal_mode = WAL");

db.exec(`
create table if not exists config (
  key text primary key,
  value text not null
);

create table if not exists peers (
  id text primary key,
  nickname text not null,
  last_ip text not null,
  user_agent text not null,
  created_at integer not null,
  last_seen_at integer not null
);

create table if not exists sessions (
  id text primary key,
  expires_at integer not null,
  created_at integer not null
);

create table if not exists file_offers (
  id text primary key,
  sender_peer_id text not null,
  receiver_peer_id text,
  name text not null,
  size integer not null,
  mime text not null,
  preview_data_url text,
  status text not null,
  expires_at integer not null,
  created_at integer not null,
  updated_at integer not null
);

create table if not exists messages (
  id text primary key,
  kind text not null,
  sender_peer_id text not null,
  sender_ip text not null,
  body text,
  file_offer_id text,
  created_at integer not null
);

create index if not exists messages_created_at_idx on messages(created_at);
create index if not exists file_offers_sender_status_idx on file_offers(sender_peer_id, status);
`);

db.exec(`
update peers set last_ip = substr(last_ip, 8) where last_ip like '::ffff:%';
update messages set sender_ip = substr(sender_ip, 8) where sender_ip like '::ffff:%';
`);
mergeDuplicatePeersByIp();

export function getConfig(key: string) {
  return db.query<{ value: string }, [string]>("select value from config where key = ?").get(key)?.value;
}

export function setConfig(key: string, value: string) {
  db.query("insert into config(key, value) values(?, ?) on conflict(key) do update set value = excluded.value").run(
    key,
    value,
  );
}

export function getOrCreateConfig(key: string, createValue: () => string) {
  const existing = getConfig(key);
  if (existing) return existing;
  const value = createValue();
  setConfig(key, value);
  return value;
}

export function upsertPeer(input: { id: string; ip: string; userAgent: string; nickname?: string }): Peer {
  const now = Date.now();
  const existing = db
    .query<{ id: string; nickname: string }, [string]>("select id, nickname from peers where id = ?")
    .get(input.id);
  const ipPeer = existing
    ? undefined
    : db
        .query<{ id: string; nickname: string }, [string]>(
          "select id, nickname from peers where last_ip = ? order by last_seen_at desc limit 1",
        )
        .get(input.ip);
  const peerId = existing?.id ?? ipPeer?.id ?? input.id;
  const nickname = existing?.nickname ?? ipPeer?.nickname ?? input.nickname ?? nextNickname();
  mergePeersByIp(peerId, input.ip);
  db.query(`
    insert into peers(id, nickname, last_ip, user_agent, created_at, last_seen_at)
    values(?, ?, ?, ?, ?, ?)
    on conflict(id) do update set
      last_ip = excluded.last_ip,
      user_agent = excluded.user_agent,
      last_seen_at = excluded.last_seen_at
  `).run(peerId, nickname, input.ip, input.userAgent, now, now);
  return { id: peerId, nickname, ip: input.ip, userAgent: input.userAgent, online: true, lastSeenAt: now };
}

function mergePeersByIp(canonicalId: string, ip: string) {
  const duplicates = db
    .query<{ id: string }, [string, string]>("select id from peers where last_ip = ? and id != ?")
    .all(ip, canonicalId);
  if (!duplicates.length) return;
  const tx = db.transaction(() => {
    for (const peer of duplicates) {
      db.query("update messages set sender_peer_id = ? where sender_peer_id = ?").run(canonicalId, peer.id);
      db.query("update file_offers set sender_peer_id = ? where sender_peer_id = ?").run(canonicalId, peer.id);
      db.query("update file_offers set receiver_peer_id = ? where receiver_peer_id = ?").run(canonicalId, peer.id);
      db.query("delete from peers where id = ?").run(peer.id);
    }
  });
  tx();
}

function mergeDuplicatePeersByIp() {
  const duplicateIps = db
    .query<{ last_ip: string }, []>("select last_ip from peers group by last_ip having count(*) > 1")
    .all();
  for (const item of duplicateIps) {
    const canonical = db
      .query<{ id: string }, [string]>("select id from peers where last_ip = ? order by last_seen_at desc limit 1")
      .get(item.last_ip);
    if (canonical) mergePeersByIp(canonical.id, item.last_ip);
  }
}

export function touchPeer(id: string) {
  db.query("update peers set last_seen_at = ? where id = ?").run(Date.now(), id);
}

export function getPeer(id: string): Peer | undefined {
  const row = db
    .query<{ id: string; nickname: string; last_ip: string; user_agent: string; last_seen_at: number }, [string]>(
      "select id, nickname, last_ip, user_agent, last_seen_at from peers where id = ?",
    )
    .get(id);
  if (!row) return undefined;
  return {
    id: row.id,
    nickname: row.nickname,
    ip: row.last_ip,
    userAgent: row.user_agent,
    online: false,
    lastSeenAt: row.last_seen_at,
  };
}

export function createTextMessage(input: { senderPeerId: string; senderIp: string; body: string }): ChatMessage {
  const peer = getPeer(input.senderPeerId);
  const message: ChatMessage = {
    id: crypto.randomUUID(),
    kind: "text",
    senderPeerId: input.senderPeerId,
    senderNickname: peer?.nickname,
    senderIp: input.senderIp,
    body: input.body,
    createdAt: Date.now(),
  };
  db.query(
    "insert into messages(id, kind, sender_peer_id, sender_ip, body, created_at) values(?, ?, ?, ?, ?, ?)",
  ).run(message.id, message.kind, message.senderPeerId, message.senderIp, message.body ?? null, message.createdAt);
  trimHistory();
  return message;
}

export function createFileMessage(input: {
  senderPeerId: string;
  senderIp: string;
  name: string;
  size: number;
  mime: string;
  previewDataUrl?: string;
}) {
  const now = Date.now();
  const peer = getPeer(input.senderPeerId);
  const offer: FileOffer = {
    id: crypto.randomUUID(),
    senderPeerId: input.senderPeerId,
    name: input.name,
    size: input.size,
    mime: input.mime,
    previewDataUrl: input.previewDataUrl,
    status: "available",
    expiresAt: now + 30 * 60 * 1000,
    createdAt: now,
    updatedAt: now,
  };
  const message: ChatMessage = {
    id: crypto.randomUUID(),
    kind: "file",
    senderPeerId: input.senderPeerId,
    senderNickname: peer?.nickname,
    senderIp: input.senderIp,
    fileOfferId: offer.id,
    fileOffer: offer,
    createdAt: now,
  };
  const tx = db.transaction(() => {
    db.query(`
      insert into file_offers(id, sender_peer_id, name, size, mime, preview_data_url, status, expires_at, created_at, updated_at)
      values(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      offer.id,
      offer.senderPeerId,
      offer.name,
      offer.size,
      offer.mime,
      offer.previewDataUrl ?? null,
      offer.status,
      offer.expiresAt,
      offer.createdAt,
      offer.updatedAt,
    );
    db.query(
      "insert into messages(id, kind, sender_peer_id, sender_ip, file_offer_id, created_at) values(?, ?, ?, ?, ?, ?)",
    ).run(message.id, message.kind, message.senderPeerId, message.senderIp, offer.id, message.createdAt);
  });
  tx();
  trimHistory();
  return { message, offer };
}

export function getFileOffer(id: string): FileOffer | undefined {
  const row = db.query<FileOfferRow, [string]>("select * from file_offers where id = ?").get(id);
  return row ? mapOffer(row) : undefined;
}

export function updateFileOffer(id: string, patch: Partial<Pick<FileOffer, "status" | "receiverPeerId">>) {
  const current = getFileOffer(id);
  if (!current) return undefined;
  const next: FileOffer = { ...current, ...patch, updatedAt: Date.now() };
  db.query("update file_offers set status = ?, receiver_peer_id = ?, updated_at = ? where id = ?").run(
    next.status,
    next.receiverPeerId ?? null,
    next.updatedAt,
    id,
  );
  return next;
}

export function deleteMessage(id: string) {
  const row = db.query<{ file_offer_id: string | null }, [string]>("select file_offer_id from messages where id = ?").get(id);
  if (!row) return false;
  const tx = db.transaction(() => {
    db.query("delete from messages where id = ?").run(id);
    if (row.file_offer_id) db.query("delete from file_offers where id = ?").run(row.file_offer_id);
  });
  tx();
  return true;
}

export function expireOffersForPeer(peerId: string) {
  const now = Date.now();
  const rows = db
    .query<FileOfferRow, [string]>(
      "select * from file_offers where sender_peer_id = ? and status in ('available', 'transferring')",
    )
    .all(peerId);
  db.query(
    "update file_offers set status = 'sender_offline', updated_at = ? where sender_peer_id = ? and status in ('available', 'transferring')",
  ).run(now, peerId);
  return rows.map((row) => ({ ...mapOffer(row), status: "sender_offline" as const, updatedAt: now }));
}

export function expireStaleOffersForPeer(peerId: string) {
  const now = Date.now();
  const rows = db
    .query<FileOfferRow, [string]>(
      "select * from file_offers where sender_peer_id = ? and status in ('available', 'transferring')",
    )
    .all(peerId);
  db.query(
    "update file_offers set status = 'expired', updated_at = ? where sender_peer_id = ? and status in ('available', 'transferring')",
  ).run(now, peerId);
  return rows.map((row) => ({ ...mapOffer(row), status: "expired" as const, updatedAt: now }));
}

export function expireOldOffers() {
  const now = Date.now();
  const rows = db
    .query<FileOfferRow, [number]>(
      "select * from file_offers where expires_at < ? and status in ('available', 'transferring', 'failed')",
    )
    .all(now);
  db.query(
    "update file_offers set status = 'expired', updated_at = ? where expires_at < ? and status in ('available', 'transferring', 'failed')",
  ).run(now, now);
  return rows.map((row) => ({ ...mapOffer(row), status: "expired" as const, updatedAt: now }));
}

export function hasActiveTransfer(peerId: string) {
  const row = db
    .query<{ id: string }, [string, string]>(
      "select id from file_offers where status = 'transferring' and (sender_peer_id = ? or receiver_peer_id = ?) limit 1",
    )
    .get(peerId, peerId);
  return Boolean(row);
}

export function getMessagesForDay(dayStart: number, dayEnd: number): ChatMessage[] {
  const rows = db
    .query<MessageRow & Partial<FileOfferRow>, [number, number]>(`
      select
        m.id as message_id,
        m.kind,
        m.sender_peer_id as message_sender_peer_id,
        p.nickname as sender_nickname,
        m.sender_ip,
        m.body,
        m.file_offer_id,
        m.created_at as message_created_at,
        f.*
      from messages m
      left join peers p on p.id = m.sender_peer_id
      left join file_offers f on f.id = m.file_offer_id
      where m.created_at >= ? and m.created_at < ?
      order by m.created_at asc
    `)
    .all(dayStart, dayEnd);
  return rows.map(mapMessage);
}

export function hasMessagesBefore(before: number, after: number) {
  const row = db
    .query<{ id: string }, [number, number]>(
      "select id from messages where created_at < ? and created_at >= ? limit 1",
    )
    .get(before, after);
  return Boolean(row);
}

function trimHistory() {
  const cutoff = Date.now() - 30 * 24 * 60 * 60 * 1000;
  db.query("delete from messages where created_at < ?").run(cutoff);
  db.query(`
    delete from messages
    where id not in (
      select id from messages order by created_at desc limit 1000
    )
  `).run();
  db.query(`
    delete from file_offers
    where id not in (
      select file_offer_id from messages where file_offer_id is not null
    )
  `).run();
}

const nicknameWords = [
  "Pebble",
  "Mochi",
  "Maple",
  "Cloud",
  "Button",
  "Cookie",
  "Rocket",
  "Pixel",
  "Walnut",
  "Clover",
  "Biscuit",
  "Marble",
  "Ribbon",
  "Pocket",
];

function nextNickname() {
  const used = new Set(db.query<{ nickname: string }, []>("select nickname from peers").all().map((row) => row.nickname));
  const available = nicknameWords.find((word) => !used.has(word));
  if (available) return available;
  return `${nicknameWords[Math.floor(Math.random() * nicknameWords.length)]}-${crypto.randomUUID().slice(0, 4)}`;
}

type FileOfferRow = {
  id: string;
  sender_peer_id: string;
  receiver_peer_id: string | null;
  name: string;
  size: number;
  mime: string;
  preview_data_url: string | null;
  status: FileOffer["status"];
  expires_at: number;
  created_at: number;
  updated_at: number;
};

type MessageRow = {
  message_id: string;
  kind: ChatMessage["kind"];
  message_sender_peer_id: string;
  sender_nickname: string | null;
  sender_ip: string;
  body: string | null;
  file_offer_id: string | null;
  message_created_at: number;
};

function mapOffer(row: FileOfferRow): FileOffer {
  return {
    id: row.id,
    senderPeerId: row.sender_peer_id,
    receiverPeerId: row.receiver_peer_id ?? undefined,
    name: row.name,
    size: row.size,
    mime: row.mime,
    previewDataUrl: row.preview_data_url ?? undefined,
    status: row.status,
    expiresAt: row.expires_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapMessage(row: MessageRow & Partial<FileOfferRow>): ChatMessage {
  const fileOffer = row.file_offer_id && row.id ? mapOffer(row as FileOfferRow) : undefined;
  return {
    id: row.message_id,
    kind: row.kind,
    senderPeerId: row.message_sender_peer_id,
    senderNickname: row.sender_nickname ?? undefined,
    senderIp: row.sender_ip,
    body: row.body ?? undefined,
    fileOfferId: row.file_offer_id ?? undefined,
    fileOffer,
    createdAt: row.message_created_at,
  };
}
