// Windblade Royale - matchmaking + relay server (zero dependencies, Node 16+)
// Run:  node server.js        (PORT env var optional, default 8080)
// Free hosts that work: Render / Koyeb / Fly.io / Railway (start command: node server.js)
'use strict';
const http = require('http');
const crypto = require('crypto');

const PORT = process.env.PORT || 8080;
const MAXP = 50;            // players per match
const PUBLIC_WAIT = 30;     // seconds a public lobby waits for more players
const PRIVATE_WAIT = 60;    // seconds a private (code) lobby waits unless host presses start
const NEAR = 1900;          // events/state are relayed to players within this distance
const FAR_EVERY = 8;        // far players still get every 8th state update (map + alive count)

const server = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'Access-Control-Allow-Origin': '*' });
  res.end('Windblade Royale server OK\nlobbies=' + lobbies.size + ' players=' + clients.size + '\n');
});

// ---------- minimal WebSocket (RFC 6455) ----------
const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
server.on('upgrade', (req, socket) => {
  const key = req.headers['sec-websocket-key'];
  if (!key) return socket.destroy();
  const acc = crypto.createHash('sha1').update(key + GUID).digest('base64');
  socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ' + acc + '\r\n\r\n');
  socket.setNoDelay(true);
  onConnect(socket);
});

function frame(str) {
  const p = Buffer.from(str, 'utf8'), n = p.length;
  let h;
  if (n < 126) h = Buffer.from([0x81, n]);
  else if (n < 65536) { h = Buffer.alloc(4); h[0] = 0x81; h[1] = 126; h.writeUInt16BE(n, 2); }
  else { h = Buffer.alloc(10); h[0] = 0x81; h[1] = 127; h.writeBigUInt64BE(BigInt(n), 2); }
  return Buffer.concat([h, p]);
}

// ---------- state ----------
let nextId = 1;
const clients = new Map();   // id -> client
const lobbies = new Map();   // key -> lobby

function send(c, obj) { if (c.open) { try { c.socket.write(frame(JSON.stringify(obj))); } catch (_) { } } }
function sendRaw(c, f) { if (c.open) { try { c.socket.write(f); } catch (_) { } } }

function onConnect(socket) {
  const c = { id: nextId++, socket, open: true, buf: Buffer.alloc(0), lobby: null, name: '', hero: 'hayate', x: 0, y: 0, seq: 0, alive: true, last: Date.now() };
  clients.set(c.id, c);
  socket.on('data', d => {
    c.buf = Buffer.concat([c.buf, d]);
    if (c.buf.length > 1 << 20) return drop(c);
    parse(c);
  });
  socket.on('close', () => drop(c));
  socket.on('error', () => drop(c));
  send(c, { t: 'hi', id: c.id });
}

function parse(c) {
  for (;;) {
    const b = c.buf;
    if (b.length < 2) return;
    const op = b[0] & 15, masked = (b[1] & 128) !== 0;
    let len = b[1] & 127, off = 2;
    if (len === 126) { if (b.length < 4) return; len = b.readUInt16BE(2); off = 4; }
    else if (len === 127) { if (b.length < 10) return; len = Number(b.readBigUInt64BE(2)); off = 10; }
    if (len > 65536) return drop(c);
    const need = off + (masked ? 4 : 0) + len;
    if (b.length < need) return;
    let payload = b.subarray(off + (masked ? 4 : 0), need);
    if (masked) {
      const m = b.subarray(off, off + 4);
      const out = Buffer.alloc(len);
      for (let i = 0; i < len; i++) out[i] = payload[i] ^ m[i & 3];
      payload = out;
    }
    c.buf = b.subarray(need);
    if (op === 8) return drop(c);
    if (op === 9) { try { c.socket.write(Buffer.concat([Buffer.from([0x8a, payload.length]), payload])); } catch (_) { } continue; }
    if (op === 1) { let m; try { m = JSON.parse(payload.toString('utf8')); } catch (_) { continue; } onMsg(c, m); }
  }
}

function drop(c) {
  if (!c.open) return;
  c.open = false;
  clients.delete(c.id);
  try { c.socket.destroy(); } catch (_) { }
  const L = c.lobby;
  if (L) {
    L.players.delete(c.id);
    if (L.started) {
      for (const p of L.players.values()) send(p, { t: 'left', id: c.id });
    }
    if (L.players.size === 0) lobbies.delete(L.key);
    else if (!L.started) bcastLobby(L);
  }
}

// ---------- matchmaking ----------
function findLobby(code) {
  const key = code ? 'c:' + code : 'public';
  let L = lobbies.get(key);
  if (L && (L.started || L.players.size >= MAXP)) {
    if (!code) { L = null; lobbies.delete(key); } else if (L.started) { L = null; lobbies.delete(key); }
  }
  if (!L) {
    L = { key, code: code || '', players: new Map(), started: false, created: Date.now(), wait: code ? PRIVATE_WAIT : PUBLIC_WAIT, host: 0, seed: (Math.random() * 2 ** 31) | 0 };
    lobbies.set(key, L);
  }
  return L;
}

function bcastLobby(L) {
  const left = Math.max(0, Math.ceil(L.wait - (Date.now() - L.created) / 1000));
  for (const p of L.players.values()) send(p, { t: 'lobby', n: L.players.size, max: MAXP, left, code: L.code, host: p.id === L.host });
}

function startLobby(L) {
  if (L.started) return;
  L.started = true;
  const list = [...L.players.values()];
  const players = list.map(p => ({ id: p.id, n: p.name, h: p.hero }));
  for (const p of list) send(p, { t: 'start', seed: L.seed, me: p.id, players });
  // a fresh lobby opens for the next joiners
  if (lobbies.get(L.key) === L) lobbies.delete(L.key);
}

setInterval(() => {
  for (const L of lobbies.values()) {
    if (L.started) continue;
    const el = (Date.now() - L.created) / 1000;
    if (L.players.size >= MAXP || el >= L.wait) startLobby(L);
    else bcastLobby(L);
  }
  const now = Date.now();
  for (const c of clients.values()) if (now - c.last > 40000) drop(c);
}, 1000);

function onMsg(c, m) {
  c.last = Date.now();
  switch (m.t) {
    case 'join': {
      if (c.lobby) return;
      c.name = String(m.n || 'Player').replace(/[^\p{L}\p{N} _.\-]/gu, '').slice(0, 14) || 'Player';
      c.hero = String(m.h || 'hayate').slice(0, 10);
      const code = String(m.code || '').toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 10);
      const L = findLobby(code);
      c.lobby = L;
      L.players.set(c.id, c);
      if (!L.host) L.host = c.id;
      bcastLobby(L);
      break;
    }
    case 'go': { // host of a private room starts early
      const L = c.lobby;
      if (L && !L.started && L.host === c.id) startLobby(L);
      break;
    }
    case 'ping': send(c, { t: 'pong' }); break;
    case 's': case 'e': { // state (s) / event (e): relay with interest filtering
      const L = c.lobby;
      if (!L || !L.started) return;
      if (m.t === 's') { c.x = +m.x || 0; c.y = +m.y || 0; c.alive = m.al !== 0; c.seq++; }
      m.i = c.id;
      const f = frame(JSON.stringify(m));
      const global = m.g === 1 || (m.t === 's' && c.seq % FAR_EVERY === 0);
      for (const p of L.players.values()) {
        if (p === c) continue;
        if (global || (Math.abs(p.x - c.x) < NEAR && Math.abs(p.y - c.y) < NEAR)) sendRaw(p, f);
      }
      break;
    }
  }
}

server.listen(PORT, () => console.log('Windblade Royale server listening on :' + PORT));
