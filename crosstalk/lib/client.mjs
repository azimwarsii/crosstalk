// Small Node client for the Crosstalk hub API. Used by the bridge, the MCP server and tests.

/** Parse a text/event-stream body into JSON events. */
export async function* sseEvents(url, { headers = {}, signal } = {}) {
  const res = await fetch(url, { headers: { ...headers, Accept: 'text/event-stream' }, signal });
  if (!res.ok) {
    const err = new Error(`event stream returned HTTP ${res.status}`);
    err.status = res.status;
    throw err;
  }
  const decoder = new TextDecoder();
  let buf = '';
  for await (const chunk of res.body) {
    buf += decoder.decode(chunk, { stream: true });
    let i;
    while ((i = buf.indexOf('\n\n')) >= 0) {
      const raw = buf.slice(0, i);
      buf = buf.slice(i + 2);
      const data = raw
        .split('\n')
        .filter((l) => l.startsWith('data:'))
        .map((l) => l.slice(5).replace(/^ /, ''))
        .join('\n');
      if (data) yield JSON.parse(data);
    }
  }
}

export class CrosstalkClient {
  constructor(baseUrl, token) {
    if (!baseUrl) throw new Error('Crosstalk URL is required (--url or CROSSTALK_URL)');
    this.baseUrl = String(baseUrl).replace(/\/+$/, '');
    this.token = token;
  }

  get authHeaders() {
    return this.token ? { Authorization: `Bearer ${this.token}` } : {};
  }

  async request(method, path, body, { signal } = {}) {
    const res = await fetch(this.baseUrl + path, {
      method,
      signal,
      headers: { 'Content-Type': 'application/json', ...this.authHeaders },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let data;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = { error: text };
    }
    if (!res.ok) {
      const err = new Error(data?.error || `HTTP ${res.status}`);
      err.status = res.status;
      throw err;
    }
    return data;
  }

  static async signup(baseUrl, name) {
    return new CrosstalkClient(baseUrl).request('POST', '/api/dev/signup', { name });
  }

  me() {
    return this.request('GET', '/api/me');
  }
  teams() {
    return this.request('GET', '/api/teams');
  }
  createTeam(fields) {
    return this.request('POST', '/api/teams', fields);
  }
  /** Join a team with the code from its invite link (…/join/<code>). */
  joinTeam(code) {
    return this.request('POST', `/api/invites/${encodeURIComponent(code)}`);
  }
  people(teamId) {
    return this.request('GET', `/api/teams/${encodeURIComponent(teamId)}/people`);
  }
  agents({ teamId } = {}) {
    return this.request('GET', `/api/agents${teamId ? `?team=${encodeURIComponent(teamId)}` : ''}`);
  }
  createAgent(fields) {
    return this.request('POST', '/api/agents', fields);
  }
  rooms() {
    return this.request('GET', '/api/rooms');
  }
  createRoom(fields) {
    return this.request('POST', '/api/rooms', fields);
  }
  addMember(roomId, handle) {
    return this.request('POST', `/api/rooms/${encodeURIComponent(roomId)}/members`, { handle });
  }
  openDM(handle, teamId) {
    return this.request('POST', '/api/dm', { handle, teamId });
  }
  messages(roomId, { limit, after, before } = {}) {
    const q = new URLSearchParams();
    if (limit) q.set('limit', String(limit));
    if (after) q.set('after', after);
    if (before) q.set('before', before);
    return this.request('GET', `/api/rooms/${encodeURIComponent(roomId)}/messages?${q}`);
  }
  post(roomId, text, replyTo) {
    return this.request('POST', `/api/rooms/${encodeURIComponent(roomId)}/messages`, { text, replyTo });
  }
  waitForReply(messageId, { from, waitSeconds = 30, signal } = {}) {
    const q = new URLSearchParams({ wait: String(waitSeconds) });
    if (from) q.set('from', from);
    return this.request('GET', `/api/messages/${encodeURIComponent(messageId)}/reply?${q}`, undefined, { signal });
  }
  mentions({ after, limit } = {}) {
    const q = new URLSearchParams();
    if (after) q.set('after', after);
    if (limit) q.set('limit', String(limit));
    return this.request('GET', `/api/mentions?${q}`);
  }
  status(roomId, state, detail) {
    return this.request('POST', '/api/agent/status', { roomId, state, detail });
  }
  getAgent(idOrHandle) {
    return this.request('GET', `/api/agents/${encodeURIComponent(idOrHandle)}`);
  }
  rotateToken(agentId) {
    return this.request('POST', `/api/agents/${encodeURIComponent(agentId)}/token`);
  }
  createPairCode(agentId) {
    return this.request('POST', `/api/agents/${encodeURIComponent(agentId)}/pair-code`);
  }
  /** Exchange a one-time pairing code for the agent's token (no sign-in needed). */
  static redeemPairCode(baseUrl, code, handle) {
    return new CrosstalkClient(baseUrl).request('POST', '/api/pair', { code, handle });
  }
  /** info: for a bridge, what it is and where it runs (shown to the agent's owner). */
  events({ signal, info } = {}) {
    const headers = { ...this.authHeaders };
    if (info) headers['X-Crosstalk-Bridge'] = encodeURIComponent(JSON.stringify(info));
    return sseEvents(`${this.baseUrl}/api/events`, { headers, signal });
  }
}
