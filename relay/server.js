// YACR WebSocket 中转服务
// 只做一件事：把同一房间里某个成员发来的消息转给其他成员（或指定的成员）。不存储任何内容。
// 房间身份由 Worker 签发的票据证明：base64url(JSON{r:房间号,u:uid,e:过期时间}).HMAC-SHA256(RELAY_SECRET)
import { createServer } from 'node:http';
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { WebSocketServer } from 'ws';

const PORT = Number(process.env.PORT || 8790);
const HOST = process.env.HOST || '127.0.0.1';
const SECRET = process.env.RELAY_SECRET || '';
const ORIGINS = (process.env.ALLOWED_ORIGINS || '').split(',').map((s) => s.trim().replace(/\/+$/, '')).filter(Boolean);
const MAX_FRAME = 1024 * 1024 + 64 * 1024; // 单帧上限：1 MB 数据块 + 头
const MAX_PER_ROOM = 40;

if (SECRET.length < 16) {
  console.error('RELAY_SECRET 未设置或太短（至少 16 个字符）');
  process.exit(1);
}

const b64url = (buf) => Buffer.from(buf).toString('base64url');
const sign = (payload) => b64url(createHmac('sha256', SECRET).update(payload).digest());
const safeEq = (a, b) => {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && timingSafeEqual(x, y);
};

function verifyTicket(ticket) {
  const [payload, sig] = String(ticket || '').split('.');
  if (!payload || !sig || !safeEq(sig, sign(payload))) return null;
  try {
    const t = JSON.parse(Buffer.from(payload, 'base64url').toString());
    if (typeof t.r !== 'string' || typeof t.u !== 'string' || !(t.e > Date.now())) return null;
    return t;
  } catch {
    return null;
  }
}

const rooms = new Map(); // 房间号 -> Map(connId -> { ws, uid })
const kicked = new Map(); // 房间号 -> Set(uid)，被管理员移出的人在房间结束前不能再连回来

const log = (...a) => console.log(new Date().toISOString(), ...a);

function send(ws, data) {
  if (ws.readyState === ws.OPEN) ws.send(data);
}

function closeRoom(roomId, code, reason) {
  const room = rooms.get(roomId);
  if (room) for (const { ws } of room.values()) ws.close(code, reason);
  rooms.delete(roomId);
  kicked.delete(roomId);
}

function kick(roomId, uids) {
  const set = kicked.get(roomId) || new Set();
  uids.forEach((u) => set.add(u));
  kicked.set(roomId, set);
  const room = rooms.get(roomId);
  if (room) for (const { ws, uid } of room.values()) if (set.has(uid)) ws.close(4003, 'banned');
}

// ---------- HTTP：健康检查 + Worker 的控制接口 ----------
const server = createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname === '/relay/health') {
    res.writeHead(200, { 'content-type': 'text/plain' });
    return res.end('ok');
  }
  if (url.pathname === '/relay/control' && req.method === 'POST') {
    if (!safeEq(req.headers['x-relay-secret'] || '', SECRET)) {
      res.writeHead(401);
      return res.end();
    }
    let body = '';
    req.on('data', (c) => {
      body += c;
      if (body.length > 64 * 1024) req.destroy();
    });
    req.on('end', () => {
      try {
        const m = JSON.parse(body);
        log('control', m.action, m.room || '', Array.isArray(m.uids) ? m.uids.length : '');
        if (m.action === 'end' && m.room) closeRoom(m.room, 4001, 'ended');
        if (m.action === 'kick' && Array.isArray(m.uids)) {
          for (const roomId of m.room ? [m.room] : [...rooms.keys()]) kick(roomId, m.uids);
        }
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end('{"ok":true}');
      } catch {
        res.writeHead(400);
        res.end();
      }
    });
    return;
  }
  res.writeHead(404);
  res.end();
});

// ---------- WebSocket ----------
const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_FRAME, perMessageDeflate: false });

server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url, 'http://x');
  const origin = req.headers.origin;
  const ticket = verifyTicket(url.searchParams.get('t'));
  const reject = (code) => {
    socket.write(`HTTP/1.1 ${code} Forbidden\r\nConnection: close\r\n\r\n`);
    socket.destroy();
  };
  if (url.pathname !== '/relay') return reject(404);
  if (ORIGINS.length && origin && !ORIGINS.includes(origin)) return reject(403);
  if (!ticket) return reject(401);
  if (kicked.get(ticket.r)?.has(ticket.u)) return reject(403);
  const room = rooms.get(ticket.r);
  if (room && room.size >= MAX_PER_ROOM) return reject(429);
  wss.handleUpgrade(req, socket, head, (ws) => onConnection(ws, ticket));
});

function onConnection(ws, ticket) {
  const roomId = ticket.r;
  const id = randomBytes(9).toString('base64url');
  const idBuf = Buffer.from(id);
  if (!rooms.has(roomId)) rooms.set(roomId, new Map());
  const room = rooms.get(roomId);

  // 告诉新人现在有谁，告诉其他人有新人
  send(ws, JSON.stringify({ t: 'hi', id, peers: [...room.entries()].map(([pid, p]) => ({ id: pid, uid: p.uid })) }));
  const joined = JSON.stringify({ t: 'join', id, uid: ticket.u });
  for (const p of room.values()) send(p.ws, joined);
  room.set(id, { ws, uid: ticket.u });

  ws.isAlive = true;
  ws.on('pong', () => (ws.isAlive = true));

  // 路由：有 to（连接 id 数组）就只发给他们，否则发给房间里除自己外的所有人
  const targets = (to) => {
    const list = Array.isArray(to) ? to : null;
    return [...room.entries()].filter(([pid]) => pid !== id && (!list || list.includes(pid))).map(([, p]) => p.ws);
  };

  ws.on('message', (data, isBinary) => {
    if (isBinary) {
      // 二进制帧：[u32 头长度][头 JSON][数据]。转发时在前面加上 [u8 发送者 id 长度][发送者 id]
      const buf = Buffer.isBuffer(data) ? data : Buffer.concat(data);
      if (buf.length < 4) return;
      const hl = buf.readUInt32BE(0);
      if (hl > 16 * 1024 || 4 + hl > buf.length) return;
      let hdr;
      try {
        hdr = JSON.parse(buf.subarray(4, 4 + hl).toString());
      } catch {
        return;
      }
      const out = Buffer.concat([Buffer.from([idBuf.length]), idBuf, buf]);
      for (const t of targets(hdr.to)) send(t, out);
      return;
    }
    let m;
    try {
      m = JSON.parse(data.toString());
    } catch {
      return;
    }
    if (!m || typeof m !== 'object') return;
    const to = m.to;
    delete m.to;
    m.from = id; // 发送者由服务端填写，不能伪造
    const out = JSON.stringify(m);
    for (const t of targets(to)) send(t, out);
  });

  ws.on('close', () => {
    room.delete(id);
    const left = JSON.stringify({ t: 'leave', id });
    for (const p of room.values()) send(p.ws, left);
    if (!room.size) rooms.delete(roomId);
  });
  ws.on('error', () => { });
}

// 心跳：30 秒没回应就断开
setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.isAlive) {
      ws.terminate();
      continue;
    }
    ws.isAlive = false;
    ws.ping();
  }
}, 30000).unref();

server.listen(PORT, HOST, () => log(`yacr-relay listening on ${HOST}:${PORT}`));
