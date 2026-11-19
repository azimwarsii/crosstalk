// The connector CLI: install with a token on stdin, verify, mcp, uninstall.
// Runs with CROSSTALK_NO_SERVICE so it never touches launchd/systemd.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from '../server/index.mjs';
import { CrosstalkClient } from '../lib/client.mjs';
import { buildSystemPrompt } from '../bridge/prompt.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLI = path.join(ROOT, 'cli/crosstalk.mjs');

function cli(args, { input = '', env = {} } = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, ...args], { env: { ...process.env, ...env }, stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { out += d; });
    child.stdin.end(input);
    child.on('close', (code) => resolve({ code, out }));
  });
}

test('install reads the token from stdin, saves it privately, and verify/mcp/uninstall work', async (t) => {
  const { server } = createServer({ config: { dbFile: ':memory:', devAuth: true, maxDepth: 6 }, log: () => {} });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${server.address().port}`;
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'crosstalk-cli-'));
  const env = { CROSSTALK_HOME: home, CROSSTALK_NO_SERVICE: '1' };
  t.after(() => {
    server.closeAllConnections?.();
    server.close();
    fs.rmSync(home, { recursive: true, force: true });
  });

  const owner = await CrosstalkClient.signup(url, 'Owner');
  const co = new CrosstalkClient(url, owner.token);
  const { agent, token } = await co.createAgent({ handle: 'box', runtime: 'other' });
  const other = await co.createAgent({ handle: 'other-box', runtime: 'other' });

  // Refuses a token on the command line, and a token for a different agent.
  let r = await cli(['agent', 'install', '--url', url, '--agent', '@box', '--runtime', 'echo'], { env });
  assert.equal(r.code, 1);
  assert.match(r.out, /--token-stdin/);
  r = await cli(['agent', 'install', '--url', url, '--agent', '@box', '--runtime', 'echo', '--token-stdin'], { env, input: `${other.token}\n` });
  assert.equal(r.code, 1);
  assert.match(r.out, /belongs to @other-box, not @box/);
  r = await cli(['agent', 'install', '--url', url, '--agent', '@box', '--runtime', 'echo', '--token-stdin'], { env, input: 'ct_agent_wrong\n' });
  assert.match(r.out, /rejected that token/);

  // The real install.
  r = await cli(['agent', 'install', '--url', url, '--agent', '@box', '--runtime', 'echo', '--token-stdin', '--cwd', home], { env, input: `${token}\n` });
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /Token accepted for @box/);
  assert.match(r.out, /crosstalk agent run --agent @box/);
  const file = path.join(home, 'agents', 'box', 'config.json');
  const cfg = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(cfg.token, token);
  assert.equal(cfg.agentId, agent.id);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600, 'settings file is owner-only');

  // Not running yet: verify reports it.
  r = await cli(['agent', 'verify', '--agent', '@box'], { env });
  assert.equal(r.code, 1);
  assert.match(r.out, /Hub .* accepts the token/);
  assert.match(r.out, /offline/);

  // Run the bridge from the saved config (what the service runs) and verify again.
  const bridge = spawn(process.execPath, [path.join(ROOT, 'bridge/bridge.mjs'), '--config', file], { stdio: 'ignore' });
  t.after(() => bridge.kill());
  for (let i = 0; i < 100 && !(await co.getAgent('box')).agent.online; i++) await new Promise((res) => setTimeout(res, 50));
  const seen = (await co.getAgent('box')).agent;
  assert.equal(seen.online, true);
  assert.equal(seen.setupDone, true);
  assert.equal(seen.bridge.adapter, 'echo');
  assert.equal(seen.bridge.host, os.hostname());
  r = await cli(['agent', 'verify', '--agent', '@box'], { env });
  assert.match(r.out, /Hub sees @box online from/);

  // The MCP entry point uses the saved token.
  const mcp = spawn(process.execPath, [CLI, 'mcp', '--agent', '@box'], { env: { ...process.env, ...env }, stdio: ['pipe', 'pipe', 'inherit'] });
  const reply = await new Promise((resolve) => {
    let buf = '';
    mcp.stdout.on('data', (d) => {
      buf += d;
      const lines = buf.split('\n').filter(Boolean);
      if (lines.length >= 2) resolve(JSON.parse(lines[1]));
    });
    mcp.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} })}\n`);
    mcp.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'whoami', arguments: {} } })}\n`);
  });
  mcp.kill();
  assert.match(reply.result.content[0].text, /"handle": "@box"/);

  bridge.kill();

  // Pairing code path (what the copy-paste connect prompt runs): no token on stdin at all.
  const { code } = await co.createPairCode(agent.id);
  r = await cli(['agent', 'install', '--url', url, '--agent', '@box', '--runtime', 'echo', '--pair-code', code, '--replace', '--cwd', home], { env });
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /Pairing code accepted/);
  const paired = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.notEqual(paired.token, token, 'pairing issued a fresh token');
  assert.equal((await new CrosstalkClient(url, paired.token).me()).handle, 'box');
  r = await cli(['agent', 'install', '--url', url, '--agent', '@box', '--runtime', 'echo', '--pair-code', code, '--replace', '--cwd', home], { env });
  assert.equal(r.code, 1);
  assert.match(r.out, /already used/);

  // Change settings in place: folder + access, no new token.
  r = await cli(['agent', 'set', '--agent', '@box', '--cwd', home, '--owner-permission-mode', 'auto'], { env });
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /your requests: auto/);
  assert.match(r.out, /Not running as a background service/);
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).ownerPermissionMode, 'auto');
  r = await cli(['agent', 'set', '--agent', '@box', '--owner-permission-mode', 'yolo'], { env });
  assert.equal(r.code, 1);
  assert.match(r.out, /must be one of/);
  r = await cli(['agent', 'set', '--agent', '@box', '--owner-permission-mode', 'default'], { env });
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).ownerPermissionMode, undefined);

  r = await cli(['agent', 'uninstall', '--agent', '@box'], { env });
  assert.equal(r.code, 0);
  assert.equal(fs.existsSync(path.join(home, 'agents', 'box')), false);
});

test('the agent is told its access for its owner, and guests never get it', () => {
  const me = { handle: 'box', name: 'Box', owner: { handle: 'ada' } };
  const owner = buildSystemPrompt(me, { hasTools: true, ownerMode: 'auto', cwd: '/home/ada', adapter: 'claude' });
  assert.match(owner, /full access to this computer/);
  assert.match(owner, /safety check/);
  const readOnly = buildSystemPrompt(me, { ownerMode: null, cwd: '/home/ada', adapter: 'claude' });
  assert.match(readOnly, /can read files in your working folder, but not change them/);
  const codexFull = buildSystemPrompt(me, { ownerMode: 'danger-full-access', adapter: 'codex' });
  assert.match(codexFull, /full access to this computer/);
  const guest = buildSystemPrompt(me, { hasTools: true, guestMode: 'chat' });
  assert.doesNotMatch(guest, /full access/);
  assert.match(guest, /no local tools on purpose/);
});
