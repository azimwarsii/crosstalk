// The hub: people, agents, rooms, messages, and the rules for who wakes up when.
// Transport-free (no HTTP here) so it is easy to test. Persistence goes through ./store.mjs.
import crypto from 'node:crypto';

export class HubError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const HANDLE_RE = /^[a-z0-9][a-z0-9_-]{1,31}$/;
const RESERVED = new Set(['crosstalk', 'system', 'all', 'here', 'everyone', 'channel', 'admin', 'support', 'help']);
const MAX_TEXT = 20000;
const RUNTIMES = ['claude-code', 'codex', 'other'];
const BRIDGE_FIELDS = ['adapter', 'version', 'host', 'platform', 'cwd', 'managed'];
export const DEFAULT_ROOM = { slug: 'general', topic: 'Say hi. Mention any agent with @handle to wake it up.' };

export const newId = (prefix) => `${prefix}_${crypto.randomBytes(9).toString('base64url')}`;
export const hashToken = (t) => crypto.createHash('sha256').update(String(t)).digest('hex');
const newToken = (kind) => `ct_${kind}_${crypto.randomBytes(24).toString('base64url')}`;

export function slugify(s) {
  return String(s ?? '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^[-_]+|[-_]+$/g, '')
    .slice(0, 32);
}

/** @handles in text, ignoring code blocks, inline code, emails and URLs. */
export function parseMentions(text) {
  const plain = String(text ?? '')
    .replace(/```[\s\S]*?(```|$)/g, ' ')
    .replace(/`[^`\n]*`/g, ' ');
  const out = [];
  const re = /(^|[^\w@./])@([a-z0-9][a-z0-9_-]{0,31})/gi;
  let m;
  while ((m = re.exec(plain))) {
    const h = m[2].toLowerCase().replace(/[-_]+$/, '');
    if (h.length >= 2 && !out.includes(h)) out.push(h);
  }
  return out;
}

export function createHub({
  store,
  maxDepth = 6,
  agentMessagesPerMinute = 40,
  contextSize = 20,
  now = () => Date.now(),
} = {}) {
  const loaded = store.loadAll();
  const users = new Map(loaded.users.map((u) => [u.id, u]));
  const agents = new Map(loaded.agents.map((a) => [a.id, a]));
  const rooms = new Map(loaded.rooms.map((r) => [r.id, r]));
  const handles = new Map(); // handle -> {kind, id}
  const userTokens = new Map(); // tokenHash -> userId (dev sign-in only)
  const agentTokens = new Map(); // tokenHash -> agentId
  const clerkUsers = new Map(); // clerkId -> userId
  for (const u of users.values()) {
    handles.set(u.handle, { kind: 'user', id: u.id });
    if (u.tokenHash) userTokens.set(u.tokenHash, u.id);
    if (u.clerkId) clerkUsers.set(u.clerkId, u.id);
  }
  for (const a of agents.values()) {
    handles.set(a.handle, { kind: 'agent', id: a.id });
    agentTokens.set(a.tokenHash, a.id);
  }
  const memberKeys = new Map(); // roomId -> Set("kind:id")
  for (const r of rooms.values()) memberKeys.set(r.id, new Set(r.members.map((m) => `${m.kind}:${m.id}`)));

  /** key "user:<id>" | "agent:<id>" -> Set<{send, close}> */
  const conns = new Map();
  const pending = new Map(); // agentId -> trigger envelopes waiting for its bridge
  const triggerDepth = new Map(); // "<agentId>:<roomId>" -> depth of the message that last woke it
  const waiters = new Map(); // messageId -> Set<{match, done}>
  const statuses = new Map(); // agentId -> {roomId, state, detail, at}
  const agentRate = new Map(); // roomId -> timestamps of agent-triggered wake-ups
  const notices = new Map();

  const pkey = (kind, id) => `${kind}:${id}`;
  const agentByHandle = (h) => {
    const e = handles.get(h);
    return e?.kind === 'agent' ? agents.get(e.id) : undefined;
  };
  const userByHandle = (h) => {
    const e = handles.get(h);
    return e?.kind === 'user' ? users.get(e.id) : undefined;
  };
  const handleTaken = (h) => RESERVED.has(h) || handles.has(h);
  const isOnline = (agentId) => (conns.get(pkey('agent', agentId))?.size ?? 0) > 0;
  const isMember = (room, kind, id) => memberKeys.get(room.id)?.has(`${kind}:${id}`) ?? false;

  function addMemberTo(room, kind, id) {
    if (isMember(room, kind, id)) return false;
    room.members.push({ kind, id });
    memberKeys.get(room.id).add(`${kind}:${id}`);
    store.addMember(room.id, kind, id, now());
    return true;
  }
  function removeMemberFrom(room, kind, id) {
    if (!isMember(room, kind, id)) return false;
    room.members = room.members.filter((m) => !(m.kind === kind && m.id === id));
    memberKeys.get(room.id).delete(`${kind}:${id}`);
    store.removeMember(room.id, kind, id);
    return true;
  }
  function uniqueHandle(base) {
    base = slugify(base) || 'user';
    let h = base;
    for (let i = 2; handleTaken(h) || !HANDLE_RE.test(h); i++) h = `${base.slice(0, 28)}${i}`;
    return h;
  }

  // ---------- views (what leaves the hub) ----------
  function memberView(m) {
    if (m.kind === 'system') return { kind: 'system', id: 'system', handle: 'crosstalk', name: 'Crosstalk' };
    if (m.kind === 'user') {
      const u = users.get(m.id);
      return { kind: 'user', id: m.id, handle: u?.handle ?? 'deleted', name: u?.name ?? 'Deleted', imageUrl: u?.imageUrl ?? null, createdAt: u?.createdAt ?? null };
    }
    const a = agents.get(m.id);
    return { kind: 'agent', id: m.id, handle: a?.handle ?? 'deleted', name: a?.name ?? 'Deleted agent', runtime: a?.runtime, online: a ? isOnline(a.id) : false };
  }
  const userView = (u) => ({ kind: 'user', id: u.id, handle: u.handle, name: u.name, imageUrl: u.imageUrl ?? null, createdAt: u.createdAt });

  /** viewerId: the owner sees where the bridge runs and whether setup ever finished. */
  function agentView(a, viewerId = null) {
    const owner = users.get(a.ownerId);
    const view = {
      kind: 'agent',
      id: a.id,
      handle: a.handle,
      name: a.name,
      runtime: a.runtime,
      description: a.description,
      visibility: a.visibility,
      owner: owner ? userView(owner) : null,
      online: isOnline(a.id),
      status: statuses.get(a.id) ?? null,
      lastSeenAt: isOnline(a.id) ? now() : (a.lastSeenAt ?? null),
      createdAt: a.createdAt,
    };
    if (viewerId && viewerId === a.ownerId) {
      Object.assign(view, {
        setupDone: !!a.lastConnectedAt,
        lastConnectedAt: a.lastConnectedAt ?? null,
        bridge: a.bridge ?? null,
        tokenIssuedAt: a.tokenIssuedAt ?? a.createdAt,
      });
    }
    return view;
  }
  const roomView = (r) => ({
    id: r.id,
    name: r.name,
    slug: r.slug,
    topic: r.topic,
    kind: r.kind,
    visibility: r.visibility,
    createdBy: r.createdBy,
    members: r.members.map(memberView),
    createdAt: r.createdAt,
    lastMessageAt: r.lastMessageAt ?? r.createdAt,
  });
  const messageView = (m) => ({
    id: m.id,
    roomId: m.roomId,
    sender: memberView(m.sender),
    text: m.deletedAt ? '' : m.text,
    deleted: !!m.deletedAt,
    mentions: m.mentions ?? [],
    replyTo: m.replyTo ?? null,
    depth: m.depth ?? 0,
    createdAt: m.createdAt,
  });

  // ---------- realtime fan-out ----------
  function broadcastUsers(evt, filter = () => true) {
    for (const [key, set] of conns) {
      if (!key.startsWith('user:') || !filter(key.slice(5))) continue;
      for (const c of set) c.send(evt);
    }
  }
  const sendToUser = (userId, evt) => {
    for (const c of conns.get(pkey('user', userId)) ?? []) c.send(evt);
  };
  const roomAudience = (room) => (uid) =>
    isMember(room, 'user', uid) || (room.kind === 'room' && room.visibility === 'public');
  const broadcastRoom = (room, evt) => broadcastUsers(evt, roomAudience(room));
  const broadcastRoomUpdate = (room) => broadcastRoom(room, { type: 'room', room: roomView(room) });
  function broadcastAgent(a) {
    broadcastUsers({ type: 'agent', agent: agentView(a) }, (uid) => uid !== a.ownerId && a.visibility === 'public');
    sendToUser(a.ownerId, { type: 'agent', agent: agentView(a, a.ownerId) });
  }

  // ---------- auth ----------
  /** Our own bearer tokens: agent tokens always; person tokens only for dev sign-in. */
  function authenticate(token) {
    if (!token) return null;
    const h = hashToken(token);
    const aid = agentTokens.get(h);
    if (aid) return { kind: 'agent', id: aid, agent: agents.get(aid) };
    const uid = userTokens.get(h);
    if (uid) return { kind: 'user', id: uid, user: users.get(uid) };
    return null;
  }
  const principalForUser = (u) => ({ kind: 'user', id: u.id, user: u });

  function requireUser(p) {
    if (p?.kind !== 'user') throw new HubError(403, 'Only people can do this (that is an agent token).');
    return p.user;
  }
  function mustRoom(id) {
    const r = rooms.get(id);
    if (!r) throw new HubError(404, 'Room not found');
    return r;
  }
  function canRead(p, r) {
    return isMember(r, p.kind, p.id) || (p.kind === 'user' && r.kind === 'room' && r.visibility === 'public');
  }
  function me(p) {
    if (p.kind === 'user') {
      return { ...userView(p.user), email: p.user.email ?? null, agents: [...agents.values()].filter((a) => a.ownerId === p.id).map((a) => agentView(a, p.id)) };
    }
    return agentView(p.agent, p.agent.ownerId);
  }

  // ---------- people ----------
  function defaultRoom() {
    let room = [...rooms.values()].find((r) => r.kind === 'room' && r.slug === DEFAULT_ROOM.slug);
    if (!room) {
      room = { id: newId('room'), name: DEFAULT_ROOM.slug, slug: DEFAULT_ROOM.slug, topic: DEFAULT_ROOM.topic, kind: 'room', visibility: 'public', dmKey: null, createdBy: null, createdAt: now(), lastMessageAt: null, members: [] };
      rooms.set(room.id, room);
      memberKeys.set(room.id, new Set());
      store.saveRoom(room);
    }
    return room;
  }
  defaultRoom();

  function createUser({ name, handleHint, email = null, imageUrl = null, clerkId = null, tokenHash = null }) {
    name = String(name ?? '').trim().slice(0, 48) || 'New user';
    const user = { id: newId('usr'), handle: uniqueHandle(handleHint || name), name, email, imageUrl, clerkId, tokenHash, createdAt: now(), profileSyncedAt: clerkId ? now() : null };
    users.set(user.id, user);
    handles.set(user.handle, { kind: 'user', id: user.id });
    if (tokenHash) userTokens.set(tokenHash, user.id);
    if (clerkId) clerkUsers.set(clerkId, user.id);
    store.saveUser(user);
    const room = defaultRoom();
    addMemberTo(room, 'user', user.id);
    broadcastRoomUpdate(room);
    broadcastUsers({ type: 'person', person: userView(user) });
    return user;
  }

  /** Everyone on this hub (name, handle, picture; never email), for adding to rooms and DMs. */
  function listPeople(p) {
    if (p.kind !== 'user') throw new HubError(403, 'Only people can list people');
    return [...users.values()].map((u) => ({ ...userView(u), online: (conns.get(pkey('user', u.id))?.size ?? 0) > 0 })).sort((a, b) => a.name.localeCompare(b.name));
  }

  /** Dev sign-in (no identity provider). The server only exposes this when dev auth is on. */
  function signup(name) {
    if (!String(name ?? '').trim()) throw new HubError(400, 'Name is required');
    const token = newToken('user');
    const user = createUser({ name, tokenHash: hashToken(token) });
    return { user: userView(user), token };
  }

  /** Find or create the person behind a verified Clerk identity, refreshing their profile. */
  function upsertClerkUser(profile) {
    const existingId = clerkUsers.get(profile.clerkId);
    if (existingId) {
      const u = users.get(existingId);
      if (profile.synced) {
        u.name = String(profile.name || u.name).slice(0, 48);
        u.email = profile.email ?? u.email;
        u.imageUrl = profile.imageUrl ?? u.imageUrl;
        u.profileSyncedAt = now();
        store.saveUser(u);
      }
      return principalForUser(u);
    }
    const local = profile.email ? profile.email.split('@')[0] : '';
    const u = createUser({ name: profile.name || local || 'New user', handleHint: profile.username || profile.name || local, email: profile.email, imageUrl: profile.imageUrl, clerkId: profile.clerkId });
    return principalForUser(u);
  }
  const userByClerkId = (clerkId) => users.get(clerkUsers.get(clerkId));

  function updateMe(p, { name } = {}) {
    const u = requireUser(p);
    if (name !== undefined) {
      const n = String(name).trim().slice(0, 48);
      if (!n) throw new HubError(400, 'Name cannot be empty');
      u.name = n;
    }
    store.saveUser(u);
    for (const r of rooms.values()) if (isMember(r, 'user', u.id)) broadcastRoomUpdate(r);
    broadcastUsers({ type: 'person', person: userView(u) });
    return me(p);
  }

  // ---------- agents ----------
  function listAgents(p) {
    return [...agents.values()]
      .filter((a) => a.visibility === 'public' || (p.kind === 'user' && a.ownerId === p.id) || a.id === p.id)
      .map((a) => agentView(a, p.kind === 'user' ? p.id : null));
  }

  function getAgent(p, id) {
    const a = agents.get(id) ?? agentByHandle(String(id).replace(/^@/, '').toLowerCase());
    const visible = a && (a.visibility === 'public' || (p.kind === 'user' && a.ownerId === p.id) || a.id === p.id);
    if (!visible) throw new HubError(404, 'Agent not found');
    return agentView(a, p.kind === 'user' ? p.id : a.id === p.id ? a.ownerId : null);
  }

  function createAgent(p, { handle, name, runtime, description, visibility } = {}) {
    const owner = requireUser(p);
    const h = slugify(handle || name);
    if (!HANDLE_RE.test(h)) throw new HubError(400, 'Handle must be 2-32 characters: letters, numbers, - or _');
    if (handleTaken(h)) throw new HubError(409, `@${h} is taken`);
    if ([...agents.values()].filter((a) => a.ownerId === owner.id).length >= 50) throw new HubError(429, 'You can have at most 50 agents');
    const token = newToken('agent');
    const agent = {
      id: newId('agt'),
      handle: h,
      name: String(name ?? '').trim().slice(0, 48) || h,
      runtime: RUNTIMES.includes(runtime) ? runtime : 'other',
      description: String(description ?? '').trim().slice(0, 280),
      visibility: visibility === 'private' ? 'private' : 'public',
      ownerId: owner.id,
      tokenHash: hashToken(token),
      tokenIssuedAt: now(),
      createdAt: now(),
      lastConnectedAt: null,
      lastSeenAt: null,
      bridge: null,
    };
    agents.set(agent.id, agent);
    handles.set(h, { kind: 'agent', id: agent.id });
    agentTokens.set(agent.tokenHash, agent.id);
    store.saveAgent(agent);
    broadcastAgent(agent);
    return { agent: agentView(agent, owner.id), token };
  }

  function ownedAgent(p, id) {
    const owner = requireUser(p);
    const a = agents.get(id) ?? agentByHandle(String(id).replace(/^@/, '').toLowerCase());
    if (!a) throw new HubError(404, 'Agent not found');
    if (a.ownerId !== owner.id) throw new HubError(403, 'Only the agent’s owner can do this');
    return a;
  }

  function updateAgent(p, id, patch = {}) {
    const a = ownedAgent(p, id);
    if (patch.name !== undefined) a.name = String(patch.name).trim().slice(0, 48) || a.handle;
    if (patch.description !== undefined) a.description = String(patch.description).trim().slice(0, 280);
    if (patch.visibility !== undefined) a.visibility = patch.visibility === 'private' ? 'private' : 'public';
    if (patch.runtime !== undefined && RUNTIMES.includes(patch.runtime)) a.runtime = patch.runtime;
    store.saveAgent(a);
    broadcastAgent(a);
    return agentView(a, a.ownerId);
  }

  function dropConnections(kind, id) {
    for (const c of conns.get(pkey(kind, id)) ?? []) c.close();
    conns.delete(pkey(kind, id));
  }

  /** Give the agent a new token; the old one stops working and its bridge disconnects. */
  function issueToken(a) {
    const token = newToken('agent');
    agentTokens.delete(a.tokenHash);
    a.tokenHash = hashToken(token);
    a.tokenIssuedAt = now();
    agentTokens.set(a.tokenHash, a.id);
    store.saveAgent(a);
    dropConnections('agent', a.id);
    return token;
  }

  function rotateAgentToken(p, id) {
    const a = ownedAgent(p, id);
    const token = issueToken(a);
    return { agent: agentView(a, a.ownerId), token };
  }

  // ---------- one-time pairing codes ----------
  // A short code the owner can paste into a prompt for their AI agent. It works once, expires
  // in 15 minutes, and is exchanged for a real agent token by `crosstalk agent install --pair-code`.
  // Only a hash is kept, in memory: a hub restart simply invalidates outstanding codes.
  const PAIR_TTL = 15 * 60_000;
  const PAIR_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  const pairCodes = new Map(); // hash -> { agentId, expiresAt }
  const normCode = (c) => String(c ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');

  function createPairCode(p, id) {
    const a = ownedAgent(p, id);
    // One live code per agent: making a new one cancels the previous one.
    for (const [h, v] of pairCodes) if (v.agentId === a.id || v.expiresAt <= now()) pairCodes.delete(h);
    const raw = Array.from({ length: 8 }, () => PAIR_ALPHABET[crypto.randomInt(PAIR_ALPHABET.length)]).join('');
    const expiresAt = now() + PAIR_TTL;
    pairCodes.set(hashToken(raw), { agentId: a.id, expiresAt });
    return { code: `${raw.slice(0, 4)}-${raw.slice(4)}`, expiresAt, agent: agentView(a, a.ownerId) };
  }

  /** Exchange a pairing code for a fresh agent token. `handle`, if given, must match. */
  function redeemPairCode(code, handle) {
    const h = hashToken(normCode(code));
    const v = pairCodes.get(h);
    const a = v && v.expiresAt > now() ? agents.get(v.agentId) : null;
    if (!a) {
      pairCodes.delete(h);
      throw new HubError(400, 'That pairing code is wrong, already used, or expired. Make a new connect prompt in the agent’s settings.');
    }
    const want = String(handle ?? '').trim().replace(/^@/, '').toLowerCase();
    if (want && want !== a.handle) throw new HubError(400, `That pairing code is for @${a.handle}, not @${want}.`); // not consumed
    pairCodes.delete(h);
    const token = issueToken(a);
    return { token, agent: agentView(a, a.ownerId) };
  }

  function deleteAgent(p, id) {
    const a = ownedAgent(p, id);
    dropConnections('agent', a.id);
    agents.delete(a.id);
    handles.delete(a.handle);
    agentTokens.delete(a.tokenHash);
    for (const r of rooms.values()) {
      if (isMember(r, 'agent', a.id)) {
        r.members = r.members.filter((m) => !(m.kind === 'agent' && m.id === a.id));
        memberKeys.get(r.id).delete(`agent:${a.id}`);
        broadcastRoomUpdate(r);
      }
    }
    store.deleteAgent(a.id);
    pending.delete(a.id);
    statuses.delete(a.id);
    broadcastUsers({ type: 'agent_removed', agentId: a.id });
  }

  function setStatus(p, { roomId, state, detail } = {}) {
    if (p.kind !== 'agent') throw new HubError(403, 'Only agents have a status');
    const room = mustRoom(roomId);
    if (!isMember(room, 'agent', p.id)) throw new HubError(403, 'Not a member of that room');
    if (state === 'thinking') statuses.set(p.id, { roomId, state, detail: String(detail ?? '').slice(0, 120), at: now() });
    else statuses.delete(p.id);
    broadcastRoom(room, { type: 'status', agentId: p.id, handle: p.agent.handle, roomId, state: state === 'thinking' ? 'thinking' : 'idle', detail: detail ?? '' });
  }

  // ---------- rooms ----------
  function listRooms(p) {
    return [...rooms.values()]
      .filter((r) => (p.kind === 'agent' ? isMember(r, 'agent', p.id) : canRead(p, r)))
      .sort((a, b) => (b.lastMessageAt ?? b.createdAt) - (a.lastMessageAt ?? a.createdAt))
      .map(roomView);
  }

  function getRoom(p, id) {
    const r = mustRoom(id);
    if (!canRead(p, r)) throw new HubError(403, 'You cannot see this room');
    return roomView(r);
  }

  function createRoom(p, { name, topic, visibility } = {}) {
    const user = requireUser(p);
    name = String(name ?? '').trim().replace(/^#/, '').slice(0, 48);
    if (!name) throw new HubError(400, 'Room name is required');
    const taken = new Set([...rooms.values()].filter((r) => r.kind === 'room').map((r) => r.slug));
    const base = slugify(name) || 'room';
    let slug = base;
    for (let i = 2; taken.has(slug); i++) slug = `${base.slice(0, 28)}-${i}`;
    const room = { id: newId('room'), name, slug, topic: String(topic ?? '').trim().slice(0, 200), kind: 'room', visibility: visibility === 'private' ? 'private' : 'public', dmKey: null, createdBy: user.id, createdAt: now(), lastMessageAt: null, members: [] };
    rooms.set(room.id, room);
    memberKeys.set(room.id, new Set());
    store.saveRoom(room);
    addMemberTo(room, 'user', user.id);
    broadcastRoomUpdate(room);
    return roomView(room);
  }

  function updateRoom(p, id, { name, topic } = {}) {
    const r = mustRoom(id);
    if (r.kind !== 'room') throw new HubError(400, 'Direct messages cannot be renamed');
    if (!(p.kind === 'user' && r.createdBy === p.id)) throw new HubError(403, 'Only the room’s creator can change it');
    if (name !== undefined) r.name = String(name).trim().replace(/^#/, '').slice(0, 48) || r.name;
    if (topic !== undefined) r.topic = String(topic).trim().slice(0, 200);
    store.saveRoom(r);
    broadcastRoomUpdate(r);
    return roomView(r);
  }

  function joinRoom(p, id) {
    const user = requireUser(p);
    const r = mustRoom(id);
    if (r.kind !== 'room' || r.visibility !== 'public') throw new HubError(403, 'This room is invite-only');
    if (addMemberTo(r, 'user', user.id)) broadcastRoomUpdate(r);
    return roomView(r);
  }

  function leaveRoom(p, id) {
    const r = mustRoom(id);
    removeMemberFrom(r, p.kind, p.id);
    broadcastRoomUpdate(r);
    if (p.kind === 'user') sendToUser(p.id, { type: 'room', room: roomView(r) });
    return roomView(r);
  }

  const canInviteAgent = (p, agent) => agent.visibility === 'public' || (p.kind === 'user' && agent.ownerId === p.id);

  function addMember(p, roomId, handle) {
    const r = mustRoom(roomId);
    if (r.kind !== 'room') throw new HubError(400, 'You cannot add people to a direct message');
    if (!isMember(r, p.kind, p.id)) throw new HubError(403, 'Join the room first');
    const h = String(handle ?? '').trim().replace(/^@/, '').toLowerCase();
    const agent = agentByHandle(h);
    const user = agent ? null : userByHandle(h);
    if (!agent && !user) throw new HubError(404, `No one called @${h}`);
    if (agent && !canInviteAgent(p, agent)) throw new HubError(403, `@${h} is private; only its owner can add it`);
    const target = agent ?? user;
    if (addMemberTo(r, agent ? 'agent' : 'user', target.id)) {
      systemMessage(r, `@${memberView({ kind: p.kind, id: p.id }).handle} added @${target.handle}`);
      broadcastRoomUpdate(r);
      if (user) sendToUser(user.id, { type: 'room', room: roomView(r) });
    }
    return roomView(r);
  }

  function removeMember(p, roomId, memberId) {
    const r = mustRoom(roomId);
    const m = r.members.find((x) => x.id === memberId);
    if (!m) return roomView(r);
    const isSelf = m.kind === p.kind && m.id === p.id;
    const ownsAgent = m.kind === 'agent' && p.kind === 'user' && agents.get(m.id)?.ownerId === p.id;
    const isCreator = p.kind === 'user' && r.createdBy === p.id;
    if (!isSelf && !ownsAgent && !isCreator) throw new HubError(403, 'Only the room creator, the member, or the agent’s owner can remove them');
    removeMemberFrom(r, m.kind, m.id);
    broadcastRoomUpdate(r);
    if (m.kind === 'user') sendToUser(m.id, { type: 'room', room: roomView(r) });
    return roomView(r);
  }

  function openDM(p, handle) {
    const user = requireUser(p);
    const h = String(handle ?? '').trim().replace(/^@/, '').toLowerCase();
    const agent = agentByHandle(h);
    const person = agent ? null : userByHandle(h);
    if (person) return openPersonDM(user, person);
    if (!agent) throw new HubError(404, `No one called @${h}`);
    if (!canInviteAgent(p, agent)) throw new HubError(403, `@${h} is private`);
    const dmKey = `${user.id}:${agent.id}`;
    let r = [...rooms.values()].find((x) => x.kind === 'dm' && x.dmKey === dmKey);
    if (!r) {
      r = { id: newId('dm'), name: agent.name, slug: `dm-${user.id}-${agent.id}`, topic: '', kind: 'dm', visibility: 'private', dmKey, createdBy: user.id, createdAt: now(), lastMessageAt: null, members: [] };
      rooms.set(r.id, r);
      memberKeys.set(r.id, new Set());
      store.saveRoom(r);
      addMemberTo(r, 'user', user.id);
      addMemberTo(r, 'agent', agent.id);
      broadcastRoomUpdate(r);
    }
    return roomView(r);
  }

  /** A private conversation between two people. Agents can't be added to it. */
  function openPersonDM(user, other) {
    if (other.id === user.id) throw new HubError(400, 'You can’t message yourself');
    const dmKey = `people:${[user.id, other.id].sort().join(':')}`;
    let r = [...rooms.values()].find((x) => x.kind === 'dm' && x.dmKey === dmKey);
    if (!r) {
      r = { id: newId('dm'), name: `${user.name} & ${other.name}`.slice(0, 48), slug: `dm-${dmKey.slice(7)}`, topic: '', kind: 'dm', visibility: 'private', dmKey, createdBy: user.id, createdAt: now(), lastMessageAt: null, members: [] };
      rooms.set(r.id, r);
      memberKeys.set(r.id, new Set());
      store.saveRoom(r);
      addMemberTo(r, 'user', user.id);
      addMemberTo(r, 'user', other.id);
      broadcastRoomUpdate(r);
    }
    return roomView(r);
  }

  // ---------- messages ----------
  function getMessages(p, roomId, { after, before, limit } = {}) {
    const r = mustRoom(roomId);
    if (!canRead(p, r)) throw new HubError(403, 'You cannot see this room');
    const n = Math.min(Math.max(Number(limit) || 100, 1), 500);
    const anchor = (id) => {
      const m = id ? store.messageById(id) : null;
      return m && m.roomId === r.id ? m : null;
    };
    if (after && anchor(after)) return store.messagesAfter(r.id, anchor(after).seq, n).map(messageView);
    if (before && anchor(before)) return store.messagesBefore(r.id, anchor(before).seq, n).map(messageView);
    return store.latestMessages(r.id, n).map(messageView);
  }

  function searchMessages(p, roomId, q, { limit } = {}) {
    const r = mustRoom(roomId);
    if (!canRead(p, r)) throw new HubError(403, 'You cannot see this room');
    const term = String(q ?? '').trim().slice(0, 100);
    if (term.length < 2) throw new HubError(400, 'Type at least 2 characters to search');
    return store.searchMessages(r.id, term, Math.min(Math.max(Number(limit) || 30, 1), 100)).map(messageView);
  }

  function addMessage(room, fields) {
    const msg = store.insertMessage({ id: newId('msg'), roomId: room.id, createdAt: now(), mentions: [], replyTo: null, depth: 0, ...fields });
    room.lastMessageAt = msg.createdAt;
    broadcastRoom(room, { type: 'message', message: messageView(msg) });
    resolveWaiters(msg);
    return msg;
  }

  function systemMessage(room, text) {
    return addMessage(room, { sender: { kind: 'system', id: 'system' }, text });
  }

  function noticeOnce(key, room, text, windowMs = 60_000) {
    const last = notices.get(key);
    if (last && now() - last < windowMs) return;
    notices.set(key, now());
    systemMessage(room, text);
  }

  function postMessage(p, roomId, { text, replyTo } = {}) {
    const room = mustRoom(roomId);
    text = String(text ?? '').trim();
    if (!text) throw new HubError(400, 'Message is empty');
    if (text.length > MAX_TEXT) throw new HubError(413, `Message is longer than ${MAX_TEXT} characters`);
    if (!isMember(room, p.kind, p.id)) {
      if (p.kind === 'user' && room.kind === 'room' && room.visibility === 'public') {
        addMemberTo(room, 'user', p.id);
        broadcastRoomUpdate(room);
      } else {
        throw new HubError(403, 'Not a member of this room');
      }
    }
    const parentRow = replyTo ? store.messageById(replyTo) : null;
    const parent = parentRow && parentRow.roomId === room.id ? parentRow : null;

    // Depth = how many agent hops since a person last spoke. People reset it to 0.
    const depth = p.kind === 'agent' ? (triggerDepth.get(`${p.id}:${room.id}`) ?? 0) + 1 : 0;

    const mentioned = parseMentions(text);
    const mentionedAgents = mentioned.map(agentByHandle).filter(Boolean);
    const resolved = mentioned.filter((h) => handles.has(h));

    // Mentioning an agent that isn't here yet invites it, if the sender is allowed to.
    let invited = false;
    if (room.kind === 'room') {
      for (const a of mentionedAgents) if (canInviteAgent(p, a) && addMemberTo(room, 'agent', a.id)) invited = true;
    }

    const msg = addMessage(room, { sender: { kind: p.kind, id: p.id }, text, mentions: resolved, replyTo: parent ? parent.id : null, depth });
    if (invited) broadcastRoomUpdate(room);
    const result = dispatch(room, msg, p, mentionedAgents, parent);
    return { message: messageView(msg), ...result };
  }

  function deleteMessage(p, messageId) {
    const m = store.messageById(messageId);
    if (!m || m.deletedAt) throw new HubError(404, 'Message not found');
    const room = mustRoom(m.roomId);
    const own = m.sender.kind === p.kind && m.sender.id === p.id;
    const ownsAgent = m.sender.kind === 'agent' && p.kind === 'user' && agents.get(m.sender.id)?.ownerId === p.id;
    const creator = p.kind === 'user' && room.createdBy === p.id;
    if (!own && !ownsAgent && !creator) throw new HubError(403, 'You can only delete your own messages (or your agent’s, or any in a room you created)');
    store.deleteMessage(m.id, now());
    broadcastRoom(room, { type: 'message_deleted', roomId: room.id, messageId: m.id });
  }

  /** Decide which agents wake up for this message, and wake them. */
  function dispatch(room, msg, p, mentionedAgents, parent) {
    const out = { delivered: [], queued: [], notice: null };
    const targets = new Map();
    for (const a of mentionedAgents) if (isMember(room, 'agent', a.id)) targets.set(a.id, a);
    // A person replying to an agent's message is talking to that agent. (Not for agents:
    // bridges reply to whoever woke them, and that would bounce agents back and forth.)
    if (p.kind === 'user' && parent?.sender.kind === 'agent' && isMember(room, 'agent', parent.sender.id)) {
      targets.set(parent.sender.id, agents.get(parent.sender.id));
    }
    if (room.kind === 'dm') for (const m of room.members) if (m.kind === 'agent') targets.set(m.id, agents.get(m.id));
    if (room.kind === 'dm' && !targets.size && mentionedAgents.length) {
      out.notice = 'Agents can’t join a direct message between people. Mention them in a room instead.';
    }
    if (p.kind === 'agent') targets.delete(p.id);
    for (const [id, a] of targets) if (!a) targets.delete(id);
    if (!targets.size) return out;

    if (p.kind === 'agent') {
      if (msg.depth >= maxDepth) {
        out.notice = `agent chain paused after ${maxDepth} hops`;
        noticeOnce(`depth:${room.id}`, room, `Paused this agent-to-agent chain after ${maxDepth} hops so agents don’t loop forever. Mention an agent to keep going.`, 5_000);
        return out;
      }
      const recent = (agentRate.get(room.id) ?? []).filter((t) => now() - t < 60_000);
      if (recent.length >= agentMessagesPerMinute) {
        out.notice = 'agent rate limit reached in this room';
        noticeOnce(`rate:${room.id}`, room, 'Agents are talking very fast in here, so further agent-to-agent wake-ups are held for a minute.');
        return out;
      }
      recent.push(now());
      agentRate.set(room.id, recent);
    }

    for (const a of targets.values()) {
      triggerDepth.set(`${a.id}:${room.id}`, msg.depth);
      const how = deliver(a, buildEnvelope(a, room, msg, p));
      out[how].push(a.handle);
      if (how === 'queued') noticeOnce(`offline:${a.id}:${room.id}`, room, `@${a.handle} is offline. It will pick this up when it reconnects.`, 10 * 60_000);
    }
    return out;
  }

  function buildEnvelope(agent, room, msg, p) {
    return {
      type: 'trigger',
      id: newId('trg'),
      agent: { id: agent.id, handle: agent.handle },
      room: roomView(room),
      message: messageView(msg),
      sender: memberView(msg.sender),
      // Only the agent's own human owner gets "owner" standing. Everyone else, including
      // other agents (even ones with the same owner), is a guest: talk, don't act.
      accessTier: p.kind === 'user' && p.id === agent.ownerId ? 'owner' : 'guest',
      depth: msg.depth,
      maxDepth,
      context: store.messagesBefore(room.id, msg.seq, contextSize).filter((m) => !m.deletedAt).map(messageView),
      createdAt: now(),
    };
  }

  function deliver(agent, env) {
    const set = conns.get(pkey('agent', agent.id));
    if (set?.size) {
      [...set].at(-1).send(env); // newest bridge wins; one agent answers once
      return 'delivered';
    }
    const q = pending.get(agent.id) ?? [];
    q.push(env);
    pending.set(agent.id, q.slice(-100));
    return 'queued';
  }

  function resolveWaiters(msg) {
    if (!msg.replyTo) return;
    for (const w of waiters.get(msg.replyTo) ?? []) if (w.match(msg)) w.done(messageView(msg));
  }

  function waitForReply(p, messageId, { from, timeoutMs = 30_000, signal } = {}) {
    const msg = store.messageById(messageId);
    if (!msg) throw new HubError(404, 'Message not found');
    if (!canRead(p, mustRoom(msg.roomId))) throw new HubError(403, 'You cannot see this room');
    const fromAgent = from ? agentByHandle(String(from).replace(/^@/, '').toLowerCase()) : null;
    const existing = store.firstAgentReply(messageId, fromAgent?.id ?? null);
    if (existing) return Promise.resolve(messageView(existing));
    const match = (m) => m.replyTo === messageId && m.sender.kind === 'agent' && (!fromAgent || m.sender.id === fromAgent.id);
    return new Promise((resolve) => {
      const set = waiters.get(messageId) ?? new Set();
      waiters.set(messageId, set);
      const w = {
        match,
        done: (value) => {
          clearTimeout(timer);
          set.delete(w);
          if (!set.size) waiters.delete(messageId);
          resolve(value);
        },
      };
      const timer = setTimeout(() => w.done(null), timeoutMs);
      signal?.addEventListener('abort', () => w.done(null), { once: true });
      set.add(w);
    });
  }

  function mentions(p, { after, limit } = {}) {
    const handle = p.kind === 'agent' ? p.agent.handle : p.user.handle;
    const afterSeq = after ? (store.messageById(after)?.seq ?? 0) : 0;
    const n = Math.min(Math.max(Number(limit) || 20, 1), 100);
    return store.mentionsFor(p.kind, p.id, handle, { afterSeq, limit: n }).map((m) => ({ ...messageView(m), room: { id: m.roomId, name: m.roomName } }));
  }

  // ---------- connections ----------
  function subscribe(p, conn, info = null) {
    const key = pkey(p.kind, p.id);
    const set = conns.get(key) ?? new Set();
    const wasOffline = set.size === 0;
    set.add(conn);
    conns.set(key, set);
    if (p.kind === 'user' && wasOffline) broadcastUsers({ type: 'presence', userId: p.id, online: true }, (uid) => uid !== p.id);
    if (p.kind === 'agent') {
      const a = p.agent;
      a.lastConnectedAt = now();
      if (info && typeof info === 'object') {
        a.bridge = Object.fromEntries(BRIDGE_FIELDS.filter((k) => info[k] != null).map((k) => [k, String(info[k]).slice(0, 200)]));
        a.bridge.connectedAt = now();
      }
      store.saveAgent(a);
      if (wasOffline) {
        for (const k of notices.keys()) if (k.startsWith(`offline:${p.id}:`)) notices.delete(k);
        broadcastUsers({ type: 'presence', agentId: p.id, online: true });
      }
      sendToUser(a.ownerId, { type: 'agent', agent: agentView(a, a.ownerId) });
      const q = pending.get(p.id);
      if (q?.length) {
        pending.delete(p.id);
        for (const env of q) conn.send(env);
      }
    }
    return () => {
      set.delete(conn);
      if (set.size) return;
      if (conns.get(key) === set) conns.delete(key);
      if (p.kind === 'user' && !conns.get(key)?.size) broadcastUsers({ type: 'presence', userId: p.id, online: false });
      if (p.kind === 'agent' && !isOnline(p.id) && agents.has(p.id)) {
        const a = p.agent;
        a.lastSeenAt = now();
        store.saveAgent(a);
        const st = statuses.get(p.id);
        statuses.delete(p.id);
        if (st && rooms.get(st.roomId)) broadcastRoom(rooms.get(st.roomId), { type: 'status', agentId: p.id, handle: a.handle, roomId: st.roomId, state: 'idle' });
        broadcastUsers({ type: 'presence', agentId: p.id, online: false, lastSeenAt: a.lastSeenAt });
        sendToUser(a.ownerId, { type: 'agent', agent: agentView(a, a.ownerId) });
      }
    };
  }

  function closeAll() {
    for (const set of conns.values()) for (const c of set) c.close();
    conns.clear();
  }

  return {
    maxDepth,
    authenticate,
    upsertClerkUser,
    userByClerkId,
    me,
    updateMe,
    signup,
    listAgents,
    listPeople,
    getAgent,
    createAgent,
    updateAgent,
    rotateAgentToken,
    createPairCode,
    redeemPairCode,
    deleteAgent,
    setStatus,
    listRooms,
    getRoom,
    createRoom,
    updateRoom,
    joinRoom,
    leaveRoom,
    addMember,
    removeMember,
    openDM,
    getMessages,
    searchMessages,
    postMessage,
    deleteMessage,
    waitForReply,
    mentions,
    subscribe,
    closeAll,
    stats: () => ({ users: users.size, agents: agents.size, rooms: rooms.size, connections: [...conns.values()].reduce((n, s) => n + s.size, 0) }),
  };
}
