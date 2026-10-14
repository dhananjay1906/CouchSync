// CouchSync server: room state, playback sync, chat, and WebRTC signaling.
// Video/audio between friends is peer-to-peer; this server only relays small JSON messages.
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');

const PORT = Number(process.env.PORT) || 8787;
const MAX_MEMBERS = Number(process.env.MAX_MEMBERS) || 4;
const RECONNECT_GRACE_MS = Number(process.env.RECONNECT_GRACE_MS) || 30_000;
const EMPTY_ROOM_TTL_MS = Number(process.env.EMPTY_ROOM_TTL_MS) || 10 * 60_000;
const BUFFER_WAIT_LIMIT_MS = Number(process.env.BUFFER_WAIT_LIMIT_MS) || 20_000;
const HEARTBEAT_MS = 15_000;
const MAX_MSG_BYTES = 64 * 1024;

const rooms = new Map(); // roomId -> Room

// ---------- helpers ----------
const now = () => Date.now();
const ROOM_ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789';
function newRoomId() {
  let id;
  do {
    const bytes = crypto.randomBytes(8);
    id = Array.from(bytes, b => ROOM_ALPHABET[b % ROOM_ALPHABET.length]).join('');
  } while (rooms.has(id));
  return id;
}
const isRoomId = s => typeof s === 'string' && /^[a-z0-9]{4,32}$/.test(s);
const isClientId = s => typeof s === 'string' && /^[A-Za-z0-9_-]{8,64}$/.test(s);
const clampStr = (s, n) => (typeof s === 'string' ? s.replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, n) : '');
const finite = (n, lo, hi) => typeof n === 'number' && Number.isFinite(n) && n >= lo && n <= hi;

function send(ws, msg) {
  if (ws && ws.readyState === 1) {
    try { ws.send(JSON.stringify(msg)); } catch { /* socket closing */ }
  }
}

// ---------- room model ----------
function createRoom(id) {
  const room = {
    id,
    members: new Map(), // clientId -> member
    hostId: null,
    hostOnly: false,
    media: null, // { url, key, title, duration }
    // Authoritative playback state. position is in seconds at server time `at`.
    state: { playing: false, position: 0, at: now(), rate: 1, seq: 0 },
    wantPlaying: false, // what users asked for; actual playing can be held for buffering/ads
    holdReason: null,
    emptySince: null,
    chatSeq: 0,
    mediaChangedAt: 0,
  };
  rooms.set(id, room);
  return room;
}

function currentPosition(room, t = now()) {
  const s = room.state;
  return s.playing ? s.position + ((t - s.at) / 1000) * s.rate : s.position;
}

function connectedMembers(room) {
  return [...room.members.values()].filter(m => m.ws);
}

function publicMembers(room) {
  return [...room.members.values()].map(m => ({
    id: m.id, name: m.name, connected: !!m.ws, buffering: !!m.buffering, ad: !!m.ad, ready: !!m.hasVideo,
  }));
}

function broadcast(room, msg, exceptId) {
  for (const m of room.members.values()) if (m.id !== exceptId) send(m.ws, msg);
}

function broadcastMembers(room) {
  broadcast(room, { type: 'members', members: publicMembers(room), hostId: room.hostId, hostOnly: room.hostOnly });
}

function broadcastState(room, by, reason) {
  room.state.seq += 1;
  broadcast(room, { type: 'state', state: room.state, by: by || null, reason: reason || null, hold: room.holdReason, serverTime: now() });
}

function system(room, text) {
  broadcast(room, { type: 'system', text, ts: now() });
}

// Who is currently holding everyone up (buffering too long is ignored so one bad connection can't freeze the party)
function holders(room) {
  const t = now();
  return connectedMembers(room).filter(m => {
    if (m.ad) return true;
    // After the host switches episode/movie, wait for friends' tabs to load it.
    if (room.media && m.id !== room.hostId && m.key !== room.media.key && t - room.mediaChangedAt < BUFFER_WAIT_LIMIT_MS) return true;
    if (m.buffering) return t - m.bufferingSince < BUFFER_WAIT_LIMIT_MS;
    return false;
  });
}

// Re-evaluate whether playback should be held (someone buffering or watching an ad).
function evaluateHold(room) {
  const h = holders(room);
  const t = now();
  if (h.length && room.wantPlaying) {
    const reason = h.map(m => `${m.name}${m.ad ? ' (ad)' : m.buffering ? '' : room.media && m.key !== room.media.key ? ' (loading)' : ''}`).join(', ');
    if (room.state.playing) {
      room.state = { ...room.state, playing: false, position: currentPosition(room, t), at: t };
      room.holdReason = reason;
      broadcastState(room, null, 'hold');
    } else if (room.holdReason !== reason) {
      room.holdReason = reason;
      broadcastState(room, null, 'hold');
    }
  } else if (!h.length && room.holdReason) {
    room.holdReason = null;
    if (room.wantPlaying && !room.state.playing) {
      room.state = { ...room.state, playing: true, at: t };
      broadcastState(room, null, 'resume');
    } else {
      broadcastState(room, null, 'hold-cleared');
    }
  }
}

function pickNewHost(room) {
  const candidates = connectedMembers(room).sort((a, b) => a.joinedAt - b.joinedAt);
  const next = candidates[0] || [...room.members.values()].sort((a, b) => a.joinedAt - b.joinedAt)[0];
  room.hostId = next ? next.id : null;
}

function removeMember(room, id) {
  const m = room.members.get(id);
  if (!m) return;
  clearTimeout(m.graceTimer);
  room.members.delete(id);
  broadcast(room, { type: 'peer-leave', id });
  system(room, `${m.name} left`);
  if (room.hostId === id) {
    pickNewHost(room);
    if (room.hostId) system(room, `${room.members.get(room.hostId).name} is now the host`);
  }
  broadcastMembers(room);
  evaluateHold(room);
  if (room.members.size === 0) room.emptySince = now();
}

// ---------- message handlers ----------
function handleHello(ws, msg) {
  if (ws.member) return;
  if (!isClientId(msg.clientId)) return send(ws, { type: 'error', code: 'bad_request', message: 'Invalid client id' });
  const name = clampStr(msg.name, 24) || 'Guest';
  let room;
  if (msg.create) {
    room = createRoom(newRoomId());
  } else {
    if (!isRoomId(msg.room)) return send(ws, { type: 'error', code: 'bad_room', message: 'That party code is not valid.' });
    room = rooms.get(msg.room);
    // A client that was already in this room (e.g. the server restarted) may bring it back with the same code.
    if (!room && msg.resurrect) { room = createRoom(msg.room); room.resurrected = true; }
    if (!room) return send(ws, { type: 'error', code: 'not_found', message: 'Party not found. It may have ended — ask the host for a new link.' });
  }

  let member = room.members.get(msg.clientId);
  const rejoin = !!member;
  if (!member) {
    if (room.members.size >= MAX_MEMBERS) {
      return send(ws, { type: 'error', code: 'full', message: `This party is full (max ${MAX_MEMBERS}).` });
    }
    member = { id: msg.clientId, name, joinedAt: now(), ws: null, buffering: false, bufferingSince: 0, ad: false, hasVideo: false };
    room.members.set(member.id, member);
  } else {
    clearTimeout(member.graceTimer);
    if (member.ws && member.ws !== ws) { member.ws.member = null; try { member.ws.close(4000, 'replaced'); } catch {} }
    member.name = name;
  }
  member.ws = ws;
  member.buffering = false;
  member.ad = false;
  ws.member = member;
  ws.room = room;
  room.emptySince = null;
  if (!room.hostId || !room.members.has(room.hostId)) room.hostId = member.id;

  send(ws, {
    type: 'welcome',
    selfId: member.id,
    room: room.id,
    hostId: room.hostId,
    hostOnly: room.hostOnly,
    media: room.media,
    state: room.state,
    hold: room.holdReason,
    members: publicMembers(room),
    maxMembers: MAX_MEMBERS,
    serverTime: now(),
    rejoin,
    resurrected: !!room.resurrected && room.members.size === 1,
  });
  // Others (re)negotiate video with this peer. On rejoin the old peer connection is dead.
  broadcast(room, { type: 'peer-join', id: member.id, name: member.name }, member.id);
  if (!rejoin) system(room, `${member.name} joined`);
  broadcastMembers(room);
}

function canControl(room, member) {
  return !room.hostOnly || room.hostId === member.id;
}

function handleControl(ws, msg) {
  const { room, member } = ws;
  if (!canControl(room, member)) return send(ws, { type: 'system', text: 'Only the host can control playback right now.', ts: now() });
  const t = now();
  const s = room.state;
  const pos = finite(msg.position, 0, 7 * 86400) ? msg.position : currentPosition(room, t);
  let label;
  switch (msg.action) {
    case 'play':
      room.wantPlaying = true;
      room.state = { ...s, position: pos, at: t, playing: !holders(room).length };
      label = 'played';
      break;
    case 'pause':
      room.wantPlaying = false;
      room.state = { ...s, position: pos, at: t, playing: false };
      label = 'paused';
      break;
    case 'seek':
      room.state = { ...s, position: pos, at: t };
      label = 'jumped to';
      break;
    case 'rate':
      if (!finite(msg.rate, 0.25, 4)) return;
      room.state = { ...s, position: currentPosition(room, t), at: t, rate: msg.rate };
      label = `set speed ${msg.rate}x at`;
      break;
    default:
      return;
  }
  room.stateTouched = true;
  broadcastState(room, member.id, msg.action);
  system(room, `${member.name} ${label} ${fmtTime(room.state.position)}`);
  evaluateHold(room);
}

function fmtTime(sec) {
  sec = Math.max(0, Math.floor(sec));
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
  return (h ? `${h}:${String(m).padStart(2, '0')}` : `${m}`) + `:${String(s).padStart(2, '0')}`;
}

function handleReport(ws, msg) {
  const { room, member } = ws;
  const buffering = !!msg.buffering;
  const ad = !!msg.ad;
  const hasVideo = !!msg.hasVideo;
  const key = clampStr(msg.key, 512) || null;
  let changed = false;
  if (key !== member.key) { member.key = key; changed = true; }
  if (buffering !== member.buffering) {
    member.buffering = buffering;
    member.bufferingSince = buffering ? now() : 0;
    changed = true;
  }
  if (ad !== member.ad) { member.ad = ad; changed = true; }
  if (hasVideo !== member.hasVideo) { member.hasVideo = hasVideo; changed = true; }
  if (changed) { broadcastMembers(room); evaluateHold(room); }
}

function handleMedia(ws, msg) {
  const { room, member } = ws;
  if (room.hostId !== member.id) return; // only host decides what everyone watches
  const url = clampStr(msg.url, 2048);
  const key = clampStr(msg.key, 512) || url;
  if (!/^https?:\/\//.test(url)) return;
  if (room.media && room.media.key === key) {
    // same title; just refresh metadata
    room.media = { ...room.media, title: clampStr(msg.title, 200) || room.media.title, duration: finite(msg.duration, 0, 7 * 86400) ? msg.duration : room.media.duration };
    return;
  }
  const hadMedia = !!room.media;
  room.media = { url, key, title: clampStr(msg.title, 200), duration: finite(msg.duration, 0, 7 * 86400) ? msg.duration : 0 };
  // New title: start from wherever the host's player is (e.g. resuming a movie at 45:00).
  const playing = !!msg.playing;
  room.holdReason = null;
  // If friends already set the state for this room (e.g. after a server restart), keep it.
  const adopted = !(room.resurrected && !hadMedia && room.stateTouched);
  if (adopted) {
    room.wantPlaying = playing;
    room.state = { ...room.state, playing, position: finite(msg.position, 0, 7 * 86400) ? msg.position : 0, at: now(), rate: 1 };
  }
  room.mediaChangedAt = now();
  member.key = key;
  room.state.seq += 1;
  broadcast(room, { type: 'media', media: room.media, by: member.id, state: room.state, adopted });
  broadcastState(room, member.id, 'media');
  system(room, `${member.name} switched to ${room.media.title || 'a new video'}`);
  evaluateHold(room);
}

function handleChat(ws, msg) {
  const { room, member } = ws;
  const text = clampStr(msg.text, 500);
  if (!text) return;
  const t = now();
  member.chatTimes = (member.chatTimes || []).filter(x => t - x < 5000);
  if (member.chatTimes.length >= 8) return send(ws, { type: 'system', text: 'Slow down a little 🙂', ts: t });
  member.chatTimes.push(t);
  broadcast(room, { type: 'chat', id: ++room.chatSeq, from: member.id, name: member.name, text, ts: t, reaction: !!msg.reaction });
}

function handleSignal(ws, msg) {
  const { room, member } = ws;
  const target = room.members.get(msg.to);
  if (!target || !target.ws || msg.data == null) return;
  send(target.ws, { type: 'signal', from: member.id, data: msg.data });
}

function handleSettings(ws, msg) {
  const { room, member } = ws;
  if (room.hostId !== member.id) return;
  if (typeof msg.hostOnly === 'boolean') {
    room.hostOnly = msg.hostOnly;
    system(room, msg.hostOnly ? 'Host locked the remote — only the host can control playback' : 'Everyone can control playback');
  }
  if (typeof msg.makeHost === 'string' && room.members.has(msg.makeHost)) {
    room.hostId = msg.makeHost;
    system(room, `${room.members.get(msg.makeHost).name} is now the host`);
  }
  broadcastMembers(room);
}

function handleRename(ws, msg) {
  const name = clampStr(msg.name, 24);
  if (!name) return;
  ws.member.name = name;
  broadcastMembers(ws.room);
}

function onMessage(ws, raw) {
  if (raw.length > MAX_MSG_BYTES) return;
  // simple per-socket rate limit
  const t = now();
  if (t - ws.rateWindow > 1000) { ws.rateWindow = t; ws.rateCount = 0; }
  if (++ws.rateCount > 60) return;
  let msg;
  try { msg = JSON.parse(raw); } catch { return; }
  if (!msg || typeof msg.type !== 'string') return;

  if (msg.type === 'ping') return send(ws, { type: 'pong', t: msg.t, serverTime: now() });
  if (msg.type === 'hello') return handleHello(ws, msg);
  if (!ws.member) return send(ws, { type: 'error', code: 'not_joined', message: 'Join a party first.' });
  switch (msg.type) {
    case 'control': return handleControl(ws, msg);
    case 'report': return handleReport(ws, msg);
    case 'media': return handleMedia(ws, msg);
    case 'chat': return handleChat(ws, msg);
    case 'signal': return handleSignal(ws, msg);
    case 'settings': return handleSettings(ws, msg);
    case 'rename': return handleRename(ws, msg);
    case 'leave': {
      const { room, member } = ws;
      ws.member = null;
      removeMember(room, member.id);
      return;
    }
  }
}

function onClose(ws) {
  const { room, member } = ws;
  if (!room || !member || member.ws !== ws) return;
  member.ws = null;
  member.buffering = false;
  member.ad = false;
  broadcast(room, { type: 'peer-leave', id: member.id, temporary: true });
  broadcastMembers(room);
  evaluateHold(room);
  // keep their seat for a while so a flaky Wi-Fi blip doesn't kick them out
  member.graceTimer = setTimeout(() => {
    if (!member.ws && room.members.get(member.id) === member) removeMember(room, member.id);
  }, RECONNECT_GRACE_MS);
}

// ---------- ICE (STUN/TURN) config ----------
// Option A: Cloudflare TURN (free up to 1,000 GB/month) — set CF_TURN_KEY_ID and CF_TURN_API_TOKEN.
let cfCache = { at: 0, servers: null };
async function cloudflareIce() {
  const id = process.env.CF_TURN_KEY_ID, token = process.env.CF_TURN_API_TOKEN;
  if (!id || !token) return null;
  if (cfCache.servers && now() - cfCache.at < 6 * 3600_000) return cfCache.servers;
  try {
    const r = await fetch(`https://rtc.live.cloudflare.com/v1/turn/keys/${encodeURIComponent(id)}/credentials/generate-ice-servers`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ ttl: 86400 }),
      signal: AbortSignal.timeout(5000),
    });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const j = await r.json();
    // Port 53 URLs can time out in browsers; drop them.
    const servers = (j.iceServers ? [].concat(j.iceServers) : []).map(s => ({
      ...s, urls: [].concat(s.urls).filter(u => !/:53(\?|$)/.test(u)),
    })).filter(s => s.urls.length);
    cfCache = { at: now(), servers };
    return servers;
  } catch (e) {
    console.warn('Cloudflare TURN credential request failed:', e.message);
    return null;
  }
}

// Option B: your own coturn (TURN_URLS + TURN_SECRET) or any TURN with static TURN_USERNAME/TURN_CREDENTIAL.
function iceServers(clientId) {
  const servers = [{ urls: ['stun:stun.l.google.com:19302', 'stun:stun.cloudflare.com:3478'] }];
  const turnUrls = (process.env.TURN_URLS || '').split(',').map(s => s.trim()).filter(Boolean);
  if (turnUrls.length) {
    if (process.env.TURN_SECRET) {
      // coturn "use-auth-secret" time-limited credentials
      const username = `${Math.floor(now() / 1000) + 12 * 3600}:${clientId || 'anon'}`;
      const credential = crypto.createHmac('sha1', process.env.TURN_SECRET).update(username).digest('base64');
      servers.push({ urls: turnUrls, username, credential });
    } else if (process.env.TURN_USERNAME) {
      servers.push({ urls: turnUrls, username: process.env.TURN_USERNAME, credential: process.env.TURN_CREDENTIAL || '' });
    }
  }
  return servers;
}

// ---------- HTTP ----------
const PUBLIC_DIR = path.join(__dirname, 'public');
const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  const cors = { 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store' };
  if (url.pathname === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json', ...cors });
    return res.end(JSON.stringify({ ok: true, rooms: rooms.size }));
  }
  if (url.pathname === '/ice') {
    const base = iceServers(clampStr(url.searchParams.get('id'), 64));
    return cloudflareIce().then(cf => {
      res.writeHead(200, { 'Content-Type': 'application/json', ...cors });
      res.end(JSON.stringify({ iceServers: cf ? [...base, ...cf] : base }));
    });
  }
  if (url.pathname.startsWith('/j/')) {
    return fs.readFile(path.join(PUBLIC_DIR, 'join.html'), (err, buf) => {
      if (err) { res.writeHead(500); return res.end(); }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(buf);
    });
  }
  if (url.pathname.startsWith('/api/room/')) {
    const id = url.pathname.slice('/api/room/'.length);
    const room = isRoomId(id) && rooms.get(id);
    res.writeHead(room ? 200 : 404, { 'Content-Type': 'application/json', ...cors });
    return res.end(JSON.stringify(room ? { id, media: room.media, members: room.members.size, maxMembers: MAX_MEMBERS } : { error: 'not_found' }));
  }
  if (url.pathname === '/') {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    return res.end('CouchSync server is running.');
  }
  res.writeHead(404); res.end();
});

const wss = new WebSocketServer({ server, path: '/ws', maxPayload: MAX_MSG_BYTES });
wss.on('connection', ws => {
  ws.isAlive = true;
  ws.rateWindow = 0; ws.rateCount = 0;
  ws.on('pong', () => { ws.isAlive = true; });
  ws.on('message', raw => onMessage(ws, raw.toString()));
  ws.on('close', () => onClose(ws));
  ws.on('error', () => {});
});

// Kill dead sockets (laptop lid closed, Wi-Fi dropped) and clean up empty rooms.
let tick = 0;
const SWEEP_MS = 5000;
const sweeper = setInterval(() => {
  if (++tick % Math.max(1, Math.round(HEARTBEAT_MS / SWEEP_MS)) === 0) for (const ws of wss.clients) {
    if (!ws.isAlive) { ws.terminate(); continue; }
    ws.isAlive = false;
    try { ws.ping(); } catch {}
  }
  const t = now();
  for (const room of rooms.values()) {
    if (room.members.size === 0 && room.emptySince && t - room.emptySince > EMPTY_ROOM_TTL_MS) rooms.delete(room.id);
    else if (room.holdReason) evaluateHold(room); // releases holds when a buffering friend exceeds the wait limit
  }
}, SWEEP_MS);

if (require.main === module) {
  server.listen(PORT, () => console.log(`CouchSync server listening on :${PORT}`));
}

module.exports = { server, wss, rooms, close: () => { clearInterval(sweeper); wss.close(); server.close(); } };
