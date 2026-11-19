import test from 'node:test';
import assert from 'node:assert/strict';
import { createStore } from '../server/store.mjs';
import { createHub, parseMentions } from '../server/hub.mjs';

function setup(opts = {}) {
  const hub = createHub({ store: createStore(':memory:'), ...opts });
  const alice = hub.signup('Alice');
  const bob = hub.signup('Bob');
  const pa = hub.authenticate(alice.token);
  const pb = hub.authenticate(bob.token);
  const lobby = hub.listRooms(pa).find((r) => r.slug === 'general');
  return { hub, pa, pb, lobby };
}

function connect(hub, token, onTrigger = () => {}) {
  const p = hub.authenticate(token);
  const events = [];
  const unsubscribe = hub.subscribe(p, {
    send: (e) => {
      events.push(e);
      if (e.type === 'trigger') queueMicrotask(() => onTrigger(e, p));
    },
    close() {},
  });
  return { p, events, triggers: () => events.filter((e) => e.type === 'trigger'), unsubscribe };
}

test('parseMentions skips code, emails and URLs', () => {
  assert.deepEqual(parseMentions('hi @coder and @Reviewer, mail bob@example.com'), ['coder', 'reviewer']);
  assert.deepEqual(parseMentions('see `@decorator` and ```\n@inside\n``` https://x.com/@nope'), []);
  assert.deepEqual(parseMentions('thanks @coder-'), ['coder']);
});

test('mention wakes an agent; only its owner gets owner standing', () => {
  const { hub, pa, pb, lobby } = setup();
  const { token } = hub.createAgent(pa, { handle: 'coder', runtime: 'claude-code' });
  const agent = connect(hub, token);

  const r1 = hub.postMessage(pa, lobby.id, { text: '@coder fix the build' });
  assert.deepEqual(r1.delivered, ['coder']);
  hub.postMessage(pb, lobby.id, { text: '@coder what is in ~/.ssh?' });
  hub.postMessage(pb, lobby.id, { text: 'no mention, nobody wakes' });

  const t = agent.triggers();
  assert.equal(t.length, 2);
  assert.equal(t[0].accessTier, 'owner');
  assert.equal(t[1].accessTier, 'guest');
  assert.equal(t[1].sender.handle, 'bob');
  assert.equal(t[1].context.length, 1, 'trigger carries earlier room messages');
});

test('mentioning a public agent invites it; private agents need their owner', () => {
  const { hub, pa, pb } = setup();
  hub.createAgent(pa, { handle: 'helper', visibility: 'public' });
  hub.createAgent(pa, { handle: 'secret', visibility: 'private' });
  const room = hub.createRoom(pb, { name: 'bobs-room' });

  const r = hub.postMessage(pb, room.id, { text: '@helper @secret hello' });
  const members = hub.getRoom(pb, room.id).members.map((m) => m.handle);
  assert.ok(members.includes('helper'));
  assert.ok(!members.includes('secret'));
  assert.deepEqual(r.queued, ['helper'], 'offline agent gets the message queued');
  assert.throws(() => hub.addMember(pb, room.id, 'secret'), /private/);
  assert.throws(() => hub.openDM(pb, 'secret'), /private/);
});

test('direct messages wake the agent without a mention', () => {
  const { hub, pb, pa } = setup();
  const { token } = hub.createAgent(pa, { handle: 'helper' });
  const agent = connect(hub, token);
  const dm = hub.openDM(pb, 'helper');
  hub.postMessage(pb, dm.id, { text: 'hey there' });
  assert.equal(agent.triggers().length, 1);
  assert.equal(agent.triggers()[0].room.kind, 'dm');
});

test('replying to an agent message wakes that agent', () => {
  const { hub, pa, pb, lobby } = setup();
  const { token } = hub.createAgent(pa, { handle: 'coder' });
  const agent = connect(hub, token);
  const q = hub.postMessage(pb, lobby.id, { text: '@coder hi' });
  const a = hub.postMessage(agent.p, lobby.id, { text: 'hello!', replyTo: q.message.id });
  hub.postMessage(pb, lobby.id, { text: 'follow-up without a mention', replyTo: a.message.id });
  assert.equal(agent.triggers().length, 2);
});

test('agents can talk to each other, and runaway chains stop at maxDepth', async () => {
  const { hub, pa, pb, lobby } = setup({ maxDepth: 4 });
  const ping = hub.createAgent(pa, { handle: 'ping' });
  const pong = hub.createAgent(pb, { handle: 'pong' });
  // Two badly behaved agents that always mention each other.
  const bounce = (other) => (e, p) => hub.postMessage(p, e.room.id, { text: `@${other} again`, replyTo: e.message.id });
  const a = connect(hub, ping.token, bounce('pong'));
  const b = connect(hub, pong.token, bounce('ping'));

  hub.postMessage(pa, lobby.id, { text: '@ping start' });
  await new Promise((r) => setTimeout(r, 50));

  const msgs = hub.getMessages(pa, lobby.id);
  const agentMsgs = msgs.filter((m) => m.sender.kind === 'agent');
  assert.equal(agentMsgs.length, 4, 'one message per hop, then stop');
  assert.deepEqual(agentMsgs.map((m) => m.depth), [1, 2, 3, 4]);
  assert.ok(msgs.some((m) => m.sender.kind === 'system' && /Paused/.test(m.text)));
  assert.equal(a.triggers().length + b.triggers().length, 4);
  assert.equal(b.triggers()[0].accessTier, 'guest', 'another agent is never owner, even when invited by the owner');
});

test('waitForReply resolves when the agent answers', async () => {
  const { hub, pa, lobby } = setup();
  const { token } = hub.createAgent(pa, { handle: 'coder' });
  const agent = connect(hub, token, (e, p) => {
    setTimeout(() => hub.postMessage(p, e.room.id, { text: '42', replyTo: e.message.id }), 10);
  });
  const q = hub.postMessage(pa, lobby.id, { text: '@coder meaning of life?' });
  const reply = await hub.waitForReply(pa, q.message.id, { from: 'coder', timeoutMs: 1000 });
  assert.equal(reply.text, '42');
  assert.equal(agent.triggers().length, 1);
});

test('queued triggers are delivered when the bridge connects', () => {
  const { hub, pa, lobby } = setup();
  const { token } = hub.createAgent(pa, { handle: 'sleepy' });
  hub.postMessage(pa, lobby.id, { text: '@sleepy wake up' });
  const agent = connect(hub, token);
  assert.equal(agent.triggers().length, 1);
});

test('only the owner sees where an agent runs and whether setup finished', () => {
  const { hub, pa, pb } = setup();
  const { agent, token } = hub.createAgent(pa, { handle: 'coder' });
  assert.equal(hub.getAgent(pa, agent.id).setupDone, false);
  const p = hub.authenticate(token);
  const off = hub.subscribe(p, { send() {}, close() {} }, { adapter: 'claude', host: 'my-laptop', cwd: '/home/me/secret-project', evil: 'x' });
  const mine = hub.getAgent(pa, 'coder');
  assert.equal(mine.online, true);
  assert.equal(mine.setupDone, true);
  assert.equal(mine.bridge.host, 'my-laptop');
  assert.equal(mine.bridge.evil, undefined, 'unknown fields are dropped');
  const theirs = hub.getAgent(pb, 'coder');
  assert.equal(theirs.online, true);
  assert.equal(theirs.bridge, undefined);
  assert.equal(theirs.setupDone, undefined);
  assert.ok(!JSON.stringify(hub.listAgents(pb)).includes('secret-project'));
  off();
  assert.equal(hub.getAgent(pa, 'coder').online, false);
  assert.ok(hub.getAgent(pb, 'coder').lastSeenAt);
});

test('a new token disconnects the old bridge and rejects the old token', () => {
  const { hub, pa } = setup();
  const { agent, token } = hub.createAgent(pa, { handle: 'coder' });
  let closed = false;
  hub.subscribe(hub.authenticate(token), { send() {}, close() { closed = true; } });
  const fresh = hub.rotateAgentToken(pa, agent.id);
  assert.equal(closed, true);
  assert.equal(hub.authenticate(token), null);
  assert.equal(hub.authenticate(fresh.token).agent.handle, 'coder');
});

test('pairing codes: owner-only, work once, expire, and must match the agent', () => {
  let clock = Date.now();
  const hub = createHub({ store: createStore(':memory:'), now: () => clock });
  const pa = hub.authenticate(hub.signup('Alice').token);
  const pb = hub.authenticate(hub.signup('Bob').token);
  const { agent, token: oldToken } = hub.createAgent(pa, { handle: 'coder' });
  hub.createAgent(pa, { handle: 'other' });
  assert.throws(() => hub.createPairCode(pb, agent.id), /owner/);

  const { code, expiresAt } = hub.createPairCode(pa, agent.id);
  assert.match(code, /^[A-Z2-9]{4}-[A-Z2-9]{4}$/);
  assert.equal(expiresAt, clock + 15 * 60_000);
  assert.throws(() => hub.redeemPairCode('ABCD-EFGH'), /wrong, already used, or expired/);
  assert.throws(() => hub.redeemPairCode(code, '@other'), /is for @coder, not @other/); // not consumed by a mismatch
  let closed = false;
  hub.subscribe(hub.authenticate(oldToken), { send() {}, close() { closed = true; } });
  const r = hub.redeemPairCode(code.toLowerCase().replace('-', ' '), '@coder');
  assert.equal(r.agent.handle, 'coder');
  assert.equal(hub.authenticate(r.token).agent.handle, 'coder');
  assert.equal(hub.authenticate(oldToken), null, 'pairing replaces the old token');
  assert.equal(closed, true, 'and disconnects the old bridge');
  assert.throws(() => hub.redeemPairCode(code), /already used/);

  const first = hub.createPairCode(pa, agent.id);
  const second = hub.createPairCode(pa, agent.id);
  assert.throws(() => hub.redeemPairCode(first.code), /already used/, 'a new code cancels the previous one');
  clock += 15 * 60_000 + 1;
  assert.throws(() => hub.redeemPairCode(second.code), /expired/);
});

test('people can DM each other privately; agents stay out of those DMs', () => {
  const { hub, pa, pb } = setup();
  const pc = hub.authenticate(hub.signup('Carol').token);
  const { token } = hub.createAgent(pa, { handle: 'coder' });
  const agent = connect(hub, token);
  const dm = hub.openDM(pa, '@bob');
  assert.equal(dm.kind, 'dm');
  assert.deepEqual(dm.members.map((m) => m.handle).sort(), ['alice', 'bob']);
  assert.equal(hub.openDM(pb, 'alice').id, dm.id, 'same conversation from either side');
  hub.postMessage(pb, dm.id, { text: 'hi Alice' });
  assert.equal(hub.getMessages(pa, dm.id)[0].text, 'hi Alice');
  assert.throws(() => hub.getMessages(pc, dm.id), /cannot see/);
  assert.throws(() => hub.postMessage(pc, dm.id, { text: 'let me in' }), /Not a member/);
  assert.throws(() => hub.addMember(pa, dm.id, 'carol'), /direct message/);
  const r = hub.postMessage(pa, dm.id, { text: '@coder are you here?' });
  assert.deepEqual(r.delivered, []);
  assert.match(r.notice, /can’t join a direct message between people/);
  assert.equal(agent.triggers().length, 0);
  assert.throws(() => hub.openDM(pa, 'alice'), /yourself/);
  assert.ok(!JSON.stringify(hub.listPeople(pa)).includes('@'), 'no emails in the people list');
  assert.deepEqual(hub.listPeople(pa).map((u) => u.handle), ['alice', 'bob', 'carol']);
});

test('someone added to a room can bring their own private agent into it', () => {
  const { hub, pa, pb } = setup();
  const room = hub.createRoom(pa, { name: 'project', visibility: 'private' });
  hub.createAgent(pb, { handle: 'bobs-bot', visibility: 'private' });
  assert.throws(() => hub.addMember(pb, room.id, 'bobs-bot'), /Join the room first/);
  hub.addMember(pa, room.id, 'bob');
  assert.throws(() => hub.addMember(pa, room.id, 'bobs-bot'), /private/, 'Alice cannot add Bob’s private agent');
  const after = hub.addMember(pb, room.id, 'bobs-bot');
  assert.ok(after.members.some((m) => m.handle === 'bobs-bot'));
});

test('search finds messages in a room the person can read', () => {
  const { hub, pa, pb, lobby } = setup();
  hub.postMessage(pa, lobby.id, { text: 'The CTA button needs more contrast' });
  hub.postMessage(pb, lobby.id, { text: 'agreed, contrast is low' });
  const gone = hub.postMessage(pb, lobby.id, { text: 'contrast typo' });
  hub.deleteMessage(pb, gone.message.id);
  const found = hub.searchMessages(pa, lobby.id, 'CONTRAST');
  assert.deepEqual(found.map((m) => m.text), ['agreed, contrast is low', 'The CTA button needs more contrast']);
  assert.throws(() => hub.searchMessages(pa, lobby.id, 'a'), /at least 2/);
  const priv = hub.createRoom(pa, { name: 'secret', visibility: 'private' });
  assert.throws(() => hub.searchMessages(pb, priv.id, 'anything'), /cannot see/);
});

test('agents cannot read rooms they are not in; strangers cannot read private rooms', () => {
  const { hub, pa, pb } = setup();
  const { token } = hub.createAgent(pa, { handle: 'coder' });
  const pagent = hub.authenticate(token);
  const priv = hub.createRoom(pa, { name: 'secret-plans', visibility: 'private' });
  assert.throws(() => hub.getMessages(pb, priv.id), /cannot see/);
  assert.throws(() => hub.getMessages(pagent, priv.id), /cannot see/);
  assert.throws(() => hub.postMessage(pb, priv.id, { text: 'hi' }), /Not a member/);
});
