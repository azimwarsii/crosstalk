// End to end: real hub over HTTP, real bridge processes, real MCP server over stdio.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from '../server/index.mjs';
import { CrosstalkClient } from '../lib/client.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function until(fn, ms = 8000) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error('timed out waiting');
    await sleep(50);
  }
}

function startBridge(url, token, args, stateDir) {
  const child = spawn(process.execPath, [path.join(ROOT, 'bridge/bridge.mjs'), '--url', url, '--token', token, '--state-dir', stateDir, ...args], {
    cwd: ROOT,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.log = '';
  child.stdout.on('data', (d) => { child.log += d; });
  child.stderr.on('data', (d) => { child.log += d; });
  return child;
}

function startMcp(env) {
  const child = spawn(process.execPath, [path.join(ROOT, 'mcp/mcp-server.mjs')], { env: { ...process.env, ...env }, stdio: ['pipe', 'pipe', 'inherit'] });
  let buf = '';
  const waiting = new Map();
  child.stdout.on('data', (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      const msg = JSON.parse(line);
      waiting.get(msg.id)?.(msg);
    }
  });
  let n = 0;
  child.call = (method, params) =>
    new Promise((resolve) => {
      const id = ++n;
      waiting.set(id, resolve);
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    });
  return child;
}

test('people talk to agents, and agents ask each other through MCP', async (t) => {
  const { server } = createServer({ config: { dbFile: ':memory:', devAuth: true, maxDepth: 6 }, log: () => {} });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${server.address().port}`;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'crosstalk-test-'));
  const procs = [];
  t.after(() => {
    for (const p of procs) p.kill();
    server.closeAllConnections?.();
    server.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  // Two people, each with an agent.
  const alice = await CrosstalkClient.signup(url, 'Alice');
  const bob = await CrosstalkClient.signup(url, 'Bob');
  const ca = new CrosstalkClient(url, alice.token);
  const cb = new CrosstalkClient(url, bob.token);
  const mock = await ca.createAgent({ handle: 'mock', runtime: 'other' });
  const echo = await cb.createAgent({ handle: 'echo-bot', runtime: 'other' });

  const mockCmd = `${JSON.stringify(process.execPath)} ${JSON.stringify(path.join(ROOT, 'test/fixtures/mock-agent.mjs'))}`;
  procs.push(startBridge(url, mock.token, ['--adapter', 'command', '--cmd', mockCmd], path.join(tmp, 'mock')));
  procs.push(startBridge(url, echo.token, ['--adapter', 'echo'], path.join(tmp, 'echo')));
  await until(async () => (await ca.agents()).agents.every((a) => a.online));

  // Alice asks her own agent: owner standing.
  const room = (await ca.createRoom({ name: 'test-room' })).room;
  const q1 = await ca.post(room.id, '@mock hello there');
  assert.deepEqual(q1.delivered, ['mock']);
  const r1 = (await ca.waitForReply(q1.message.id, { from: 'mock', waitSeconds: 10 })).reply;
  assert.match(r1.text, /mock mock heard "mock hello there" tier=owner rules/);

  // Bob asks Alice's agent in the same room: guest standing.
  await ca.addMember(room.id, 'bob');
  const q2 = await cb.post(room.id, '@mock what about me?');
  const r2 = (await cb.waitForReply(q2.message.id, { from: 'mock', waitSeconds: 10 })).reply;
  assert.match(r2.text, /tier=guest/);

  // Alice's agent asks Bob's agent through the MCP ask_agent tool.
  const mcp = startMcp({ CROSSTALK_URL: url, CROSSTALK_TOKEN: mock.token, CROSSTALK_ROOM: room.id });
  procs.push(mcp);
  const init = await mcp.call('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '0' } });
  assert.equal(init.result.serverInfo.name, 'crosstalk');
  const list = await mcp.call('tools/list', {});
  assert.deepEqual(list.result.tools.map((x) => x.name).sort(), ['ask_agent', 'check_mentions', 'list_agents', 'list_rooms', 'read_room', 'send_message', 'whoami']);
  const ask = await mcp.call('tools/call', { name: 'ask_agent', arguments: { agent: '@echo-bot', question: 'are you there?', timeout_seconds: 15 } });
  assert.equal(ask.result.isError, undefined, JSON.stringify(ask));
  assert.match(ask.result.content[0].text, /@echo-bot replied:[\s\S]*echo from @echo-bot \(guest\)/);

  // Everyone in the room saw the agent-to-agent exchange.
  const { messages } = await cb.messages(room.id);
  const transcript = messages.map((m) => `${m.sender.handle}: ${m.text}`).join('\n');
  assert.match(transcript, /mock: @echo-bot are you there\?/);
  assert.match(transcript, /echo-bot: echo from/);

  const read = await mcp.call('tools/call', { name: 'read_room', arguments: { limit: 3 } });
  assert.match(read.result.content[0].text, /@echo-bot \(agent\)/);
});
