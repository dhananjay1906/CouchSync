'use strict';
process.env.RECONNECT_GRACE_MS = '300';
process.env.BUFFER_WAIT_LIMIT_MS = '400';
process.env.TURN_URLS = 'turn:turn.example.com:3478';
process.env.TURN_SECRET = 'testsecret';

const test = require('node:test');
const assert = require('node:assert');
const WebSocket = require('ws');
const { server, close } = require('../server');

let port;
test.before(() => new Promise(r => server.listen(0, () => { port = server.address().port; r(); })));
test.after(() => close());

function client(clientId, name) {
  const ws = new WebSocket(`ws://localhost:${port}/ws`);
  const inbox = [];
  const waiters = [];
  ws.on('message', d => {
    const m = JSON.parse(d);
    inbox.push(m);
    for (const w of [...waiters]) if (w.pred(m)) { waiters.splice(waiters.indexOf(w), 1); w.resolve(m); }
  });
  const c = {
    ws, inbox, clientId, name,
    open: () => new Promise(r => ws.once('open', r)),
    send: m => ws.send(JSON.stringify(m)),
    wait: (pred, ms = 2000) => {
      const found = inbox.find(pred);
      if (found) { inbox.splice(inbox.indexOf(found), 1); return Promise.resolve(found); }
      return new Promise((resolve, reject) => {
        const w = { pred, resolve: m => { clearTimeout(timer); inbox.splice(inbox.indexOf(m), 1); resolve(m); } };
        const timer = setTimeout(() => { waiters.splice(waiters.indexOf(w), 1); reject(new Error('timeout waiting')); }, ms);
        waiters.push(w);
      });
    },
    clear: () => inbox.splice(0),
  };
  return c;
}

async function join(id, name, room) {
  const c = client(id, name);
  await c.open();
  c.send(room ? { type: 'hello', clientId: id, name, room } : { type: 'hello', clientId: id, name, create: true });
  c.welcome = await c.wait(m => m.type === 'welcome' || m.type === 'error');
  return c;
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

test('create, join, sync play/pause/seek', async () => {
  const a = await join('aaaaaaaa1', 'Asha');
  assert.equal(a.welcome.type, 'welcome');
  const room = a.welcome.room;
  const b = await join('bbbbbbbb1', 'Ben', room);
  assert.equal(b.welcome.type, 'welcome');
  assert.equal(b.welcome.hostId, 'aaaaaaaa1');
  await a.wait(m => m.type === 'peer-join' && m.id === 'bbbbbbbb1');

  a.send({ type: 'control', action: 'play', position: 10 });
  const s = await b.wait(m => m.type === 'state' && m.reason === 'play');
  assert.equal(s.state.playing, true);
  assert.equal(s.state.position, 10);

  b.send({ type: 'control', action: 'pause', position: 12.5 });
  const p = await a.wait(m => m.type === 'state' && m.reason === 'pause');
  assert.equal(p.state.playing, false);
  assert.equal(p.state.position, 12.5);
  a.ws.close(); b.ws.close();
});

test('room caps at 4 and rejects 5th', async () => {
  const cs = [await join('cap0000001', 'P1')];
  const room = cs[0].welcome.room;
  for (let i = 2; i <= 4; i++) cs.push(await join(`cap000000${i}`, `P${i}`, room));
  const fifth = await join('cap0000005', 'P5', room);
  assert.equal(fifth.welcome.type, 'error');
  assert.equal(fifth.welcome.code, 'full');
  // a member who was already in can rejoin even when full
  cs[3].ws.close();
  await sleep(50);
  const again = await join('cap0000004', 'P4', room);
  assert.equal(again.welcome.type, 'welcome');
  assert.equal(again.welcome.rejoin, true);
  for (const c of [...cs, fifth, again]) c.ws.close();
});

test('buffering friend holds playback, then it resumes', async () => {
  const a = await join('buf0000001', 'A');
  const room = a.welcome.room;
  const b = await join('buf0000002', 'B', room);
  a.send({ type: 'control', action: 'play', position: 0 });
  await b.wait(m => m.type === 'state' && m.reason === 'play');
  b.send({ type: 'report', buffering: true, hasVideo: true });
  const held = await a.wait(m => m.type === 'state' && m.reason === 'hold');
  assert.equal(held.state.playing, false);
  assert.match(held.hold, /B/);
  b.send({ type: 'report', buffering: false, hasVideo: true });
  const resumed = await a.wait(m => m.type === 'state' && m.reason === 'resume');
  assert.equal(resumed.state.playing, true);
  a.ws.close(); b.ws.close();
});

test('stuck buffering friend stops holding everyone after the limit', async () => {
  const a = await join('stk0000001', 'A');
  const room = a.welcome.room;
  const b = await join('stk0000002', 'B', room);
  a.send({ type: 'control', action: 'play', position: 0 });
  b.send({ type: 'report', buffering: true, hasVideo: true });
  await a.wait(m => m.type === 'state' && m.reason === 'hold');
  const resumed = await a.wait(m => m.type === 'state' && m.reason === 'resume', 7000);
  assert.equal(resumed.state.playing, true);
  a.ws.close(); b.ws.close();
});

test('ad on one client holds; pause during hold is respected', async () => {
  const a = await join('add0000001', 'A');
  const room = a.welcome.room;
  const b = await join('add0000002', 'B', room);
  a.send({ type: 'control', action: 'play', position: 5 });
  b.send({ type: 'report', ad: true, hasVideo: true });
  await a.wait(m => m.type === 'state' && m.reason === 'hold');
  a.send({ type: 'control', action: 'pause', position: 5 });
  await b.wait(m => m.type === 'state' && m.reason === 'pause');
  b.send({ type: 'report', ad: false, hasVideo: true });
  const cleared = await a.wait(m => m.type === 'state' && m.reason === 'hold-cleared');
  assert.equal(cleared.state.playing, false, 'should stay paused because someone paused during the ad');
  a.ws.close(); b.ws.close();
});

test('disconnect keeps seat during grace, then removes and transfers host', async () => {
  const a = await join('grc0000001', 'A');
  const room = a.welcome.room;
  const b = await join('grc0000002', 'B', room);
  a.ws.close();
  const tmp = await b.wait(m => m.type === 'peer-leave' && m.temporary);
  assert.equal(tmp.id, 'grc0000001');
  const leave = await b.wait(m => m.type === 'peer-leave' && !m.temporary, 2000);
  assert.equal(leave.id, 'grc0000001');
  const members = await b.wait(m => m.type === 'members' && m.hostId === 'grc0000002');
  assert.equal(members.members.length, 1);
  b.ws.close();
});

test('signaling relays only to members in the same room', async () => {
  const a = await join('sig0000001', 'A');
  const b = await join('sig0000002', 'B', a.welcome.room);
  const x = await join('sig0000003', 'X'); // different room
  a.send({ type: 'signal', to: 'sig0000002', data: { sdp: 'offer' } });
  const got = await b.wait(m => m.type === 'signal');
  assert.equal(got.from, 'sig0000001');
  a.send({ type: 'signal', to: 'sig0000003', data: { sdp: 'nope' } });
  await sleep(150);
  assert.ok(!x.inbox.some(m => m.type === 'signal'));
  a.ws.close(); b.ws.close(); x.ws.close();
});

test('only host can change media; host-only lock works', async () => {
  const a = await join('med0000001', 'A');
  const b = await join('med0000002', 'B', a.welcome.room);
  b.send({ type: 'media', url: 'https://www.netflix.com/watch/1', key: 'netflix:1', title: 'Nope' });
  a.send({ type: 'media', url: 'https://www.netflix.com/watch/2', key: 'netflix:2', title: 'Ep 2' });
  const m = await b.wait(x => x.type === 'media');
  assert.equal(m.media.key, 'netflix:2');
  a.send({ type: 'settings', hostOnly: true });
  await b.wait(x => x.type === 'members' && x.hostOnly === true);
  b.clear();
  b.send({ type: 'control', action: 'play', position: 1 });
  const sys = await b.wait(x => x.type === 'system' && /Only the host/.test(x.text));
  assert.ok(sys);
  a.ws.close(); b.ws.close();
});

test('chat is sanitized-length and rate limited', async () => {
  const a = await join('cht0000001', 'A');
  const b = await join('cht0000002', 'B', a.welcome.room);
  a.send({ type: 'chat', text: 'x'.repeat(2000) });
  const c = await b.wait(m => m.type === 'chat');
  assert.equal(c.text.length, 500);
  for (let i = 0; i < 12; i++) a.send({ type: 'chat', text: 'spam' + i });
  await a.wait(m => m.type === 'system' && /Slow down/.test(m.text));
  a.ws.close(); b.ws.close();
});

test('bad room and ICE endpoint with TURN credentials', async () => {
  const c = await join('bad0000001', 'A', 'doesnotexist');
  assert.equal(c.welcome.code, 'not_found');
  c.ws.close();
  const res = await fetch(`http://localhost:${port}/ice?id=abc12345`);
  const j = await res.json();
  const turn = j.iceServers.find(s => s.username);
  assert.ok(turn && turn.credential, 'TURN creds present');
});

test('host switching episode holds until friends load it, and keeps host position', async () => {
  const a = await join('epi0000001', 'A');
  const b = await join('epi0000002', 'B', a.welcome.room);
  b.send({ type: 'report', hasVideo: true, key: 'netflix:1' });
  a.send({ type: 'media', url: 'https://www.netflix.com/watch/2', key: 'netflix:2', title: 'Ep 2', position: 42, playing: true });
  const st = await b.wait(m => m.type === 'state' && m.reason === 'media');
  assert.equal(st.state.position, 42);
  const held = await b.wait(m => m.type === 'state' && m.reason === 'hold');
  assert.match(held.hold, /B \(loading\)/);
  b.send({ type: 'report', hasVideo: true, key: 'netflix:2' });
  const res = await a.wait(m => m.type === 'state' && m.reason === 'resume');
  assert.equal(res.state.playing, true);
  a.ws.close(); b.ws.close();
});

test('room can be resurrected after server restart', async () => {
  const c = client('res0000001', 'R');
  await c.open();
  c.send({ type: 'hello', clientId: 'res0000001', name: 'R', room: 'lostroom99', resurrect: true });
  const w = await c.wait(m => m.type === 'welcome');
  assert.equal(w.room, 'lostroom99');
  assert.equal(w.resurrected, true);
  c.ws.close();
});
