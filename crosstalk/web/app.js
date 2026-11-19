(() => {
  'use strict';
  const $ = (s, el = document) => el.querySelector(s);
  const $$ = (s, el = document) => [...el.querySelectorAll(s)];
  const esc = window.escapeHtml;
  const md = window.renderMarkdown;
  const KEYS = { token: 'crosstalk.devToken', room: 'crosstalk.room', team: 'crosstalk.team', invite: 'crosstalk.invite', ui: 'crosstalk.ui2', theme: 'crosstalk.theme', seenMention: 'crosstalk.seenMention' };
  const local = {
    get: (k) => { try { return localStorage.getItem(k); } catch { return null; } },
    set: (k, v) => { try { localStorage.setItem(k, v); } catch { /* private mode */ } },
    del: (k) => { try { localStorage.removeItem(k); } catch { /* private mode */ } },
  };
  // An invite link (/join/<code>) survives the trip through sign-in.
  const JOIN_RE = /^\/join\/([A-Za-z0-9_-]{6,64})\/?$/;
  {
    const m = location.pathname.match(JOIN_RE);
    if (m) local.set(KEYS.invite, m[1]);
  }
  const PAGE = 60;
  const isMac = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
  const MOD = isMac ? '⌘' : 'Ctrl+';
  const wideQuery = window.matchMedia('(min-width: 1181px)');
  const mobileQuery = window.matchMedia('(max-width: 760px)');

  // ---------- icons (inline SVG, stroke-based) ----------
  const ICONS = {
    chat: '<path d="M4 6.5A2.5 2.5 0 0 1 6.5 4h11A2.5 2.5 0 0 1 20 6.5v8a2.5 2.5 0 0 1-2.5 2.5H10l-4.5 3.5V17A1.5 1.5 0 0 1 4 15.5z"/>',
    at: '<circle cx="12" cy="12" r="4"/><path d="M16 8v5a3 3 0 0 0 6 0v-1a10 10 0 1 0-4 8"/>',
    bot: '<rect x="4" y="8" width="16" height="12" rx="3.5"/><path d="M12 8V5"/><circle cx="12" cy="4" r="1.2"/><path d="M9 13.5h.01M15 13.5h.01M9.5 17h5"/>',
    users: '<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20a6.5 6.5 0 0 1 13 0"/><path d="M16 4.5a3.5 3.5 0 0 1 0 7M18 14a6 6 0 0 1 3.5 6"/>',
    plus: '<path d="M12 5v14M5 12h14"/>',
    hash: '<path d="M9.5 4 7.5 20M16.5 4l-2 16M4.5 9h16M3.5 15h16"/>',
    lock: '<rect x="5" y="11" width="14" height="9" rx="2.5"/><path d="M8.5 11V8a3.5 3.5 0 0 1 7 0v3"/>',
    search: '<circle cx="11" cy="11" r="6.5"/><path d="m20 20-4-4"/>',
    chevron: '<path d="m6 9 6 6 6-6"/>',
    sidebarLeft: '<rect x="3" y="4" width="18" height="16" rx="3"/><path d="M9.5 4v16"/>',
    sidebarRight: '<rect x="3" y="4" width="18" height="16" rx="3"/><path d="M14.5 4v16"/>',
    chevronsRight: '<path d="m6 7 5 5-5 5M13 7l5 5-5 5"/>',
    help: '<circle cx="12" cy="12" r="9"/><path d="M9.6 9.4a2.5 2.5 0 0 1 4.9.7c0 1.7-2.5 2-2.5 3.6M12 17h.01"/>',
    smile: '<circle cx="12" cy="12" r="9"/><path d="M8.5 14.5a4.5 4.5 0 0 0 7 0M9 9.5h.01M15 9.5h.01"/>',
    link: '<path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1"/><path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1"/>',
    bold: '<path d="M7 5h6a3.5 3.5 0 0 1 0 7H7zM7 12h7a3.5 3.5 0 0 1 0 7H7z"/>',
    italic: '<path d="M11 5h7M6 19h7M14.5 5l-5 14"/>',
    strike: '<path d="M4 12h16M16 7.5C15.4 6 13.9 5 12 5c-2.5 0-4 1.3-4 3 0 .9.4 1.6 1.1 2.2M8 16.5c.6 1.5 2.1 2.5 4 2.5 2.5 0 4-1.3 4-3 0-.6-.2-1.2-.5-1.7"/>',
    code: '<path d="m8 8-4 4 4 4M16 8l4 4-4 4"/>',
    quote: '<path d="M5 7h5v5H7.5a2.5 2.5 0 0 0 2.5 3M14 7h5v5h-2.5a2.5 2.5 0 0 0 2.5 3"/>',
    list: '<path d="M9 6.5h11M9 12h11M9 17.5h11"/><circle cx="4.5" cy="6.5" r=".9"/><circle cx="4.5" cy="12" r=".9"/><circle cx="4.5" cy="17.5" r=".9"/>',
    olist: '<path d="M10 6.5h10M10 12h10M10 17.5h10M4 5h1.2v4M4 9h2.4M4 15h2.3l-2.3 3h2.4"/>',
    send: '<path d="M4.5 12 20 4.5 15.5 20l-3-6.5z"/><path d="m12.5 13.5 3-3"/>',
    mail: '<rect x="3" y="5" width="18" height="14" rx="2.5"/><path d="m3.5 6.5 8.5 6 8.5-6"/>',
    clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
    calendar: '<rect x="4" y="5" width="16" height="15" rx="2.5"/><path d="M4 10h16M9 3v4M15 3v4"/>',
    cpu: '<rect x="7" y="7" width="10" height="10" rx="2"/><path d="M10 3v4M14 3v4M10 17v4M14 17v4M3 10h4M3 14h4M17 10h4M17 14h4"/>',
    folder: '<path d="M4 6.5A1.5 1.5 0 0 1 5.5 5H10l2 2h6.5A1.5 1.5 0 0 1 20 8.5v9a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 4 17.5z"/>',
    eye: '<path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z"/><circle cx="12" cy="12" r="3"/>',
    user: '<circle cx="12" cy="8" r="4"/><path d="M4 20a8 8 0 0 1 16 0"/>',
    monitor: '<rect x="3" y="4" width="18" height="12" rx="2"/><path d="M8 20h8M12 16v4"/>',
    activity: '<path d="M3 12h4l3-7 4 14 3-7h4"/>',
    shield: '<path d="M12 3 5 6v6c0 4.2 3 7.4 7 9 4-1.6 7-4.8 7-9V6z"/>',
    x: '<path d="M6 6l12 12M18 6 6 18"/>',
    reply: '<path d="M9 7 4 12l5 5"/><path d="M4 12h10a6 6 0 0 1 6 6"/>',
    copy: '<rect x="8" y="8" width="12" height="12" rx="2.5"/><path d="M16 8V5.5A1.5 1.5 0 0 0 14.5 4h-9A1.5 1.5 0 0 0 4 5.5v9A1.5 1.5 0 0 0 5.5 16H8"/>',
    trash: '<path d="M4 7h16M10 11v6M14 11v6M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12M9 7V4h6v3"/>',
    sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2.5v2M12 19.5v2M4.6 4.6 6 6M18 18l1.4 1.4M2.5 12h2M19.5 12h2M4.6 19.4 6 18M18 6l1.4-1.4"/>',
    moon: '<path d="M20 14.5A8 8 0 1 1 9.5 4a6.5 6.5 0 0 0 10.5 10.5z"/>',
    laptop: '<rect x="4" y="5" width="16" height="11" rx="2"/><path d="M2 19h20"/>',
    logout: '<path d="M15 4h3a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-3M10 17l5-5-5-5M15 12H3"/>',
    edit: '<path d="M4 20h4L19 9l-4-4L4 16z"/>',
    settings: '<path d="M4 7h10M18 7h2M4 17h4M12 17h8"/><circle cx="16" cy="7" r="2"/><circle cx="10" cy="17" r="2"/>',
    menu: '<path d="M4 7h16M4 12h16M4 17h16"/>',
    info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 8h.01"/>',
    key: '<circle cx="8" cy="15" r="4"/><path d="m11 12 8-8M16 7l2 2M14 9l2 2"/>',
    chevronLeft: '<path d="m15 6-6 6 6 6"/>',
    chevronRight: '<path d="m9 6 6 6-6 6"/>',
    history: '<path d="M4 12a8 8 0 1 0 2.4-5.7"/><path d="M4 4.5V8h3.5"/><path d="M12 8v4l2.5 2"/>',
    chatDots: '<path d="M4 6.5A2.5 2.5 0 0 1 6.5 4h11A2.5 2.5 0 0 1 20 6.5v8a2.5 2.5 0 0 1-2.5 2.5H10l-4.5 3.5V17A1.5 1.5 0 0 1 4 15.5z"/><path d="M8.5 10.5h.01M12 10.5h.01M15.5 10.5h.01"/>',
  };
  const icon = (name, cls = '') => `<svg class="i ${cls}" viewBox="0 0 24 24" aria-hidden="true">${ICONS[name] || ''}</svg>`;
  for (const el of $$('[data-icon]')) el.insertAdjacentHTML('afterbegin', icon(el.dataset.icon));

  const S = {
    config: null,
    me: null,
    starting: false,
    rooms: new Map(),
    agents: new Map(),
    active: null,
    msgs: new Map(), // roomId -> { list, loaded, hasMore, loadingOlder }
    statuses: new Map(),
    unread: new Map(),
    mentionsUnread: 0,
    replyTo: null,
    ac: { items: [], sel: 0, start: 0 },
    filter: '',
    panel: { mode: 'room', id: null }, // room | profile | search | mentions | directory
    panelNarrowOpen: false,
    search: { q: '', results: null, busy: false },
    mentions: null,
    settings: null,
    roomDialog: null,
    nav: { stack: [], index: -1, moving: false },
    people: new Map(), // people in the current team
    teams: new Map(),
    teamId: null, // the team the sidebar shows
    appReady: false,
    eventsStarted: false,
  };
  const UI = (() => {
    try {
      return { sidebar: true, collapsed: {}, panel: true, ...JSON.parse(local.get(KEYS.ui) || '{}') };
    } catch {
      return { sidebar: true, collapsed: {}, panel: true };
    }
  })();
  const saveUi = () => local.set(KEYS.ui, JSON.stringify(UI));

  // ---------- theme ----------
  const currentTheme = () => document.documentElement.getAttribute('data-theme') || 'light';
  function setTheme(t) {
    document.documentElement.setAttribute('data-theme', t);
    local.set(KEYS.theme, t);
  }

  // ---------- auth: Clerk (Google) in production, a name-only form in development ----------
  const Auth = { mode: null, getToken: async () => null, signOut: async () => {}, manage: null };
  const SIGN_IN_PATH = '/sign-in';
  const SIGN_UP_PATH = '/sign-up';
  const onAuthPage = () => location.pathname.startsWith(SIGN_IN_PATH) || location.pathname.startsWith(SIGN_UP_PATH);

  const clerkAppearance = () => {
    const css = getComputedStyle(document.documentElement);
    const v = (n, d) => css.getPropertyValue(n).trim() || d;
    return {
      variables: {
        colorPrimary: v('--solid', '#111114'),
        colorBackground: v('--app', '#ffffff'),
        colorText: v('--text', '#1c1c21'),
        colorTextSecondary: v('--muted', '#8b8b96'),
        colorInputBackground: v('--app', '#ffffff'),
        colorInputText: v('--text', '#1c1c21'),
        borderRadius: '12px',
        fontFamily: 'inherit',
      },
    };
  };

  function loadScript(src, attrs = {}) {
    return new Promise((resolve, reject) => {
      const s = document.createElement('script');
      for (const [k, v] of Object.entries(attrs)) s.setAttribute(k, v);
      s.async = true;
      s.crossOrigin = 'anonymous';
      s.src = src;
      s.addEventListener('load', () => resolve());
      s.addEventListener('error', () => reject(new Error(`Could not load ${new URL(src).pathname}`)));
      document.head.appendChild(s);
    });
  }

  // ClerkJS v6 ships its UI (sign-in box, account page) as a separate bundle (@clerk/ui).
  // Both come from your Clerk instance's own domain.
  async function loadClerk({ publishableKey, frontendApi }) {
    const base = `https://${frontendApi}/npm`;
    await loadScript(`${base}/@clerk/clerk-js@6/dist/clerk.browser.js`, { 'data-clerk-publishable-key': publishableKey });
    await loadScript(`${base}/@clerk/ui@1/dist/ui.browser.js`);
    if (!window.__internal_ClerkUICtor) throw new Error('Clerk UI did not register');
    await window.Clerk.load({
      ui: { ClerkUI: window.__internal_ClerkUICtor },
      appearance: clerkAppearance(),
      telemetry: { disabled: true },
      // Keep every step (Google, new-account sign-up, bot checks) on our own pages instead of
      // Clerk's hosted Account Portal.
      signInUrl: SIGN_IN_PATH,
      signUpUrl: SIGN_UP_PATH,
      signInFallbackRedirectUrl: '/',
      signUpFallbackRedirectUrl: '/',
    });
    return window.Clerk;
  }

  // ---------- helpers ----------
  class ApiError extends Error {}
  async function api(method, path, body) {
    const token = await Auth.getToken();
    const res = await fetch(path, {
      method,
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const e = new ApiError(data.error || `Request failed (${res.status})`);
      e.status = res.status;
      if (res.status === 401 && S.me) signedOut();
      throw e;
    }
    return data;
  }
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const hue = (s) => [...String(s)].reduce((h, c) => (h * 31 + c.charCodeAt(0)) % 360, 7);
  const initials = (name) => String(name || '?').split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]).join('').toUpperCase() || '?';
  const runtimeLabel = (r) => ({ 'claude-code': 'Claude Code', codex: 'Codex' })[r] || 'Agent';
  const snippet = (t, n = 80) => { const s = String(t).replace(/\s+/g, ' ').trim(); return s.length > n ? `${s.slice(0, n)}…` : s; };
  const fmtTime = (t) => new Date(t).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  const fmtDate = (t) => new Date(t).toLocaleDateString(undefined, { day: 'numeric', month: 'long', year: 'numeric' });
  const isJoined = (room) => room.members.some((m) => m.kind === 'user' && m.id === S.me.id);
  const agentOf = (m) => (m && m.kind === 'agent' ? S.agents.get(m.id) || m : m);
  const mine = (a) => !!a && a.owner?.id === S.me?.id;
  const sameDay = (a, b) => new Date(a).toDateString() === new Date(b).toDateString();
  function rel(t) {
    const s = (Date.now() - t) / 1000;
    if (s < 45) return 'just now';
    if (s < 3600) return `${Math.max(1, Math.round(s / 60))} min ago`;
    if (sameDay(t, Date.now())) return fmtTime(t);
    if (sameDay(t, Date.now() - 864e5)) return `Yesterday ${fmtTime(t)}`;
    return new Date(t).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  }
  const ago = (t) => (t ? rel(t) : 'never');
  const timeEl = (t) => `<time datetime="${new Date(t).toISOString()}" data-ts="${t}" title="${esc(new Date(t).toLocaleString())}">${rel(t)}</time>`;
  function dayLabel(t) {
    const d = new Date(t);
    if (sameDay(t, Date.now())) return 'Today';
    if (sameDay(t, Date.now() - 864e5)) return 'Yesterday';
    return d.toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric', ...(d.getFullYear() !== new Date().getFullYear() ? { year: 'numeric' } : {}) });
  }
  setInterval(() => { for (const el of $$('time[data-ts]')) el.textContent = rel(Number(el.dataset.ts)); }, 30_000);

  function avatar(e, { size = '', presence = false } = {}) {
    if (!e) return '';
    const isAgent = e.kind === 'agent';
    const imageUrl = !isAgent && /^https:\/\//.test(e.imageUrl || '') ? e.imageUrl : null;
    const online = isAgent ? (S.agents.get(e.id)?.online ?? e.online) : e.id === S.me?.id || (S.people.get(e.id)?.online ?? e.online);
    const dot = presence && (isAgent || online !== undefined) ? `<span class="dot ${online ? 'on' : ''}"></span>` : '';
    const style = imageUrl ? '' : ` style="background:hsl(${hue(e.handle)} 55% ${isAgent ? 46 : 52}%)"`;
    const inner = imageUrl ? `<img src="${esc(imageUrl)}" alt="" referrerpolicy="no-referrer" loading="lazy">` : esc(initials(e.name));
    return `<span class="avatar ${isAgent ? 'agent' : ''} ${size}"${style}>${inner}${dot}</span>`;
  }

  /** The other side of a direct message: an agent, or another person. */
  function dmOther(room) {
    const m = room.members.find((x) => x.kind === 'agent') || room.members.find((x) => x.kind === 'user' && x.id !== S.me?.id);
    if (!m) return null;
    return m.kind === 'agent' ? agentOf(m) : { ...m, ...(S.people.get(m.id) || {}), kind: 'user' };
  }
  function roomTitle(room) {
    if (room.kind === 'dm') return dmOther(room)?.name || room.name;
    return room.name;
  }

  // ---------- teams ----------
  const currentTeam = () => S.teams.get(S.teamId) || null;
  const teamRooms = (teamId = S.teamId) => [...S.rooms.values()].filter((r) => r.teamId === teamId);
  /** Agents you can use in the current team: yours, and shared ones of its members. */
  const inTeamAgent = (a) => mine(a) || S.people.has(a.owner?.id);
  const teamUnread = (teamId) => teamRooms(teamId).reduce((n, r) => n + (S.unread.get(r.id) || 0), 0);
  const inviteUrl = (t) => `${location.origin}/join/${encodeURIComponent(t.inviteCode)}`;
  function teamTile(t, size = '') {
    if (!t) return '';
    return `<span class="team-tile ${size}" style="background:hsl(${hue(t.slug || t.name)} 58% 50%)" aria-hidden="true">${esc((String(t.name).trim()[0] || '?').toUpperCase())}</span>`;
  }
  /** "https://hub/join/abc", "/join/abc" or just "abc". */
  const codeFrom = (text) => {
    const v = String(text || '').trim();
    return (v.match(/\/join\/([A-Za-z0-9_-]+)/) || [])[1] || v;
  };

  let toastTimer;
  function toast(text) {
    const el = $('#toast');
    el.textContent = text;
    el.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { el.hidden = true; }, 4000);
  }

  // ---------- floating menus ----------
  let menuAnchor = null;
  function openMenu(anchor, items, { align = 'start', side = 'below' } = {}) {
    const el = $('#menu');
    if (menuAnchor === anchor && !el.hidden) return closeMenu();
    closeMenu();
    menuAnchor = anchor;
    anchor.setAttribute('aria-expanded', 'true');
    el.innerHTML = items.filter(Boolean).map((it, i) => {
      if (it === '-') return '<div class="msep"></div>';
      if (it.html) return it.html;
      if (it.label && !it.action) return `<div class="mlabel">${esc(it.label)}</div>`;
      const lead = it.lead || (it.icon ? icon(it.icon) : '');
      const text = it.sub ? `<span class="mtext"><span>${esc(it.text)}</span><small>${esc(it.sub)}</small></span>` : `<span>${esc(it.text)}</span>`;
      return `<button class="mi ${it.danger ? 'danger' : ''} ${it.checked ? 'checked' : ''}" type="button" role="menuitem" data-mi="${i}">${lead}${text}${it.badge ? `<span class="badge">${esc(it.badge)}</span>` : ''}</button>`;
    }).join('');
    el.hidden = false;
    el.onclick = (e) => {
      const b = e.target.closest('[data-mi]');
      if (!b) return;
      const it = items.filter(Boolean)[Number(b.dataset.mi)];
      closeMenu();
      it?.action?.();
    };
    const r = anchor.getBoundingClientRect();
    const mw = el.offsetWidth;
    const mh = el.offsetHeight;
    let left = side === 'right' ? r.right + 10 : align === 'end' ? r.right - mw : r.left;
    let top = side === 'right' ? r.bottom - mh : side === 'above' ? r.top - mh - 8 : r.bottom + 6;
    left = Math.max(8, Math.min(left, innerWidth - mw - 8));
    top = Math.max(8, Math.min(top, innerHeight - mh - 8));
    el.style.left = `${left}px`;
    el.style.top = `${top}px`;
    el.querySelector('.mi')?.focus({ preventScroll: true });
  }
  function closeMenu() {
    $('#menu').hidden = true;
    menuAnchor?.setAttribute('aria-expanded', 'false');
    menuAnchor = null;
  }
  const themeItems = () => [
    { label: 'Theme' },
    { text: 'Light', icon: 'sun', checked: currentTheme() === 'light', action: () => setTheme('light') },
    { text: 'Dark', icon: 'moon', checked: currentTheme() === 'dark', action: () => setTheme('dark') },
    { text: 'Match system', icon: 'laptop', checked: currentTheme() === 'system', action: () => setTheme('system') },
  ];
  const createItems = () => [
    { text: 'New room', icon: 'hash', action: () => openRoomDialog() },
    { text: 'Connect an agent', icon: 'bot', action: openConnectAgent },
    { text: 'New message', icon: 'chat', action: () => openNewMessage() },
  ];

  // ---------- boot ----------
  function showOnly(id) {
    for (const x of ['boot', 'signin', 'onboard', 'app']) $(`#${x}`).hidden = x !== id;
  }
  function bootError(text) {
    showOnly('boot');
    $('#boot').innerHTML = `<span class="logo lg" aria-hidden="true"></span><strong>Crosstalk can’t start</strong><span class="muted">${esc(text)}</span><button class="btn" type="button" onclick="location.reload()">Try again</button>`;
  }

  async function main() {
    try {
      const res = await fetch('/api/config');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      S.config = await res.json();
    } catch (e) {
      return bootError(`Could not reach the hub (${e.message}).`);
    }
    if (S.config.auth === 'clerk') {
      Auth.mode = 'clerk';
      let clerk;
      try {
        clerk = await loadClerk(S.config.clerk);
      } catch (e) {
        return bootError(`Could not load sign-in (${e.message}). Check your connection, or the Clerk keys on the server.`);
      }
      Auth.getToken = async () => (clerk.session ? clerk.session.getToken() : null);
      Auth.signOut = () => clerk.signOut();
      Auth.manage = () => clerk.openUserProfile({ appearance: clerkAppearance() });
      clerk.addListener(({ user }) => {
        if (user && !S.me && !S.starting) start();
        if (!user && S.me) location.reload();
      });
      return clerk.user ? start() : showSignin();
    }
    Auth.mode = 'dev';
    Auth.getToken = async () => local.get(KEYS.token);
    Auth.signOut = async () => local.del(KEYS.token);
    return local.get(KEYS.token) ? start() : showSignin();
  }

  let signInMounted = null; // 'in' | 'up' | null
  function showSignin(message = '') {
    showOnly('signin');
    $('#signin-error').textContent = message;
    if (Auth.mode === 'clerk') {
      if (!signInMounted) {
        const clerk = window.Clerk;
        const el = $('#clerk-signin');
        if (!onAuthPage()) history.replaceState(null, '', SIGN_IN_PATH);
        if (location.pathname.startsWith(SIGN_UP_PATH)) {
          clerk.mountSignUp(el, { routing: 'path', path: SIGN_UP_PATH, signInUrl: SIGN_IN_PATH, appearance: clerkAppearance() });
          signInMounted = 'up';
        } else {
          // withSignUp: someone new signing in with Google continues straight into sign-up here.
          clerk.mountSignIn(el, { routing: 'path', path: SIGN_IN_PATH, signUpUrl: SIGN_UP_PATH, withSignUp: true, appearance: clerkAppearance() });
          signInMounted = 'in';
        }
      }
    } else {
      $('#dev-signin').hidden = false;
      $('#dev-name').focus();
    }
  }

  $('#dev-signin').addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      const { token } = await api('POST', '/api/dev/signup', { name: $('#dev-name').value });
      local.set(KEYS.token, token);
      await start();
    } catch (x) {
      $('#signin-error').textContent = x.message;
    }
  });

  function signedOut() {
    if (Auth.mode === 'dev') local.del(KEYS.token);
    location.reload();
  }

  async function start() {
    S.starting = true;
    try {
      S.me = await api('GET', '/api/me');
    } catch (e) {
      S.starting = false;
      if (e.status === 401 && Auth.mode === 'dev') local.del(KEYS.token);
      return showSignin(e.status === 401 ? '' : `Could not sign you in: ${e.message}`);
    }
    if (S.me.kind !== 'user') {
      S.me = null;
      S.starting = false;
      return showSignin('That is an agent token. Sign in as a person.');
    }
    if (signInMounted) {
      if (signInMounted === 'up') window.Clerk.unmountSignUp($('#clerk-signin'));
      else window.Clerk.unmountSignIn($('#clerk-signin'));
      signInMounted = null;
    }
    if (onAuthPage() || JOIN_RE.test(location.pathname) || location.hash.startsWith('#/') || /__clerk/.test(location.search)) history.replaceState(null, '', '/');
    S.teams = new Map((S.me.teams || []).map((t) => [t.id, t]));
    renderMe();
    S.starting = false;
    const code = local.get(KEYS.invite);
    if (code) return showInvite(code);
    if (!S.teams.size) return showOnboard();
    return enterApp();
  }

  /** Show the app for a team (the last one used, unless told otherwise). */
  async function enterApp(teamId = null, roomId = null) {
    const saved = local.get(KEYS.team);
    S.teamId = [teamId, saved].find((id) => id && S.teams.has(id)) || S.teams.keys().next().value;
    local.set(KEYS.team, S.teamId);
    applyUi();
    try {
      await Promise.all([loadRooms(), loadAgents(), loadPeople()]);
    } catch (e) {
      return bootError(e.message);
    }
    showOnly('app');
    S.appReady = true;
    renderTeamSwitch();
    renderSidebar();
    await openTeamRoom(roomId);
    if (!S.eventsStarted) {
      S.eventsStarted = true;
      connectEvents();
    }
    refreshMentions(true);
  }

  /** Open a room in the current team: the one asked for, the last one used, or #general. */
  async function openTeamRoom(roomId = null) {
    const ok = (id) => id && S.rooms.get(id)?.teamId === S.teamId;
    const target = [roomId, local.get(`${KEYS.room}.${S.teamId}`)].find(ok) || lobbyRoom()?.id;
    if (target) return openRoom(target);
    S.active = null;
    renderAll();
  }
  const lobbyRoom = () => {
    const rooms = teamRooms().filter((r) => r.kind === 'room');
    return rooms.find((r) => r.slug === 'general') || rooms.find(isJoined) || rooms[0] || teamRooms()[0] || null;
  };

  /** Make another team current: its people, then its last room. */
  async function setTeam(teamId) {
    if (!S.teams.has(teamId) || teamId === S.teamId) return;
    S.teamId = teamId;
    local.set(KEYS.team, teamId);
    S.people = new Map();
    S.filter = '';
    $('#side-filter').value = '';
    if (['people', 'directory', 'profile'].includes(S.panel.mode)) S.panel = { mode: 'room', id: null };
    renderTeamSwitch();
    try { await loadPeople(); } catch (e) { toast(e.message); }
    renderSidebar();
  }
  async function switchTeam(teamId, roomId = null) {
    closeMenu();
    await setTeam(teamId);
    await openTeamRoom(roomId);
  }
  /** After creating or joining a team: pick up its rooms and agents, then go there. */
  async function goToTeam(team, roomId = null) {
    S.teams.set(team.id, team);
    local.del(KEYS.invite);
    if (!S.appReady) return enterApp(team.id, roomId);
    await Promise.all([loadRooms(), loadAgents()]);
    if (team.id === S.teamId) { await loadPeople(); renderAll(); return openTeamRoom(roomId); }
    return switchTeam(team.id, roomId);
  }

  function renderTeamSwitch() {
    const t = currentTeam();
    $('#ws-tile').innerHTML = teamTile(t, 'sm');
    $('#ws-name').textContent = t?.name || 'Crosstalk';
    const others = [...S.teams.keys()].filter((id) => id !== S.teamId).reduce((n, id) => n + teamUnread(id), 0);
    $('#ws-switch').classList.toggle('has-unread', others > 0);
    $('#ws-switch').title = others ? `Switch team (${others} unread in other teams)` : 'Switch team';
  }

  // ---------- onboarding: no team yet, or an invite link ----------
  function moveTeamForms(where, tab = 'create') {
    $(where).appendChild($('#team-forms'));
    setTeamTab(tab);
    for (const f of [$('#form-team-create'), $('#form-team-join')]) {
      f.reset();
      f.querySelector('[data-error]').textContent = '';
    }
    loadOpenTeams();
  }
  function setTeamTab(tab) {
    for (const b of $$('[data-team-tab]')) b.classList.toggle('on', b.dataset.teamTab === tab);
    for (const p of $$('#team-forms .tf-pane')) p.hidden = p.dataset.pane !== tab;
    setTimeout(() => $(`#team-forms [data-pane="${tab}"] input`)?.focus(), 30);
  }
  $('#team-forms').addEventListener('click', (e) => {
    const tab = e.target.closest('[data-team-tab]');
    if (tab) setTeamTab(tab.dataset.teamTab);
  });

  async function loadOpenTeams() {
    try {
      const { teams } = await api('GET', '/api/teams/discover');
      $('#open-teams-section').hidden = !teams.length;
      $('#open-teams').innerHTML = teams.map((t) => `<li>${teamTile(t, 'md')}<span class="grow"><strong>${esc(t.name)}</strong><small>${t.memberCount} member${t.memberCount === 1 ? '' : 's'}</small></span><button class="btn sm" type="button" data-join-team="${esc(t.id)}">Join</button></li>`).join('');
    } catch { $('#open-teams-section').hidden = true; }
  }
  $('#open-teams').addEventListener('click', async (e) => {
    const b = e.target.closest('[data-join-team]');
    if (!b) return;
    b.disabled = true;
    try {
      const { team } = await api('POST', `/api/teams/${encodeURIComponent(b.dataset.joinTeam)}/join`);
      $('#dlg-team').close();
      await goToTeam(team, team.lobbyId);
    } catch (x) {
      b.disabled = false;
      $('#form-team-join [data-error]').textContent = x.message;
    }
  });

  function showOnboard() {
    showOnly('onboard');
    $('#onboard-invite').hidden = true;
    $('#onboard-main').hidden = false;
    $('#onboard-me').textContent = `Signed in as ${S.me.name}${S.me.email ? ` (${S.me.email})` : ''}`;
    moveTeamForms('#onboard-forms', 'create');
  }

  async function showInvite(code) {
    showOnly('onboard');
    $('#onboard-me').textContent = `Signed in as ${S.me.name}${S.me.email ? ` (${S.me.email})` : ''}`;
    $('#onboard-main').hidden = true;
    $('#onboard-invite').hidden = false;
    $('#invite-error').textContent = '';
    $('#invite-accept').hidden = false;
    $('#invite-skip').textContent = 'Not now';
    try {
      const { team } = await api('GET', `/api/invites/${encodeURIComponent(code)}`);
      if (team.member) {
        local.del(KEYS.invite);
        S.teams.set(team.id, team);
        return enterApp(team.id);
      }
      $('#invite-tile').innerHTML = teamTile(team, 'xl');
      $('#invite-team-name').textContent = team.name;
      $('#invite-team-meta').textContent = `${team.memberCount} member${team.memberCount === 1 ? '' : 's'}`;
      $('#invite-accept').textContent = `Join ${team.name}`;
      $('#invite-accept').onclick = async () => {
        $('#invite-accept').disabled = true;
        try {
          const { team: joined } = await api('POST', `/api/invites/${encodeURIComponent(code)}`);
          await goToTeam(joined, joined.lobbyId);
        } catch (x) {
          $('#invite-error').textContent = x.message;
        } finally {
          $('#invite-accept').disabled = false;
        }
      };
    } catch (x) {
      $('#invite-tile').innerHTML = '';
      $('#invite-team-name').textContent = 'This invite doesn’t work';
      $('#invite-team-meta').textContent = '';
      $('#invite-error').textContent = x.message;
      $('#invite-accept').hidden = true;
      $('#invite-skip').textContent = 'Continue';
    }
  }
  $('#invite-skip').addEventListener('click', () => {
    local.del(KEYS.invite);
    if (S.teams.size) enterApp();
    else showOnboard();
  });
  $('#onboard-signout').addEventListener('click', () => signOut());

  wireForm($('#form-team-create'), async (fd) => {
    const { team } = await api('POST', '/api/teams', { name: fd.get('name'), visibility: fd.get('visibility') });
    $('#dlg-team').close();
    await goToTeam(team, team.lobbyId);
    toast(`Created ${team.name}. Invite people from the team menu.`);
  });
  wireForm($('#form-team-join'), async (fd) => {
    const code = codeFrom(fd.get('code'));
    if (!code) throw new Error('Paste an invite link');
    const { team } = await api('POST', `/api/invites/${encodeURIComponent(code)}`);
    $('#dlg-team').close();
    await goToTeam(team, team.lobbyId);
  });

  function openTeamDialog(tab = 'create') {
    closeMenu();
    moveTeamForms('#dlg-team-body', tab);
    $('#app').classList.remove('nav-open');
    $('#dlg-team').showModal();
  }

  // ---------- team settings ----------
  function openTeamSettings() {
    closeMenu();
    const t = currentTeam();
    if (!t) return;
    const form = $('#form-team-settings');
    form.reset();
    form.querySelector('[data-error]').textContent = '';
    form.elements.name.value = t.name;
    form.elements.visibility.value = t.visibility;
    renderTeamSettings();
    $('#app').classList.remove('nav-open');
    if (!$('#dlg-team-settings').open) $('#dlg-team-settings').showModal();
  }
  function renderTeamSettings() {
    const t = currentTeam();
    if (!t) return;
    const owner = t.role === 'owner';
    const form = $('#form-team-settings');
    $('#ts-title').textContent = `${t.name} settings`;
    for (const el of form.elements) if (el.name) el.disabled = !owner;
    for (const el of $$('#dlg-team-settings [data-owner-only]')) el.hidden = !owner;
    $('#ts-link').textContent = inviteUrl(t);
    const people = [...S.people.values()].sort((a, b) => (b.role === 'owner') - (a.role === 'owner') || a.name.localeCompare(b.name));
    $('#ts-members-title').textContent = `Members · ${people.length}`;
    $('#ts-members').innerHTML = people.map((u) => `<li>${avatar({ ...u, kind: 'user', imageUrl: u.id === S.me.id ? S.me.imageUrl : u.imageUrl }, { presence: true })}<span class="grow"><strong>${esc(u.name)}${u.id === S.me.id ? ' <span class="muted">(you)</span>' : ''}</strong><small>@${esc(u.handle)} · ${u.role === 'owner' ? 'Owner' : 'Member'}</small></span>${owner && u.id !== S.me.id ? `<button class="btn sm" type="button" data-team-remove="${esc(u.id)}">Remove</button>` : ''}</li>`).join('');
    $('#ts-leave').hidden = people.length <= 1;
  }
  wireForm($('#form-team-settings'), async (fd) => {
    const { team } = await api('PATCH', `/api/teams/${encodeURIComponent(S.teamId)}`, { name: fd.get('name'), visibility: fd.get('visibility') });
    S.teams.set(team.id, { ...currentTeam(), ...team });
    renderTeamSwitch();
    renderTeamSettings();
    toast('Team saved');
  });
  $('#ts-reset').addEventListener('click', async () => {
    if (!confirm('Make a new invite link? The current link stops working.')) return;
    try {
      const { team } = await api('POST', `/api/teams/${encodeURIComponent(S.teamId)}/invite`);
      S.teams.set(team.id, { ...currentTeam(), ...team });
      renderTeamSettings();
      toast('New invite link made');
    } catch (x) { toast(x.message); }
  });
  $('#ts-members').addEventListener('click', async (e) => {
    const b = e.target.closest('[data-team-remove]');
    if (!b) return;
    const u = S.people.get(b.dataset.teamRemove);
    if (!confirm(`Remove ${u?.name || 'them'} from ${currentTeam().name}? They lose access to its rooms and DMs.`)) return;
    try {
      await api('DELETE', `/api/teams/${encodeURIComponent(S.teamId)}/members/${encodeURIComponent(b.dataset.teamRemove)}`);
      S.people.delete(b.dataset.teamRemove);
      renderTeamSettings();
      renderSidebar();
    } catch (x) { toast(x.message); }
  });
  $('#ts-leave').addEventListener('click', async () => {
    const t = currentTeam();
    if (!confirm(`Leave ${t.name}? You lose access to its rooms and DMs until someone invites you again.`)) return;
    try {
      await api('POST', `/api/teams/${encodeURIComponent(t.id)}/leave`);
      $('#dlg-team-settings').close();
      leftTeam(t.id, `You left ${t.name}`);
    } catch (x) { toast(x.message); }
  });
  $('#ts-delete').addEventListener('click', async () => {
    const t = currentTeam();
    const typed = prompt(`Delete ${t.name} for everyone? Its rooms, DMs and messages are deleted and can’t be recovered.\n\nType the team name to confirm:`);
    if (typed === null) return;
    if (typed.trim() !== t.name) return toast('The name didn’t match, so nothing was deleted.');
    try {
      await api('DELETE', `/api/teams/${encodeURIComponent(t.id)}`);
      $('#dlg-team-settings').close();
      leftTeam(t.id, `Deleted ${t.name}`);
    } catch (x) { toast(x.message); }
  });

  /** You are out of a team (left, removed, or it was deleted): drop it and move on. */
  async function leftTeam(teamId, message) {
    const t = S.teams.get(teamId);
    S.teams.delete(teamId);
    for (const r of teamRooms(teamId)) { S.rooms.delete(r.id); S.msgs.delete(r.id); S.unread.delete(r.id); }
    if (message || t) toast(message || `You’re no longer in ${t.name}`);
    try { await loadAgents(); } catch { /* keep the old list */ }
    if (teamId !== S.teamId) return renderAll();
    if ($('#dlg-team-settings').open) $('#dlg-team-settings').close();
    const next = S.teams.keys().next().value;
    if (!next) {
      S.teamId = null;
      S.active = null;
      S.appReady = false;
      return showOnboard();
    }
    await switchTeam(next);
  }

  function renderMe() {
    $('#me-avatar').outerHTML = avatar({ ...S.me, kind: 'user' }).replace('<span class="', '<span id="me-avatar" class="');
    $('#btn-me').title = `${S.me.name} (@${S.me.handle})`;
  }

  async function loadRooms() {
    const { rooms } = await api('GET', '/api/rooms');
    S.rooms = new Map(rooms.map((r) => [r.id, r]));
  }
  async function loadPeople() {
    if (!S.teamId) { S.people = new Map(); return; }
    const teamId = S.teamId;
    const { people } = await api('GET', `/api/teams/${encodeURIComponent(teamId)}/people`);
    if (teamId === S.teamId) S.people = new Map(people.map((u) => [u.id, u]));
  }
  async function loadTeams() {
    const { teams } = await api('GET', '/api/teams');
    S.teams = new Map(teams.map((t) => [t.id, t]));
  }
  async function loadAgents() {
    const { agents } = await api('GET', '/api/agents');
    S.agents = new Map(agents.map((a) => [a.id, a]));
    for (const a of agents) if (a.status?.state === 'thinking') S.statuses.set(a.id, { ...a.status, agentId: a.id, handle: a.handle });
  }
  const roomState = (id) => {
    if (!S.msgs.has(id)) S.msgs.set(id, { list: [], loaded: false, hasMore: false, loadingOlder: false });
    return S.msgs.get(id);
  };
  async function loadMessages(id) {
    const { messages } = await api('GET', `/api/rooms/${encodeURIComponent(id)}/messages?limit=${PAGE}`);
    Object.assign(roomState(id), { list: messages, loaded: true, hasMore: messages.length === PAGE });
  }
  async function loadOlder() {
    const st = roomState(S.active);
    if (!st.hasMore || st.loadingOlder || !st.list.length) return false;
    st.loadingOlder = true;
    const roomId = S.active;
    const el = $('#messages');
    try {
      const { messages } = await api('GET', `/api/rooms/${encodeURIComponent(roomId)}/messages?before=${encodeURIComponent(st.list[0].id)}&limit=${PAGE}`);
      const have = new Set(st.list.map((m) => m.id));
      st.list = [...messages.filter((m) => !have.has(m.id)), ...st.list];
      st.hasMore = messages.length === PAGE;
    } catch (e) {
      toast(e.message);
    } finally {
      st.loadingOlder = false;
    }
    if (S.active !== roomId) return false;
    const fromBottom = el.scrollHeight - el.scrollTop;
    renderMessages({ keep: true });
    el.scrollTop = el.scrollHeight - fromBottom;
    return true;
  }

  // ---------- realtime ----------
  let connTimer;
  function setConn(ok) {
    clearTimeout(connTimer);
    if (ok) $('#conn-banner').hidden = true;
    else connTimer = setTimeout(() => { $('#conn-banner').hidden = false; }, 1500);
  }

  async function connectEvents() {
    let backoff = 1000;
    let first = true;
    for (;;) {
      try {
        const token = await Auth.getToken();
        const res = await fetch('/api/events', { headers: { Authorization: `Bearer ${token}`, Accept: 'text/event-stream' } });
        if (res.status === 401) return signedOut();
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        setConn(true);
        backoff = 1000;
        if (!first) await resync();
        first = false;
        const reader = res.body.getReader();
        const dec = new TextDecoder();
        let buf = '';
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buf += dec.decode(value, { stream: true });
          let i;
          while ((i = buf.indexOf('\n\n')) >= 0) {
            const raw = buf.slice(0, i);
            buf = buf.slice(i + 2);
            const data = raw.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trimStart()).join('\n');
            if (data) {
              try { onEvent(JSON.parse(data)); } catch (err) { console.error(err); }
            }
          }
        }
      } catch (err) {
        console.warn('event stream:', err.message);
      }
      setConn(false);
      await sleep(backoff);
      backoff = Math.min(backoff * 2, 15000);
    }
  }

  async function resync() {
    await loadTeams();
    if (!S.teams.has(S.teamId)) return leftTeam(S.teamId);
    await Promise.all([loadRooms(), loadAgents(), loadPeople()]);
    if (S.active && S.rooms.has(S.active)) await loadMessages(S.active);
    renderTeamSwitch();
    renderAll();
  }

  function onEvent(evt) {
    switch (evt.type) {
      case 'message': return onMessage(evt.message);
      case 'message_deleted': {
        const m = roomState(evt.roomId).list.find((x) => x.id === evt.messageId);
        if (m) Object.assign(m, { deleted: true, text: '' });
        if (evt.roomId === S.active) renderMessages({ keep: true });
        return;
      }
      case 'team': {
        const known = S.teams.has(evt.team.id);
        S.teams.set(evt.team.id, { ...S.teams.get(evt.team.id), ...evt.team });
        if (!S.appReady) return;
        renderTeamSwitch();
        if (!known) loadRooms().then(loadAgents).then(renderAll).catch(() => {});
        if (evt.team.id === S.teamId && $('#dlg-team-settings').open) renderTeamSettings();
        return;
      }
      case 'team_member':
        if (evt.teamId === S.teamId) {
          S.people.set(evt.person.id, evt.person);
          renderSidebar();
          if (S.panel.mode === 'people') renderPanel();
          if ($('#dlg-team-settings').open) renderTeamSettings();
        }
        loadAgents().then(() => { renderSidebar(); if (S.panel.mode === 'directory') renderPanel(); }).catch(() => {});
        return;
      case 'team_member_removed':
        if (evt.teamId === S.teamId) {
          S.people.delete(evt.userId);
          renderAll();
          if ($('#dlg-team-settings').open) renderTeamSettings();
        }
        return;
      case 'team_removed':
        if (S.teams.has(evt.teamId)) leftTeam(evt.teamId);
        return;
      case 'room': {
        const r = evt.room;
        const visible = (!r.teamId || S.teams.has(r.teamId)) && (r.visibility === 'public' || r.members.some((m) => m.kind === 'user' && m.id === S.me.id));
        if (visible) S.rooms.set(r.id, r);
        else S.rooms.delete(r.id);
        renderSidebar();
        if (r.id === S.active) {
          if (visible) { renderHeader(); renderPanel(); } else openFallback();
        }
        return;
      }
      case 'agent': {
        const prev = S.agents.get(evt.agent.id);
        S.agents.set(evt.agent.id, { ...prev, ...evt.agent });
        renderSidebar();
        renderHeader();
        renderPanel();
        refreshSettingsLive(evt.agent.id);
        return;
      }
      case 'person':
        if (S.people.has(evt.person.id)) S.people.set(evt.person.id, { ...S.people.get(evt.person.id), ...evt.person });
        renderSidebar();
        if (S.panel.mode === 'profile') renderPanel();
        return;
      case 'agent_removed':
        S.agents.delete(evt.agentId);
        S.statuses.delete(evt.agentId);
        renderAll();
        return;
      case 'presence': {
        if (evt.userId) {
          const u = S.people.get(evt.userId);
          if (u) u.online = evt.online;
          renderSidebar();
          if (S.panel.mode === 'people' || S.panel.mode === 'profile') renderPanel();
          return;
        }
        const a = S.agents.get(evt.agentId);
        if (a) {
          a.online = evt.online;
          if (evt.lastSeenAt) a.lastSeenAt = evt.lastSeenAt;
        }
        for (const r of S.rooms.values()) for (const m of r.members) if (m.id === evt.agentId) m.online = evt.online;
        if (!evt.online) S.statuses.delete(evt.agentId);
        refreshSettingsLive(evt.agentId);
        renderSidebar();
        renderHeader();
        renderPanel();
        renderThinking();
        return;
      }
      case 'status':
        if (evt.state === 'thinking') S.statuses.set(evt.agentId, evt);
        else S.statuses.delete(evt.agentId);
        renderThinking();
        return;
      default:
    }
  }

  function onMessage(m) {
    const st = S.msgs.get(m.roomId);
    if (st?.loaded && !st.list.some((x) => x.id === m.id)) st.list.push(m);
    const room = S.rooms.get(m.roomId);
    if (room) room.lastMessageAt = m.createdAt;
    const fromOther = m.sender.id !== S.me.id && m.sender.kind !== 'system';
    const visible = m.roomId === S.active && !document.hidden;
    if (!visible && room && isJoined(room) && fromOther) S.unread.set(m.roomId, (S.unread.get(m.roomId) || 0) + 1);
    if (m.roomId === S.active) renderMessages({ forceBottom: visible && m.sender.id === S.me.id });
    const forMe = fromOther && ((m.mentions || []).includes(S.me.handle) || room?.kind === 'dm');
    if (forMe) {
      if (S.mentions) S.mentions = [{ ...m, room: { id: m.roomId, name: room?.name } }, ...S.mentions].slice(0, 50);
      if (!(visible && panelShowing('mentions'))) {
        if (!visible) S.mentionsUnread++;
        renderMentionBadges();
      }
      if (panelShowing('mentions')) renderPanel();
    }
    renderSidebar();
  }

  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && S.active && S.unread.has(S.active)) {
      S.unread.delete(S.active);
      renderSidebar();
    }
  });

  // ---------- layout state ----------
  const panelVisible = () => (wideQuery.matches ? UI.panel : S.panelNarrowOpen);
  const panelShowing = (mode) => panelVisible() && S.panel.mode === mode && !$('#panel').hidden;

  function applyUi() {
    const collapsed = !UI.sidebar && !mobileQuery.matches;
    $('#app').classList.toggle('side-collapsed', collapsed);
    $('#rail-rooms').setAttribute('aria-pressed', String(!collapsed));
    $('#rail-rooms').title = `${collapsed ? 'Show' : 'Hide'} rooms and messages (${MOD}B)`;
    for (const sec of $$('.side-section')) {
      const c = !!UI.collapsed[sec.dataset.section] && !S.filter;
      sec.classList.toggle('collapsed', c);
      $('.section-toggle', sec).setAttribute('aria-expanded', String(!c));
    }
    const show = panelVisible() && !!S.active;
    $('#panel').hidden = !show;
    $('#btn-details').setAttribute('aria-pressed', String(show && S.panel.mode === 'room'));
    $('#btn-search').setAttribute('aria-pressed', String(show && S.panel.mode === 'search'));
    for (const b of $$('.nav-item[data-nav]')) b.classList.toggle('active', show && S.panel.mode === b.dataset.nav);
    if (show) renderPanel();
  }
  wideQuery.addEventListener('change', applyUi);
  mobileQuery.addEventListener('change', applyUi);

  function toggleSidebar(force) {
    if (mobileQuery.matches) return $('#app').classList.toggle('nav-open');
    UI.sidebar = typeof force === 'boolean' ? force : !UI.sidebar;
    saveUi();
    applyUi();
  }
  function setPanelOpen(open) {
    if (wideQuery.matches) {
      UI.panel = open;
      saveUi();
    } else {
      S.panelNarrowOpen = open;
    }
    applyUi();
  }
  function openPanel(mode, id = null) {
    S.panel = { mode, id };
    $('#app').classList.remove('nav-open');
    setPanelOpen(true);
    if (mode === 'mentions') {
      S.mentionsUnread = 0;
      local.set(KEYS.seenMention, String(Date.now()));
      renderMentionBadges();
      refreshMentions();
    }
    if (mode === 'search') setTimeout(() => $('#search-input')?.focus(), 30);
  }
  function togglePanel(mode, id = null) {
    if (panelVisible() && S.panel.mode === mode && (id === null || S.panel.id === id)) return setPanelOpen(false);
    openPanel(mode, id);
  }

  $('#rail-rooms').addEventListener('click', () => toggleSidebar());
  $('#rail-mentions').addEventListener('click', () => togglePanel('mentions'));
  $('#rail-agents').addEventListener('click', () => openSettings(null));
  $('#rail-home').addEventListener('click', () => { toggleSidebar(true); openFallback(); });
  $('#rail-create').addEventListener('click', (e) => openMenu(e.currentTarget, createItems(), { side: 'right' }));
  $('#btn-create').addEventListener('click', (e) => openMenu(e.currentTarget, createItems(), { side: 'above' }));
  $('#rail-help').addEventListener('click', (e) => openMenu(e.currentTarget, [
    { label: 'Getting started' },
    { text: 'Connect your agent', icon: 'bot', action: openConnectAgent },
    { text: 'Browse agents', icon: 'users', action: () => openPanel('directory') },
    '-',
    { label: 'Shortcuts' },
    { html: `<div class="minfo"><span>Jump to</span><kbd>${MOD}K</kbd></div>` },
    { html: `<div class="minfo"><span>Toggle sidebar</span><kbd>${MOD}B</kbd></div>` },
    { html: '<div class="minfo"><span>Send · new line</span><kbd>Enter · Shift+Enter</kbd></div>' },
    { html: '<div class="minfo"><span>Mention an agent</span><kbd>@</kbd></div>' },
    '-',
    { html: `<div class="minfo"><span>Crosstalk</span><span>v${esc(S.config?.version || '')}</span></div>` },
  ], { side: 'right' }));
  $('#btn-me').addEventListener('click', (e) => openMenu(e.currentTarget, [
    { html: `<div class="mhead">${avatar({ ...S.me, kind: 'user' })}<span><strong>${esc(S.me.name)}</strong><small>@${esc(S.me.handle)}${S.me.email ? ` · ${esc(S.me.email)}` : ''}</small></span></div>` },
    '-',
    { text: 'Your profile', icon: 'user', action: () => openPanel('profile', `user:${S.me.id}`) },
    { text: 'Your agents', icon: 'bot', action: () => openSettings(null) },
    Auth.manage ? { text: 'Manage account', icon: 'shield', action: () => Auth.manage() } : null,
    '-',
    ...themeItems(),
    '-',
    { text: 'Sign out', icon: 'logout', danger: true, action: signOut },
  ], { side: 'right' }));
  $('#ws-switch').addEventListener('click', (e) => {
    const t = currentTeam();
    const teams = [...S.teams.values()].sort((a, b) => (a.joinedAt || 0) - (b.joinedAt || 0));
    openMenu(e.currentTarget, [
      { label: 'Your teams' },
      ...teams.map((x) => {
        const n = x.id === S.teamId ? 0 : teamUnread(x.id);
        return { text: x.name, sub: `${x.memberCount} member${x.memberCount === 1 ? '' : 's'}${x.visibility === 'open' ? ' · open' : ''}`, lead: teamTile(x, 'md'), checked: x.id === S.teamId, badge: n ? (n > 99 ? '99+' : String(n)) : '', action: () => x.id !== S.teamId && switchTeam(x.id) };
      }),
      { text: 'Create a team', icon: 'plus', action: () => openTeamDialog('create') },
      { text: 'Join a team', icon: 'link', action: () => openTeamDialog('join') },
      '-',
      t ? { label: t.name } : null,
      t ? { text: 'Invite people', icon: 'mail', action: openInvite } : null,
      t ? { text: 'Team settings', icon: 'settings', action: openTeamSettings } : null,
      t ? { text: 'People', icon: 'users', action: () => openPanel('people') } : null,
    ]);
  });
  async function signOut() {
    if (Auth.mode === 'dev' && !confirm('Sign out? In development mode this browser forgets the account.')) return;
    await Auth.signOut();
    location.href = '/';
  }

  // ---------- back / forward / recent rooms ----------
  function recordVisit(id) {
    const n = S.nav;
    if (n.moving) return updateNavButtons();
    if (n.stack[n.index] === id) return updateNavButtons();
    n.stack = n.stack.slice(0, n.index + 1).concat(id).slice(-50);
    n.index = n.stack.length - 1;
    updateNavButtons();
  }
  function updateNavButtons() {
    const n = S.nav;
    $('#btn-back').disabled = !n.stack.slice(0, n.index).some((id) => S.rooms.has(id));
    $('#btn-forward').disabled = !n.stack.slice(n.index + 1).some((id) => S.rooms.has(id));
  }
  async function goHistory(step) {
    const n = S.nav;
    let i = n.index + step;
    while (i >= 0 && i < n.stack.length && !S.rooms.has(n.stack[i])) i += step;
    if (i < 0 || i >= n.stack.length) return;
    n.index = i;
    n.moving = true;
    try { await openRoom(n.stack[i]); } finally { n.moving = false; updateNavButtons(); }
  }
  $('#btn-back').addEventListener('click', () => goHistory(-1));
  $('#btn-forward').addEventListener('click', () => goHistory(1));
  $('#btn-history').addEventListener('click', (e) => {
    const seen = new Set();
    const recent = [...S.nav.stack].reverse().filter((id) => S.rooms.has(id) && id !== S.active && !seen.has(id) && seen.add(id)).slice(0, 8);
    openMenu(e.currentTarget, [
      { label: 'Recent' },
      ...(recent.length
        ? recent.map((id) => {
          const r = S.rooms.get(id);
          return { text: r.kind === 'dm' ? roomTitle(r) : `#${r.name}`, icon: r.kind === 'dm' ? 'chat' : r.visibility === 'private' ? 'lock' : 'hash', action: () => openRoom(id) };
        })
        : [{ html: '<div class="minfo"><span>Rooms you visit show up here.</span></div>' }]),
      '-',
      { text: `Jump to…   ${MOD}K`, icon: 'search', action: () => toggleFind(true) },
      { text: `${UI.sidebar ? 'Hide' : 'Show'} sidebar   ${MOD}B`, icon: 'sidebarLeft', action: () => toggleSidebar() },
    ]);
  });
  function openDirectMessages() {
    const dms = teamRooms().filter((r) => r.kind === 'dm');
    const unread = dms.filter((r) => S.unread.get(r.id)).sort((a, b) => (b.lastMessageAt || 0) - (a.lastMessageAt || 0));
    if (unread.length) return openRoom(unread[0].id);
    UI.collapsed.dms = false;
    saveUi();
    applyUi();
    const sec = $('[data-section="dms"]');
    sec.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    if (!dms.length) openNewMessage();
  }

  function toggleFind(force) {
    if (force === false) return clearFilter();
    $('#side-filter').focus();
    $('#side-filter').select();
  }
  if (!isMac) $('#kbd-k').textContent = 'Ctrl K';
  function clearFilter() {
    $('#side-filter').value = '';
    S.filter = '';
    renderSidebar();
    applyUi();
  }
  for (const sec of $$('.side-section')) {
    $('.section-toggle', sec).addEventListener('click', () => {
      UI.collapsed[sec.dataset.section] = !UI.collapsed[sec.dataset.section];
      saveUi();
      applyUi();
    });
  }
  $('#side-filter').addEventListener('input', (e) => {
    S.filter = e.target.value;
    renderSidebar();
    applyUi();
  });
  $('#side-filter').addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { toggleFind(false); $('#input').focus(); }
    if (e.key === 'Enter') {
      const first = $('#sidebar .side-list li[data-room], #sidebar .side-list li[data-agent]');
      if (first) first.click();
      toggleFind(false);
    }
  });
  document.addEventListener('keydown', (e) => {
    const mod = isMac ? e.metaKey : e.ctrlKey;
    if (!S.me) return;
    if (mod && e.key.toLowerCase() === 'k') {
      e.preventDefault();
      if (!UI.sidebar && !mobileQuery.matches) toggleSidebar(true);
      if (mobileQuery.matches) $('#app').classList.add('nav-open');
      toggleFind(true);
    }
    if (mod && (e.key === '[' || e.key === ']') && document.activeElement !== $('#input')) {
      e.preventDefault();
      goHistory(e.key === '[' ? -1 : 1);
    }
    if (mod && e.key.toLowerCase() === 'b' && document.activeElement !== $('#input')) {
      e.preventDefault();
      toggleSidebar();
    }
    if (e.key === 'Escape') {
      closeMenu();
      $('#emoji-pop').hidden = true;
    }
  });

  // ---------- rendering ----------
  function renderAll() {
    renderSidebar();
    renderHeader();
    renderMessages({ keep: true });
    renderThinking();
    renderPanel();
  }

  function renderMentionBadges() {
    const n = S.mentionsUnread;
    for (const id of ['#rail-mentions-badge', '#nav-mentions-badge']) {
      $(id).hidden = !n;
      $(id).textContent = n > 99 ? '99+' : String(n);
    }
  }

  async function refreshMentions(countOnly = false) {
    try {
      const { mentions } = await api('GET', '/api/mentions?limit=50');
      S.mentions = mentions.reverse();
      if (countOnly) {
        const seen = Number(local.get(KEYS.seenMention) || 0);
        S.mentionsUnread = S.mentions.filter((m) => m.createdAt > seen).length;
        renderMentionBadges();
      }
      if (panelShowing('mentions')) renderPanel();
    } catch (e) {
      if (!countOnly) toast(e.message);
    }
  }

  function renderSidebar() {
    if (!S.me) return;
    const f = S.filter.trim().toLowerCase();
    const match = (...xs) => !f || xs.some((x) => String(x ?? '').toLowerCase().includes(f));
    const byRecent = (a, b) => (b.lastMessageAt || 0) - (a.lastMessageAt || 0);
    const item = (room, label, lead) => {
      const unread = S.unread.get(room.id);
      return `<li data-room="${room.id}" class="${room.id === S.active ? 'active' : ''} ${unread ? 'unread' : ''} ${isJoined(room) ? '' : 'unjoined'}" title="${esc(label)}">
        ${lead}<span class="label">${esc(label)}</span>${unread ? `<span class="badge">${unread > 99 ? '99+' : unread}</span>` : ''}</li>`;
    };
    const rooms = teamRooms();
    const channels = rooms.filter((r) => r.kind === 'room' && match(r.name, r.topic)).sort((a, b) => isJoined(b) - isJoined(a) || byRecent(a, b));
    $('#room-list').innerHTML =
      channels.map((r) => item(r, r.name, `<span class="room-icon">${icon(r.visibility === 'private' ? 'lock' : 'hash')}</span>`)).join('') +
      (f ? (channels.length ? '' : '<li class="empty">No matching rooms</li>') : `<li class="add-row" data-open="new-room"><span class="room-icon">${icon('plus')}</span><span class="label">Add room</span></li>`);

    const dms = rooms.filter((r) => r.kind === 'dm' && match(roomTitle(r))).sort(byRecent);
    $('#dm-list').innerHTML =
      dms.map((r) => {
        const other = dmOther(r);
        return item(r, roomTitle(r), other ? avatar(other, { size: 'sm', presence: true }) : `<span class="room-icon">${icon('at')}</span>`);
      }).join('') + (f ? (dms.length ? '' : '<li class="empty">No matching messages</li>') : `<li class="add-row" data-open="new-dm"><span class="room-icon">${icon('plus')}</span><span class="label">New message</span></li>`);

    const people = [...S.people.values()].filter((u) => u.id !== S.me.id && match(u.name, u.handle)).sort((a, b) => (b.online ? 1 : 0) - (a.online ? 1 : 0) || a.name.localeCompare(b.name));
    const shown = f ? people : people.slice(0, 8);
    $('#people-list').innerHTML =
      shown.map((u) => `<li data-person="${u.id}" title="${esc(`${u.name} (@${u.handle})`)}">${avatar({ ...u, kind: 'user' }, { size: 'sm', presence: true })}<span class="label">${esc(u.name)}</span>
        <button class="icon-btn sm row-act" type="button" data-dm-handle="${esc(u.handle)}" title="Message ${esc(u.name)}" aria-label="Message ${esc(u.name)}">${icon('chat', 'sm')}</button></li>`).join('') +
      (people.length > shown.length ? `<li class="more-row" data-nav-open="people"><span class="room-icon">${icon('users')}</span><span class="label">See all ${people.length} people</span></li>` : '') +
      (f ? (people.length ? '' : '<li class="empty">No matching people</li>')
        : `${people.length ? '' : `<li class="empty">No one else is in ${esc(currentTeam()?.name || 'this team')} yet.</li>`}<li class="add-row" data-open="invite"><span class="room-icon">${icon('plus')}</span><span class="label">Invite people</span></li>`);

    const agents = [...S.agents.values()].filter((a) => inTeamAgent(a) && match(a.name, a.handle, a.description)).sort((a, b) => mine(b) - mine(a) || b.online - a.online || a.handle.localeCompare(b.handle));
    $('#agent-list').innerHTML =
      agents.map((a) => `<li data-agent="${a.id}" title="${esc(`${a.name} (@${a.handle})${a.description ? ` — ${a.description}` : ''}`)}">
        ${avatar(a, { size: 'sm', presence: true })}<span class="label">${esc(a.name)}</span>
        ${mine(a) ? (a.setupDone === false ? '<span class="tag warn">set up</span>' : '<span class="tag plain">yours</span>') : ''}</li>`).join('') +
      (f ? (agents.length ? '' : '<li class="empty">No matching agents</li>') : `<li class="add-row" data-open="connect"><span class="room-icon">${icon('plus')}</span><span class="label">Connect your agent</span></li>`);

    $('#nav-setup').hidden = ![...S.agents.values()].some((a) => mine(a) && a.setupDone === false);
    const dmUnread = rooms.filter((r) => r.kind === 'dm').reduce((n, r) => n + (S.unread.get(r.id) || 0), 0);
    $('#nav-dms-badge').hidden = !dmUnread;
    $('#nav-dms-badge').textContent = dmUnread > 99 ? '99+' : String(dmUnread);
    updateNavButtons();
    const total = [...S.unread.values()].reduce((n, x) => n + x, 0);
    document.title = total ? `(${total}) ${currentTeam()?.name || 'Crosstalk'}` : `${currentTeam()?.name ? `${currentTeam().name} · ` : ''}Crosstalk`;
    renderTeamSwitch();
  }

  function renderHeader() {
    const room = S.rooms.get(S.active);
    if (!room) return;
    const other = room.kind === 'dm' ? dmOther(room) : null;
    const dmAgent = other?.kind === 'agent' ? other : null;
    $('#room-pill-lead').innerHTML = other ? avatar(other, { size: 'xs', presence: true }) : icon(room.visibility === 'private' ? 'lock' : 'hash');
    $('#room-name').textContent = roomTitle(room);
    $('#room-topic').textContent = dmAgent
      ? `${dmAgent.online ? 'Online' : 'Offline'} · ${runtimeLabel(dmAgent.runtime)}${dmAgent.owner ? ` · by ${dmAgent.owner.name}` : ''}`
      : other ? `Direct message · @${other.handle}` : room.topic || '';
    const members = [...room.members].sort((a, b) => (b.kind === 'agent') - (a.kind === 'agent') || (agentOf(b).online ? 1 : 0) - (agentOf(a).online ? 1 : 0));
    $('#head-avatars').hidden = room.kind !== 'room';
    $('#head-avatars').innerHTML = members.slice(0, 3).map((m) => avatar(agentOf(m), { size: 'sm' })).join('') + `<span class="count">${members.length}</span>`;
    $('#head-avatars').title = `${members.length} member${members.length === 1 ? '' : 's'}`;
    const joined = isJoined(room);
    $('#input').placeholder = !joined && room.kind === 'room' ? `You're previewing #${room.name}. Sending a message joins it.` : room.kind === 'dm' ? `Message ${roomTitle(room)}…` : `Message #${room.name}…`;
  }

  function emptyRoomHtml(room) {
    if (room?.kind === 'dm' && dmOther(room)?.kind === 'user') {
      const u = dmOther(room);
      return `<div class="empty-room">${avatar(u, { size: 'lg' })}<h2>${esc(u.name)}</h2><p>This is the start of your direct messages with @${esc(u.handle)}. Only the two of you can see them. To bring in agents, talk in a room.</p></div>`;
    }
    if (room?.kind === 'dm') {
      const a = agentOf(room.members.find((m) => m.kind === 'agent') || {});
      return `<div class="empty-room">${avatar(a, { size: 'lg', presence: true })}<h2>Talk to ${esc(a.name || 'this agent')}</h2><p>Everything you send here goes straight to @${esc(a.handle || '')}. ${a.online ? 'It’s online now.' : 'It’s offline right now and will answer when it reconnects.'}</p></div>`;
    }
    return `<div class="empty-room"><h2>Welcome to #${esc(room?.name || '')}</h2><p>Type <code>@</code> to mention an agent. Agents can mention each other too — try “@coder ask @reviewer to check your answer”.</p>
      <div class="row-actions"><button class="btn" type="button" data-open="add-member">${icon('plus', 'sm')}Add people or agents</button><button class="solid" type="button" data-open="connect">${icon('bot', 'sm')}Connect your own</button></div></div>`;
  }

  function canDelete(m, room) {
    if (m.deleted || m.sender.kind === 'system') return false;
    if (m.sender.kind === 'user' && m.sender.id === S.me.id) return true;
    if (m.sender.kind === 'agent' && mine(S.agents.get(m.sender.id))) return true;
    return room?.createdBy === S.me.id;
  }

  function senderOf(m) {
    if (m.sender.kind === 'agent') return agentOf(m.sender);
    if (m.sender.kind === 'user' && m.sender.id === S.me.id) return { ...m.sender, imageUrl: S.me.imageUrl };
    return m.sender;
  }

  function renderMessages({ forceBottom = false, keep = false } = {}) {
    const el = $('#messages');
    const room = S.rooms.get(S.active);
    const st = roomState(S.active);
    if (!room) { el.innerHTML = ''; return; }
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 160;
    if (!st.loaded) { el.innerHTML = '<div class="empty-room"><p>Loading…</p></div>'; return; }
    if (!st.list.length) { el.innerHTML = emptyRoomHtml(room); return; }
    const byId = new Map(st.list.map((m) => [m.id, m]));
    let html = st.hasMore ? `<div class="load-older"><button class="btn sm" type="button" data-older>${st.loadingOlder ? 'Loading…' : 'Load earlier messages'}</button></div>` : '';
    let group = null;
    const close = () => { if (group) { html += '</div></div>'; group = null; } };
    let prev = null;
    for (const m of st.list) {
      if (!prev || !sameDay(prev.createdAt, m.createdAt)) {
        close();
        html += `<div class="day" role="separator">${esc(dayLabel(m.createdAt))}</div>`;
      }
      prev = m;
      if (m.sender.kind === 'system') {
        close();
        html += `<div class="system-line" data-id="${m.id}">${md(m.text)}</div>`;
        continue;
      }
      const startNew = !group || group.sender !== m.sender.id || m.createdAt - group.last > 5 * 60e3;
      if (startNew) {
        close();
        const who = senderOf(m);
        const isAgent = m.sender.kind === 'agent';
        const mentionsMe = (m.mentions || []).includes(S.me.handle) && !m.deleted;
        html += `<div class="group ${mentionsMe ? 'mentions-me' : ''}">
          <span data-profile="${m.sender.kind}:${m.sender.id}">${avatar(who)}</span>
          <div><div class="meta"><button class="name" type="button" data-profile="${m.sender.kind}:${m.sender.id}">${esc(m.sender.name)}</button>${isAgent ? `<span class="tag">${runtimeLabel(who.runtime)}</span>` : ''}${timeEl(m.createdAt)}${m.depth > 1 ? `<span class="hop" title="Agent-to-agent hop count">· hop ${m.depth}</span>` : ''}</div>`;
        group = { sender: m.sender.id, last: m.createdAt };
      }
      group.last = m.createdAt;
      const parent = m.replyTo ? byId.get(m.replyTo) : null;
      const quote = parent
        ? `<div class="reply-quote" data-jump="${parent.id}"><div class="who">${esc(parent.sender.name)}${timeEl(parent.createdAt)}</div><div class="what">${esc(parent.deleted ? 'Deleted message' : `“${snippet(parent.text, 140)}”`)}</div></div>`
        : m.replyTo ? '<div class="reply-quote"><div class="what muted">Replying to an earlier message</div></div>' : '';
      html += `<div class="msg" data-id="${m.id}">${quote}
        <div class="bubble ${m.deleted ? 'deleted' : ''}">${m.deleted ? 'This message was deleted.' : md(m.text)}</div>
        ${m.deleted ? '' : `<div class="msg-actions"><button type="button" data-act="reply" data-id="${m.id}" title="Reply">${icon('reply', 'sm')}</button><button type="button" data-act="copy" data-id="${m.id}" title="Copy text">${icon('copy', 'sm')}</button>${canDelete(m, room) ? `<button type="button" data-act="delete" data-id="${m.id}" title="Delete">${icon('trash', 'sm')}</button>` : ''}</div>`}
      </div>`;
    }
    close();
    el.innerHTML = html;
    for (const s of $$('.mention', el)) if (s.dataset.handle.toLowerCase() === S.me.handle) s.classList.add('me');
    if (forceBottom || nearBottom) el.scrollTop = el.scrollHeight;
  }

  function renderThinking() {
    const who = [...S.statuses.values()].filter((s) => s.roomId === S.active && s.state === 'thinking');
    $('#thinking').innerHTML = who.length ? `${who.map((s) => `<strong>@${esc(s.handle)}</strong>`).join(', ')} ${who.length > 1 ? 'are' : 'is'} working<span class="dots"></span>` : '';
  }

  // ---------- right panel ----------
  const infoRow = (ic, html) => `<li>${icon(ic)}<span class="v">${html}</span></li>`;
  const statusPill = (a) => (a.online ? '<span class="pill ok"><span class="dot"></span>Active</span>' : `<span class="pill off"><span class="dot"></span>Offline</span>${a.lastSeenAt ? ` <small>Last seen ${esc(ago(a.lastSeenAt))}</small>` : ''}`);

  function memberRow(m, room) {
    const e = agentOf(m);
    const isAgent = m.kind === 'agent';
    const canRemove = room.kind === 'room' && !(m.kind === 'user' && m.id === S.me.id) && (room.createdBy === S.me.id || (isAgent && mine(e)));
    const sub = isAgent ? `@${e.handle} · ${runtimeLabel(e.runtime)} · ${e.online ? 'online' : 'offline'}` : `@${e.handle}${room.createdBy === m.id ? ' · created this room' : ''}${m.id === S.me.id ? ' · you' : ''}`;
    return `<div class="row click" data-profile="${m.kind}:${m.id}">${avatar(m.kind === 'user' && m.id === S.me.id ? { ...e, imageUrl: S.me.imageUrl } : e, { size: 'sm', presence: true })}
      <span class="grow"><strong>${esc(e.name)}</strong><small>${esc(sub)}</small></span>
      ${canRemove ? `<button class="icon-btn sm" type="button" data-remove="${m.id}" title="Remove from room" aria-label="Remove ${esc(e.name)} from room">${icon('x', 'sm')}</button>` : ''}</div>`;
  }

  function findPerson(id) {
    if (id === S.me.id) return { kind: 'user', ...S.me };
    if (S.people.has(id)) return { kind: 'user', ...S.people.get(id) };
    for (const r of S.rooms.values()) {
      const m = r.members.find((x) => x.kind === 'user' && x.id === id);
      if (m) return m;
    }
    for (const a of S.agents.values()) if (a.owner?.id === id) return { kind: 'user', ...a.owner };
    return null;
  }

  function renderPanel() {
    const panel = $('#panel');
    if (panel.hidden) return;
    const body = $('#panel-body');
    const foot = $('#panel-foot');
    const title = $('#panel-title');
    const room = S.rooms.get(S.active);
    const { mode, id } = S.panel;
    foot.innerHTML = '';

    if (mode === 'profile' && id?.startsWith('agent:')) {
      const a = S.agents.get(id.slice(6));
      if (!a) { S.panel = { mode: 'room', id: null }; return renderPanel(); }
      title.textContent = `${a.name}’s profile`;
      const b = a.bridge;
      body.innerHTML = `<div class="profile-top">${avatar(a, { size: 'xl', presence: true })}<h3>${esc(a.name)}</h3><p>${runtimeLabel(a.runtime)} agent</p></div>
        <ul class="info">
          ${infoRow('at', `@${esc(a.handle)}`)}
          ${infoRow('user', a.owner ? `Owned by <a href="#" data-profile="user:${a.owner.id}">${esc(a.owner.name)}</a>` : 'No owner')}
          ${infoRow('cpu', esc(runtimeLabel(a.runtime)))}
          ${infoRow('eye', a.visibility === 'public' ? 'Anyone in its owner’s teams can talk to it' : 'Only its owner can talk to it')}
          ${infoRow('shield', mine(a) ? 'You’re its owner: it acts on your requests' : 'You’re a guest: it chats, but won’t act on its computer for you')}
          ${mine(a) && b ? infoRow('monitor', `${esc(b.host || '?')}<small>${esc(b.cwd || '')}</small>`) : ''}
          ${infoRow('calendar', `Added ${esc(fmtDate(a.createdAt))}`)}
          ${infoRow('activity', statusPill(a))}
        </ul>
        ${a.description ? `<div class="p-section"><h4>About</h4><p>${esc(a.description)}</p></div>` : ''}`;
      const canAdd = room?.kind === 'room' && !room.members.some((m) => m.id === a.id);
      foot.innerHTML = `<button class="btn" type="button" data-pact="dm" data-handle="${esc(a.handle)}">${icon('send', 'sm')}Message</button>` +
        (mine(a) ? `<button class="btn" type="button" data-settings-for="${a.id}">${icon('settings', 'sm')}Settings</button>`
          : canAdd ? `<button class="btn" type="button" data-pact="add" data-handle="${esc(a.handle)}">${icon('plus', 'sm')}Add to room</button>`
          : `<button class="btn" type="button" data-pact="mention" data-handle="${esc(a.handle)}">${icon('at', 'sm')}Mention</button>`);
      return;
    }

    if (mode === 'profile' && id?.startsWith('user:')) {
      const u = findPerson(id.slice(5));
      if (!u) { S.panel = { mode: 'room', id: null }; return renderPanel(); }
      const isMe = u.id === S.me.id;
      title.textContent = isMe ? 'Your profile' : `${u.name}’s profile`;
      const theirAgents = [...S.agents.values()].filter((a) => a.owner?.id === u.id);
      body.innerHTML = `<div class="profile-top">${avatar({ ...u, kind: 'user', imageUrl: isMe ? S.me.imageUrl : u.imageUrl }, { size: 'xl' })}<h3>${esc(u.name)}</h3><p>@${esc(u.handle)}</p></div>
        <ul class="info">
          ${isMe && S.me.email ? infoRow('mail', `<a href="mailto:${esc(S.me.email)}">${esc(S.me.email)}</a>`) : ''}
          ${infoRow('at', `@${esc(u.handle)}`)}
          ${u.createdAt ? infoRow('calendar', `Joined ${esc(fmtDate(u.createdAt))}`) : ''}
          ${infoRow('bot', `${theirAgents.length} agent${theirAgents.length === 1 ? '' : 's'}`)}
          ${infoRow('clock', `${esc(fmtTime(Date.now()))} your local time`)}
        </ul>
        ${theirAgents.length ? `<div class="p-section"><h4>Agents</h4>${theirAgents.map((a) => `<div class="row click" data-profile="agent:${a.id}">${avatar(a, { size: 'sm', presence: true })}<span class="grow"><strong>${esc(a.name)}</strong><small>@${esc(a.handle)} · ${runtimeLabel(a.runtime)}</small></span></div>`).join('')}</div>` : ''}`;
      foot.innerHTML = isMe
        ? `<button class="btn" type="button" data-pact="my-agents">${icon('bot', 'sm')}Your agents</button>${Auth.manage ? `<button class="btn" type="button" data-pact="account">${icon('shield', 'sm')}Account</button>` : ''}`
        : `<button class="btn" type="button" data-pact="dm" data-handle="${esc(u.handle)}">${icon('send', 'sm')}Message</button><button class="btn" type="button" data-pact="mention" data-handle="${esc(u.handle)}">${icon('at', 'sm')}Mention</button>`;
      return;
    }

    if (mode === 'search') {
      title.textContent = room ? `Search ${room.kind === 'dm' ? roomTitle(room) : `#${room.name}`}` : 'Search';
      const s = S.search;
      const re = s.q.length >= 2 ? new RegExp(s.q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi') : null;
      const hi = (t) => (re ? esc(t).replace(new RegExp(esc(s.q).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi'), (x) => `<mark>${x}</mark>`) : esc(t));
      body.innerHTML = `<form class="panel-search" id="search-form"><input id="search-input" type="search" placeholder="Search messages…" value="${esc(s.q)}" autocomplete="off"></form>
        <div id="search-results">${s.busy ? '<p class="muted">Searching…</p>' : s.results === null ? '<p class="muted small">Find messages in this room by any word or name.</p>'
          : s.results.length ? s.results.map((m) => `<div class="result" data-jump="${m.id}"><div class="top">${avatar(senderOf(m), { size: 'xs' })}<strong>${esc(m.sender.name)}</strong>${timeEl(m.createdAt)}</div><div class="txt">${hi(snippet(m.text, 220))}</div></div>`).join('')
          : '<p class="muted">No messages match.</p>'}</div>`;
      return;
    }

    if (mode === 'mentions') {
      title.textContent = 'Mentions & replies';
      const list = S.mentions;
      body.innerHTML = !list ? '<p class="muted">Loading…</p>' : list.length
        ? list.map((m) => `<div class="result" data-open-room="${m.roomId}" data-jump-id="${m.id}"><div class="top">${avatar(senderOf(m), { size: 'xs' })}<strong>${esc(m.sender.name)}</strong><span class="muted">in ${esc(S.rooms.get(m.roomId) ? (S.rooms.get(m.roomId).kind === 'dm' ? roomTitle(S.rooms.get(m.roomId)) : `#${m.room?.name || S.rooms.get(m.roomId).name}`) : m.room?.name || '')}${m.room?.teamId && m.room.teamId !== S.teamId && S.teams.get(m.room.teamId) ? ` · ${esc(S.teams.get(m.room.teamId).name)}` : ''}</span>${timeEl(m.createdAt)}</div><div class="txt">${esc(snippet(m.text, 220))}</div></div>`).join('')
        : '<div class="empty-room" style="margin:30px auto"><p>When someone @mentions you, or an agent answers you in a direct message, it shows up here.</p></div>';
      return;
    }

    if (mode === 'people') {
      title.textContent = 'People';
      const q = (S.peopleQuery || '').toLowerCase();
      const list = [...S.people.values()].filter((u) => !q || [u.name, u.handle].some((x) => String(x || '').toLowerCase().includes(q))).sort((a, b) => (b.id === S.me.id) - (a.id === S.me.id) || (b.online ? 1 : 0) - (a.online ? 1 : 0) || a.name.localeCompare(b.name));
      body.innerHTML = `<form class="panel-search" id="people-form"><input id="people-input" type="search" placeholder="Find a person…" value="${esc(S.peopleQuery || '')}" autocomplete="off"></form>
        <div>${list.map((u) => `<div class="row click" data-profile="user:${u.id}">${avatar({ ...u, kind: 'user', imageUrl: u.id === S.me.id ? S.me.imageUrl : u.imageUrl }, { size: 'sm', presence: true })}<span class="grow"><strong>${esc(u.name)}${u.id === S.me.id ? ' <span class="muted">(you)</span>' : ''}</strong><small>@${esc(u.handle)} · ${u.id === S.me.id || u.online ? 'online' : 'offline'}</small></span>${u.id === S.me.id ? '' : `<button class="btn sm" type="button" data-dm-handle="${esc(u.handle)}">Message</button>`}</div>`).join('')}
        ${list.length <= 1 && !q ? `<p class="muted small">No one else is in ${esc(currentTeam()?.name || 'this team')} yet. Invite people and they’ll show up here.</p>` : ''}</div>`;
      foot.innerHTML = `<button class="solid" type="button" data-open="invite">${icon('plus', 'sm')}Invite people</button>`;
      return;
    }

    if (mode === 'directory') {
      title.textContent = 'Agent directory';
      const q = (S.dirQuery || '').toLowerCase();
      const list = [...S.agents.values()].filter(inTeamAgent).filter((a) => !q || [a.name, a.handle, a.description, a.owner?.name].some((x) => String(x || '').toLowerCase().includes(q))).sort((a, b) => b.online - a.online || a.name.localeCompare(b.name));
      body.innerHTML = `<form class="panel-search" id="dir-form"><input id="dir-input" type="search" placeholder="Find an agent…" value="${esc(S.dirQuery || '')}" autocomplete="off"></form>
        <div>${list.map((a) => `<div class="row click" data-profile="agent:${a.id}">${avatar(a, { size: 'sm', presence: true })}<span class="grow"><strong>${esc(a.name)}</strong><small>@${esc(a.handle)} · ${runtimeLabel(a.runtime)}${a.owner ? ` · ${esc(a.owner.name)}` : ''}${a.description ? ` · ${esc(a.description)}` : ''}</small></span></div>`).join('') || '<p class="muted">No agents yet.</p>'}</div>`;
      foot.innerHTML = `<button class="solid" type="button" data-open="connect">${icon('plus', 'sm')}Connect your agent</button>`;
      return;
    }

    // room details
    if (!room) { body.innerHTML = ''; title.textContent = ''; return; }
    if (room.kind === 'dm') {
      const other = dmOther(room);
      if (other) { S.panel = { mode: 'profile', id: `${other.kind}:${other.id}` }; return renderPanel(); }
    }
    title.textContent = `#${room.name}`;
    const agentsHere = room.members.filter((m) => m.kind === 'agent');
    const people = room.members.filter((m) => m.kind === 'user');
    const creator = room.members.find((m) => m.id === room.createdBy);
    body.innerHTML = `<div class="p-section"><h4>About ${room.createdBy === S.me.id ? '<button class="link-btn" type="button" data-open="edit-room">Edit</button>' : ''}</h4>
        <p>${esc(room.topic || 'No topic yet.')}</p></div>
      <ul class="info">
        ${infoRow(room.visibility === 'private' ? 'lock' : 'eye', room.visibility === 'private' ? 'Invite only' : `Anyone in ${esc(S.teams.get(room.teamId)?.name || 'the team')} can join`)}
        ${creator ? infoRow('user', `Created by <a href="#" data-profile="user:${creator.id}">${esc(memberName(creator))}</a>`) : ''}
        ${infoRow('calendar', `Created ${esc(fmtDate(room.createdAt))}`)}
      </ul>
      <div class="p-section"><h4>Agents · ${agentsHere.length} <button class="link-btn" type="button" data-open="add-member">Add</button></h4>
        ${agentsHere.map((m) => memberRow(m, room)).join('') || '<p class="muted small">No agents here yet. Mention one with @ or press Add.</p>'}</div>
      <div class="p-section"><h4>People · ${people.length} <button class="link-btn" type="button" data-open="add-member">Add</button></h4>${people.map((m) => memberRow(m, room)).join('')}</div>`;
    foot.innerHTML = isJoined(room)
      ? `<button class="btn" type="button" data-open="add-member">${icon('plus', 'sm')}Add people</button><button class="btn danger" type="button" data-open="leave">${icon('logout', 'sm')}Leave</button>`
      : `<button class="solid" type="button" data-open="join">${icon('plus', 'sm')}Join room</button>`;
  }
  const memberName = (m) => agentOf(m).name;

  // ---------- rooms ----------
  async function openRoom(id) {
    if (!S.rooms.has(id)) return;
    const teamId = S.rooms.get(id).teamId;
    if (teamId && teamId !== S.teamId && S.teams.has(teamId)) await setTeam(teamId);
    const changed = S.active !== id;
    S.active = id;
    recordVisit(id);
    local.set(`${KEYS.room}.${S.teamId}`, id);
    S.unread.delete(id);
    if (changed) {
      setReply(null);
      S.search = { q: '', results: null, busy: false };
      if (S.panel.mode === 'search' || S.panel.mode === 'profile') S.panel = { mode: 'room', id: null };
    }
    $('#app').classList.remove('nav-open');
    renderSidebar();
    renderHeader();
    renderThinking();
    applyUi();
    const st = roomState(id);
    renderMessages({ forceBottom: true });
    if (!st.loaded) {
      try { await loadMessages(id); } catch (e) { toast(e.message); }
    }
    if (S.active === id) renderMessages({ forceBottom: true });
    if (!mobileQuery.matches) $('#input').focus();
  }

  function openFallback() {
    const lobby = lobbyRoom();
    if (lobby) return openRoom(lobby.id);
    S.active = null;
    renderAll();
  }

  async function jumpTo(messageId) {
    for (let i = 0; i < 25 && !roomState(S.active).list.some((m) => m.id === messageId); i++) {
      if (!(await loadOlder())) break;
    }
    const el = $(`.msg[data-id="${CSS.escape(messageId)}"]`);
    if (!el) return toast('That message is no longer here.');
    el.scrollIntoView({ block: 'center', behavior: 'smooth' });
    el.classList.remove('flash');
    void el.offsetWidth;
    el.classList.add('flash');
  }

  $('#messages').addEventListener('scroll', (e) => { if (e.target.scrollTop < 60) loadOlder(); });

  $('#room-pill').addEventListener('click', (e) => {
    const room = S.rooms.get(S.active);
    if (!room) return;
    if (room.kind === 'dm' && dmOther(room)?.kind === 'user') {
      const u = dmOther(room);
      return openMenu(e.currentTarget, [
        { text: 'View profile', icon: 'user', action: () => openPanel('profile', `user:${u.id}`) },
        { text: 'Search this conversation', icon: 'search', action: () => openPanel('search') },
      ]);
    }
    if (room.kind === 'dm') {
      const a = room.members.find((m) => m.kind === 'agent');
      return openMenu(e.currentTarget, [
        { text: 'Agent profile', icon: 'info', action: () => openPanel('profile', `agent:${a?.id}`) },
        { text: 'Search this conversation', icon: 'search', action: () => openPanel('search') },
        mine(agentOf(a)) ? { text: 'Agent settings', icon: 'settings', action: () => openSettings(a.id) } : null,
      ]);
    }
    openMenu(e.currentTarget, [
      { text: 'Room details', icon: 'info', action: () => openPanel('room') },
      { text: 'Search this room', icon: 'search', action: () => openPanel('search') },
      { text: 'Add people or agents', icon: 'plus', action: openAddMember },
      room.createdBy === S.me.id ? { text: 'Edit name & topic', icon: 'edit', action: () => openRoomDialog(room.id) } : null,
      '-',
      isJoined(room) ? { text: 'Leave room', icon: 'logout', danger: true, action: () => joinLeave('leave') } : { text: 'Join room', icon: 'plus', action: () => joinLeave('join') },
    ]);
  });
  $('#btn-search').addEventListener('click', () => togglePanel('search'));
  $('#btn-details').addEventListener('click', () => togglePanel('room'));
  $('#head-avatars').addEventListener('click', () => openPanel('room'));
  $('#panel-close').addEventListener('click', () => setPanelOpen(false));

  async function runSearch(q) {
    S.search = { q, results: null, busy: true };
    renderPanel();
    try {
      const { messages } = await api('GET', `/api/rooms/${encodeURIComponent(S.active)}/search?q=${encodeURIComponent(q)}`);
      if (S.search.q === q) S.search = { q, results: messages, busy: false };
    } catch (e) {
      S.search = { q, results: [], busy: false };
      toast(e.message);
    }
    if (panelShowing('search')) {
      renderPanel();
      const input = $('#search-input');
      if (input) { input.focus(); input.setSelectionRange(input.value.length, input.value.length); }
    }
  }
  $('#panel-body').addEventListener('submit', (e) => {
    e.preventDefault();
    if (e.target.id === 'search-form') {
      const q = $('#search-input').value.trim();
      if (q.length >= 2) runSearch(q);
      else toast('Type at least 2 characters');
    }
  });
  let peopleTimer;
  $('#panel-body').addEventListener('input', (e) => {
    if (e.target.id !== 'people-input') return;
    clearTimeout(peopleTimer);
    peopleTimer = setTimeout(() => {
      S.peopleQuery = e.target.value;
      renderPanel();
      const input = $('#people-input');
      input.focus();
      input.setSelectionRange(input.value.length, input.value.length);
    }, 120);
  });
  let dirTimer;
  $('#panel-body').addEventListener('input', (e) => {
    if (e.target.id !== 'dir-input') return;
    clearTimeout(dirTimer);
    dirTimer = setTimeout(() => {
      S.dirQuery = e.target.value;
      renderPanel();
      const input = $('#dir-input');
      input.focus();
      input.setSelectionRange(input.value.length, input.value.length);
    }, 120);
  });

  async function joinLeave(what) {
    try {
      const { room } = await api('POST', `/api/rooms/${encodeURIComponent(S.active)}/${what}`);
      S.rooms.set(room.id, room);
      if (what === 'leave' && room.visibility === 'private') { S.rooms.delete(room.id); openFallback(); }
      renderAll();
    } catch (x) { toast(x.message); }
  }

  // ---------- composer ----------
  const input = $('#input');
  function autosize() {
    input.style.height = 'auto';
    input.style.height = `${Math.min(input.scrollHeight, 220)}px`;
  }
  function setReply(id) {
    S.replyTo = id;
    const chip = $('#reply-chip');
    if (!id) { chip.hidden = true; chip.innerHTML = ''; return; }
    const m = roomState(S.active).list.find((x) => x.id === id);
    chip.hidden = false;
    chip.innerHTML = `${icon('reply', 'sm')} Replying to <strong>${esc(m?.sender.name || '')}</strong> <span>${esc(snippet(m?.text || '', 70))}</span> <button type="button" aria-label="Cancel reply">${icon('x', 'sm')}</button>`;
    chip.querySelector('button').onclick = () => setReply(null);
    input.focus();
  }
  async function send() {
    const text = input.value.trim();
    if (!text || !S.active) return;
    const replyTo = S.replyTo;
    input.value = '';
    autosize();
    setReply(null);
    closeAC();
    $('#btn-send').disabled = true;
    try {
      const r = await api('POST', `/api/rooms/${encodeURIComponent(S.active)}/messages`, { text, replyTo });
      onMessage(r.message);
      if (r.notice) toast(r.notice);
      else if (r.queued?.length) toast(`@${r.queued.join(', @')} is offline. It will answer when it reconnects.`);
    } catch (e) {
      input.value = text;
      autosize();
      toast(e.message);
    } finally {
      $('#btn-send').disabled = false;
    }
  }
  $('#composer').addEventListener('submit', (e) => { e.preventDefault(); send(); });

  // formatting
  function wrap(before, after = before, placeholder = 'text') {
    const s = input.selectionStart;
    const e = input.selectionEnd;
    const sel = input.value.slice(s, e) || placeholder;
    input.setRangeText(`${before}${sel}${after}`, s, e, 'end');
    input.setSelectionRange(s + before.length, s + before.length + sel.length);
    input.focus();
    autosize();
  }
  function prefixLines(fn) {
    const v = input.value;
    const s = v.lastIndexOf('\n', input.selectionStart - 1) + 1;
    let e = v.indexOf('\n', input.selectionEnd);
    if (e < 0) e = v.length;
    const lines = v.slice(s, e).split('\n').map((l, i) => fn(i) + l);
    input.setRangeText(lines.join('\n'), s, e, 'end');
    input.focus();
    autosize();
  }
  function insertAtCursor(text) {
    input.setRangeText(text, input.selectionStart, input.selectionEnd, 'end');
    input.focus();
    autosize();
  }
  const FORMATS = {
    bold: () => wrap('**'),
    italic: () => wrap('*'),
    strike: () => wrap('~~'),
    code: () => (input.value.slice(input.selectionStart, input.selectionEnd).includes('\n') ? wrap('```\n', '\n```', 'code') : wrap('`', '`', 'code')),
    quote: () => prefixLines(() => '> '),
    bullets: () => prefixLines(() => '- '),
    numbers: () => prefixLines((i) => `${i + 1}. `),
    link: () => {
      const sel = input.value.slice(input.selectionStart, input.selectionEnd);
      if (/^https?:\/\//.test(sel)) return wrap('[link](', ')', sel);
      const s = input.selectionStart;
      wrap('[', '](https://)', sel || 'link text');
      const urlStart = s + 1 + (sel || 'link text').length + 2;
      input.setSelectionRange(urlStart, urlStart + 8);
    },
    mention: () => {
      const before = input.value.slice(0, input.selectionStart);
      insertAtCursor(before && !/\s$/.test(before) ? ' @' : '@');
      updateAC();
    },
    emoji: () => toggleEmoji(),
  };
  $('.toolbar').addEventListener('mousedown', (e) => { if (e.target.closest('[data-fmt]')) e.preventDefault(); });
  $('.toolbar').addEventListener('click', (e) => {
    const b = e.target.closest('[data-fmt]');
    if (b) FORMATS[b.dataset.fmt]?.();
  });
  const EMOJI = ['👍', '👏', '🙏', '🎉', '🚀', '✅', '❌', '👀', '😄', '😂', '🙂', '😅', '🤔', '😮', '😢', '😍', '🔥', '💡', '⚠️', '🐛', '📌', '📎', '🧪', '🛠️', '❤️', '💯', '⏳', '🤖', '🧠', '📝', '🔒', '✨'];
  function toggleEmoji(force) {
    const pop = $('#emoji-pop');
    const show = typeof force === 'boolean' ? force : pop.hidden;
    if (show && !pop.innerHTML) pop.innerHTML = EMOJI.map((x) => `<button type="button" data-emoji="${x}" aria-label="${x}">${x}</button>`).join('');
    pop.hidden = !show;
  }
  $('#emoji-pop').addEventListener('mousedown', (e) => e.preventDefault());
  $('#emoji-pop').addEventListener('click', (e) => {
    const b = e.target.closest('[data-emoji]');
    if (!b) return;
    insertAtCursor(b.dataset.emoji);
    toggleEmoji(false);
  });

  function mentionQuery() {
    const before = input.value.slice(0, input.selectionStart);
    const m = before.match(/(^|[^\w@])@([a-z0-9_-]{0,31})$/i);
    return m ? { q: m[2].toLowerCase(), start: input.selectionStart - m[2].length - 1 } : null;
  }
  function mentionCandidates(q) {
    const room = S.rooms.get(S.active);
    const seen = new Set();
    const out = [];
    const push = (e, inRoom) => {
      if (!e || e.id === S.me.id || seen.has(e.handle)) return;
      seen.add(e.handle);
      out.push({ ...e, inRoom });
    };
    room?.members.filter((m) => m.kind === 'agent').forEach((m) => push(agentOf(m), true));
    [...S.agents.values()].filter(inTeamAgent).forEach((a) => push(a, false));
    room?.members.filter((m) => m.kind === 'user').forEach((m) => push(m, true));
    return out.filter((e) => e.handle.startsWith(q) || e.name.toLowerCase().includes(q)).slice(0, 8);
  }
  function updateAC() {
    const mq = mentionQuery();
    if (!mq) return closeAC();
    const items = mentionCandidates(mq.q);
    if (!items.length) return closeAC();
    S.ac = { items, sel: 0, start: mq.start };
    renderAC();
  }
  function renderAC() {
    const el = $('#autocomplete');
    el.hidden = false;
    el.innerHTML = S.ac.items.map((e, i) => `<li role="option" data-i="${i}" class="${i === S.ac.sel ? 'sel' : ''}" aria-selected="${i === S.ac.sel}">
      ${avatar(e, { size: 'sm', presence: true })}<span>${esc(e.name)} <span class="muted">@${esc(e.handle)}</span></span>
      <small>${e.kind === 'agent' ? (e.inRoom ? runtimeLabel(e.runtime) : 'will be invited') : 'person'}</small></li>`).join('');
  }
  function closeAC() { $('#autocomplete').hidden = true; S.ac.items = []; }
  function pickAC(i) {
    const e = S.ac.items[i];
    if (!e) return;
    const end = input.selectionStart;
    input.value = `${input.value.slice(0, S.ac.start)}@${e.handle} ${input.value.slice(end)}`;
    const pos = S.ac.start + e.handle.length + 2;
    input.setSelectionRange(pos, pos);
    closeAC();
    input.focus();
  }
  input.addEventListener('input', () => { autosize(); updateAC(); });
  input.addEventListener('keydown', (e) => {
    const open = !$('#autocomplete').hidden && S.ac.items.length;
    const mod = isMac ? e.metaKey : e.ctrlKey;
    if (open && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
      e.preventDefault();
      const n = S.ac.items.length;
      S.ac.sel = (S.ac.sel + (e.key === 'ArrowDown' ? 1 : n - 1)) % n;
      return renderAC();
    }
    if (open && (e.key === 'Enter' || e.key === 'Tab')) { e.preventDefault(); return pickAC(S.ac.sel); }
    if (open && e.key === 'Escape') return closeAC();
    if (mod && e.key.toLowerCase() === 'b') { e.preventDefault(); return FORMATS.bold(); }
    if (mod && e.key.toLowerCase() === 'i') { e.preventDefault(); return FORMATS.italic(); }
    if (e.key === 'Escape' && S.replyTo) return setReply(null);
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && !mobileQuery.matches) { e.preventDefault(); send(); }
  });
  input.addEventListener('blur', () => setTimeout(closeAC, 150));
  $('#autocomplete').addEventListener('mousedown', (e) => {
    const li = e.target.closest('li[data-i]');
    if (li) { e.preventDefault(); pickAC(Number(li.dataset.i)); }
  });

  // ---------- clicks ----------
  document.addEventListener('click', async (e) => {
    const t = e.target;
    if (!t.closest('#menu') && !t.closest('[aria-haspopup="menu"]') && !t.closest('#rail-create') && !t.closest('#rail-help')) closeMenu();
    if (!t.closest('#emoji-pop') && !t.closest('[data-fmt="emoji"]')) $('#emoji-pop').hidden = true;
    const close = t.closest('[data-close]');
    if (close) return close.closest('dialog')?.close();
    const roomLi = t.closest('[data-room]');
    if (roomLi) return openRoom(roomLi.dataset.room);
    const agentLi = t.closest('[data-agent]');
    if (agentLi) {
      const a = S.agents.get(agentLi.dataset.agent);
      $('#app').classList.remove('nav-open');
      return mine(a) && !a.setupDone ? openSettings(a.id) : openPanel('profile', `agent:${a.id}`);
    }
    const navItem = t.closest('[data-nav]');
    if (navItem) {
      if (navItem.dataset.nav === 'my-agents') return openSettings(null);
      if (navItem.dataset.nav === 'dms') { $('#app').classList.remove('nav-open'); return openDirectMessages(); }
      return togglePanel(navItem.dataset.nav);
    }
    const dmHandle = t.closest('[data-dm-handle]');
    if (dmHandle) {
      e.stopPropagation();
      try {
        const { room } = await api('POST', '/api/dm', { handle: dmHandle.dataset.dmHandle, teamId: S.teamId });
        S.rooms.set(room.id, room);
        if (!wideQuery.matches && dmHandle.closest('#panel')) setPanelOpen(false);
        return openRoom(room.id);
      } catch (x) { return toast(x.message); }
    }
    const personLi = t.closest('[data-person]');
    if (personLi) { $('#app').classList.remove('nav-open'); return openPanel('profile', `user:${personLi.dataset.person}`); }
    const navOpen = t.closest('[data-nav-open]');
    if (navOpen) return openPanel(navOpen.dataset.navOpen);
    const settingsFor = t.closest('[data-settings-for]');
    if (settingsFor) return openSettings(settingsFor.dataset.settingsFor);
    const remove = t.closest('[data-remove]');
    if (remove) {
      e.stopPropagation();
      try {
        const { room } = await api('DELETE', `/api/rooms/${encodeURIComponent(S.active)}/members/${encodeURIComponent(remove.dataset.remove)}`);
        S.rooms.set(room.id, room);
        renderHeader();
        renderPanel();
      } catch (x) { toast(x.message); }
      return;
    }
    const prof = t.closest('[data-profile]');
    if (prof) {
      e.preventDefault();
      return openPanel('profile', prof.dataset.profile);
    }
    const mention = t.closest('.mention');
    if (mention) {
      const h = mention.dataset.handle.toLowerCase();
      const a = [...S.agents.values()].find((x) => x.handle === h);
      if (a) return openPanel('profile', `agent:${a.id}`);
      const u = h === S.me.handle ? S.me : [...S.rooms.values()].flatMap((r) => r.members).find((m) => m.kind === 'user' && m.handle === h);
      if (u) return openPanel('profile', `user:${u.id}`);
      return;
    }
    if (t.closest('[data-older]')) return loadOlder();
    const pact = t.closest('[data-pact]');
    if (pact) {
      const h = pact.dataset.handle;
      try {
        if (pact.dataset.pact === 'dm') {
          const { room } = await api('POST', '/api/dm', { handle: h, teamId: S.teamId });
          S.rooms.set(room.id, room);
          return openRoom(room.id);
        }
        if (pact.dataset.pact === 'add') {
          const { room } = await api('POST', `/api/rooms/${encodeURIComponent(S.active)}/members`, { handle: h });
          S.rooms.set(room.id, room);
          renderHeader();
          return renderPanel();
        }
        if (pact.dataset.pact === 'mention') {
          if (!wideQuery.matches) setPanelOpen(false);
          return insertAtCursor(`${/\S$/.test(input.value.slice(0, input.selectionStart)) ? ' ' : ''}@${h} `);
        }
        if (pact.dataset.pact === 'my-agents') return openSettings(null);
        if (pact.dataset.pact === 'account') return Auth.manage?.();
      } catch (x) { toast(x.message); }
      return;
    }
    const act = t.closest('[data-act]');
    if (act && act.closest('.msg-actions')) {
      const m = roomState(S.active).list.find((x) => x.id === act.dataset.id);
      if (!m) return;
      if (act.dataset.act === 'reply') return setReply(m.id);
      if (act.dataset.act === 'copy') {
        await navigator.clipboard?.writeText(m.text);
        return toast('Copied');
      }
      if (act.dataset.act === 'delete') {
        if (!confirm('Delete this message for everyone?')) return;
        try {
          await api('DELETE', `/api/messages/${encodeURIComponent(m.id)}`);
          Object.assign(m, { deleted: true, text: '' });
          renderMessages({ keep: true });
        } catch (x) { toast(x.message); }
      }
      return;
    }
    const openRoomResult = t.closest('[data-open-room]');
    if (openRoomResult) {
      const roomId = openRoomResult.dataset.openRoom;
      const msgId = openRoomResult.dataset.jumpId;
      if (!wideQuery.matches) setPanelOpen(false);
      await openRoom(roomId);
      return jumpTo(msgId);
    }
    const open = t.closest('[data-open]')?.dataset.open;
    if (open === 'add-member') return openAddMember();
    if (open === 'connect') return openConnectAgent();
    if (open === 'new-room') return openRoomDialog();
    if (open === 'new-dm') return openNewMessage();
    if (open === 'invite') return openInvite();
    if (open === 'edit-room') return openRoomDialog(S.active);
    if (open === 'join' || open === 'leave') return joinLeave(open);
    const jump = t.closest('[data-jump]');
    if (jump) {
      if (!wideQuery.matches && jump.closest('#panel')) setPanelOpen(false);
      return jumpTo(jump.dataset.jump);
    }
    const copy = t.closest('[data-copy]');
    if (copy) {
      const src = copy.dataset.copy.startsWith('#') ? $(copy.dataset.copy) : copy.parentElement.querySelector('pre');
      navigator.clipboard?.writeText(src.textContent).then(() => { copy.textContent = 'Copied'; setTimeout(() => { copy.textContent = 'Copy'; }, 1200); });
    }
  });

  $('#btn-menu').addEventListener('click', () => $('#app').classList.toggle('nav-open'));
  $('#scrim').addEventListener('click', () => $('#app').classList.remove('nav-open'));

  // ---------- dialogs ----------
  function wireForm(form, onOk) {
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const err = form.querySelector('[data-error]');
      err.textContent = '';
      const btn = form.querySelector('[type="submit"]');
      btn.disabled = true;
      try { await onOk(new FormData(form)); } catch (x) { err.textContent = x.message; } finally { btn.disabled = false; }
    });
  }

  function openRoomDialog(editId = null) {
    const form = $('#form-room');
    form.reset();
    form.querySelector('[data-error]').textContent = '';
    S.roomDialog = editId;
    const room = editId ? S.rooms.get(editId) : null;
    $('#room-dlg-title').textContent = room ? 'Edit room' : 'New room';
    $('#room-dlg-submit').textContent = room ? 'Save' : 'Create';
    form.querySelector('[data-only="new"]').hidden = !!room;
    if (room) {
      form.elements.name.value = room.name;
      form.elements.topic.value = room.topic || '';
    }
    $('#dlg-room').showModal();
  }
  $('#btn-new-room').addEventListener('click', () => openRoomDialog());
  wireForm($('#form-room'), async (fd) => {
    const fields = Object.fromEntries(fd);
    if (S.roomDialog) {
      const { room } = await api('PATCH', `/api/rooms/${encodeURIComponent(S.roomDialog)}`, { name: fields.name, topic: fields.topic });
      S.rooms.set(room.id, room);
      $('#dlg-room').close();
      return renderAll();
    }
    const { room } = await api('POST', '/api/rooms', { ...fields, teamId: S.teamId });
    S.rooms.set(room.id, room);
    $('#dlg-room').close();
    openRoom(room.id);
  });

  function openConnectAgent() {
    $('#form-agent').reset();
    $('#form-agent [data-error]').textContent = '';
    $('#dlg-settings').close();
    $('#dlg-agent').showModal();
  }
  $('#btn-connect-agent').addEventListener('click', openConnectAgent);
  wireForm($('#form-agent'), async (fd) => {
    const { agent, token } = await api('POST', '/api/agents', Object.fromEntries(fd));
    S.agents.set(agent.id, agent);
    renderSidebar();
    $('#dlg-agent').close();
    openSettings(agent.id, { freshToken: token });
  });

  // ---------- pickers: add to room, new message ----------
  const personRow = (u, action) => `<li class="${action.click ? 'click' : ''}" ${action.click ? `data-${action.click}="${esc(u.handle)}"` : ''}>${avatar({ ...u, kind: 'user' })}<span class="grow"><strong>${esc(u.name)}</strong><small>@${esc(u.handle)}</small></span>${action.button || ''}</li>`;
  const agentRow = (a, action) => `<li class="${action.click ? 'click' : ''}" ${action.click ? `data-${action.click}="${esc(a.handle)}"` : ''}>${avatar(a, { presence: true })}<span class="grow"><strong>${esc(a.name)}</strong> <span class="muted">@${esc(a.handle)}</span><small>${esc(runtimeLabel(a.runtime))}${a.owner ? ` · ${mine(a) ? 'yours' : `by ${esc(a.owner.name)}`}` : ''}${a.description ? ` · ${esc(a.description)}` : ''}</small></span>${action.button || ''}</li>`;
  const group = (title, rows) => (rows.length ? `<section><h3>${esc(title)}</h3><ul class="picker">${rows.join('')}</ul></section>` : '');
  const matches = (q, ...xs) => !q || xs.some((x) => String(x || '').toLowerCase().includes(q));

  function renderMemberPicker() {
    const room = S.rooms.get(S.active);
    if (!room) return;
    const q = $('#member-search').value.trim().toLowerCase();
    const inRoom = new Set(room.members.map((m) => m.id));
    const addBtn = (h) => ({ button: `<button class="btn sm" type="button" data-add="${esc(h)}">Add</button>` });
    const agents = [...S.agents.values()].filter((a) => inTeamAgent(a) && !inRoom.has(a.id) && matches(q, a.name, a.handle, a.description));
    const yours = agents.filter(mine).map((a) => agentRow(a, addBtn(a.handle)));
    const others = agents.filter((a) => !mine(a)).sort((a, b) => b.online - a.online).map((a) => agentRow(a, addBtn(a.handle)));
    const people = [...S.people.values()].filter((u) => !inRoom.has(u.id) && matches(q, u.name, u.handle)).map((u) => personRow(u, addBtn(u.handle)));
    const html = group('Your agents', yours) + group('People', people) + group('Other agents', others);
    const nobodyElse = [...S.people.values()].every((u) => u.id === S.me.id);
    $('#member-picker').innerHTML = (html || `<p class="empty-note">${q ? 'No one matches. You can also type an exact @handle below.' : 'Everyone you can add is already here.'}</p>`) +
      (nobodyElse && !q ? `<p class="empty-note">No one else is in this team yet. <button class="link-btn" type="button" data-open="invite">Invite people</button> and they’ll appear here to add.</p>` : '');
  }
  function openAddMember() {
    const room = S.rooms.get(S.active);
    if (!room || room.kind !== 'room') return;
    $('#form-member').reset();
    $('#form-member [data-error]').textContent = '';
    $('#member-dlg-title').textContent = `Add to #${room.name}`;
    renderMemberPicker();
    $('#dlg-member').showModal();
    $('#member-search').focus();
  }
  $('#member-search').addEventListener('input', renderMemberPicker);

  function renderDmPicker() {
    const q = $('#dm-search').value.trim().toLowerCase();
    const people = [...S.people.values()].filter((u) => u.id !== S.me.id && matches(q, u.name, u.handle)).map((u) => personRow(u, { click: 'dm-to' }));
    const agents = [...S.agents.values()].filter((a) => inTeamAgent(a) && matches(q, a.name, a.handle, a.description)).sort((a, b) => mine(b) - mine(a) || b.online - a.online).map((a) => agentRow(a, { click: 'dm-to' }));
    $('#dm-picker').innerHTML = (group('People', people) || (q ? '' : `<section><h3>People</h3><p class="empty-note">No one else is in this team yet. <button class="link-btn" type="button" data-open="invite">Invite people</button></p></section>`)) +
      group('Agents', agents) || '<p class="empty-note">No one matches.</p>';
  }
  function openInvite() {
    closeMenu();
    $('#dlg-dm').close();
    $('#dlg-member').close();
    const t = currentTeam();
    if (!t) return;
    const link = inviteUrl(t);
    const local = /^(localhost|127\.|0\.0\.0\.0|\[::1\])/.test(location.hostname);
    $('#invite-title').textContent = `Invite people to ${t.name}`;
    $('#invite-link').textContent = link;
    $('#invite-text').value = `Join ${t.name} on Crosstalk, where people and AI agents talk to each other: ${link}\nSign in with Google and you’re in. I’m @${S.me.handle}.`;
    $('#invite-local').hidden = !local;
    $('#invite-local').innerHTML = local
      ? '<strong>This link only works on your computer.</strong> The hub runs at localhost, so other people can’t open it yet. To invite them, put the hub online (see “Deploy” in the README), or share it temporarily with a tunnel such as <code>cloudflared tunnel --url ${esc(location.origin)}</code> and add that address to <code>CLERK_AUTHORIZED_PARTIES</code> in the hub’s <code>.env</code>.'
      : '';
    $('#app').classList.remove('nav-open');
    $('#dlg-invite').showModal();
  }
  $('#btn-invite').addEventListener('click', openInvite);
  $('#btn-copy-invite').addEventListener('click', async () => {
    await navigator.clipboard?.writeText($('#invite-text').value);
    toast('Invite copied');
  });

  function openNewMessage() {
    closeMenu();
    $('#dm-search').value = '';
    renderDmPicker();
    $('#app').classList.remove('nav-open');
    $('#dlg-dm').showModal();
    $('#dm-search').focus();
  }
  $('#dm-search').addEventListener('input', renderDmPicker);
  $('#dm-search').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); $('#dm-picker [data-dm-to]')?.click(); }
  });
  $('#dm-picker').addEventListener('click', async (e) => {
    const li = e.target.closest('[data-dm-to]');
    if (!li) return;
    try {
      const { room } = await api('POST', '/api/dm', { handle: li.dataset.dmTo, teamId: S.teamId });
      S.rooms.set(room.id, room);
      $('#dlg-dm').close();
      openRoom(room.id);
    } catch (x) { toast(x.message); }
  });
  $('#btn-new-dm').addEventListener('click', openNewMessage);
  $('#member-picker').addEventListener('click', async (e) => {
    const b = e.target.closest('[data-add]');
    if (!b) return;
    try {
      const { room } = await api('POST', `/api/rooms/${encodeURIComponent(S.active)}/members`, { handle: b.dataset.add });
      S.rooms.set(room.id, room);
      b.outerHTML = '<span class="done">Added ✓</span>';
      renderHeader();
      renderPanel();
    } catch (x) { $('#form-member [data-error]').textContent = x.message; }
  });
  wireForm($('#form-member'), async (fd) => {
    const handle = String(fd.get('handle') || '').trim();
    if (!handle) return $('#dlg-member').close();
    const { room } = await api('POST', `/api/rooms/${encodeURIComponent(S.active)}/members`, { handle });
    S.rooms.set(room.id, room);
    renderHeader();
    renderPanel();
    $('#dlg-member').close();
  });

  // ---------- agent settings (status, connection steps, token) ----------
  const myAgents = () => [...S.agents.values()].filter((a) => a.owner?.id === S.me.id).sort((a, b) => a.handle.localeCompare(b.handle));
  const RUNTIME_TABS = [
    { id: 'claude-code', label: 'Claude Code', runtime: 'claude' },
    { id: 'codex', label: 'Codex', runtime: 'codex' },
    { id: 'other', label: 'Any CLI', runtime: 'command' },
    { id: 'mcp', label: 'Tools in a session you use (MCP)' },
  ];

  function openSettings(agentId, { freshToken = null } = {}) {
    const mine = myAgents();
    const id = agentId || S.settings?.agentId || mine[0]?.id || null;
    S.settings = { agentId: id, token: freshToken && id ? { agentId: id, value: freshToken } : null, tab: null, pair: null, access: 'auto', cmd: 'ollama run llama3.2' };
    renderSettings();
    if (!$('#dlg-settings').open) $('#dlg-settings').showModal();
    $('#settings-main').focus({ preventScroll: true }); // not the Back button
  }

  function renderSettingsNav() {
    const mine = myAgents();
    $('#settings-agents').innerHTML = mine.map((a) => `<li data-settings-agent="${a.id}" class="${a.id === S.settings?.agentId ? 'active' : ''}">
      ${avatar(a, { size: 'sm', presence: true })}<span class="label">${esc(a.name)}</span>${a.setupDone ? '' : '<span class="tag warn">set up</span>'}</li>`).join('') ||
      '<li class="empty">No agents yet</li>';
  }

  function statusHtml(a) {
    const b = a.bridge;
    if (a.online) {
      return `<p class="status-line"><span class="dot on"></span><strong>Online</strong> <span class="muted">· connected ${ago(b?.connectedAt || a.lastConnectedAt)}</span></p>
        ${b ? `<dl class="facts">
          <dt>Computer</dt><dd>${esc(b.host || '?')} <span class="muted">(${esc(b.platform || '')})</span></dd>
          <dt>Runs</dt><dd>${esc(b.adapter || '?')} · bridge ${esc(b.version || '?')} · ${b.managed === 'manual' ? 'in a terminal' : `background service (${esc(b.managed)})`}</dd>
          <dt>Works in</dt><dd><code>${esc(b.cwd || '?')}</code></dd></dl>` : ''}`;
    }
    if (a.setupDone) {
      return `<p class="status-line"><span class="dot"></span><strong>Offline</strong> <span class="muted">· last seen ${ago(a.lastSeenAt)}${b?.host ? ` on ${esc(b.host)}` : ''}</span></p>
        <p class="muted">Messages wait for it and are delivered when it reconnects. On that computer, check it with:</p>
        ${cmdBlock(`crosstalk agent verify --agent @${a.handle}`)}`;
    }
    return '<p class="status-line"><span class="dot"></span><strong>Not connected yet</strong></p><p class="muted">Paste the connect prompt from Connections into your agent. This updates on its own when it comes online.</p>';
  }

  const cmdBlock = (cmd) => `<div class="cmd"><pre>${esc(cmd)}</pre><button class="btn sm" type="button" data-copy="pre">Copy</button></div>`;

  // ---------- Connections: a copy-paste prompt the AI agent runs itself ----------
  const shSingle = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;
  const fmtClock = (t) => new Date(t).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  const pairFor = (a) => (S.settings?.pair?.agentId === a.id && S.settings.pair.expiresAt > Date.now() ? S.settings.pair : null);
  const AGENT_NAMES = { 'claude-code': 'Claude Code', codex: 'Codex', other: 'your AI assistant (Claude Code, Codex, Cursor…)', mcp: 'a Claude Code or Codex session you’re using' };

  // What your own requests may do. Claude Code: permission modes. Codex: sandbox levels.
  const ACCESS_OPTIONS = {
    claude: [['read', 'Read files and answer only'], ['edit', 'Also edit files in its folder'], ['auto', 'Full access, with safety checks (home folder)'], ['full', 'Full access, no checks (home folder)']],
    codex: [['read', 'Read files and answer only'], ['edit', 'Edit files and run commands in its folder'], ['full', 'Full access to this computer (home folder)']],
  };
  const accessFor = (runtime) => {
    const v = S.settings.access || 'auto';
    if (runtime === 'codex' && v === 'auto') return 'edit';
    return v;
  };
  function accessFlags(runtime, access) {
    if (runtime === 'claude') return { read: '', edit: ' --owner-permission-mode acceptEdits', auto: ' --owner-permission-mode auto', full: ' --owner-permission-mode bypassPermissions' }[access] ?? '';
    if (runtime === 'codex') return { read: ' --codex-sandbox read-only', edit: '', full: ' --codex-sandbox danger-full-access' }[access] ?? '';
    return '';
  }

  function connectPrompt(a, tabId, pair) {
    const origin = location.origin;
    const h = `@${a.handle}`;
    const code = pair.code;
    const until = fmtClock(pair.expiresAt);
    const cli = '~/.local/bin/crosstalk';
    const footer = 'Then tell me the result. If a step fails, show me the error and suggest a fix. Don’t change anything else on this computer.';
    if (tabId === 'mcp') {
      return [
        `Please give yourself Crosstalk tools, so that while I work with you, you can talk to people and other AI agents on my Crosstalk hub as ${h}. Run these in a terminal on this computer:`,
        '',
        '1. Install the Crosstalk connector (needs Node.js 20 or later):',
        `   curl -fsSL ${origin}/install.sh | sh`,
        `2. If \`${cli} agent list\` already shows ${h}, skip this step. Otherwise save ${h}’s sign-in on this computer, without starting a background agent. The pairing code works once and expires at ${until}:`,
        `   ${cli} agent install --url ${origin} --agent ${h} --runtime claude --pair-code ${code} --no-service`,
        '   (If you are Codex, use --runtime codex instead.)',
        '3. Add the Crosstalk tools to yourself:',
        `   - If you are Claude Code: claude mcp add crosstalk -- ${cli} mcp --agent ${h}`,
        `   - If you are Codex: codex mcp add crosstalk -- ${cli} mcp --agent ${h}`,
        '4. Tell me to restart this session so the tools load. After that I can ask you things like “ask @reviewer to check this diff” or “check my Crosstalk mentions”.',
        '',
        footer,
      ].join('\n');
    }
    const runtime = tabId === 'codex' ? 'codex' : tabId === 'other' ? 'command' : 'claude';
    const access = accessFor(runtime);
    const full = access === 'auto' || access === 'full';
    let extra = full ? ' --cwd ~' : '';
    extra += accessFlags(runtime, access);
    if (runtime === 'command') extra = ` --cmd ${shSingle(S.settings.cmd || 'ollama run llama3.2')}`;
    const intro = runtime === 'command'
      ? `Please set up a Crosstalk agent called ${h} on this computer, so people and other AI agents on my Crosstalk hub can message it. It should answer by running this command: ${S.settings.cmd || 'ollama run llama3.2'}\n(The command gets the conversation on stdin, and whatever it prints becomes the reply.) Run these in a terminal on this computer:`
      : full
        ? `Please connect yourself to my Crosstalk hub as the agent ${h}, so people and other AI agents can message you there. For my own requests you’ll have full access to this computer, working from my home folder${access === 'auto' ? ' (risky actions are screened by a safety check)' : ''}; anyone else only gets to chat with you. Run these in a terminal on this computer:`
        : `Please connect yourself to my Crosstalk hub as the agent ${h}, so people and other AI agents can message you there. Run these in a terminal on this computer, from the folder you should work in — use the current folder unless I tell you otherwise:`;
    const steps = [
      '1. Check that Node.js 20 or later is installed:',
      '   node --version',
    ];
    if (runtime === 'codex') steps.push('   Also check you’re signed in to Codex: codex login status (if not, ask me to run codex login).');
    if (runtime === 'command') steps.push(`   Also check that this works on its own: ${S.settings.cmd || 'ollama run llama3.2'}`);
    steps.push(
      '2. Install the Crosstalk connector:',
      `   curl -fsSL ${origin}/install.sh | sh`,
      `3. Connect as ${h}. The pairing code works once and expires at ${until}:`,
      `   ${cli} agent install --url ${origin} --agent ${h} --runtime ${runtime}${extra} --pair-code ${code} --replace`,
      `4. Check that ${h} is online:`,
      `   ${cli} agent verify --agent ${h}`,
    );
    const sandboxNote = runtime === 'codex' ? ['', 'If your sandbox blocks network access or writing outside this folder, ask me to approve those commands, or give me the commands to run myself.'] : [];
    return [intro, '', ...steps, ...sandboxNote, '', footer].join('\n');
  }

  function manualSteps(a, tabId) {
    const origin = location.origin;
    const h = `@${a.handle}`;
    const connector = `curl -fsSL ${origin}/install.sh | sh`;
    const installCmd = (runtime, extra = '') => `crosstalk agent install --url ${origin} --agent ${h} --runtime ${runtime}${extra} --token-stdin`;
    const tokenStep = `<div class="step"><h4>3. When it asks, click <b>Get token</b> under Access token, then <b>Copy</b>, and paste it into the prompt.</h4>
      <p class="muted">Nothing shows as you paste. A new token replaces the current one. Then check it:</p>${cmdBlock(`crosstalk agent verify --agent ${h}`)}</div>`;
    const runStep = (runtime, extra) => `<div class="step"><h4>2. In a terminal, go to the folder the agent should work in and run this. It asks for the token.</h4>
      ${cmdBlock(installCmd(runtime, extra))}</div>`;
    const flags = (runtime) => {
      const access = accessFor(runtime);
      return `${access === 'auto' || access === 'full' ? ' --cwd ~' : ''}${accessFlags(runtime, access)}`;
    };
    if (tabId === 'claude-code') return `<div class="step"><h4>1. Once: install Claude Code, sign in, and install the Crosstalk connector.</h4>${cmdBlock(`curl -fsSL https://claude.ai/install.sh | bash\nclaude    # sign in once, then /exit\n${connector}`)}</div>${runStep('claude', flags('claude'))}${tokenStep}`;
    if (tabId === 'codex') return `<div class="step"><h4>1. Once: install Codex, sign in, and install the Crosstalk connector.</h4>${cmdBlock(`npm install -g @openai/codex\ncodex login\n${connector}`)}</div>${runStep('codex', flags('codex'))}${tokenStep}`;
    if (tabId === 'other') return `<div class="step"><h4>1. Once: install the Crosstalk connector.</h4>${cmdBlock(connector)}</div>${runStep('command', ` --cmd ${shSingle(S.settings.cmd || 'ollama run llama3.2')}`)}${tokenStep}`;
    return `<div class="step"><h4>1. Install the connector and save the sign-in here, without a background agent.</h4>${cmdBlock(`${connector}\ncrosstalk agent install --url ${origin} --agent ${h} --no-service --token-stdin`)}</div>
      <div class="step"><h4>2. Add the tools to your session.</h4>${cmdBlock(`claude mcp add crosstalk -- crosstalk mcp --agent ${h}`)}${cmdBlock(`codex mcp add crosstalk -- crosstalk mcp --agent ${h}`)}</div>`;
  }

  function connectionsHtml(a, tabId) {
    const pair = pairFor(a);
    const who = AGENT_NAMES[tabId];
    const lead = tabId === 'mcp'
      ? `<p class="muted">Paste this into ${who} to give it Crosstalk tools as @${esc(a.handle)}: ask other agents, read rooms, check mentions. It won’t answer other people on its own; use the Claude Code or Codex tab for that.</p>`
      : `<p class="muted">Copy this prompt and paste it into <b>${esc(who)}</b> on the computer where @${esc(a.handle)} should live, started in the folder it should work in. It installs the connector, connects itself and checks it’s online. You just approve its commands.</p>`;
    const options = tabId === 'claude-code' || tabId === 'codex'
      ? `<label>When you ask it to do things<select data-settings-opt="access">${ACCESS_OPTIONS[tabId === 'codex' ? 'codex' : 'claude'].map(([v, l]) => `<option value="${v}" ${accessFor(tabId === 'codex' ? 'codex' : 'claude') === v ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
         <p class="muted small">Other people and other agents only ever get to chat with it, with no tools.${accessFor(tabId === 'codex' ? 'codex' : 'claude') === 'full' ? ' <b>No checks</b> means it runs whatever your messages lead it to, without asking.' : ''}</p>`
      : tabId === 'other'
        ? `<label>Command that answers messages<input data-settings-opt="cmd" value="${esc(S.settings.cmd || 'ollama run llama3.2')}" placeholder="ollama run llama3.2" spellcheck="false"></label>`
        : '';
    const prompt = pair
      ? `<div class="prompt-box"><pre id="connect-prompt">${esc(connectPrompt(a, tabId, pair))}</pre></div>
         <div class="connect-actions">
           <button class="solid" type="button" data-settings-act="copy-prompt">${icon('copy', 'sm')}Copy prompt</button>
           <span class="muted small">Code <b>${esc(pair.code)}</b> · expires in <span data-expires="${pair.expiresAt}">${countdown(pair.expiresAt)}</span> · works once · replaces the agent’s current token</span>
           <button class="link-btn" type="button" data-settings-act="pair">New code</button>
         </div>`
      : `<div class="connect-actions"><button class="solid" type="button" data-settings-act="pair">${icon('key', 'sm')}Create connect prompt</button>
           <span class="muted small">Makes a one-time pairing code (valid 15 minutes) and puts it in a prompt you can copy.</span></div>`;
    return `${lead}${options}${prompt}
      <details class="manual"><summary>Do it by hand instead</summary><div class="steps">${manualSteps(a, tabId)}</div></details>`;
  }

  function countdown(t) {
    const s = Math.max(0, Math.round((t - Date.now()) / 1000));
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  }
  setInterval(() => {
    if (!$('#dlg-settings').open) return;
    const el = $('[data-expires]');
    if (!el) return;
    const t = Number(el.dataset.expires);
    if (t <= Date.now()) { S.settings.pair = null; return renderConnect(); }
    el.textContent = countdown(t);
  }, 1000);

  function renderConnect({ promptOnly = false } = {}) {
    const a = S.agents.get(S.settings?.agentId);
    if (!a) return;
    if (promptOnly && $('#connect-prompt') && pairFor(a)) {
      $('#connect-prompt').textContent = connectPrompt(a, S.settings.tab, pairFor(a));
      return;
    }
    const el = $('#settings-connect');
    if (el) {
      const open = el.querySelector('details.manual')?.open;
      el.innerHTML = connectionsHtml(a, S.settings.tab);
      if (open) el.querySelector('details.manual').open = true;
    }
  }

  $('#settings-main').addEventListener('input', (e) => {
    const opt = e.target.dataset?.settingsOpt;
    if (!opt) return;
    if (opt === 'access') { S.settings.access = e.target.value; return renderConnect(); }
    if (opt === 'cmd') { S.settings.cmd = e.target.value; return renderConnect({ promptOnly: true }); }
  });

  function renderSettings() {
    renderSettingsNav();
    const a = S.agents.get(S.settings?.agentId);
    const main = $('#settings-main');
    if (!a) {
      main.innerHTML = `<div class="card"><h3>Connect your first agent</h3><p class="muted">Bring a Claude Code, Codex or any CLI agent. People can then @mention it, and it can talk to other agents.</p><div><button class="primary" type="button" data-settings-act="new">Connect an agent</button></div></div>`;
      return;
    }
    const tabId = S.settings.tab || ({ codex: 'codex', other: 'other' })[a.runtime] || 'claude-code';
    S.settings.tab = tabId;
    const token = S.settings.token?.agentId === a.id ? S.settings.token.value : null;
    main.innerHTML = `
      <div class="card settings-head">
        ${avatar(a, { size: 'lg', presence: true })}
        <div class="grow"><h2>${esc(a.name)} <span class="tag">${runtimeLabel(a.runtime)}</span></h2><span class="muted">@${esc(a.handle)} · ${a.visibility === 'public' ? 'people in your teams can talk to it' : 'only you can talk to it'}</span></div>
        <button class="btn sm" type="button" data-settings-act="copy-handle">Copy handle</button>
      </div>
      ${a.setupDone ? '' : `<div class="banner warn"><strong>Setup not finished.</strong> Under Connections, create a connect prompt and paste it into your AI agent. It comes online here when it’s done.</div>`}
      <div class="card"><div class="card-head"><h3>Status</h3><button class="btn sm" type="button" data-settings-act="refresh">Refresh</button></div><div id="settings-status">${statusHtml(a)}</div></div>
      <div class="card"><div class="card-head"><h3>Connections</h3></div>
        <div class="tabs" role="tablist">${RUNTIME_TABS.map((t) => `<button type="button" role="tab" data-settings-tab="${t.id}" class="${t.id === tabId ? 'on' : ''}">${esc(t.label)}</button>`).join('')}</div>
        <div id="settings-connect">${connectionsHtml(a, tabId)}</div>
      </div>
      <div class="card" id="settings-token-card"><div class="card-head"><h3>Access token</h3>${token ? '' : '<button class="primary sm" type="button" data-settings-act="token">Get token</button>'}</div>
        ${token
          ? `<p class="muted">Copy it and paste it into the install prompt. It is shown only once.</p>
             <div class="kv"><code id="settings-token" class="copyable">${esc(token)}</code><button class="btn sm" type="button" data-copy="#settings-token">Copy</button><button class="btn sm" type="button" data-settings-act="hide-token">Hide</button></div>`
          : `<p class="muted">The agent signs in to this hub with a token. <b>Get token</b> makes a new one and shows it once; the previous token stops working. Last issued ${ago(a.tokenIssuedAt)}.</p>`}
      </div>
      <form class="card" id="settings-profile"><div class="card-head"><h3>Profile</h3></div>
        <label>Display name<input name="name" maxlength="48" value="${esc(a.name)}"></label>
        <label>What it’s good at<input name="description" maxlength="280" value="${esc(a.description || '')}"></label>
        <div class="two">
          <label>Runtime<select name="runtime">${[['claude-code', 'Claude Code'], ['codex', 'Codex'], ['other', 'Other CLI or script']].map(([v, l]) => `<option value="${v}" ${a.runtime === v ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
          <label>Who can talk to it<select name="visibility"><option value="public" ${a.visibility === 'public' ? 'selected' : ''}>People in my teams</option><option value="private" ${a.visibility === 'private' ? 'selected' : ''}>Only me</option></select></label>
        </div>
        <div><button class="btn" type="submit">Save</button> <span class="muted small" data-saved></span></div>
      </form>
      <div class="card danger-zone"><div class="card-head"><h3>Delete agent</h3><button class="btn danger sm" type="button" data-settings-act="delete">Delete @${esc(a.handle)}</button></div>
        <p class="muted">Its messages stay in rooms. Its token stops working. On its computer, also run <code>crosstalk agent uninstall --agent @${esc(a.handle)}</code>.</p></div>`;
  }

  function refreshSettingsLive(agentId) {
    if (!$('#dlg-settings').open) return;
    renderSettingsNav();
    if (agentId !== S.settings?.agentId) return;
    const a = S.agents.get(agentId);
    const el = $('#settings-status');
    if (!a || !el) return renderSettings();
    el.innerHTML = statusHtml(a);
    const banner = $('#settings-main .banner.warn');
    if (banner && a.setupDone) banner.remove();
  }

  $('#settings-agents').addEventListener('click', (e) => {
    const li = e.target.closest('[data-settings-agent]');
    if (!li) return;
    S.settings = { ...S.settings, agentId: li.dataset.settingsAgent, tab: null };
    renderSettings();
    $('#settings-main').scrollTop = 0;
  });

  $('#settings-main').addEventListener('click', async (e) => {
    const tab = e.target.closest('[data-settings-tab]');
    if (tab) {
      S.settings.tab = tab.dataset.settingsTab;
      return renderSettings();
    }
    const act = e.target.closest('[data-settings-act]')?.dataset.settingsAct;
    if (!act) return;
    const a = S.agents.get(S.settings.agentId);
    try {
      if (act === 'new') return openConnectAgent();
      if (!a) return;
      if (act === 'copy-handle') { await navigator.clipboard?.writeText(`@${a.handle}`); return toast(`Copied @${a.handle}`); }
      if (act === 'refresh') {
        const { agent } = await api('GET', `/api/agents/${a.id}`);
        S.agents.set(agent.id, { ...a, ...agent });
        return refreshSettingsLive(agent.id);
      }
      if (act === 'token') {
        if ((a.online || a.setupDone) && !confirm(`Make a new token for @${a.handle}? The current one stops working, so the running bridge stops receiving messages until you install with the new token.`)) return;
        const { agent, token } = await api('POST', `/api/agents/${a.id}/token`);
        S.agents.set(agent.id, { ...a, ...agent });
        S.settings.token = { agentId: a.id, value: token };
        renderSettings();
        return $('#settings-token-card').scrollIntoView({ block: 'nearest', behavior: 'smooth' });
      }
      if (act === 'hide-token') { S.settings.token = null; return renderSettings(); }
      if (act === 'pair') {
        if (a.online && !confirm(`@${a.handle} is online. Using a new connect prompt replaces its token, so the copy that’s running now disconnects. Make a code anyway?`)) return;
        const { code, expiresAt } = await api('POST', `/api/agents/${a.id}/pair-code`);
        S.settings.pair = { agentId: a.id, code, expiresAt };
        return renderConnect();
      }
      if (act === 'copy-prompt') {
        await navigator.clipboard?.writeText($('#connect-prompt').textContent);
        const b = e.target.closest('[data-settings-act]');
        b.innerHTML = `${icon('copy', 'sm')}Copied`;
        setTimeout(() => { b.innerHTML = `${icon('copy', 'sm')}Copy prompt`; }, 1500);
        return toast('Prompt copied. Paste it into your agent.');
      }
      if (act === 'delete') {
        if (!confirm(`Delete @${a.handle}? Its messages stay; the agent and its token are gone. This cannot be undone.`)) return;
        await api('DELETE', `/api/agents/${a.id}`);
        S.agents.delete(a.id);
        S.settings = { agentId: myAgents()[0]?.id ?? null, token: null, tab: null };
        renderSidebar();
        renderHeader();
        return renderSettings();
      }
    } catch (x) { toast(x.message); }
  });

  $('#settings-main').addEventListener('submit', async (e) => {
    if (e.target.id !== 'settings-profile') return;
    e.preventDefault();
    const a = S.agents.get(S.settings.agentId);
    try {
      const { agent } = await api('PATCH', `/api/agents/${a.id}`, Object.fromEntries(new FormData(e.target)));
      S.agents.set(agent.id, { ...a, ...agent });
      renderSidebar();
      renderSettingsNav();
      e.target.querySelector('[data-saved]').textContent = 'Saved';
    } catch (x) { toast(x.message); }
  });

  $('#btn-settings-new').addEventListener('click', openConnectAgent);

  main();
})();
