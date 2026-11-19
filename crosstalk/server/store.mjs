// SQLite storage (node:sqlite, built into Node 22.13+). One file, WAL mode, no dependencies.
//
// People, agents and rooms are small and hot, so the hub keeps them in memory and writes
// through to SQLite on every change. Messages are large and only live in SQLite.
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const MIGRATIONS = [
  `CREATE TABLE users (
     id TEXT PRIMARY KEY,
     handle TEXT NOT NULL UNIQUE,
     name TEXT NOT NULL,
     email TEXT,
     image_url TEXT,
     clerk_id TEXT UNIQUE,
     token_hash TEXT UNIQUE,
     created_at INTEGER NOT NULL,
     profile_synced_at INTEGER
   );
   CREATE TABLE agents (
     id TEXT PRIMARY KEY,
     handle TEXT NOT NULL UNIQUE,
     name TEXT NOT NULL,
     runtime TEXT NOT NULL,
     description TEXT NOT NULL DEFAULT '',
     visibility TEXT NOT NULL,
     owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
     token_hash TEXT NOT NULL UNIQUE,
     token_issued_at INTEGER,
     created_at INTEGER NOT NULL,
     last_connected_at INTEGER,
     last_seen_at INTEGER,
     bridge_json TEXT
   );
   CREATE TABLE rooms (
     id TEXT PRIMARY KEY,
     name TEXT NOT NULL,
     slug TEXT NOT NULL,
     topic TEXT NOT NULL DEFAULT '',
     kind TEXT NOT NULL,
     visibility TEXT NOT NULL,
     dm_key TEXT UNIQUE,
     created_by TEXT,
     created_at INTEGER NOT NULL,
     last_message_at INTEGER
   );
   CREATE UNIQUE INDEX rooms_slug ON rooms(slug) WHERE kind = 'room';
   CREATE TABLE members (
     room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
     kind TEXT NOT NULL,
     member_id TEXT NOT NULL,
     joined_at INTEGER NOT NULL,
     PRIMARY KEY (room_id, kind, member_id)
   );
   CREATE INDEX members_by_member ON members(kind, member_id);
   CREATE TABLE messages (
     seq INTEGER PRIMARY KEY AUTOINCREMENT,
     id TEXT NOT NULL UNIQUE,
     room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
     sender_kind TEXT NOT NULL,
     sender_id TEXT NOT NULL,
     text TEXT NOT NULL,
     mentions_json TEXT NOT NULL DEFAULT '[]',
     reply_to TEXT,
     depth INTEGER NOT NULL DEFAULT 0,
     created_at INTEGER NOT NULL,
     deleted_at INTEGER
   );
   CREATE INDEX messages_room ON messages(room_id, seq);
   CREATE INDEX messages_reply ON messages(reply_to);`,
];

const userFromRow = (r) => ({
  id: r.id,
  handle: r.handle,
  name: r.name,
  email: r.email ?? null,
  imageUrl: r.image_url ?? null,
  clerkId: r.clerk_id ?? null,
  tokenHash: r.token_hash ?? null,
  createdAt: r.created_at,
  profileSyncedAt: r.profile_synced_at ?? null,
});
const agentFromRow = (r) => ({
  id: r.id,
  handle: r.handle,
  name: r.name,
  runtime: r.runtime,
  description: r.description,
  visibility: r.visibility,
  ownerId: r.owner_id,
  tokenHash: r.token_hash,
  tokenIssuedAt: r.token_issued_at ?? null,
  createdAt: r.created_at,
  lastConnectedAt: r.last_connected_at ?? null,
  lastSeenAt: r.last_seen_at ?? null,
  bridge: r.bridge_json ? JSON.parse(r.bridge_json) : null,
});
const messageFromRow = (r) =>
  r && {
    seq: r.seq,
    id: r.id,
    roomId: r.room_id,
    sender: { kind: r.sender_kind, id: r.sender_id },
    text: r.text,
    mentions: JSON.parse(r.mentions_json),
    replyTo: r.reply_to ?? null,
    depth: r.depth,
    createdAt: r.created_at,
    deletedAt: r.deleted_at ?? null,
  };

/** file: path to the database, or ':memory:' (tests). */
export function createStore(file = ':memory:') {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
  const version = db.prepare('PRAGMA user_version').get().user_version;
  for (let v = version; v < MIGRATIONS.length; v++) {
    db.exec('BEGIN');
    try {
      db.exec(MIGRATIONS[v]);
      db.exec(`PRAGMA user_version = ${v + 1}`);
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
  }
  if (file !== ':memory:') {
    try {
      fs.chmodSync(file, 0o600);
    } catch { /* not fatal */ }
  }

  let closed = false;
  const q = (sql) => db.prepare(sql);
  const stmt = {
    upsertUser: q(`INSERT INTO users (id, handle, name, email, image_url, clerk_id, token_hash, created_at, profile_synced_at)
      VALUES (:id, :handle, :name, :email, :imageUrl, :clerkId, :tokenHash, :createdAt, :profileSyncedAt)
      ON CONFLICT(id) DO UPDATE SET handle=excluded.handle, name=excluded.name, email=excluded.email, image_url=excluded.image_url,
        clerk_id=excluded.clerk_id, token_hash=excluded.token_hash, profile_synced_at=excluded.profile_synced_at`),
    upsertAgent: q(`INSERT INTO agents (id, handle, name, runtime, description, visibility, owner_id, token_hash, token_issued_at, created_at, last_connected_at, last_seen_at, bridge_json)
      VALUES (:id, :handle, :name, :runtime, :description, :visibility, :ownerId, :tokenHash, :tokenIssuedAt, :createdAt, :lastConnectedAt, :lastSeenAt, :bridgeJson)
      ON CONFLICT(id) DO UPDATE SET handle=excluded.handle, name=excluded.name, runtime=excluded.runtime, description=excluded.description,
        visibility=excluded.visibility, token_hash=excluded.token_hash, token_issued_at=excluded.token_issued_at,
        last_connected_at=excluded.last_connected_at, last_seen_at=excluded.last_seen_at, bridge_json=excluded.bridge_json`),
    deleteAgent: q('DELETE FROM agents WHERE id = ?'),
    deleteAgentMemberships: q("DELETE FROM members WHERE kind = 'agent' AND member_id = ?"),
    upsertRoom: q(`INSERT INTO rooms (id, name, slug, topic, kind, visibility, dm_key, created_by, created_at, last_message_at)
      VALUES (:id, :name, :slug, :topic, :kind, :visibility, :dmKey, :createdBy, :createdAt, :lastMessageAt)
      ON CONFLICT(id) DO UPDATE SET name=excluded.name, slug=excluded.slug, topic=excluded.topic, visibility=excluded.visibility,
        last_message_at=excluded.last_message_at`),
    addMember: q('INSERT OR IGNORE INTO members (room_id, kind, member_id, joined_at) VALUES (?, ?, ?, ?)'),
    removeMember: q('DELETE FROM members WHERE room_id = ? AND kind = ? AND member_id = ?'),
    insertMessage: q(`INSERT INTO messages (id, room_id, sender_kind, sender_id, text, mentions_json, reply_to, depth, created_at)
      VALUES (:id, :roomId, :senderKind, :senderId, :text, :mentionsJson, :replyTo, :depth, :createdAt)`),
    touchRoom: q('UPDATE rooms SET last_message_at = ? WHERE id = ?'),
    messageById: q('SELECT * FROM messages WHERE id = ?'),
    latest: q('SELECT * FROM (SELECT * FROM messages WHERE room_id = ? ORDER BY seq DESC LIMIT ?) ORDER BY seq'),
    before: q('SELECT * FROM (SELECT * FROM messages WHERE room_id = ? AND seq < ? ORDER BY seq DESC LIMIT ?) ORDER BY seq'),
    after: q('SELECT * FROM messages WHERE room_id = ? AND seq > ? ORDER BY seq LIMIT ?'),
    replyFrom: q("SELECT * FROM messages WHERE reply_to = ? AND sender_kind = 'agent' AND (? IS NULL OR sender_id = ?) AND deleted_at IS NULL ORDER BY seq LIMIT 1"),
    deleteMessage: q("UPDATE messages SET text = '', mentions_json = '[]', deleted_at = ? WHERE id = ?"),
    search: q("SELECT * FROM messages WHERE room_id = ? AND deleted_at IS NULL AND sender_kind != 'system' AND instr(lower(text), lower(?)) > 0 ORDER BY seq DESC LIMIT ?"),
    mentions: q(`SELECT m.*, r.name AS room_name FROM messages m
      JOIN members mb ON mb.room_id = m.room_id AND mb.kind = :kind AND mb.member_id = :id
      JOIN rooms r ON r.id = m.room_id
      WHERE m.seq > :afterSeq AND m.deleted_at IS NULL AND m.sender_kind != 'system'
        AND NOT (m.sender_kind = :kind AND m.sender_id = :id)
        AND (r.kind = 'dm' OR instr(m.mentions_json, :needle) > 0)
      ORDER BY m.seq DESC LIMIT :limit`),
  };

  function loadAll() {
    const users = q('SELECT * FROM users').all().map(userFromRow);
    const agents = q('SELECT * FROM agents').all().map(agentFromRow);
    const byRoom = new Map();
    for (const m of q('SELECT * FROM members ORDER BY joined_at').all()) {
      if (!byRoom.has(m.room_id)) byRoom.set(m.room_id, []);
      byRoom.get(m.room_id).push({ kind: m.kind, id: m.member_id });
    }
    const rooms = q('SELECT * FROM rooms').all().map((r) => ({
      id: r.id,
      name: r.name,
      slug: r.slug,
      topic: r.topic,
      kind: r.kind,
      visibility: r.visibility,
      dmKey: r.dm_key ?? null,
      createdBy: r.created_by ?? null,
      createdAt: r.created_at,
      lastMessageAt: r.last_message_at ?? null,
      members: byRoom.get(r.id) ?? [],
    }));
    return { users, agents, rooms };
  }

  return {
    loadAll,
    saveUser(u) {
      stmt.upsertUser.run({ id: u.id, handle: u.handle, name: u.name, email: u.email ?? null, imageUrl: u.imageUrl ?? null, clerkId: u.clerkId ?? null, tokenHash: u.tokenHash ?? null, createdAt: u.createdAt, profileSyncedAt: u.profileSyncedAt ?? null });
    },
    saveAgent(a) {
      if (closed) return; // late writes during shutdown (e.g. a bridge disconnecting) are dropped
      stmt.upsertAgent.run({
        id: a.id, handle: a.handle, name: a.name, runtime: a.runtime, description: a.description ?? '', visibility: a.visibility,
        ownerId: a.ownerId, tokenHash: a.tokenHash, tokenIssuedAt: a.tokenIssuedAt ?? null, createdAt: a.createdAt,
        lastConnectedAt: a.lastConnectedAt ?? null, lastSeenAt: a.lastSeenAt ?? null, bridgeJson: a.bridge ? JSON.stringify(a.bridge) : null,
      });
    },
    deleteAgent(id) {
      db.exec('BEGIN');
      try {
        stmt.deleteAgentMemberships.run(id);
        stmt.deleteAgent.run(id);
        db.exec('COMMIT');
      } catch (e) {
        db.exec('ROLLBACK');
        throw e;
      }
    },
    saveRoom(r) {
      stmt.upsertRoom.run({ id: r.id, name: r.name, slug: r.slug, topic: r.topic ?? '', kind: r.kind, visibility: r.visibility, dmKey: r.dmKey ?? null, createdBy: r.createdBy ?? null, createdAt: r.createdAt, lastMessageAt: r.lastMessageAt ?? null });
    },
    addMember(roomId, kind, id, at) {
      stmt.addMember.run(roomId, kind, id, at);
    },
    removeMember(roomId, kind, id) {
      stmt.removeMember.run(roomId, kind, id);
    },
    insertMessage(m) {
      stmt.insertMessage.run({ id: m.id, roomId: m.roomId, senderKind: m.sender.kind, senderId: m.sender.id, text: m.text, mentionsJson: JSON.stringify(m.mentions ?? []), replyTo: m.replyTo ?? null, depth: m.depth ?? 0, createdAt: m.createdAt });
      stmt.touchRoom.run(m.createdAt, m.roomId);
      return messageFromRow(stmt.messageById.get(m.id));
    },
    messageById: (id) => messageFromRow(stmt.messageById.get(id)) ?? null,
    latestMessages: (roomId, limit) => stmt.latest.all(roomId, limit).map(messageFromRow),
    messagesBefore: (roomId, seq, limit) => stmt.before.all(roomId, seq, limit).map(messageFromRow),
    messagesAfter: (roomId, seq, limit) => stmt.after.all(roomId, seq, limit).map(messageFromRow),
    searchMessages: (roomId, term, limit) => stmt.search.all(roomId, term, limit).map(messageFromRow),
    firstAgentReply: (messageId, agentId = null) => messageFromRow(stmt.replyFrom.get(messageId, agentId, agentId)) ?? null,
    deleteMessage(id, at) {
      stmt.deleteMessage.run(at, id);
    },
    mentionsFor(kind, id, handle, { afterSeq = 0, limit = 20 } = {}) {
      return stmt.mentions
        .all({ kind, id, afterSeq, needle: JSON.stringify(handle), limit })
        .reverse()
        .map((r) => ({ ...messageFromRow(r), roomName: r.room_name }));
    },
    ping() {
      return q('SELECT 1 AS ok').get().ok === 1;
    },
    close() {
      if (closed) return;
      closed = true;
      db.close();
    },
  };
}
