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
  // Teams (workspaces): every room and DM belongs to one. People only see the people, rooms
  // and public agents of the teams they are in.
  const teams = new Map(loaded.teams.map((t) => [t.id, t])); // t.members: Map userId -> {role, joinedAt}
  const teamCodes = new Map([...teams.values()].map((t) => [t.inviteCode, t.id])); // invite code -> teamId

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
  const isTeamMember = (teamId, userId) => (teamId ? (teams.get(teamId)?.members.has(userId) ?? false) : false);
  const teamsOf = (userId) => [...teams.values()].filter((t) => t.members.has(userId));
  /** Do these two people have a team in common? (Everyone shares a team with themself.) */
  const sharesTeam = (a, b) => a === b || [...teams.values()].some((t) => t.members.has(a) && t.members.has(b));
  /** Whose agent this principal acts for: the person, or the agent's owner. */
  const actingUserId = (p) => (p.kind === 'user' ? p.id : p.agent?.ownerId);

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
    teamId: r.teamId ?? null,
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
  const roomAudience = (room) => (uid) => canRead({ kind: 'user', id: uid }, room);
  const broadcastRoom = (room, evt) => broadcastUsers(evt, roomAudience(room));
  const broadcastRoomUpdate = (room) => broadcastRoom(room, { type: 'room', room: roomView(room) });
  const broadcastTeammates = (userId, evt) => broadcastUsers(evt, (uid) => sharesTeam(uid, userId));
  const broadcastTeam = (t, evt) => {
    for (const uid of t.members.keys()) sendToUser(uid, evt);
  };
  function broadcastAgent(a) {
    // Teammates see public agents; a private one disappears from their lists.
    const evt = a.visibility === 'public' ? { type: 'agent', agent: agentView(a) } : { type: 'agent_removed', agentId: a.id };
    broadcastUsers(evt, (uid) => uid !== a.ownerId && sharesTeam(uid, a.ownerId));
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
  /**
   * Agents read the rooms they are in. People read rooms they are in and the public rooms
   * of their teams, and lose access to a team's rooms and DMs when they leave the team.
   */
  function canRead(p, r) {
    if (p.kind === 'agent') return isMember(r, 'agent', p.id);
    if (!r.teamId) return isMember(r, 'user', p.id);
    if (!isTeamMember(r.teamId, p.id)) return false;
    return isMember(r, 'user', p.id) || (r.kind === 'room' && r.visibility === 'public');
  }
  function me(p) {
    if (p.kind === 'user') {
      return {
        ...userView(p.user),
        email: p.user.email ?? null,
        agents: [...agents.values()].filter((a) => a.ownerId === p.id).map((a) => agentView(a, p.id)),
        teams: listTeams(p),
      };
    }
    return agentView(p.agent, p.agent.ownerId);
  }

  // ---------- teams ----------
  const MAX_TEAMS_CREATED = 20;
  const newInviteCode = () => crypto.randomBytes(9).toString('base64url');
  const online = (uid) => (conns.get(pkey('user', uid))?.size ?? 0) > 0;

  function teamView(t, viewerId = null) {
    const m = viewerId ? t.members.get(viewerId) : null;
    const view = { id: t.id, name: t.name, slug: t.slug, visibility: t.visibility, memberCount: t.members.size, createdAt: t.createdAt, role: m?.role ?? null };
    if (m) Object.assign(view, { inviteCode: t.inviteCode, joinedAt: m.joinedAt });
    return view;
  }
  const teamPersonView = (t, uid) => ({ ...userView(users.get(uid)), role: t.members.get(uid)?.role ?? null, joinedAt: t.members.get(uid)?.joinedAt ?? null, online: online(uid) });

  function mustTeam(id) {
    const t = teams.get(id);
    if (!t) throw new HubError(404, 'Team not found');
    return t;
  }
  function memberTeam(p, id) {
    const t = mustTeam(id);
    if (!t.members.has(actingUserId(p))) throw new HubError(403, 'You are not in this team');
    return t;
  }
  function ownedTeam(p, id) {
    const user = requireUser(p);
    const t = memberTeam(p, id);
    if (t.members.get(user.id).role !== 'owner') throw new HubError(403, 'Only the team’s owner can do this');
    return t;
  }
  /** The team's lobby (#general, or its oldest public room) that new members land in. */
  const lobbyOf = (t) =>
    [...rooms.values()].filter((r) => r.teamId === t.id && r.kind === 'room' && r.visibility === 'public').sort((a, b) => (a.slug === 'general' ? -1 : b.slug === 'general' ? 1 : a.createdAt - b.createdAt))[0] ?? null;

  function uniqueTeamSlug(name) {
    const taken = new Set([...teams.values()].map((t) => t.slug));
    const base = slugify(name) || 'team';
    let slug = base;
    for (let i = 2; taken.has(slug); i++) slug = `${base.slice(0, 28)}-${i}`;
    return slug;
  }
  function putTeamMember(t, uid, role) {
    const at = now();
    t.members.set(uid, { role, joinedAt: t.members.get(uid)?.joinedAt ?? at });
    store.addTeamMember(t.id, uid, role, t.members.get(uid).joinedAt);
  }
  function newTeam({ name, visibility, ownerId }) {
    const t = { id: newId('team'), name, slug: uniqueTeamSlug(name), visibility: visibility === 'open' ? 'open' : 'invite', inviteCode: newInviteCode(), createdBy: ownerId, createdAt: now(), members: new Map() };
    teams.set(t.id, t);
    teamCodes.set(t.inviteCode, t.id);
    store.saveTeam(t);
    return t;
  }
  function newRoom(fields) {
    const room = { id: newId(fields.kind === 'dm' ? 'dm' : 'room'), topic: '', visibility: 'public', dmKey: null, createdBy: null, createdAt: now(), lastMessageAt: null, members: [], ...fields };
    rooms.set(room.id, room);
    memberKeys.set(room.id, new Set());
    store.saveRoom(room);
    return room;
  }
  const teamDmKey = (teamId, key) => `${teamId}|${key}`;

  // Data from before teams existed moves into one team, owned by the earliest person.
  if (!teams.size && users.size) {
    const all = [...users.values()].sort((a, b) => a.createdAt - b.createdAt);
    const t = newTeam({ name: 'Crosstalk', visibility: 'invite', ownerId: all[0].id });
    for (const u of all) putTeamMember(t, u.id, u.id === all[0].id ? 'owner' : 'member');
    for (const r of rooms.values()) {
      if (r.teamId) continue;
      r.teamId = t.id;
      if (r.dmKey) r.dmKey = teamDmKey(t.id, r.dmKey);
      store.saveRoom(r);
    }
  }

  function listTeams(p) {
    if (p.kind !== 'user') return [];
    return teamsOf(p.id).map((t) => teamView(t, p.id)).sort((a, b) => a.joinedAt - b.joinedAt);
  }

  /** Open teams anyone signed in can join, biggest first. */
  function discoverTeams(p) {
    const user = requireUser(p);
    return [...teams.values()].filter((t) => t.visibility === 'open' && !t.members.has(user.id)).sort((a, b) => b.members.size - a.members.size).slice(0, 50).map((t) => teamView(t));
  }

  function createTeam(p, { name, visibility } = {}) {
    const user = requireUser(p);
    name = String(name ?? '').trim().slice(0, 48);
    if (!name) throw new HubError(400, 'Team name is required');
    if ([...teams.values()].filter((t) => t.createdBy === user.id).length >= MAX_TEAMS_CREATED) throw new HubError(429, `You can create at most ${MAX_TEAMS_CREATED} teams`);
    const t = newTeam({ name, visibility, ownerId: user.id });
    putTeamMember(t, user.id, 'owner');
    const lobby = newRoom({ teamId: t.id, name: DEFAULT_ROOM.slug, slug: DEFAULT_ROOM.slug, topic: DEFAULT_ROOM.topic, kind: 'room', visibility: 'public', createdBy: user.id });
    addMemberTo(lobby, 'user', user.id);
    sendToUser(user.id, { type: 'team', team: teamView(t, user.id) });
    broadcastRoomUpdate(lobby);
    return { ...teamView(t, user.id), lobbyId: lobby.id };
  }

  function addToTeam(t, user) {
    if (t.members.has(user.id)) return { ...teamView(t, user.id), lobbyId: lobbyOf(t)?.id ?? null };
    putTeamMember(t, user.id, 'member');
    const lobby = lobbyOf(t);
    if (lobby) addMemberTo(lobby, 'user', user.id);
    sendToUser(user.id, { type: 'team', team: teamView(t, user.id) });
    for (const uid of t.members.keys()) {
      if (uid === user.id) continue;
      sendToUser(uid, { type: 'team', team: teamView(t, uid) });
      sendToUser(uid, { type: 'team_member', teamId: t.id, person: teamPersonView(t, user.id) });
    }
    if (lobby) {
      broadcastRoomUpdate(lobby);
      systemMessage(lobby, `@${user.handle} joined the team`);
    }
    return { ...teamView(t, user.id), lobbyId: lobby?.id ?? null };
  }

  function joinTeam(p, id) {
    const user = requireUser(p);
    const t = mustTeam(id);
    if (!t.members.has(user.id) && t.visibility !== 'open') throw new HubError(403, 'This team is invite-only. Ask someone in it for an invite link.');
    return addToTeam(t, user);
  }

  const teamByCode = (code) => teams.get(teamCodes.get(String(code ?? '').trim()));
  /** What an invite link points at, so the app can say "Join <team>?" before joining. */
  function previewInvite(p, code) {
    const user = requireUser(p);
    const t = teamByCode(code);
    if (!t) throw new HubError(404, 'That invite link is wrong or has been reset. Ask for a new one.');
    return { ...teamView(t, user.id), member: t.members.has(user.id) };
  }
  function joinByCode(p, code) {
    const user = requireUser(p);
    const t = teamByCode(code);
    if (!t) throw new HubError(404, 'That invite link is wrong or has been reset. Ask for a new one.');
    return addToTeam(t, user);
  }

  /** Take someone out of a team: out of its rooms, and their agents out of its rooms and DMs. */
  function dropFromTeam(t, uid) {
    t.members.delete(uid);
    store.removeTeamMember(t.id, uid);
    const theirAgents = new Set([...agents.values()].filter((a) => a.ownerId === uid).map((a) => a.id));
    for (const r of rooms.values()) {
      if (r.teamId !== t.id) continue;
      let changed = r.kind === 'room' && removeMemberFrom(r, 'user', uid);
      for (const m of [...r.members]) if (m.kind === 'agent' && theirAgents.has(m.id)) changed = removeMemberFrom(r, 'agent', m.id) || changed;
      if (changed) broadcastRoomUpdate(r);
    }
    sendToUser(uid, { type: 'team_removed', teamId: t.id });
    for (const other of t.members.keys()) {
      sendToUser(other, { type: 'team', team: teamView(t, other) });
      sendToUser(other, { type: 'team_member_removed', teamId: t.id, userId: uid });
    }
  }

  function leaveTeam(p, id) {
    const user = requireUser(p);
    const t = memberTeam(p, id);
    if (t.members.size === 1) throw new HubError(400, 'You are the only member. Delete the team instead.');
    if (t.members.get(user.id).role === 'owner' && ![...t.members].some(([uid, m]) => uid !== user.id && m.role === 'owner')) {
      // Hand the team to whoever has been in it longest.
      const [heir] = [...t.members].filter(([uid]) => uid !== user.id).sort((a, b) => a[1].joinedAt - b[1].joinedAt)[0];
      putTeamMember(t, heir, 'owner');
    }
    dropFromTeam(t, user.id);
    const lobby = lobbyOf(t);
    if (lobby) systemMessage(lobby, `@${user.handle} left the team`);
  }

  function removeFromTeam(p, id, userId) {
    const owner = requireUser(p);
    if (userId === owner.id) return leaveTeam(p, id);
    const t = ownedTeam(p, id);
    if (!t.members.has(userId)) throw new HubError(404, 'They are not in this team');
    dropFromTeam(t, userId);
  }

  function updateTeam(p, id, { name, visibility } = {}) {
    const t = ownedTeam(p, id);
    if (name !== undefined) t.name = String(name).trim().slice(0, 48) || t.name;
    if (visibility !== undefined) t.visibility = visibility === 'open' ? 'open' : 'invite';
    store.saveTeam(t);
    for (const uid of t.members.keys()) sendToUser(uid, { type: 'team', team: teamView(t, uid) });
    return teamView(t, p.id);
  }

  /** New invite link; the old one stops working. */
  function resetTeamInvite(p, id) {
    const t = ownedTeam(p, id);
    teamCodes.delete(t.inviteCode);
    t.inviteCode = newInviteCode();
    teamCodes.set(t.inviteCode, t.id);
    store.saveTeam(t);
    for (const uid of t.members.keys()) sendToUser(uid, { type: 'team', team: teamView(t, uid) });
    return teamView(t, p.id);
  }

  /** Deletes the team and everything in it: rooms, DMs and messages. */
  function deleteTeam(p, id) {
    const t = ownedTeam(p, id);
    const members = [...t.members.keys()];
    for (const r of [...rooms.values()]) {
      if (r.teamId !== t.id) continue;
      rooms.delete(r.id);
      memberKeys.delete(r.id);
    }
    teams.delete(t.id);
    teamCodes.delete(t.inviteCode);
    store.deleteTeam(t.id);
    for (const uid of members) sendToUser(uid, { type: 'team_removed', teamId: t.id });
  }

  // ---------- people ----------
  function createUser({ name, handleHint, email = null, imageUrl = null, clerkId = null, tokenHash = null }) {
    name = String(name ?? '').trim().slice(0, 48) || 'New user';
    const user = { id: newId('usr'), handle: uniqueHandle(handleHint || name), name, email, imageUrl, clerkId, tokenHash, createdAt: now(), profileSyncedAt: clerkId ? now() : null };
    users.set(user.id, user);
    handles.set(user.handle, { kind: 'user', id: user.id });
    if (tokenHash) userTokens.set(tokenHash, user.id);
    if (clerkId) clerkUsers.set(clerkId, user.id);
    store.saveUser(user);
    return user;
  }

  /** The people in a team (name, handle, picture, role; never email), for rooms and DMs. */
  function listPeople(p, teamId) {
    if (p.kind !== 'user') throw new HubError(403, 'Only people can list people');
    if (!teamId) throw new HubError(400, 'Pick a team');
    const t = memberTeam(p, teamId);
    return [...t.members.keys()].filter((uid) => users.has(uid)).map((uid) => teamPersonView(t, uid)).sort((a, b) => a.name.localeCompare(b.name));
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
    broadcastTeammates(u.id, { type: 'person', person: userView(u) });
    return me(p);
  }

  // ---------- agents ----------
  /** Your own agents, and the public agents of people you share a team with. */
  function canSeeAgent(p, a) {
    if (a.id === p.id) return true;
    if (p.kind === 'user' && a.ownerId === p.id) return true;
    return a.visibility === 'public' && sharesTeam(actingUserId(p), a.ownerId);
  }
  /** teamId narrows it to the agents usable in that team: yours, and public ones of its members. */
  function listAgents(p, { teamId } = {}) {
    const t = teamId ? memberTeam(p, teamId) : null;
    return [...agents.values()]
      .filter((a) => canSeeAgent(p, a) && (!t || (p.kind === 'user' && a.ownerId === p.id) || a.id === p.id || t.members.has(a.ownerId)))
      .map((a) => agentView(a, p.kind === 'user' ? p.id : null));
  }

  function getAgent(p, id) {
    const a = agents.get(id) ?? agentByHandle(String(id).replace(/^@/, '').toLowerCase());
    if (!a || !canSeeAgent(p, a)) throw new HubError(404, 'Agent not found');
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
    broadcastTeammates(a.ownerId, { type: 'agent_removed', agentId: a.id });
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

  function createRoom(p, { teamId, name, topic, visibility } = {}) {
    const user = requireUser(p);
    if (!teamId) throw new HubError(400, 'Pick a team for the room');
    const t = memberTeam(p, teamId);
    name = String(name ?? '').trim().replace(/^#/, '').slice(0, 48);
    if (!name) throw new HubError(400, 'Room name is required');
    const taken = new Set([...rooms.values()].filter((r) => r.kind === 'room' && r.teamId === t.id).map((r) => r.slug));
    const base = slugify(name) || 'room';
    let slug = base;
    for (let i = 2; taken.has(slug); i++) slug = `${base.slice(0, 28)}-${i}`;
    const room = newRoom({ teamId: t.id, name, slug, topic: String(topic ?? '').trim().slice(0, 200), kind: 'room', visibility: visibility === 'private' ? 'private' : 'public', createdBy: user.id });
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
    if (r.kind !== 'room' || r.visibility !== 'public' || !canRead(p, r)) throw new HubError(403, 'This room is invite-only');
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

  /** Your own agents go anywhere you are; other public agents only into their owner's teams. */
  const canInviteAgent = (p, agent, teamId) =>
    (p.kind === 'user' && agent.ownerId === p.id) || (agent.visibility === 'public' && isTeamMember(teamId, agent.ownerId));

  function addMember(p, roomId, handle) {
    const r = mustRoom(roomId);
    if (r.kind !== 'room') throw new HubError(400, 'You cannot add people to a direct message');
    if (!isMember(r, p.kind, p.id)) throw new HubError(403, 'Join the room first');
    const h = String(handle ?? '').trim().replace(/^@/, '').toLowerCase();
    const agent = agentByHandle(h);
    const user = agent ? null : userByHandle(h);
    if (!agent && !user) throw new HubError(404, `No one called @${h}`);
    if (user && !isTeamMember(r.teamId, user.id)) throw new HubError(403, `@${h} is not in this team yet. Invite them to the team first.`);
    if (agent && !canInviteAgent(p, agent, r.teamId)) {
      throw new HubError(403, agent.visibility === 'private' ? `@${h} is private; only its owner can add it` : `@${h} belongs to someone outside this team`);
    }
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

  /** A DM lives in a team. Without a teamId, use the first of your teams the other side is in. */
  function openDM(p, handle, teamId) {
    const user = requireUser(p);
    const h = String(handle ?? '').trim().replace(/^@/, '').toLowerCase();
    const agent = agentByHandle(h);
    const person = agent ? null : userByHandle(h);
    if (!agent && !person) throw new HubError(404, `No one called @${h}`);
    const reachable = (tid) => (person ? isTeamMember(tid, person.id) : canInviteAgent(p, agent, tid));
    if (teamId) memberTeam(p, teamId);
    else teamId = listTeams(p).find((t) => reachable(t.id))?.id;
    if (!teamId || !reachable(teamId)) {
      if (person) throw new HubError(403, `@${h} is not in this team`);
      throw new HubError(403, agent.visibility === 'private' ? `@${h} is private` : `@${h} belongs to someone outside this team`);
    }
    if (person) return openPersonDM(user, person, teamId);
    const dmKey = teamDmKey(teamId, `${user.id}:${agent.id}`);
    let r = [...rooms.values()].find((x) => x.kind === 'dm' && x.dmKey === dmKey);
    if (!r) {
      r = newRoom({ teamId, name: agent.name, slug: `dm-${user.id}-${agent.id}`, kind: 'dm', visibility: 'private', dmKey, createdBy: user.id });
      addMemberTo(r, 'user', user.id);
      addMemberTo(r, 'agent', agent.id);
      broadcastRoomUpdate(r);
    }
    return roomView(r);
  }

  /** A private conversation between two people. Agents can't be added to it. */
  function openPersonDM(user, other, teamId) {
    if (other.id === user.id) throw new HubError(400, 'You can’t message yourself');
    const pair = [user.id, other.id].sort().join(':');
    const dmKey = teamDmKey(teamId, `people:${pair}`);
    let r = [...rooms.values()].find((x) => x.kind === 'dm' && x.dmKey === dmKey);
    if (!r) {
      r = newRoom({ teamId, name: `${user.name} & ${other.name}`.slice(0, 48), slug: `dm-${pair}`, kind: 'dm', visibility: 'private', dmKey, createdBy: user.id });
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
      if (p.kind === 'user' && room.kind === 'room' && canRead(p, room)) {
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
      for (const a of mentionedAgents) if (canInviteAgent(p, a, room.teamId) && addMemberTo(room, 'agent', a.id)) invited = true;
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
    return store
      .mentionsFor(p.kind, p.id, handle, { afterSeq, limit: n })
      .filter((m) => rooms.has(m.roomId) && canRead(p, rooms.get(m.roomId)))
      .map((m) => ({ ...messageView(m), room: { id: m.roomId, name: m.roomName, teamId: rooms.get(m.roomId).teamId ?? null } }));
  }

  // ---------- connections ----------
  function subscribe(p, conn, info = null) {
    const key = pkey(p.kind, p.id);
    const set = conns.get(key) ?? new Set();
    const wasOffline = set.size === 0;
    set.add(conn);
    conns.set(key, set);
    if (p.kind === 'user' && wasOffline) broadcastUsers({ type: 'presence', userId: p.id, online: true }, (uid) => uid !== p.id && sharesTeam(uid, p.id));
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
        broadcastTeammates(p.agent.ownerId, { type: 'presence', agentId: p.id, online: true });
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
      if (p.kind === 'user' && !conns.get(key)?.size) broadcastTeammates(p.id, { type: 'presence', userId: p.id, online: false });
      if (p.kind === 'agent' && !isOnline(p.id) && agents.has(p.id)) {
        const a = p.agent;
        a.lastSeenAt = now();
        store.saveAgent(a);
        const st = statuses.get(p.id);
        statuses.delete(p.id);
        if (st && rooms.get(st.roomId)) broadcastRoom(rooms.get(st.roomId), { type: 'status', agentId: p.id, handle: a.handle, roomId: st.roomId, state: 'idle' });
        broadcastTeammates(a.ownerId, { type: 'presence', agentId: p.id, online: false, lastSeenAt: a.lastSeenAt });
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
    listTeams,
    discoverTeams,
    createTeam,
    joinTeam,
    previewInvite,
    joinByCode,
    leaveTeam,
    removeFromTeam,
    updateTeam,
    resetTeamInvite,
    deleteTeam,
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
    stats: () => ({ users: users.size, teams: teams.size, agents: agents.size, rooms: rooms.size, connections: [...conns.values()].reduce((n, s) => n + s.size, 0) }),
  };
}
