import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";

export type AppDatabase = Database;

export function openDatabase(
  path = join(process.cwd(), "data", "quick-send.sqlite")
) {
  mkdirSync(dirname(path), { recursive: true });
  const database = new Database(path, { create: true });
  database.exec("pragma journal_mode = WAL");
  database.exec("pragma foreign_keys = ON");
  migrate(database);
  expireUnrecoverableOffers(database);
  return database;
}

function migrate(database: Database) {
  database.exec(`
    create table if not exists schema_migrations (
      version integer primary key,
      applied_at integer not null
    )
  `);
  const current =
    database
      .query<{ version: number }, []>(
        "select version from schema_migrations order by version desc limit 1"
      )
      .get()?.version ?? 0;
  if (current >= 1) {
    return;
  }
  database.transaction(() => {
    for (const table of [
      "sessions",
      "peers",
      "messages",
      "file_offers",
      "config",
    ]) {
      database.exec(`drop table if exists ${table}`);
    }
    database.exec(`
      create table users (
        id text primary key,
        username text not null collate nocase unique,
        avatar_seed text not null,
        device_kind text not null,
        totp_ciphertext text not null,
        created_at integer not null
      );

      create table credentials (
        id text primary key,
        user_id text not null unique references users(id) on delete cascade,
        token_hash text not null unique,
        created_at integer not null,
        last_used_at integer not null
      );

      create table recovery_codes (
        user_id text primary key references users(id) on delete cascade,
        code_hash text not null,
        created_at integer not null
      );

      create table rooms (
        id text primary key,
        name text not null,
        creator_id text not null references users(id),
        created_at integer not null
      );

      create table room_members (
        room_id text not null references rooms(id) on delete cascade,
        user_id text not null references users(id) on delete cascade,
        joined_at integer not null,
        primary key(room_id, user_id)
      );

      create table join_requests (
        id text primary key,
        room_id text not null references rooms(id) on delete cascade,
        requester_id text not null references users(id) on delete cascade,
        status text not null,
        created_at integer not null,
        resolved_at integer,
        unique(room_id, requester_id)
      );

      create table file_offers (
        id text primary key,
        room_id text not null references rooms(id) on delete cascade,
        sender_user_id text not null references users(id),
        sender_socket_id text not null,
        receiver_user_id text references users(id),
        name text not null,
        size integer not null,
        mime text not null,
        preview_data_url text,
        status text not null,
        expires_at integer not null,
        created_at integer not null,
        updated_at integer not null
      );

      create table messages (
        id text primary key,
        room_id text not null references rooms(id) on delete cascade,
        sender_user_id text not null references users(id),
        client_message_id text not null,
        kind text not null,
        body text,
        file_offer_id text references file_offers(id) on delete cascade,
        created_at integer not null,
        unique(sender_user_id, client_message_id)
      );

      create table audit_logs (
        id text primary key,
        actor_user_id text references users(id) on delete set null,
        room_id text references rooms(id) on delete set null,
        room_name_snapshot text,
        action text not null,
        created_at integer not null
      );

      create index messages_room_cursor_idx
        on messages(room_id, created_at desc, id desc);
      create index requests_room_status_idx
        on join_requests(room_id, status);
      create index offers_sender_status_idx
        on file_offers(sender_user_id, status);
    `);
    database
      .query("insert into schema_migrations(version, applied_at) values(1, ?)")
      .run(Date.now());
  })();
}

function expireUnrecoverableOffers(database: Database) {
  database
    .query(
      `update file_offers
       set status = 'sender_offline', updated_at = ?
       where status in ('available', 'transferring')`
    )
    .run(Date.now());
}

export function checkpointAndClose(database: Database) {
  database.exec("pragma wal_checkpoint(TRUNCATE)");
  database.close();
}
