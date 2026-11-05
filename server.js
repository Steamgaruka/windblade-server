// Windblade Royale - matchmaking + relay server (zero dependencies, Node 16+)
// Run:  node server.js        (PORT env var optional, default 8080)
// Free hosts that work: Render / Koyeb / Fly.io / Railway (start command: node server.js)
'use strict';
const http = require('http');
const crypto = require('crypto');

const PORT = process.env.PORT || 8080;
const MAXP = 50;            // players per match
const PUBLIC_WAIT = 8;      // seconds a public lobby waits for more players (then bots fill in)
const PRIVATE_WAIT = 60;    // seconds a private (code) lobby waits unless host presses start
const NEAR = 1900;          // events/state are relayed to players within this distance
const FAR_EVERY = 8;        // far players still get every 8th state update (map + alive count)

// ---------- developer stats (who played, when, level, coins, heroes) ----------
const fs = require('fs');
const DEV_KEY = process.env.DEV_KEY || 'wb-dev-7k3q';       // open  /dev?key=YOUR_KEY   (set DEV_KEY in Render to change it)
const SHEET_URL = process.env.SHEET_URL || '';      // Google Apps Script web-app URL (optional): every player update is also sent to a Google Sheet
const DATA_FILE = process.env.DATA_FILE || './players.json';
const HEROES = ['hayate', 'luna', 'carm', 'milo', 'wokin', 'panda', 'box'];
const HNAME = { hayate: 'ฮายาเตะ', luna: 'ลูน่า', carm: 'คาร์มิลลา', milo: 'ไมโล', wokin: 'วอคิน', panda: 'แพนด้า', box: 'แกว' };
let DB = { players: {}, events: [] };
try { DB = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')); } catch (_) { }
let dirty = false;
setInterval(() => { if (dirty) { dirty = false; try { fs.writeFileSync(DATA_FILE, JSON.stringify(DB)); } catch (_) { } } }, 30000);
const clean = (s, n) => String(s == null ? '' : s).replace(/[^\p{L}\p{N} _.\-]/gu, '').slice(0, n);
const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
function record(m) {
  const uid = clean(m.u, 24); if (!uid) return;
  const P = DB.players;
  if (!P[uid]) { if (Object.keys(P).length > 5000) return; P[uid] = { first: Date.now(), visits: 0, joins: 0, lo: 0 }; }
  const p = P[uid], now = Date.now();
  p.name = clean(m.n, 14) || p.name || 'Guest'; p.last = now;
  p.lv = Math.max(1, Math.min(30, +m.lv || 1)); p.coins = Math.max(0, +m.c || 0) | 0;
  p.owned = (Array.isArray(m.o) ? m.o : []).filter(h => HEROES.includes(h));
  const hp = {}; if (m.hp && typeof m.hp === 'object') for (const h of HEROES) if (+m.hp[h] > 0) hp[h] = +m.hp[h] | 0; p.hp = hp;
  p.games = +m.g | 0; p.wins = +m.w | 0; p.kills = +m.k | 0; p.best = +m.b | 0;
  const ty = ['open', 'join', 'end'].includes(m.e) ? m.e : 'open';
  let log = true;
  if (ty === 'open') { if (now - p.lo > 1800000) p.visits++; else log = false; p.lo = now; }
  if (ty === 'join') p.joins++;
  if (log) { DB.events.push({ t: now, u: uid, n: p.name, e: ty, lv: p.lv, r: ty === 'end' ? (+m.rk | 0) : 0 }); if (DB.events.length > 1500) DB.events.splice(0, DB.events.length - 1500); }
  dirty = true;
  if (SHEET_URL) {
    const body = JSON.stringify({ u: uid, name: p.name, lv: p.lv, coins: p.coins, owned: p.owned, hp: p.hp, games: p.games, wins: p.wins, kills: p.kills, best: p.best, visits: p.visits, joins: p.joins, first: p.first, last: p.last, ev: log ? { t: now, e: ty, r: ty === 'end' ? (+m.rk | 0) : 0 } : null });
    try { fetch(SHEET_URL, { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body, redirect: 'follow' }).catch(() => { }); } catch (_) { }
  }
}
const fmt = t => t ? new Date(t).toLocaleString('th-TH', { timeZone: 'Asia/Bangkok', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : '-';
function dash() {
  const ps = Object.entries(DB.players).sort((a, b) => b[1].last - a[1].last), day = Date.now() - 86400000;
  const act = ps.filter(([, p]) => p.last > day).length;
  const rows = ps.map(([u, p]) => {
    const top = Object.entries(p.hp || {}).sort((a, b) => b[1] - a[1])[0];
    return '<tr><td>' + esc(p.name) + '<br><small>' + esc(u.slice(0, 6)) + '</small></td><td>' + p.lv + '</td><td>' + p.coins.toLocaleString() + '</td><td>' + p.owned.length + '/7<br><small>' + p.owned.map(h => HNAME[h]).join(', ') + '</small></td><td>' + (top ? HNAME[top[0]] + ' (' + top[1] + ')' : '-') + '</td><td>' + p.games + ' / ' + p.wins + '</td><td>' + p.visits + '</td><td>' + fmt(p.first) + '</td><td>' + fmt(p.last) + '</td></tr>';
  }).join('');
  const ev = DB.events.slice(-80).reverse().map(e => '<tr><td>' + fmt(e.t) + '</td><td>' + esc(e.n) + '</td><td>' + ({ open: 'เปิดเกม', join: 'เข้าออนไลน์', end: 'จบเกม' + (e.r ? ' อันดับ ' + e.r : '') }[e.e] || e.e) + '</td><td>Lv.' + e.lv + '</td></tr>').join('');
  return '<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="refresh" content="30"><title>Windblade Dev</title><style>body{font:14px system-ui,sans-serif;background:#0f1220;color:#e8ebff;margin:0;padding:14px}h1{font-size:20px}h2{font-size:16px;margin:22px 0 8px}table{border-collapse:collapse;width:100%}th,td{padding:6px 8px;border-bottom:1px solid #2a3050;text-align:left;vertical-align:top}th{color:#ffd24d;font-weight:600}small{color:#9aa3c7}.w{overflow-x:auto}.k{display:inline-block;background:#1c2240;border-radius:8px;padding:6px 12px;margin:0 8px 8px 0}</style>'
    + '<h1>Windblade Royale · Dev</h1><div class="k">ผู้เล่นทั้งหมด <b>' + ps.length + '</b></div><div class="k">เข้า 24 ชม. <b>' + act + '</b></div><div class="k">ออนไลน์ตอนนี้ <b>' + clients.size + '</b></div>'
    + '<h2>ผู้เล่น</h2><div class="w"><table><tr><th>ชื่อ</th><th>เลเวล</th><th>เหรียญ</th><th>ตัวละครที่มี</th><th>เล่นบ่อยสุด</th><th>เกม / ชนะ</th><th>เข้า (ครั้ง)</th><th>เข้าครั้งแรก</th><th>ล่าสุด</th></tr>' + rows + '</table></div>'
    + '<h2>ใครเข้าเกมเมื่อไหร่ (ล่าสุด 80)</h2><div class="w"><table><tr><th>เวลา</th><th>ชื่อ</th><th>เหตุการณ์</th><th>เลเวล</th></tr>' + ev + '</table></div><p><small>เวลาเป็นเวลาไทย · ข้อมูลเก็บในไฟล์บนเซิร์ฟเวอร์ ถ้า Render รีสตาร์ตหรืออัปเดตโค้ดข้อมูลอาจหาย</small></p>';
}

const server = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x'), cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*' };
  if (req.method === 'OPTIONS') { res.writeHead(204, cors); return res.end(); }
  if (u.pathname === '/log' && req.method === 'POST') {
    let b = ''; req.on('data', d => { b += d; if (b.length > 4096) req.destroy(); });
    req.on('end', () => { try { record(JSON.parse(b)); } catch (_) { } res.writeHead(204, cors); res.end(); });
    return;
  }
  if (u.pathname === '/dev' || u.pathname === '/dev.json') {
    if (u.searchParams.get('key') !== DEV_KEY) { res.writeHead(403, { 'Content-Type': 'text/plain' }); return res.end('forbidden'); }
    if (u.pathname === '/dev.json') { res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' }); return res.end(JSON.stringify(DB)); }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); return res.end(dash());
  }
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
