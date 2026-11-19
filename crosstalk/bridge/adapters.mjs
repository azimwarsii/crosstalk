// Adapters turn "here is a prompt" into "here is the agent's reply" for each agent runtime.
// Each returns { text, sessionId? }. They run the real CLI as a child process.
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export function runProcess(cmd, args, { cwd, env, input, timeoutMs = 600_000, shell = false } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd, env, shell, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const cap = 5_000_000;
    child.stdout.on('data', (d) => { if (stdout.length < cap) stdout += d; });
    child.stderr.on('data', (d) => { if (stderr.length < cap) stderr += d; });
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      setTimeout(() => child.kill('SIGKILL'), 5000).unref();
    }, timeoutMs);
    child.on('error', (e) => {
      clearTimeout(timer);
      reject(e.code === 'ENOENT' ? new Error(`"${cmd}" was not found on PATH`) : e);
    });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, stdout, stderr, timedOut: signal === 'SIGTERM' || signal === 'SIGKILL' });
    });
    child.stdin.on('error', () => {});
    child.stdin.end(input ?? '');
  });
}

/** Environment for agent processes: never leak the bridge's own token or nested-session markers. */
export function childEnv(extra = {}) {
  const env = { ...process.env };
  for (const k of ['CROSSTALK_TOKEN', 'CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_CODE_SSE_PORT']) delete env[k];
  return { ...env, ...extra };
}

function parseLastJson(stdout) {
  const s = stdout.trim();
  if (!s) return null;
  try {
    return JSON.parse(s);
  } catch {
    for (const line of s.split('\n').reverse()) {
      try {
        return JSON.parse(line);
      } catch { /* keep looking */ }
    }
  }
  return null;
}

const tail = (s, n = 600) => String(s ?? '').trim().slice(-n);

// ---------------- Claude Code ----------------
function claudeAdapter(o) {
  return {
    label: 'Claude Code',
    supportsMcp: true,
    async run({ prompt, system, tier, sessionId, mcpConfigPath }) {
      const args = ['-p', '--output-format', 'json', '--append-system-prompt', system];
      if (sessionId) args.push('--resume', sessionId);
      if (o.model) args.push('--model', o.model);
      if (tier === 'owner') {
        if (o.ownerPermissionMode) args.push('--permission-mode', o.ownerPermissionMode);
      } else {
        // Guests: plain conversation (no built-in tools), or read-only file access.
        args.push('--tools', o.guestMode === 'readonly' ? 'Read,Grep,Glob' : '');
        args.push('--permission-mode', 'dontAsk');
      }
      if (mcpConfigPath) args.push('--mcp-config', mcpConfigPath, '--allowedTools', 'mcp__crosstalk');
      const r = await runProcess(o.bin || 'claude', args, { cwd: o.cwd, env: childEnv(), input: prompt, timeoutMs: o.timeoutMs });
      if (r.timedOut) throw new Error(`Claude Code took longer than ${Math.round(o.timeoutMs / 1000)}s`);
      const out = parseLastJson(r.stdout);
      if (!out) throw new Error(`claude exited with ${r.code}: ${tail(r.stderr || r.stdout)}`);
      if (out.is_error) {
        const e = new Error(tail(out.result || out.subtype || 'Claude Code returned an error', 300));
        e.sessionProblem = /session|conversation/i.test(String(out.result));
        throw e;
      }
      return { text: out.result ?? '', sessionId: out.session_id };
    },
  };
}

// ---------------- Codex ----------------
function tomlString(s) {
  return JSON.stringify(String(s));
}

function codexMcpFlags(mcpServerPath, mcpEnv) {
  const envTable = Object.entries(mcpEnv)
    .map(([k, v]) => `${k} = ${tomlString(v)}`)
    .join(', ');
  return [
    '-c', `mcp_servers.crosstalk.command=${tomlString(process.execPath)}`,
    '-c', `mcp_servers.crosstalk.args=[${tomlString(mcpServerPath)}]`,
    '-c', `mcp_servers.crosstalk.env={ ${envTable} }`,
  ];
}

function codexAdapter(o) {
  return {
    label: 'Codex',
    supportsMcp: true,
    async run({ prompt, system, tier, sessionId, mcpEnv }) {
      const outFile = path.join(os.tmpdir(), `crosstalk-codex-${crypto.randomBytes(6).toString('hex')}.txt`);
      const sandbox = tier === 'owner' ? o.codexSandbox || 'workspace-write' : 'read-only';
      const args = ['exec', '--json', '--skip-git-repo-check', '--sandbox', sandbox, '-C', o.cwd, '--output-last-message', outFile];
      if (o.model) args.push('-m', o.model);
      if (mcpEnv && o.mcpServerPath) args.push(...codexMcpFlags(o.mcpServerPath, mcpEnv));
      if (sessionId) args.push('resume', sessionId);
      args.push('-'); // read the prompt from stdin
      const input = `${system}\n\n---\n\n${prompt}`;
      try {
        const r = await runProcess(o.bin || 'codex', args, { cwd: o.cwd, env: childEnv(), input, timeoutMs: o.timeoutMs });
        if (r.timedOut) throw new Error(`Codex took longer than ${Math.round(o.timeoutMs / 1000)}s`);
        let newSession = null;
        let lastAgentText = '';
        for (const line of r.stdout.split('\n')) {
          let ev;
          try { ev = JSON.parse(line); } catch { continue; }
          newSession ??= ev.thread_id || ev.session_id || ev.msg?.session_id || null;
          const item = ev.item || ev.msg;
          if (item && /agent_message/.test(item.type || item.item_type || '') && (item.text || item.message)) lastAgentText = item.text || item.message;
        }
        let text = fs.existsSync(outFile) ? fs.readFileSync(outFile, 'utf8') : '';
        if (!text.trim()) text = lastAgentText;
        if (r.code !== 0 && !text.trim()) {
          const e = new Error(`codex exited with ${r.code}: ${tail(r.stderr || r.stdout)}`);
          e.sessionProblem = !!sessionId;
          throw e;
        }
        return { text, sessionId: newSession || sessionId };
      } finally {
        fs.rmSync(outFile, { force: true });
      }
    },
  };
}

// ---------------- any shell command ----------------
function commandAdapter(o) {
  if (!o.cmd) throw new Error('--adapter command needs --cmd "<shell command>"');
  return {
    label: `command (${o.cmd})`,
    supportsMcp: false,
    async run({ prompt, system, tier, env, mcpEnv }) {
      const r = await runProcess(o.cmd, [], {
        shell: true,
        cwd: o.cwd,
        input: `${system}\n\n---\n\n${prompt}`,
        timeoutMs: o.timeoutMs,
        env: childEnv({
          ...mcpEnv,
          CROSSTALK_AGENT: o.me.handle,
          CROSSTALK_TIER: tier,
          CROSSTALK_MESSAGE: env.message.text,
          CROSSTALK_SENDER: env.sender.handle,
          CROSSTALK_SENDER_KIND: env.sender.kind,
        }),
      });
      if (r.timedOut) throw new Error(`command took longer than ${Math.round(o.timeoutMs / 1000)}s`);
      if (r.code !== 0) throw new Error(`command exited with ${r.code}: ${tail(r.stderr)}`);
      return { text: r.stdout };
    },
  };
}

// ---------------- echo (for testing the wiring) ----------------
function echoAdapter(o) {
  return {
    label: 'echo',
    supportsMcp: false,
    async run({ env, tier }) {
      // Break @mentions with a zero-width space so echoing never wakes other agents.
      const said = env.message.text.replace(/@/g, '@​');
      return { text: `echo from @${o.me.handle} (${tier}): ${said}` };
    },
  };
}

export function createAdapter(name, opts) {
  const factories = { claude: claudeAdapter, 'claude-code': claudeAdapter, codex: codexAdapter, command: commandAdapter, echo: echoAdapter };
  const f = factories[name];
  if (!f) throw new Error(`Unknown adapter "${name}". Use one of: claude, codex, command, echo`);
  return f(opts);
}
