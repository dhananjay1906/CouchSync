import { DEFAULT_SERVER } from './config.js';
import { Mesh } from './rtc.js';

const $ = id => document.getElementById(id);
// The face grid can move into a floating picture-in-picture window, so keep a direct reference to it.
const gridEl = document.getElementById('grid');
const params = new URLSearchParams(location.search);
// Shown inside the video page as a sidebar (the normal way), vs. opened as a tab (tests / old side panel).
const EMBED = params.has('embed');
if (EMBED) document.body.classList.add('embed');

// ---------------- persistent prefs ----------------
const prefs = { name: '', serverUrl: DEFAULT_SERVER, clientId: '', autoFollow: true, duck: true, hideIp: false, headphoneTip: false };
const VERSION = chrome.runtime.getManifest().version;

async function loadPrefs() {
  const s = await chrome.storage.local.get(['name', 'serverUrl', 'clientId', 'autoFollow', 'duck', 'hideIp', 'headphoneTip']);
  Object.assign(prefs, Object.fromEntries(Object.entries(s).filter(([, v]) => v !== undefined)));
  if (!prefs.clientId) {
    prefs.clientId = crypto.randomUUID().replace(/-/g, '');
    await chrome.storage.local.set({ clientId: prefs.clientId });
  }
}
const savePrefs = patch => { Object.assign(prefs, patch); return chrome.storage.local.set(patch); };

// ---------------- helpers ----------------
function normalizeServer(s) {
  s = (s || '').trim().replace(/\/+$/, '');
  if (s && !/^https?:\/\//.test(s)) s = 'https://' + s;
  return s;
}
const wsUrl = server => server.replace(/^http/, 'ws') + '/ws';

function mediaKey(url) {
  let u;
  try { u = new URL(url); } catch { return null; }
  if (!/^https?:$/.test(u.protocol)) return null;
  const h = u.hostname, p = u.pathname;
  let m;
  if (/(^|\.)netflix\.com$/.test(h)) return (m = p.match(/\/watch\/(\d+)/)) ? `netflix:${m[1]}` : null;
  if (/(^|\.)youtube\.com$/.test(h)) {
    if (u.searchParams.get('v')) return `yt:${u.searchParams.get('v')}`;
    return (m = p.match(/\/(shorts|live|embed)\/([\w-]+)/)) ? `yt:${m[2]}` : null;
  }
  if (h === 'youtu.be') return `yt:${p.slice(1)}`;
  if (/(^|\.)disneyplus\.com$/.test(h)) return (m = p.match(/\/(video|play)\/([\w-]+)/)) ? `disney:${m[2]}` : null;
  if (/(^|\.)(primevideo|amazon)\.[a-z.]+$/.test(h)) return (m = p.match(/\/detail\/(?:[^/]+\/)?([A-Z0-9]{8,})/i)) ? `prime:${m[1]}` : null;
  if (/(^|\.)hulu\.com$/.test(h)) return (m = p.match(/\/watch\/([\w-]+)/)) ? `hulu:${m[1]}` : null;
  if (/(^|\.)(max|hbomax)\.com$/.test(h)) return (m = p.match(/\/video\/watch\/([\w-]+(?:\/[\w-]+)?)/)) ? `max:${m[1]}` : null;
  // Any other site: the page address identifies the video. Keep query values that pick the video
  // (e.g. watch.php?id=123) and hash routes (#/video/123), but drop tracking and start-time bits.
  const DROP = /^(utm_.*|fbclid|gclid|mc_.*|ref|ref_src|si|feature|t|time|start|ts|autoplay|from|source|share|s)$/i;
  const q = [...u.searchParams.entries()].filter(([k]) => !DROP.test(k)).sort(([a], [b]) => a.localeCompare(b));
  const qs = q.length ? '?' + q.map(([k, v]) => `${k}=${v}`).join('&') : '';
  const route = /^#[!/]/.test(u.hash) ? u.hash.replace(/[?&](t|time|start)=[^&]*/g, '') : '';
  return `${u.origin}${p}${qs}${route}`;
}

const vnum = v => String(v || '0').split('.').map(x => parseInt(x, 10) || 0);
const versionLess = (a, b) => { const x = vnum(a), y = vnum(b); for (let i = 0; i < 3; i++) { if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) < (y[i] || 0); } return false; };

// Sites a host can send you to automatically. Anything else needs your click.
const TRUSTED_SITES = /(^|\.)(netflix\.com|youtube\.com|youtu\.be|primevideo\.com|amazon\.[a-z.]+|hulu\.com|disneyplus\.com|max\.com|hbomax\.com|crunchyroll\.com|paramountplus\.com|peacocktv\.com|tv\.apple\.com|tubitv\.com|pluto\.tv|twitch\.tv|vimeo\.com)$/;
function hostOf(url) { try { return new URL(url).hostname; } catch { return ''; } }
function originOf(url) { try { return new URL(url).origin; } catch { return ''; } }
function safeToAutoOpen(url) {
  if (!/^https?:/.test(url || '')) return false;
  if (TRUSTED_SITES.test(hostOf(url))) return true;
  // Otherwise only the exact same site you're already watching on (e.g. the next episode),
  // never something that merely shares a hosting domain (like another *.onrender.com app).
  const here = originOf(tabUrl);
  return !!here && here === originOf(url) && here !== originOf(party.server || '');
}

// Prime Video and Hulu play every episode on the same page, so the URL alone can't tell episodes apart.
// For them, the player's episode title (from the content script) becomes part of the key.
const LABELED_SITE = /(^|\.)(primevideo\.com|amazon\.[a-z.]+|hulu\.com)$/;
function effectiveKey(base, label) {
  if (!base) return null;
  return LABELED_SITE.test(hostOf(tabUrl)) && label ? `${base}|${label}` : base;
}

function fmtTime(sec) {
  sec = Math.max(0, Math.floor(sec || 0));
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
  return (h ? `${h}:${String(m).padStart(2, '0')}` : `${m}`) + `:${String(s).padStart(2, '0')}`;
}
function colorFor(id) {
  let h = 0;
  for (const c of String(id)) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return `hsl(${h % 360} 65% 55%)`;
}
const initials = n => (n || '?').trim().split(/\s+/).map(w => w[0]).join('').slice(0, 2).toUpperCase();

// ---------------- party state ----------------
const party = {
  server: null, room: null, selfId: null, hostId: null, hostOnly: false,
  members: [], state: null, media: null, hold: null, joined: false,
};
const isHost = () => party.selfId && party.selfId === party.hostId;
let boundTabId = null;
let tabUrl = '';
let baseKey = null;   // from the URL
let tabKey = null;    // URL key + episode label where needed
let tabLabel = '';
let tabTitle = '';
const onPartyMedia = () => !!(party.media && tabKey && tabKey === party.media.key);

// ---------------- clock sync ----------------
let clockOffset = 0, bestRtt = Infinity;
const serverNow = () => Date.now() + clockOffset;
function expectedPosition() {
  const s = party.state;
  if (!s) return 0;
  return s.playing ? s.position + ((serverNow() - s.at) / 1000) * s.rate : s.position;
}

// ---------------- WebSocket connection with auto-reconnect ----------------
let ws = null, wsWanted = false, retry = 0, retryTimer = null, pingTimer = null;

function connect() {
  clearTimeout(retryTimer);
  wsWanted = true;
  setConn('connecting');
  let sock;
  try { sock = new WebSocket(wsUrl(party.server)); } catch (e) { return scheduleReconnect(); }
  ws = sock;
  sock.onopen = () => {
    retry = 0;
    bestRtt = Infinity;
    const hello = { type: 'hello', clientId: prefs.clientId, name: prefs.name || 'Guest', version: VERSION };
    if (party.room) Object.assign(hello, { room: party.room, resurrect: party.joined || party.resume });
    else hello.create = true;
    send(hello);
    for (let i = 0; i < 5; i++) setTimeout(() => send({ type: 'ping', t: Date.now() }), i * 250);
    clearInterval(pingTimer);
    pingTimer = setInterval(() => send({ type: 'ping', t: Date.now() }), 20_000);
  };
  sock.onmessage = e => { let m; try { m = JSON.parse(e.data); } catch { return; } onServer(m); };
  sock.onclose = ev => {
    if (ws !== sock) return;
    clearInterval(pingTimer);
    if (ev.code === 4000) {
      // Same browser opened this party in another window/panel: don't fight over the seat.
      wsWanted = false;
      setConn('down', 'Open in another window');
      showOtherWindowBanner();
      return;
    }
    if (ev.code === 4001) return; // removed by host (handled by the error message)
    if (ev.code === 4029) { setConn('down'); setSyncStatus('Too many connections from your network — retrying…', 'warn'); }
    setConn('down');
    if (wsWanted) scheduleReconnect();
  };
  sock.onerror = () => {};
}
function scheduleReconnect() {
  if (!wsWanted) return;
  // Random spread so 1,000 people don't all hit a restarted server in the same second.
  const delay = Math.min(15_000, 1000 * 2 ** retry++) * (0.5 + Math.random());
  setConn('down', `Reconnecting in ${Math.round(delay / 1000)}s…`);
  retryTimer = setTimeout(connect, delay);
}
function send(msg) { if (ws && ws.readyState === 1) ws.send(JSON.stringify(msg)); }
function disconnect() {
  wsWanted = false;
  clearTimeout(retryTimer);
  clearInterval(pingTimer);
  if (ws) { try { ws.close(); } catch {} ws = null; }
}

function setConn(state, text) {
  const dot = $('conn-dot');
  dot.className = 'dot' + (state === 'ok' ? ' ok' : state === 'down' ? ' bad' : '');
  dot.title = text || state;
  if (state === 'down') setSyncStatus(text || 'Connection lost — reconnecting…', 'warn');
}

// ---------------- server messages ----------------
function onServer(m) {
  switch (m.type) {
    case 'pong': {
      const t1 = Date.now();
      const rtt = t1 - m.t;
      if (rtt < bestRtt || rtt < 80) { bestRtt = Math.min(bestRtt, rtt); clockOffset = m.serverTime + rtt / 2 - t1; }
      break;
    }
    case 'welcome': onWelcome(m); break;
    case 'error': onJoinError(m); break;
    case 'members':
      party.members = m.members; party.hostId = m.hostId; party.hostOnly = m.hostOnly; party.locked = !!m.locked;
      renderMembers();
      checkFriends();
      break;
    case 'denied':
      // Server refused our play/pause/seek: snap back to what everyone else is doing.
      party.state = m.state; party.hold = m.hold;
      pushStateToContent(true);
      notifyOnce('denied-' + m.text, m.text, 10000);
      break;
    case 'restarting':
      retry = 0;
      addSystem('Server is restarting — reconnecting automatically…');
      break;
    case 'state':
      party.state = m.state; party.hold = m.hold;
      pushStateToContent(m.reason === 'seek' || m.reason === 'media' || m.reason === 'resume');
      updateSyncStatus();
      break;
    case 'media':
      party.media = m.media;
      if (m.state) party.state = m.state;
      // Our own player started this title; let it win once (e.g. Netflix autoplaying the next episode).
      hostAuthorityUntil = isHost() && m.adopted ? Date.now() + 5000 : 0;
      lastMediaSentKey = m.media.key;
      handleMediaChange();
      break;
    case 'chat': addChat(m); break;
    case 'system': addSystem(m.text); break;
    case 'peer-join': whenIceReady(() => { mesh && mesh.addPeer(m.id, true); setPeerStatus(m.id, 'connecting'); }); break;
    case 'peer-leave':
      if (mesh) mesh.removePeer(m.id);
      markTile(m.id, m.temporary ? 'reconnecting' : null);
      break;
    case 'signal': whenIceReady(() => mesh && mesh.handleSignal(m.from, m.data)); break;
  }
}

function onWelcome(m) {
  const firstTime = !party.joined;
  Object.assign(party, {
    room: m.room, selfId: m.selfId, hostId: m.hostId, hostOnly: m.hostOnly, members: m.members,
    state: m.state, media: m.media, hold: m.hold, joined: true,
  });
  clockOffset = clockOffset || m.serverTime - Date.now();
  setConn('ok');
  chrome.storage.local.set({ currentParty: { room: m.room, server: party.server, tabId: boundTabId, at: Date.now() } });
  showView('party');
  $('room-label').textContent = `Party ${m.room}`;
  party.locked = !!m.locked;
  hideOtherWindowBanner();
  if (m.outdated || (m.minClientVersion && versionLess(VERSION, m.minClientVersion))) {
    notifyOnce('outdated', `⚠️ Your CouchSync (${VERSION}) is older than the server needs (${m.minClientVersion}). Ask the host for the new version — some things may not work.`, 3600_000);
  }
  if (firstTime && Array.isArray(m.chat) && m.chat.length) {
    addSystem('— earlier messages —');
    m.chat.forEach(addChat);
    addSystem('— now —');
  }
  if (m.resurrected) { lastMediaSentKey = null; addSystem('Reconnected to a restarted server — restoring the party.'); }
  // The other members will (re)offer video to us; drop any stale connections.
  mesh.setSelfId(m.selfId);
  mesh.closeAll();
  renderMembers();
  if (firstTime) {
    addSystem(isHost() ? 'Party started! Click 🔗 Invite and send the link to up to 3 friends.' : 'You joined the party 🎉');
    fetchIce();
    startLocalMedia();
  }
  lastMediaSentKey = party.media ? party.media.key : null;
  handleMediaChange();
  pushStateToContent(true);
}

function onJoinError(m) {
  if (!party.joined || ['full', 'not_found', 'bad_room', 'kicked', 'locked', 'busy', 'rate'].includes(m.code)) {
    if (party.joined) leaveParty();
    disconnect();
    party.room = null; party.joined = false;
    chrome.storage.local.remove('currentParty');
    showView('start');
    showStartError(m.message || 'Could not join.');
  }
}

let iceReady = Promise.resolve();
let hasRelay = false;
function applyHideIp() {
  if (!mesh) return;
  if (prefs.hideIp && !hasRelay) {
    notifyOnce('hideip', "\"Hide my IP\" needs a relay server, and this server doesn't have one set up — your video still connects directly.", 600000);
  }
  mesh.setRelayOnly(prefs.hideIp && hasRelay);
}
function fetchIce() {
  iceReady = (async () => {
    let servers = [{ urls: ['stun:stun.l.google.com:19302', 'stun:stun.cloudflare.com:3478'] }];
    try {
      const r = await fetch(`${party.server}/ice?id=${encodeURIComponent(prefs.clientId)}`, { signal: AbortSignal.timeout(4000) });
      const j = await r.json();
      if (Array.isArray(j.iceServers) && j.iceServers.length) servers = j.iceServers;
    } catch { /* keep defaults */ }
    mesh.setIceServers(servers);
    hasRelay = servers.some(x => x.username);
    applyHideIp();
  })();
  return iceReady;
}

// Keep signaling in order, but don't start any video connection before the relay info is in.
let signalChain = Promise.resolve();
function whenIceReady(fn) {
  signalChain = signalChain
    .then(() => Promise.race([iceReady, new Promise(r => setTimeout(r, 5000))]))
    .then(fn)
    .catch(e => console.warn(e));
}

// ---------------- the party tab ----------------
async function bindTab(tabId) {
  boundTabId = tabId;
  frames.clear();
  activeFrameId = null;
  try {
    const tab = await chrome.tabs.get(tabId);
    setTabUrl(tab.url || '', tab.title || '');
  } catch { setTabUrl('', ''); }
  await ensureContentScript();
  if (party.joined) chrome.storage.local.set({ currentParty: { room: party.room, server: party.server, tabId, at: Date.now() } });
  updateBanner();
}

function setTabUrl(url, title) {
  tabUrl = url;
  tabTitle = title || tabTitle;
  const k = mediaKey(url);
  if (k !== baseKey) { baseKey = k; tabLabel = ''; }
  recomputeKey();
  updateBanner();
}

function recomputeKey() {
  const k = effectiveKey(baseKey, tabLabel);
  if (k !== tabKey) {
    tabKey = k;
    if (activeFrameId !== null) setActiveFrame(null);
  }
}

async function ensureContentScript() {
  if (boundTabId == null || !/^https?:/.test(tabUrl)) return;
  try {
    await chrome.tabs.sendMessage(boundTabId, { cs: 'ping' });
  } catch {
    // Tab was open before the extension was installed/updated: inject now.
    try {
      await chrome.scripting.executeScript({ target: { tabId: boundTabId, allFrames: true }, files: ['content.js'] });
      if (/netflix\.com/.test(tabUrl)) {
        await chrome.scripting.executeScript({ target: { tabId: boundTabId }, files: ['netflix-main.js'], world: 'MAIN' });
      }
    } catch { /* restricted page (chrome://, Web Store) */ }
  }
}

chrome.tabs.onUpdated.addListener((tabId, info, tab) => {
  if (tabId !== boundTabId) return;
  if (info.url || info.title) setTabUrl(tab.url || tabUrl, tab.title);
  // Any (re)load — including a plain refresh with the same URL — replaces the page's script.
  if (info.status === 'loading') { frames.clear(); if (activeFrameId !== null) activeFrameId = null; }
  if (info.status === 'complete') ensureContentScript();
});
chrome.tabs.onRemoved.addListener(tabId => {
  if (tabId === boundTabId) { boundTabId = null; tabKey = null; frames.clear(); activeFrameId = null; updateBanner(); }
});
chrome.tabs.onActivated.addListener(() => updateBanner());

// ---------------- frames reporting from the content script ----------------
const frames = new Map(); // frameId -> latest status
let activeFrameId = null;

chrome.runtime.onMessage.addListener((msg, sender) => {
  if (msg && msg.panel === 'pending-join') { checkPendingJoin(); return; }
  if (msg && msg.panel === 'media-granted') { startLocalMedia(true); return; }
  if (msg && msg.panel === 'mini-action') {
    if (!(EMBED && sender.tab && sender.tab.id === boundTabId)) return;
    (msg.action === 'mic' ? toggleMic() : toggleCam()).then(updateMediaButtons);
    return;
  }
  if (msg && msg.panel === 'sidebar-mode') {
    if (EMBED && sender.tab && sender.tab.id === boundTabId) applySidebarMode(msg.mode);
    return;
  }
  if (!msg || !msg.cs || !sender.tab || sender.tab.id !== boundTabId) return;
  const fid = sender.frameId;
  if (msg.cs === 'status') {
    frames.set(fid, { ...msg, seen: Date.now(), firstSeen: frames.get(fid)?.firstSeen || Date.now() });
    // The page script forgot it's the party player (e.g. it was reloaded): remind it.
    if (fid === activeFrameId && msg.active === false && msg.hasVideo) {
      chrome.tabs.sendMessage(boundTabId, { cs: 'activate', active: true }, { frameId: fid }).catch(() => {});
      pushStateToContent(true);
    }
    if (msg.hasVideo && typeof msg.label === 'string' && msg.label !== tabLabel && (msg.top || !frames.get(0)?.label)) {
      tabLabel = msg.label;
      recomputeKey();
      if (party.media) handleMediaChange();
    }
    chooseFrame();
  } else if (msg.cs === 'event' && fid === activeFrameId && party.joined) {
    if (party.hostOnly && !isHost()) {
      // Guests can't drive playback in host-only mode: put their player back right away.
      pushStateToContent(true);
      notifyOnce('hostonly', 'Only the host can play, pause or skip right now.', 10000);
      return;
    }
    const ctl = { type: 'control', action: msg.action, position: msg.position };
    if (msg.action === 'rate') ctl.rate = msg.rate;
    send(ctl);
    // optimistic
    if (party.state) {
      const t = serverNow();
      if (msg.action === 'play') party.state = { ...party.state, playing: true, position: msg.position, at: t };
      if (msg.action === 'pause') party.state = { ...party.state, playing: false, position: msg.position, at: t };
      if (msg.action === 'seek') party.state = { ...party.state, position: msg.position, at: t };
    }
  } else if (msg.cs === 'seek-broken') {
    notifyOnce('seek-broken', "This site's player isn't accepting jumps from CouchSync right now. Playback still syncs; use ⇆ Sync all to me if someone drifts.", 600000);
  } else if (msg.cs === 'autoplay-blocked') {
    setSyncStatus('▶ Click the video (or the orange button on it) once so it can sync.', 'warn');
  }
});

function activeStatus() {
  const f = activeFrameId !== null ? frames.get(activeFrameId) : null;
  return f && Date.now() - f.seen < 4000 && f.hasVideo ? f : null;
}

function chooseFrame() {
  const t = Date.now();
  let best = null;
  for (const [fid, f] of frames) {
    if (!f.hasVideo || t - f.seen > 3500) continue;
    if (!best || f.area > best.f.area * 1.1 || (f.area >= best.f.area * 0.9 && f.top)) best = { fid, f };
  }
  const want = best && onPartyMedia() ? best.fid : null;
  if (want !== activeFrameId) setActiveFrame(want);
  maybeSendMedia(best && best.f);
}

function setActiveFrame(fid) {
  if (activeFrameId !== null && boundTabId !== null) {
    chrome.tabs.sendMessage(boundTabId, { cs: 'activate', active: false }, { frameId: activeFrameId }).catch(() => {});
  }
  activeFrameId = fid;
  if (fid !== null && boundTabId !== null) {
    chrome.tabs.sendMessage(boundTabId, { cs: 'activate', active: true }, { frameId: fid }).catch(() => {});
    pushStateToContent(true);
  }
}

let hostAuthorityUntil = 0;
function consumeHostAuthority() {
  const ok = isHost() && !party.hold && Date.now() < hostAuthorityUntil;
  if (ok) hostAuthorityUntil = 0; // one shot, so it can never loop
  return ok;
}
function pushStateToContent(force) {
  if (activeFrameId === null || boundTabId === null || !party.state || !onPartyMedia()) return;
  chrome.tabs.sendMessage(boundTabId, {
    cs: 'state', state: party.state, offset: clockOffset, force: !!force,
    hostAuthority: consumeHostAuthority(),
    mediaDuration: (party.media && party.media.duration) || 0,
  }, { frameId: activeFrameId }).catch(() => {});
}

// Host tells everyone what to watch (new movie / next episode).
let lastMediaSentKey = null;
let mediaSending = false;
async function maybeSendMedia(f) {
  if (!party.joined || !isHost() || !f || !tabKey || mediaSending) return;
  if (LABELED_SITE.test(hostOf(tabUrl)) && !tabLabel && Date.now() - (f.firstSeen || f.seen) < 6000) return; // give the episode title a moment
  if (party.media && party.media.key === tabKey) return;
  if (lastMediaSentKey === tabKey) return;
  const fid = [...frames.entries()].find(([, x]) => x === f)?.[0];
  if (fid === undefined) return;
  mediaSending = true;
  try {
    // Ask the player for its exact position right now (status updates can be ~1s old).
    const snap = await chrome.tabs.sendMessage(boundTabId, { cs: 'snapshot' }, { frameId: fid }).catch(() => null);
    if (!snap || !snap.hasVideo || (!(snap.duration > 0) && snap.paused)) return;
    if (lastMediaSentKey === tabKey || (party.media && party.media.key === tabKey)) return;
    lastMediaSentKey = tabKey;
    const title = tabLabel && !tabTitle.includes(tabLabel) ? `${tabTitle} — ${tabLabel}` : tabTitle;
    send({ type: 'media', url: tabUrl, key: tabKey, title, duration: snap.duration || 0, position: snap.currentTime, playing: !snap.paused });
  } finally {
    mediaSending = false;
  }
}

function handleMediaChange() {
  if (!party.media) { chooseFrame(); updateBanner(); return; }
  if (!onPartyMedia() && !isHost() && prefs.autoFollow && boundTabId !== null) {
    const samePage = mediaKey(party.media.url) === baseKey;
    if (samePage) {
      // Same page, different episode (Prime/Hulu): reloading wouldn't help — tell them what to pick.
      // (If our own episode title hasn't loaded yet, wait: it's probably the same episode.)
      if (tabLabel) notifyOnce('pick-' + party.media.key, `Host switched to: ${party.media.title || 'another episode'}. Pick it in the player — everyone waits up to 20s.`, 60000);
    } else if (safeToAutoOpen(party.media.url)) {
      chrome.tabs.update(boundTabId, { url: party.media.url }).catch(() => {});
    } else {
      notifyOnce('unsafe-' + party.media.url, `Host opened a page on ${hostOf(party.media.url)}. It won't open automatically — use the button at the top if you trust it.`, 60000);
    }
  }
  chooseFrame();
  updateBanner();
}

// Periodic: report readiness to server, keep frame choice fresh, update UI
let lastReport = '', reportTick = 0;
setInterval(() => {
  if (!party.joined) return;
  chooseFrame();
  const f = activeStatus();
  const rep = { type: 'report', hasVideo: !!f, buffering: !!(f && f.buffering), ad: !!(f && f.ad), key: tabKey,
    duration: f && f.duration ? Math.round(f.duration / 5) * 5 : 0, label: tabLabel };
  const k = JSON.stringify(rep);
  if (k !== lastReport || ++reportTick % 15 === 0) { send(rep); lastReport = k; reportTick = 0; }
  // Keep the content script awake only while we're in a party (it sleeps otherwise to save CPU/battery).
  if (boundTabId !== null) chrome.tabs.sendMessage(boundTabId, { cs: 'wake' }).catch(() => {});
  updateSyncStatus();
}, 1000);

// ---------------- UI: sync status + banner ----------------
function setSyncStatus(text, cls) {
  const el = $('sync-status');
  el.textContent = text;
  el.className = 'sync-status' + (cls ? ' ' + cls : '');
}

function updateSyncStatus() {
  if (!party.joined || !ws || ws.readyState !== 1) return;
  if (!party.media) return setSyncStatus(isHost() ? 'Open a movie or episode in this tab and press play.' : 'Waiting for the host to pick something…');
  if (!onPartyMedia()) return setSyncStatus('You are not on the party video.', 'warn');
  if (party.hold) return setSyncStatus(`⏸ Waiting for ${party.hold}…`, 'warn');
  const f = activeStatus();
  if (!f) return setSyncStatus('Looking for the video player…', 'warn');
  if (f.blocked) return setSyncStatus('▶ Click the orange button on the video once so it can sync.', 'warn');
  if (f.ad) return setSyncStatus('Ad playing — everyone will wait for you.', 'warn');
  if (f.buffering) return setSyncStatus('Buffering…', 'warn');
  const drift = f.currentTime - expectedPosition();
  const where = `${party.state.playing ? '▶' : '⏸'} ${fmtTime(expectedPosition())}`;
  if (!f.duration || Math.abs(drift) < 1) setSyncStatus(`✓ In sync · ${where}`, 'ok');
  else setSyncStatus(`↻ Syncing (${drift > 0 ? '+' : ''}${drift.toFixed(1)}s) · ${where}`, 'warn');
}

let bannerAction = null;
async function updateBanner() {
  if (otherWindow) return;
  const b = $('banner');
  let text = '', btn = '', action = null;
  if (party.joined) {
    let activeTab = null;
    activeTab = await activeBrowserTab();
    if (boundTabId === null) {
      text = 'The party tab was closed.'; btn = 'Use this tab'; action = rebindToCurrent;
    } else if (party.media && !onPartyMedia()) {
      const where = safeToAutoOpen(party.media.url) ? '' : ` (${hostOf(party.media.url)})`;
      text = `${isHost() ? 'Party video' : 'Host is watching'}: ${party.media.title || 'a video'}${where}`;
      btn = isHost() ? 'Go back' : 'Open it';
      action = () => chrome.tabs.update(boundTabId, { url: party.media.url, active: true });
    } else if (!EMBED && activeTab && activeTab.id !== boundTabId) {
      text = 'The party is playing in another tab.'; btn = 'Go there';
      action = () => chrome.tabs.update(boundTabId, { active: true });
    }
  }
  $('banner-text').textContent = text;
  $('banner-action').textContent = btn;
  $('banner-action').classList.toggle('hidden', !btn);
  b.classList.toggle('hidden', !text);
  bannerAction = action;
}
$('banner-action').addEventListener('click', () => bannerAction && bannerAction());

function showOtherWindowBanner() {
  $('banner-text').textContent = 'This party is open in another window.';
  $('banner-action').textContent = 'Use it here';
  $('banner-action').classList.remove('hidden');
  $('banner').classList.remove('hidden');
  bannerAction = () => { hideOtherWindowBanner(); retry = 0; connect(); };
  otherWindow = true;
}
let otherWindow = false;
function hideOtherWindowBanner() { if (otherWindow) { otherWindow = false; updateBanner(); } }

// ---------------- chat ----------------
function addChat(m) {
  const el = document.createElement('div');
  el.className = 'msg' + (m.reaction ? ' reaction' : '');
  const who = document.createElement('span');
  who.className = 'who';
  who.style.color = colorFor(m.from);
  who.textContent = m.from === party.selfId ? 'You' : m.name;
  const text = document.createElement('span');
  text.className = 'text';
  text.textContent = m.text;
  const time = document.createElement('span');
  time.className = 'time';
  time.textContent = new Date(m.ts).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  el.append(who, text, time);
  appendChat(el);
}
function addSystem(text) {
  const el = document.createElement('div');
  el.className = 'msg sys';
  el.textContent = text;
  appendChat(el);
}
function appendChat(el) {
  const c = $('chat');
  const atBottom = c.scrollHeight - c.scrollTop - c.clientHeight < 60;
  c.append(el);
  while (c.children.length > 300) c.firstChild.remove();
  if (atBottom) c.scrollTop = c.scrollHeight;
}
$('chat-form').addEventListener('submit', e => {
  e.preventDefault();
  const v = $('chat-input').value.trim();
  if (!v) return;
  send({ type: 'chat', text: v });
  $('chat-input').value = '';
});
document.querySelectorAll('.reactions button').forEach(b => b.addEventListener('click', () => send({ type: 'chat', text: b.dataset.r, reaction: true })));

// ---------------- members ----------------
let kickArmed = {};
function renderMembers() {
  const box = $('members');
  box.textContent = '';
  for (const m of party.members) {
    const row = document.createElement('div');
    row.className = 'member';
    const left = document.createElement('div');
    left.textContent = `${m.id === party.hostId ? '👑 ' : ''}${m.name}${m.id === party.selfId ? ' (you)' : ''}`;
    const meta = document.createElement('span');
    meta.className = 'meta';
    const tile = tiles.get(m.id);
    const route = tile && tile.el.dataset.route ? ` · video ${tile.el.dataset.route}` : (m.id !== party.selfId && tile ? ' · video not connected' : '');
    meta.textContent = (!m.connected ? 'reconnecting…' : m.ad ? 'ad' : m.buffering ? 'buffering' : m.ready ? 'ready' : 'no video yet') + route;
    row.append(left, meta);
    if (m.version && m.version !== VERSION) meta.textContent += ` · v${m.version}`;
    if (isHost() && m.id !== party.selfId) {
      const btns = document.createElement('span');
      btns.className = 'member-btns';
      if (m.connected) {
        const mk = document.createElement('button');
        mk.className = 'small';
        mk.textContent = 'Make host';
        mk.addEventListener('click', () => send({ type: 'settings', makeHost: m.id }));
        btns.append(mk);
      }
      const kick = document.createElement('button');
      kick.className = 'small danger';
      kick.textContent = 'Remove';
      kick.title = 'Remove from the party (they cannot rejoin this party)';
      // Two-step confirm that survives the list re-rendering.
      const armed = kickArmed.id === m.id && Date.now() < kickArmed.until;
      if (armed) kick.textContent = 'Sure?';
      kick.addEventListener('click', () => {
        if (kickArmed.id === m.id && Date.now() < kickArmed.until) { kickArmed = {}; send({ type: 'settings', kick: m.id }); return; }
        kickArmed = { id: m.id, until: Date.now() + 4000 };
        renderMembers();
        setTimeout(renderMembers, 4100);
      });
      btns.append(kick);
      row.append(btns);
    }
    box.append(row);
  }
  $('set-hostonly').checked = party.hostOnly;
  $('set-lock').checked = !!party.locked;
  document.querySelectorAll('.host-only-setting').forEach(el => el.classList.toggle('hidden', !isHost()));
  // tiles
  const ids = new Set(party.members.filter(m => m.id !== party.selfId).map(m => m.id));
  for (const id of [...tiles.keys()]) if (id !== 'self' && !ids.has(id)) { tiles.get(id).el.remove(); tiles.delete(id); hiddenFaces.delete(id); }
  updateHiddenChip();
  for (const m of party.members) {
    if (m.id === party.selfId) { if (tiles.has('self')) setTileName('self', `${m.name} (you)`); continue; }
    const t = ensureTile(m.id, m.name);
    setTileName(m.id, `${m.id === party.hostId ? '👑 ' : ''}${m.name}`);
    t.el.classList.toggle('reconnecting', !m.connected);
  }
  layoutGrid();
}

// Warn about things that silently break a party: old versions, different cuts of a movie.
function checkFriends() {
  const me = party.members.find(x => x.id === party.selfId);
  for (const m of party.members) {
    if (m.id === party.selfId || !m.connected) continue;
    if (m.version && versionLess(m.version, VERSION)) notifyOnce('old-' + m.id, `${m.name} is on an older CouchSync (v${m.version}). Send them the new version so things work for both of you.`, 3600_000);
    if (me && me.duration && m.duration && onPartyMedia() && Math.abs(me.duration - m.duration) > 60) {
      const diff = Math.round(Math.abs(me.duration - m.duration) / 60);
      notifyOnce('len-' + m.id + '-' + party.media?.key, `${m.name}'s video is about ${diff} min ${m.duration > me.duration ? 'longer' : 'shorter'} than yours — you may be on different versions (extended cut, region, or ads), so scenes won't line up perfectly.`, 3600_000);
    }
  }
}

// ---------------- video tiles ----------------
const tiles = new Map(); // id -> { el, video, analyser }
function ensureTile(id, name) {
  if (tiles.has(id)) return tiles.get(id);
  const el = $('tile-tpl').content.firstElementChild.cloneNode(true);
  const video = el.querySelector('video');
  el.querySelector('.avatar').textContent = initials(name);
  el.querySelector('.avatar').style.background = colorFor(id === 'self' ? party.selfId : id);
  el.classList.add('no-video');
  if (id === 'self') { el.classList.add('self'); video.muted = true; }
  el.querySelector('.tile-hide').addEventListener('click', ev => { ev.stopPropagation(); setHidden(id, true); });
  gridEl.insertBefore(el, gridEl.contains(showHiddenEl) ? showHiddenEl : null);
  if (hiddenFaces.has(id)) el.classList.add('user-hidden');
  const t = { el, video, analyser: null, mediaState: { cam: true, mic: true } };
  tiles.set(id, t);
  layoutGrid();
  return t;
}
function setTileName(id, name) {
  const t = tiles.get(id);
  if (!t) return;
  t.el.querySelector('.nm').textContent = name;
  t.el.querySelector('.avatar').textContent = initials(name.replace('👑 ', '').replace(' (you)', ''));
}
const STATUS_TEXT = {
  connecting: 'Connecting video…',
  checking: 'Connecting video…',
  slow: 'Still connecting…',
  failed: "Can't reach this friend's video — retrying",
};
function setPeerStatus(id, st) {
  const m = party.members.find(x => x.id === id);
  const t = tiles.get(id) || (m ? ensureTile(id, m.name) : null);
  if (!t) return;
  let el = t.el.querySelector('.conn-status');
  if (!el) { el = document.createElement('div'); el.className = 'conn-status'; t.el.append(el); }
  const text = STATUS_TEXT[st] || '';
  el.textContent = text;
  el.classList.toggle('hidden', !text);
  t.el.classList.toggle('conn-bad', st === 'failed');
}
function markTile(id, state) {
  const t = tiles.get(id);
  if (t) t.el.classList.toggle('reconnecting', state === 'reconnecting');
}
function layoutGrid() {
  const visible = [...tiles.values()].filter(t => !t.el.classList.contains('user-hidden')).length;
  gridEl.classList.toggle('one', visible <= 1);
  gridEl.dataset.count = String(visible);
  gridEl.dataset.friends = String([...tiles.entries()].filter(([id, t]) => id !== 'self' && !t.el.classList.contains('user-hidden')).length);
}

// ---------------- hide a person's video ----------------
const hiddenFaces = new Set();      // ids whose video you've hidden (you still hear them)
const showHiddenEl = document.getElementById('show-hidden');
function setHidden(id, hide) {
  if (hide) hiddenFaces.add(id); else hiddenFaces.delete(id);
  const t = tiles.get(id);
  if (t) t.el.classList.toggle('user-hidden', hide);
  updateHiddenChip();
  layoutGrid();
}
function updateHiddenChip() {
  const n = [...hiddenFaces].filter(id => tiles.has(id)).length;
  showHiddenEl.textContent = `👁 Show ${n} hidden`;
  showHiddenEl.classList.toggle('hidden', n === 0);
  if (!gridEl.contains(showHiddenEl)) gridEl.append(showHiddenEl);
}
showHiddenEl.addEventListener('click', () => { [...hiddenFaces].forEach(id => setHidden(id, false)); });

// ---------------- float faces over the movie (picture-in-picture) ----------------
let pipWin = null;      // Document Picture-in-Picture window (Chrome/Brave/Edge 116+)
let pipCanvas = null;   // fallback: one composited video in classic picture-in-picture
async function toggleFloat() {
  if (pipWin) { pipWin.close(); return; }
  if (pipCanvas) { document.exitPictureInPicture().catch(() => {}); return; }
  if ('documentPictureInPicture' in window) {
    try {
      pipWin = await window.documentPictureInPicture.requestWindow({ width: 320, height: Math.min(560, 120 + 170 * Math.max(1, tiles.size - 1)) });
      openDocPip(pipWin);
      return;
    } catch (e) { console.warn('document PiP unavailable:', e.name); pipWin = null; }
  }
  try { await openCanvasPip(); } catch (e) {
    notifyOnce('pip', `This browser won't open a floating window (${e.name}). Use F11 for fullscreen with the panel visible.`, 60000);
  }
}

function openDocPip(w) {
  const d = w.document;
  const link = d.createElement('link');
  link.rel = 'stylesheet';
  link.href = chrome.runtime.getURL('panel.css');
  d.head.append(link);
  d.title = 'CouchSync';
  d.body.classList.add('pip');
  const bar = d.createElement('div');
  bar.className = 'pip-bar';
  const mk = (label, title, fn) => { const b = d.createElement('button'); b.className = 'ctl'; b.textContent = label; b.title = title; b.addEventListener('click', fn); return b; };
  const micB = mk(micOn ? '🎙️' : '🔇', 'Mute / unmute', async () => { await toggleMic(); micB.textContent = micOn ? '🎙️' : '🔇'; micB.classList.toggle('off', !micOn); });
  const camB = mk('📷', 'Camera on / off', async () => { await toggleCam(); camB.classList.toggle('off', !camOn); });
  micB.classList.toggle('off', !micOn); camB.classList.toggle('off', !camOn);
  const back = mk('⤢', 'Put faces back in the panel', () => w.close());
  bar.append(micB, camB, back);
  d.body.append(gridEl, bar);
  gridEl.querySelectorAll('video').forEach(v => v.play().catch(() => {}));
  $('float-placeholder').classList.remove('hidden');
  $('float').classList.add('on');
  tellContent({ cs: 'pip', on: true });
  w.addEventListener('pagehide', () => {
    $('float-placeholder').before(gridEl);
    $('float-placeholder').classList.add('hidden');
    gridEl.querySelectorAll('video').forEach(v => v.play().catch(() => {}));
    $('float').classList.remove('on');
    pipWin = null;
    tellContent({ cs: 'pip', on: false });
  });
}

// Fallback: draw the visible faces into one canvas and float that as a normal PiP video.
async function openCanvasPip() {
  const c = document.createElement('canvas');
  c.width = 320; c.height = 240;
  const ctx = c.getContext('2d');
  const v = document.createElement('video');
  v.muted = true; v.playsInline = true;
  v.srcObject = c.captureStream(15);
  const draw = () => {
    const faces = [...tiles.entries()].filter(([id, t]) => id !== 'self' && !t.el.classList.contains('user-hidden'));
    const n = Math.max(1, faces.length);
    c.height = n === 1 ? 240 : 160 * Math.ceil(n / 2);
    ctx.fillStyle = '#111'; ctx.fillRect(0, 0, c.width, c.height);
    faces.forEach(([id, t], i) => {
      const w = n === 1 ? 320 : 160, h = n === 1 ? 240 : 160;
      const x = n === 1 ? 0 : (i % 2) * 160, y = n === 1 ? 0 : Math.floor(i / 2) * 160;
      if (t.video.videoWidth && !t.el.classList.contains('no-video')) ctx.drawImage(t.video, x, y, w, h);
      else { ctx.fillStyle = colorFor(id); ctx.fillRect(x, y, w, h); ctx.fillStyle = '#fff'; ctx.font = 'bold 40px system-ui'; ctx.textAlign = 'center'; ctx.fillText(initials(t.el.querySelector('.nm').textContent), x + w / 2, y + h / 2 + 14); }
      ctx.fillStyle = '#fff'; ctx.font = '13px system-ui'; ctx.textAlign = 'left'; ctx.fillText(t.el.querySelector('.nm').textContent, x + 6, y + h - 8);
    });
  };
  draw();
  const timer = setInterval(draw, 66);
  await v.play();
  await v.requestPictureInPicture();
  pipCanvas = { v, timer };
  $('float').classList.add('on');
  tellContent({ cs: 'pip', on: true });
  try {
    navigator.mediaSession.setActionHandler('togglemicrophone', () => toggleMic());
    navigator.mediaSession.setActionHandler('togglecamera', () => toggleCam());
  } catch {}
  v.addEventListener('leavepictureinpicture', () => {
    clearInterval(timer); v.srcObject = null; pipCanvas = null;
    $('float').classList.remove('on');
    tellContent({ cs: 'pip', on: false });
  }, { once: true });
}
function tellContent(msg) {
  if (boundTabId !== null) chrome.tabs.sendMessage(boundTabId, msg).catch(() => {});
}
function refreshTileVideo(id) {
  const t = tiles.get(id);
  if (!t) return;
  const stream = t.video.srcObject;
  const vt = stream && stream.getVideoTracks().find(x => x.readyState === 'live');
  const camOn = id === 'self' ? !!(localStream && localStream.getVideoTracks().some(x => x.readyState === 'live' && x.enabled)) : t.mediaState.cam !== false;
  t.el.classList.toggle('no-video', !vt || !camOn || (id !== 'self' && vt.muted));
  t.el.querySelector('.icons').textContent = t.mediaState.mic === false ? '🔇' : '';
}

// ---------------- local camera/mic ----------------
let mesh = null;
let localStream = null;
let micOn = true, camOn = true;

async function mediaPermissionState() {
  try {
    const [c, m] = await Promise.all([
      navigator.permissions.query({ name: 'camera' }),
      navigator.permissions.query({ name: 'microphone' }),
    ]);
    return c.state === 'granted' && m.state === 'granted' ? 'granted' : (c.state === 'denied' && m.state === 'denied' ? 'denied' : 'prompt');
  } catch { return 'prompt'; }
}

async function getStream() {
  const video = { width: { ideal: 320 }, height: { ideal: 240 }, frameRate: { ideal: 15, max: 15 } };
  const audio = { echoCancellation: true, noiseSuppression: true, autoGainControl: true };
  const attempts = [{ video, audio }, { audio }, { video }];
  for (const c of attempts) {
    try { return await navigator.mediaDevices.getUserMedia(c); } catch (e) { console.warn('getUserMedia', c, e.name); }
  }
  return null;
}

async function startLocalMedia(fromPermissionPage) {
  const t = ensureTile('self', `${prefs.name || 'You'} (you)`);
  const perm = await mediaPermissionState();
  if (perm !== 'granted' && !fromPermissionPage && !params.has('autoMedia')) {
    // Chrome can't show the camera prompt inside a side panel, so ask on a normal page once.
    addSystem('Camera & mic are off. Click 📷 to turn them on (one-time permission).');
    camOn = false; micOn = false;
    updateMediaButtons();
    return;
  }
  const stream = await getStream();
  if (!stream) {
    notifyOnce('busy', 'Could not start camera/mic (is another app using it?). You can still watch and see friends.');
    camOn = false; micOn = false;
    updateMediaButtons();
    return;
  }
  if (localStream) localStream.getTracks().forEach(tr => tr.stop());
  localStream = stream;
  stream.getTracks().forEach(watchEnded);
  camOn = stream.getVideoTracks().length > 0;
  micOn = stream.getAudioTracks().length > 0;
  t.video.srcObject = stream;
  t.video.play().catch(() => {});
  await mesh.setLocalStream(stream);
  mesh.setMediaState({ cam: camOn, mic: micOn });
  watchLevel('self', stream);
  refreshTileVideo('self');
  updateMediaButtons();
  headphoneTip();
}
function headphoneTip() {
  if (prefs.headphoneTip || !liveTracks('audio').length) return;
  savePrefs({ headphoneTip: true });
  addSystem('🎧 Tip: wear headphones — otherwise your mic picks up the movie and friends hear it twice.');
}

let permissionTabOpening = false;
async function openPermissionPage() {
  if (permissionTabOpening) return;
  permissionTabOpening = true;
  try {
    // Reuse an already-open permission tab instead of piling up new ones.
    const url = chrome.runtime.getURL('permission.html');
    const [existing] = await chrome.tabs.query({ url });
    if (existing) await chrome.tabs.update(existing.id, { active: true });
    else await chrome.tabs.create({ url });
  } catch {} finally {
    setTimeout(() => { permissionTabOpening = false; }, 1500);
  }
}

// Say each problem once, not once per click.
const lastNotice = new Map();
function notifyOnce(key, text, ms = 15000) {
  if (Date.now() - (lastNotice.get(key) || 0) < ms) return;
  lastNotice.set(key, Date.now());
  addSystem(text);
}

const liveTracks = kind => (localStream ? localStream.getTracks().filter(t => t.kind === kind && t.readyState === 'live') : []);

// Get one more device (camera or mic) without touching the one we already have.
async function acquire(kind) {
  if (!EMBED && (await mediaPermissionState()) !== 'granted') {
    notifyOnce('perm', 'Camera/mic permission expired or was never saved. A tab opened — click Allow and pick "Forever"/"Allow on every visit".');
    openPermissionPage();
    return false;
  }
  const V = { width: { ideal: 320 }, height: { ideal: 240 }, frameRate: { ideal: 15, max: 15 } };
  const A = { echoCancellation: true, noiseSuppression: true, autoGainControl: true };
  const constraints = kind === 'both' ? { video: V, audio: A } : kind === 'video' ? { video: V } : { audio: A };
  try {
    const s = await navigator.mediaDevices.getUserMedia(constraints);
    if (!localStream) localStream = new MediaStream();
    s.getTracks().forEach(tr => { watchEnded(tr); localStream.addTrack(tr); });
    return true;
  } catch (e) {
    if (e.name === 'NotAllowedError') {
      notifyOnce('perm', 'Chrome/Brave blocked the camera/mic. A tab opened to fix it — click Allow and pick "Forever".');
      openPermissionPage();
    } else if (e.name === 'NotReadableError') {
      notifyOnce('busy', `Your ${kind === 'video' ? 'camera' : 'mic'} is being used by another app (Zoom, Teams…). Close it and try again.`);
    } else {
      notifyOnce('dev-' + e.name, `${kind === 'video' ? 'Camera' : 'Mic'} unavailable (${e.name}).`);
    }
    return false;
  }
}

// If the OS or browser takes the device away (unplugged, permission revoked), reflect it in the UI.
function watchEnded(track) {
  track.addEventListener('ended', () => {
    if (track.kind === 'video') camOn = false; else micOn = false;
    if (mesh) { mesh.setLocalStream(localStream); mesh.setMediaState({ cam: camOn, mic: micOn }); }
    refreshTileVideo('self');
    updateMediaButtons();
  });
}

async function applyLocalChange() {
  // Muted/off tracks stay open (so no new permission is ever needed) but are not sent to friends.
  liveTracks('audio').forEach(t => { t.enabled = micOn; });
  liveTracks('video').forEach(t => { t.enabled = camOn; });
  await mesh.setLocalStream(localStream);
  mesh.setMediaState({ cam: camOn, mic: micOn });
  const sv = tiles.get('self').video;
  if (sv.srcObject !== localStream) { sv.srcObject = localStream; }
  sv.play().catch(() => {});
  if (liveTracks('audio').length) watchLevel('self', localStream);
  refreshTileVideo('self');
  updateMediaButtons();
}

let toggling = false;
async function toggleMic() {
  if (toggling) return;
  toggling = true;
  try {
    if (!liveTracks('audio').length && !liveTracks('video').length) {
      if (!(await acquire('both')) && !(await acquire('audio'))) return;
      micOn = true; camOn = liveTracks('video').length > 0;
    } else if (!liveTracks('audio').length) { if (!(await acquire('audio'))) return; micOn = true; }
    else micOn = !micOn;
    await applyLocalChange();
    headphoneTip();
  } finally { toggling = false; }
}

async function toggleCam() {
  if (toggling) return;
  toggling = true;
  try {
    if (!liveTracks('audio').length && !liveTracks('video').length) {
      if (!(await acquire('both')) && !(await acquire('video'))) return;
      camOn = liveTracks('video').length > 0; micOn = liveTracks('audio').length > 0;
    } else if (!liveTracks('video').length) { if (!(await acquire('video'))) return; camOn = true; }
    else camOn = !camOn; // just pause sending; the camera light turns off shortly while disabled
    await applyLocalChange();
  } finally { toggling = false; }
}

function updateMediaButtons() {
  if (EMBED && boundTabId !== null) chrome.tabs.sendMessage(boundTabId, { cs: 'mini-state', mic: micOn, cam: camOn }, { frameId: 0 }).catch(() => {});
  if ($('mini-mic')) { $('mini-mic').textContent = micOn ? '🎙️' : '🔇'; $('mini-mic').classList.toggle('off', !micOn); $('mini-cam').classList.toggle('off', !camOn); }
  $('toggle-mic').classList.toggle('off', !micOn);
  $('toggle-mic').textContent = micOn ? '🎙️' : '🔇';
  $('toggle-cam').classList.toggle('off', !camOn);
  $('toggle-cam').title = camOn ? 'Turn camera off' : 'Turn camera on';
}

// ---------------- remote streams + who's talking ----------------
let audioCtx = null;
function getAudioCtx() {
  if (!audioCtx) { try { audioCtx = new AudioContext(); } catch { return null; } }
  if (audioCtx.state === 'suspended') audioCtx.resume().catch(() => {});
  return audioCtx;
}
document.addEventListener('click', () => getAudioCtx(), { capture: true });

function watchLevel(id, stream) {
  const t = tiles.get(id);
  const track = stream.getAudioTracks()[0];
  if (!t || !track) return;
  const ctx = getAudioCtx();
  if (!ctx) return;
  try {
    if (t.source) t.source.disconnect();
    t.source = ctx.createMediaStreamSource(new MediaStream([track]));
    t.analyser = ctx.createAnalyser();
    t.analyser.fftSize = 512;
    t.source.connect(t.analyser);
    t.buf = new Float32Array(t.analyser.fftSize);
  } catch { t.analyser = null; }
}

let lastFriendSpeech = 0, ducking = false;
setInterval(() => {
  let friendTalking = false;
  for (const [id, t] of tiles) {
    if (!t.analyser) continue;
    t.analyser.getFloatTimeDomainData(t.buf);
    let sum = 0;
    for (const v of t.buf) sum += v * v;
    const rms = Math.sqrt(sum / t.buf.length);
    const muted = id === 'self' ? !micOn : t.mediaState.mic === false;
    const speaking = rms > 0.02 && !muted;
    t.el.classList.toggle('speaking', speaking);
    if (speaking && id !== 'self') friendTalking = true;
  }
  if (friendTalking) lastFriendSpeech = Date.now();
  const shouldDuck = prefs.duck && Date.now() - lastFriendSpeech < 1500;
  if (shouldDuck !== ducking && activeFrameId !== null) {
    ducking = shouldDuck;
    chrome.tabs.sendMessage(boundTabId, { cs: 'duck', on: ducking }, { frameId: activeFrameId }).catch(() => {});
  }
}, 150);

// Browsers can block sound until you click in the page. Show a button instead of failing silently.
function playRemote(t) {
  t.video.play().then(updateSoundButton).catch(err => {
    if (err.name === 'NotAllowedError') $('enable-sound').classList.remove('hidden');
  });
}
function updateSoundButton() {
  const blocked = [...tiles.entries()].some(([id, t]) => id !== 'self' && t.video.srcObject && t.video.paused);
  $('enable-sound').classList.toggle('hidden', !blocked);
}
$('enable-sound').addEventListener('click', () => {
  getAudioCtx();
  tiles.forEach((t, id) => { if (id !== 'self' && t.video.srcObject) { t.video.muted = false; t.video.play().catch(() => {}); } });
  setTimeout(updateSoundButton, 500);
});
setInterval(updateSoundButton, 2000);

function createMesh() {
  mesh = new Mesh({
    selfId: party.selfId,
    sendSignal: (to, data) => send({ type: 'signal', to, data }),
    onPeerStream: (id, stream) => {
      const m = party.members.find(x => x.id === id);
      const t = ensureTile(id, m ? m.name : 'Friend');
      if (t.video.srcObject !== stream) t.video.srcObject = stream;
      t.video.muted = false;
      t.video.volume = 1;
      playRemote(t);
      stream.getTracks().forEach(tr => { tr.onmute = tr.onunmute = () => refreshTileVideo(id); });
      watchLevel(id, stream);
      refreshTileVideo(id);
    },
    onPeerGone: id => {
      const t = tiles.get(id);
      if (t) { t.video.srcObject = null; t.analyser = null; refreshTileVideo(id); }
    },
    onPeerStatus: (id, conn, mediaState) => {
      const t = tiles.get(id);
      if (!t) return;
      if (mediaState) { t.mediaState = mediaState; refreshTileVideo(id); }
      if (conn) setPeerStatus(id, conn);
      if (conn === 'failed') notifyOnce('rtc-fail-' + id, hasRelay
        ? "Couldn't connect video with a friend — retrying through the relay."
        : "Couldn't connect video with a friend: your networks block direct video calls, and this server has no relay set up yet, so it can't get through. The server owner needs to add a TURN relay (see README).", 60000);
      if (conn === 'connected') mesh.routeOf(id).then(r => {
        const t2 = tiles.get(id);
        if (t2) { t2.el.dataset.route = r || ''; renderMembers(); }
        mesh.setPeerRoute(id, r); // relay connections use less bandwidth (and cost less)
      });
    },
  });
}

// ---------------- sidebar modes (open / floating faces / hidden) ----------------
let sidebarMode = 'open';
function applySidebarMode(mode) {
  sidebarMode = mode;
  document.body.classList.toggle('mini', mode === 'mini');
  if (mode === 'mini') gridEl.querySelectorAll('video').forEach(v => v.play().catch(() => {}));
}
function miniHeight() {
  const n = [...tiles.entries()].filter(([id, t]) => id !== 'self' && !t.el.classList.contains('user-hidden')).length;
  return n <= 1 ? 230 : n === 2 ? 160 : 300;
}
function requestMode(mode) {
  if (!EMBED || boundTabId === null) return;
  applySidebarMode(mode);
  chrome.tabs.sendMessage(boundTabId, { cs: 'sidebar-mode', mode, height: miniHeight() }, { frameId: 0 }).catch(() => {});
}
$('collapse').addEventListener('click', () => requestMode(party.joined && tiles.size > 1 ? 'mini' : 'hidden'));
$('mini-expand').addEventListener('click', () => requestMode('open'));
$('mini-hide').addEventListener('click', () => requestMode('hidden'));
$('mini-mic').addEventListener('click', async () => { await toggleMic(); syncMiniButtons(); });
$('mini-cam').addEventListener('click', async () => { await toggleCam(); syncMiniButtons(); });
function syncMiniButtons() {
  $('mini-mic').textContent = micOn ? '🎙️' : '🔇';
  $('mini-mic').classList.toggle('off', !micOn);
  $('mini-cam').classList.toggle('off', !camOn);
}

// ---------------- views & actions ----------------
function showView(v) {
  $('start').classList.toggle('hidden', v !== 'start');
  $('party').classList.toggle('hidden', v !== 'party');
  $('settings').classList.add('hidden');
}
function showStartError(text) {
  const e = $('start-error');
  e.textContent = text;
  e.classList.toggle('hidden', !text);
}

async function requireName() {
  const n = $('name').value.trim();
  if (!n) { $('name').focus(); showStartError('Enter your name first.'); return false; }
  await savePrefs({ name: n });
  return true;
}

let joinStarted = 0; // increments every time we start joining something; stale boot steps check it
async function startParty({ room, server, resume }) {
  const my = ++joinStarted;
  // Drop any connection that's still in progress (e.g. an old party being resumed).
  if (ws || wsWanted) { disconnect(); if (mesh) mesh.closeAll(); }
  party.resume = !!resume;
  showStartError('');
  party.server = normalizeServer(server || prefs.serverUrl);
  if (!party.server) return showStartError('Set the server address under "Server" first.');
  await savePrefs({ serverUrl: party.server });
  party.room = room || null;
  party.joined = false;
  if (boundTabId === null) await rebindToCurrent();
  if (my !== joinStarted) return; // something newer (an invite) took over while we waited
  createMesh();
  $('chat').textContent = '';
  connect();
}

function parseInvite(text) {
  text = (text || '').trim();
  const m = text.match(/^(https?:\/\/[^/]+)\/j\/([a-z0-9]{4,32})/i);
  if (m) return { server: m[1], room: m[2].toLowerCase() };
  if (/^[a-z0-9]{4,32}$/i.test(text)) return { room: text.toLowerCase() };
  return null;
}

$('create').addEventListener('click', async () => { if (await requireName()) startParty({}); });
$('join').addEventListener('click', async () => {
  if (!(await requireName())) return;
  const inv = parseInvite($('join-code').value);
  if (!inv) return showStartError('Paste the invite link (or the party code).');
  startParty(inv);
});
$('join-code').addEventListener('keydown', e => { if (e.key === 'Enter') $('join').click(); });
$('server-url').addEventListener('change', () => savePrefs({ serverUrl: normalizeServer($('server-url').value) }));
$('test-server').addEventListener('click', async () => {
  const s = normalizeServer($('server-url').value);
  $('server-status').textContent = 'Checking…';
  try {
    const r = await fetch(`${s}/health`, { cache: 'no-store' });
    $('server-status').textContent = r.ok ? '✓ Server is up' : `✗ Server answered ${r.status}`;
  } catch { $('server-status').textContent = '✗ Can\'t reach it'; }
});

$('copy-link').addEventListener('click', async () => {
  const link = `${party.server}/j/${party.room}`;
  try { await navigator.clipboard.writeText(link); addSystem(`Invite link copied: ${link}`); }
  catch { addSystem(`Invite link: ${link}`); }
});
$('toggle-mic').addEventListener('click', toggleMic);
$('float').addEventListener('click', toggleFloat);
$('float-placeholder').addEventListener('click', toggleFloat);
$('toggle-cam').addEventListener('click', toggleCam);
$('sync-me').addEventListener('click', () => {
  const f = activeStatus();
  if (!f) return addSystem('Open the party video in this tab first.');
  send({ type: 'control', action: 'seek', position: f.currentTime });
  send({ type: 'control', action: f.paused ? 'pause' : 'play', position: f.currentTime });
});

$('open-settings').addEventListener('click', () => {
  $('set-name').value = prefs.name;
  $('set-follow').checked = prefs.autoFollow;
  $('set-duck').checked = prefs.duck;
  $('set-hideip').checked = !!prefs.hideIp;
  renderMembers();
  $('settings').classList.remove('hidden');
});
$('close-settings').addEventListener('click', () => $('settings').classList.add('hidden'));
$('set-name').addEventListener('change', async () => {
  const n = $('set-name').value.trim();
  if (!n) return;
  await savePrefs({ name: n });
  send({ type: 'rename', name: n });
});
$('set-follow').addEventListener('change', e => savePrefs({ autoFollow: e.target.checked }));
$('set-duck').addEventListener('change', e => savePrefs({ duck: e.target.checked }));
$('set-hostonly').addEventListener('change', e => send({ type: 'settings', hostOnly: e.target.checked }));
$('set-lock').addEventListener('change', e => send({ type: 'settings', locked: e.target.checked }));
$('set-hideip').addEventListener('change', async e => {
  await savePrefs({ hideIp: e.target.checked });
  applyHideIp();
  if (mesh && party.joined) {
    // Reconnect video so the new setting takes effect.
    mesh.closeAll();
    for (const m of party.members) if (m.id !== party.selfId && m.connected) whenIceReady(() => { mesh.addPeer(m.id, true); setPeerStatus(m.id, 'connecting'); });
  }
});
$('copy-debug').addEventListener('click', async () => {
  const info = await debugInfo();
  try { await navigator.clipboard.writeText(info); addSystem('Debug info copied — paste it to whoever is helping you.'); }
  catch { addSystem(info); }
});
async function debugInfo() {
  const routes = await Promise.all(party.members.filter(m => m.id !== party.selfId).map(async m => `${m.name}: ${m.connected ? 'online' : 'offline'}, v${m.version || '?'}, video=${(mesh && (await mesh.routeOf(m.id))) || 'not connected'}, state=${mesh?.peers.get(m.id)?.pc.connectionState || '-'}`));
  const f = activeStatus();
  return [
    `CouchSync v${VERSION} · ${navigator.userAgent}`,
    `server ${party.server} · party ${party.room} · host=${isHost()} · hostOnly=${party.hostOnly} · locked=${!!party.locked}`,
    `relay available=${hasRelay} · hideIp=${prefs.hideIp}`,
    `tab ${hostOf(tabUrl)} · key=${tabKey} · party key=${party.media?.key || '-'}`,
    `player: ${f ? `t=${f.currentTime.toFixed(1)} dur=${Math.round(f.duration)} paused=${f.paused} buffering=${f.buffering} ad=${f.ad}` : 'not found'}`,
    `party: ${party.state ? `${party.state.playing ? 'playing' : 'paused'} @ ${expectedPosition().toFixed(1)}` : '-'} hold=${party.hold || '-'}`,
    `cam=${camOn} mic=${micOn}`,
    ...routes,
  ].join('\n');
}
$('rebind').addEventListener('click', async () => { await rebindToCurrent(); $('settings').classList.add('hidden'); addSystem('Party moved to this tab.'); });
$('cam-permission').addEventListener('click', openPermissionPage);
$('leave').addEventListener('click', leaveParty);

// The tab the person is looking at in a normal browser window. (When CouchSync runs in its own
// small window — Opera and other browsers without a side panel — "current window" would be itself.)
const IN_WINDOW = params.has('window');
async function activeBrowserTab() {
  try {
    if (!IN_WINDOW) { const [t] = await chrome.tabs.query({ active: true, currentWindow: true }); return t || null; }
    const w = await chrome.windows.getLastFocused({ windowTypes: ['normal'] });
    const [t] = await chrome.tabs.query({ active: true, windowId: w.id });
    return t || null;
  } catch { return null; }
}
async function rebindToCurrent() {
  let tab = null;
  tab = await activeBrowserTab();
  if (tab) await bindTab(tab.id);
}

function leaveParty() {
  if (pipWin) pipWin.close();
  if (pipCanvas) document.exitPictureInPicture().catch(() => {});
  hiddenFaces.clear(); updateHiddenChip();
  send({ type: 'leave' });
  disconnect();
  if (mesh) mesh.closeAll();
  if (localStream) { localStream.getTracks().forEach(t => t.stop()); localStream = null; }
  if (activeFrameId !== null && boundTabId !== null) {
    chrome.tabs.sendMessage(boundTabId, { cs: 'deactivate-all' }, { frameId: activeFrameId }).catch(() => {});
  }
  activeFrameId = null;
  tiles.forEach(t => t.el.remove());
  tiles.clear();
  Object.assign(party, { room: null, selfId: null, hostId: null, members: [], state: null, media: null, hold: null, joined: false });
  chrome.storage.local.remove('currentParty');
  showView('start');
}

// Closing the panel = leaving (seat is kept 30s server-side so reopening rejoins)
window.addEventListener('pagehide', () => { if (party.joined) { wsWanted = false; } });

async function checkPendingJoin() {
  const { pendingJoin } = await chrome.storage.local.get('pendingJoin');
  if (!pendingJoin || Date.now() - pendingJoin.at > 10 * 60_000) return false;
  // A sidebar only takes invites opened in its own tab.
  if (EMBED && pendingJoin.tabId != null && pendingJoin.tabId !== boundTabId) return false;
  await chrome.storage.local.remove('pendingJoin');
  if (party.room === pendingJoin.room && (party.joined || wsWanted)) return true;
  if (party.joined) leaveParty();
  if (pendingJoin.tabId != null) await bindTab(pendingJoin.tabId);
  if (!prefs.name) {
    // Need a name before joining: prefill code and wait for the user.
    $('join-code').value = `${pendingJoin.server}/j/${pendingJoin.room}`;
    showStartError('Enter your name, then press Join.');
    $('name').focus();
    return true;
  }
  startParty({ room: pendingJoin.room, server: pendingJoin.server });
  return true;
}

// If the party tab is showing an invite page (…/j/<code>), that invite is what the person wants.
function inviteFromTab() {
  const m = (tabUrl || '').match(/^(https?:\/\/[^/]+)\/j\/([a-z0-9]{4,32})(?:[/?#]|$)/i);
  return m ? { server: m[1], room: m[2].toLowerCase(), at: Date.now(), tabId: boundTabId } : null;
}

// Keep "currently in a party" fresh so only a recent party is auto-resumed when the panel reopens.
setInterval(() => {
  if (party.joined && party.room) chrome.storage.local.set({ currentParty: { room: party.room, server: party.server, tabId: boundTabId, at: Date.now() } });
}, 30_000);

// ---------------- boot ----------------
(async function boot() {
  if (EMBED) {
    // Only the CouchSync page script may show this panel (stops other websites from framing it).
    const token = location.hash.slice(1);
    let ok = false;
    try {
      const r = await chrome.tabs.sendMessage(Number(params.get('tabId')), { cs: 'verify-embed', token }, { frameId: 0 });
      ok = !!(r && r.ok);
      if (r && r.mode) applySidebarMode(r.mode);
    } catch {}
    if (!ok) { document.body.textContent = 'CouchSync can only be opened with its toolbar button.'; return; }
  }
  await loadPrefs();
  $('name').value = prefs.name;
  $('server-url').value = prefs.serverUrl;
  updateMediaButtons();
  const tabParam = params.get('tabId');
  if (tabParam) await bindTab(Number(tabParam));
  else await rebindToCurrent();

  // 1) An invite always wins: from the tab itself, or one the invite page just saved.
  const fromTab = inviteFromTab();
  if (fromTab) await chrome.storage.local.set({ pendingJoin: fromTab });
  if (await checkPendingJoin()) return;
  // The invite page may still be saving it (the panel can open a split second earlier): give it a moment.
  await new Promise(r => setTimeout(r, 700));
  if (joinStarted || await checkPendingJoin()) return;
  // 2) Otherwise, reopened the panel during a party? Rejoin it — but only if it was recent.
  const { currentParty } = await chrome.storage.local.get('currentParty');
  if (currentParty && Date.now() - currentParty.at < 20 * 60_000 && prefs.name && (!EMBED || currentParty.tabId === boundTabId)) {
    if (currentParty.tabId != null && !tabParam) {
      try { await chrome.tabs.get(currentParty.tabId); await bindTab(currentParty.tabId); } catch {}
    }
    if (joinStarted) return; // an invite arrived while we were looking
    await startParty({ room: currentParty.room, server: currentParty.server, resume: true });
  }
})();
