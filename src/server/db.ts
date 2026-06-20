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
  if (current < 1) {
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
        fingerprint_hash text unique,
        created_at integer not null
      );

      create table credentials (
        id text primary key,
        user_id text not null unique references users(id) on delete cascade,
        token_hash text not null unique,
        created_at integer not null,
        last_used_at integer not null
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
        .query(
          "insert into schema_migrations(version, applied_at) values(1, ?)"
        )
        .run(Date.now());
    })();
  }
  if (current < 2) {
    migrateIdentityToV2(database);
    database
      .query("insert into schema_migrations(version, applied_at) values(2, ?)")
      .run(Date.now());
  }
  if (current < 3) {
    pruneLegacyIdentityData(database);
    database
      .query("insert into schema_migrations(version, applied_at) values(3, ?)")
      .run(Date.now());
  }
  if (current < 4) {
    pruneOrphanedData(database);
    database
      .query("insert into schema_migrations(version, applied_at) values(4, ?)")
      .run(Date.now());
  }
  if (current < 5) {
    migrateFileCache(database);
    database
      .query("insert into schema_migrations(version, applied_at) values(5, ?)")
      .run(Date.now());
  }
  if (current < 6) {
    database.exec(
      "alter table users add column device_name text not null default 'Unknown device'"
    );
    database
      .query("insert into schema_migrations(version, applied_at) values(6, ?)")
      .run(Date.now());
  }
}

function migrateIdentityToV2(database: Database) {
  const columns = database
    .query<{ name: string }, []>("pragma table_info(users)")
    .all()
    .map((column) => column.name);
  if (!columns.includes("fingerprint_hash")) {
    database.exec("alter table users add column fingerprint_hash text");
  }
  database.exec(
    "create unique index if not exists users_fingerprint_hash_idx on users(fingerprint_hash)"
  );
  database.exec("drop table if exists recovery_codes");
}

function pruneLegacyIdentityData(database: Database) {
  database.transaction(() => {
    database.exec(`
      delete from rooms
      where creator_id in (
        select id from users where fingerprint_hash is null
      );

      delete from file_offers
      where sender_user_id in (
        select id from users where fingerprint_hash is null
      )
      or receiver_user_id in (
        select id from users where fingerprint_hash is null
      );

      delete from messages
      where sender_user_id in (
        select id from users where fingerprint_hash is null
      );

      delete from join_requests
      where requester_id in (
        select id from users where fingerprint_hash is null
      );

      delete from room_members
      where user_id in (
        select id from users where fingerprint_hash is null
      );

      delete from credentials
      where user_id in (
        select id from users where fingerprint_hash is null
      );

      delete from users
      where fingerprint_hash is null;
    `);
  })();
}

function pruneOrphanedData(database: Database) {
  database.transaction(() => {
    database.exec(`
      delete from room_members
      where room_id not in (select id from rooms)
      or user_id not in (select id from users);

      delete from credentials
      where user_id not in (select id from users);

      update audit_logs
      set actor_user_id = null
      where actor_user_id not in (select id from users);
    `);
  })();
}

function migrateFileCache(database: Database) {
  database.transaction(() => {
    database.exec(`
      delete from messages where kind = 'file';

      create table messages_v5 (
        id text primary key,
        room_id text not null references rooms(id) on delete cascade,
        sender_user_id text not null references users(id),
        client_message_id text not null,
        kind text not null,
        body text,
        created_at integer not null,
        unique(sender_user_id, client_message_id)
      );

      insert into messages_v5(
        id, room_id, sender_user_id, client_message_id, kind, body, created_at
      )
      select id, room_id, sender_user_id, client_message_id, kind, body, created_at
      from messages;

      drop table messages;
      alter table messages_v5 rename to messages;
      drop table file_offers;

      create table server_files (
        id text primary key,
        sha256 text not null,
        size integer not null,
        storage_path text not null unique,
        created_at integer not null
      );

      create table message_files (
        message_id text primary key references messages(id) on delete cascade,
        file_id text not null references server_files(id),
        name text not null,
        mime text not null,
        size integer not null,
        preview_data_url text,
        expires_at integer not null
      );

      create index messages_room_cursor_idx
        on messages(room_id, created_at desc, id desc);
      create index message_files_expiry_idx
        on message_files(expires_at);
      create index message_files_file_idx
        on message_files(file_id);
    `);
  })();
}

export function checkpointAndClose(database: Database) {
  database.exec("pragma wal_checkpoint(TRUNCATE)");
  database.close();
}
