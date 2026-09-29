import { DurableObject } from 'cloudflare:workers';

// ---------- 房间 ID：6 位，Crockford 风格 32 字符表（去掉 i l o u），不区分大小写 ----------
const ALPHA = '0123456789abcdefghjkmnpqrstvwxyz';
const ID_LEN = 6;
const ID_RE = new RegExp(`^[${ALPHA}]{${ID_LEN}}$`);
const newId = () =>
  [...crypto.getRandomValues(new Uint8Array(ID_LEN))].map((b) => ALPHA[b & 31]).join('');
const normalizeId = (s) =>
  String(s || '').toLowerCase().replace(/[^0-9a-z]/g, '').replace(/o/g, '0').replace(/[il]/g, '1');

// ---------- 配置（wrangler.jsonc 的 vars 可覆盖） ----------
const num = (v, d) => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : d;
};
const conf = (env) => ({
  idleMs: num(env.IDLE_MINUTES, 30) * 60e3, // 无新消息多久自动结束
  emptyGraceMs: num(env.EMPTY_GRACE_SECONDS, 60) * 1e3, // 所有人离开后的宽限期
  unjoinedMs: num(env.UNJOINED_MINUTES, 5) * 60e3, // 创建后无人加入的失效时间
  tombstoneMs: num(env.TOMBSTONE_HOURS, 24) * 3600e3, // 结束后保留墓碑多久
  maxMembers: num(env.MAX_MEMBERS, 10),
  createLimit: num(env.CREATE_LIMIT_PER_10MIN, 10), // 每 IP 每 10 分钟可建房数
});

const json = (data, status = 200, headers = {}) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers },
  });

const clip = (s, n) => String(s ?? '').slice(0, n);

// ---------- 管理员鉴权：HttpOnly cookie 里存 ADMIN_TOKEN ----------
const COOKIE = 'rc_admin';
const readCookie = (req, name) => {
  const m = (req.headers.get('cookie') || '').match(new RegExp(`(?:^|;\\s*)${name}=([^;]+)`));
  return m ? decodeURIComponent(m[1]) : null;
};
const safeEqual = (a, b) => {
  const enc = new TextEncoder();
  const x = enc.encode(a);
  const y = enc.encode(b);
  return x.length === y.length && crypto.subtle.timingSafeEqual(x, y);
};
const isAdmin = (req, env) => {
  const t = readCookie(req, COOKIE);
  return Boolean(t && env.ADMIN_TOKEN && safeEqual(t, env.ADMIN_TOKEN));
};

const registry = (env) => env.REGISTRY.get(env.REGISTRY.idFromName('global'));
const roomStub = (env, id) => env.ROOM.get(env.ROOM.idFromName(id));

// 站点开关缓存 10 秒，避免每个请求都访问 Registry
let openCache = { v: false, t: 0 };
const siteOpen = async (env) => {
  if (Date.now() - openCache.t < 10e3) return openCache.v;
  openCache = { v: await registry(env).getOpen(), t: Date.now() };
  return openCache.v;
};

// ---------- Worker 入口：只处理 /api/* 与 /ws/*，其余静态文件不经过这里 ----------
export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    const path = url.pathname;
    const admin = isAdmin(req, env);
    const ip = req.headers.get('cf-connecting-ip') || '';
    const origin = req.headers.get('origin');
    if (origin && origin !== url.origin) return json({ error: 'forbidden_origin' }, 403);

    try {
      if (path === '/api/status') return json({ open: await siteOpen(env), admin });

      // ----- 管理员 -----
      if (path === '/api/admin/login' && req.method === 'POST') {
        const { token } = await req.json().catch(() => ({}));
        if (!env.ADMIN_TOKEN) return json({ error: 'no_admin_token_configured' }, 500);
        if (!token || !safeEqual(String(token), env.ADMIN_TOKEN)) return json({ error: 'bad_token' }, 401);
        const cookie = `${COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=2592000`;
        return json({ ok: true }, 200, { 'set-cookie': cookie });
      }
      if (path === '/api/admin/logout' && req.method === 'POST') {
        return json({ ok: true }, 200, { 'set-cookie': `${COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0` });
      }
      if (path.startsWith('/api/admin/')) {
        if (!admin) return json({ error: 'unauthorized' }, 401);
        return await adminApi(req, env, path);
      }

      // ----- 访客：站点关闭时一律拒绝（管理员除外） -----
      if (!admin && !(await siteOpen(env))) return json({ error: 'closed' }, 503);

      if (path === '/api/rooms' && req.method === 'POST') {
        if (!(await registry(env).reserve(ip || 'unknown', admin))) return json({ error: 'rate_limited' }, 429);
        for (let i = 0; i < 5; i++) {
          const id = newId();
          if ((await roomStub(env, id).init(id)).ok) {
            await registry(env).add(id);
            return json({ id });
          }
        }
        return json({ error: 'busy' }, 503);
      }

      let m = path.match(/^\/api\/rooms\/([^/]+)$/);
      if (m && req.method === 'GET') {
        const id = normalizeId(m[1]);
        if (!ID_RE.test(id)) return json({ exists: false, id });
        return json({ id, ...(await roomStub(env, id).status()) });
      }

      m = path.match(/^\/ws\/([^/]+)$/);
      if (m) {
        if (req.headers.get('upgrade') !== 'websocket') return json({ error: 'expected_websocket' }, 426);
        const id = normalizeId(m[1]);
        if (!ID_RE.test(id)) return json({ error: 'not_found' }, 404);
        const h = new Headers(req.headers);
        h.set('x-rc-admin', admin ? '1' : '0');
        h.set('x-rc-ip', ip);
        return roomStub(env, id).fetch(new Request(req.url, { headers: h }));
      }

      return json({ error: 'not_found' }, 404);
    } catch (err) {
      console.error(err);
      return json({ error: 'server_error' }, 500);
    }
  },
};

async function adminApi(req, env, path) {
  const reg = registry(env);

  if (path === '/api/admin/state' && req.method === 'GET') {
    const ids = await reg.list();
    const rooms = (await Promise.all(ids.map((id) => roomStub(env, id).info()))).filter(Boolean);
    return json({ open: await reg.getOpen(), rooms, config: conf(env) });
  }

  if (path === '/api/admin/open' && req.method === 'POST') {
    const { open } = await req.json().catch(() => ({}));
    const v = await reg.setOpen(Boolean(open));
    openCache = { v, t: Date.now() };
    // 关站时结束所有房间
    if (!v) await Promise.all((await reg.list()).map((id) => roomStub(env, id).end('closed')));
    return json({ open: v });
  }

  if (path === '/api/admin/rooms/end-all' && req.method === 'POST') {
    const ids = await reg.list();
    await Promise.all(ids.map((id) => roomStub(env, id).end('admin')));
    return json({ ended: ids.length });
  }

  const m = path.match(/^\/api\/admin\/rooms\/([^/]+)\/end$/);
  if (m && req.method === 'POST') {
    const id = normalizeId(m[1]);
    if (!ID_RE.test(id)) return json({ error: 'not_found' }, 404);
    return json({ ended: await roomStub(env, id).end('admin') });
  }

  return json({ error: 'not_found' }, 404);
}

// =====================================================================
// Room：每个房间一个实例 —— 信令中继 + 生命周期 + 锁定
// =====================================================================
export class Room extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.c = conf(env);
  }

  getMeta() {
    return this.ctx.storage.get('meta');
  }
  putMeta(meta) {
    return this.ctx.storage.put('meta', meta);
  }
  members() {
    return this.ctx.getWebSockets('m');
  }

  async init(id) {
    if (await this.getMeta()) return { ok: false };
    const now = Date.now();
    const meta = {
      id,
      createdAt: now,
      state: 'open',
      locked: false,
      lastActivity: now,
      emptySince: now,
      everJoined: false,
    };
    await this.putMeta(meta);
    await this.schedule(meta);
    return { ok: true };
  }

  async status() {
    const meta = await this.getMeta();
    if (!meta) return { exists: false };
    const count = meta.state === 'open' ? this.members().length : 0;
    return {
      exists: true,
      state: meta.state,
      reason: meta.reason || null,
      locked: meta.locked,
      full: count >= this.c.maxMembers,
    };
  }

  async info() {
    const meta = await this.getMeta();
    if (!meta) return null;
    const members = this.members().map((ws) => {
      const a = ws.deserializeAttachment() || {};
      return { uid: a.uid, name: a.name, ip: a.ip, ua: a.ua, joinedAt: a.joinedAt, admin: a.admin };
    });
    return { ...meta, members };
  }

  // ----- WebSocket 接入 -----
  async fetch(req) {
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    const reject = (reason) => {
      server.accept();
      server.send(JSON.stringify({ type: 'reject', reason }));
      server.close(4003, reason);
      return new Response(null, { status: 101, webSocket: client });
    };

    const meta = await this.getMeta();
    if (!meta) return reject('not_found');
    if (meta.state !== 'open') return reject('ended');

    const url = new URL(req.url);
    const admin = req.headers.get('x-rc-admin') === '1';
    const rt = url.searchParams.get('rt') || '';
    const tokens = (await this.ctx.storage.get('tokens')) || [];
    const returning = Boolean(rt) && tokens.includes(rt);

    if (meta.locked && !returning && !admin) return reject('locked');
    if (!returning && !admin && this.members().length >= this.c.maxMembers) return reject('full');

    const token = returning ? rt : crypto.randomUUID();
    if (!returning) {
      tokens.push(token);
      await this.ctx.storage.put('tokens', tokens);
    }

    this.ctx.acceptWebSocket(server, ['m']);
    server.serializeAttachment({
      cid: crypto.randomUUID(),
      uid: clip(url.searchParams.get('uid'), 32),
      name: clip(url.searchParams.get('name'), 24),
      ip: req.headers.get('x-rc-ip') || '',
      ua: clip(req.headers.get('user-agent'), 160),
      joinedAt: Date.now(),
      admin,
      topics: [],
    });

    meta.everJoined = true;
    meta.emptySince = null;
    await this.putMeta(meta);
    await this.schedule(meta);

    server.send(
      JSON.stringify({
        type: 'welcome',
        token,
        locked: meta.locked,
        idleMs: this.c.idleMs,
        lastActivity: meta.lastActivity,
      }),
    );
    this.broadcast({ type: 'presence', count: this.members().length });
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws, raw) {
    if (typeof raw !== 'string' || raw.length > 65536) return;
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    const att = ws.deserializeAttachment();
    if (!att) return;
    const topic = typeof msg.topic === 'string' ? msg.topic.slice(0, 128) : '';

    switch (msg.type) {
      // --- Trystero 信令：简单 pub/sub ---
      case 'subscribe':
        if (topic && !att.topics.includes(topic) && att.topics.length < 8) {
          att.topics.push(topic);
          ws.serializeAttachment(att);
        }
        return;
      case 'unsubscribe':
        att.topics = att.topics.filter((t) => t !== topic);
        ws.serializeAttachment(att);
        return;
      case 'publish': {
        if (!topic) return;
        const out = JSON.stringify({ topic, payload: msg.payload });
        for (const s of this.members()) {
          const a = s.deserializeAttachment();
          if (a && a.cid !== att.cid && a.topics.includes(topic)) {
            try {
              s.send(out);
            } catch { }
          }
        }
        return;
      }

      // --- 房间控制 ---
      case 'activity': {
        const meta = await this.getMeta();
        if (meta?.state !== 'open') return;
        meta.lastActivity = Date.now();
        await this.putMeta(meta);
        await this.schedule(meta);
        return;
      }
      case 'lock': {
        const meta = await this.getMeta();
        if (meta?.state !== 'open') return;
        meta.locked = Boolean(msg.value);
        await this.putMeta(meta);
        this.broadcast({ type: 'state', locked: meta.locked, by: att.name });
        return;
      }
      case 'end':
        await this.end('member', att.name);
        return;
    }
  }

  async webSocketClose(ws, code) {
    try {
      ws.close(code === 1005 ? 1000 : code, 'bye');
    } catch { }
    await this.onLeave(ws);
  }

  async webSocketError(ws) {
    await this.onLeave(ws);
  }

  async onLeave(ws) {
    const meta = await this.getMeta();
    if (!meta || meta.state !== 'open') return;
    const leaving = ws.deserializeAttachment()?.cid;
    const left = this.members().filter((s) => s.deserializeAttachment()?.cid !== leaving);
    const out = JSON.stringify({ type: 'presence', count: left.length });
    for (const s of left) {
      try {
        s.send(out);
      } catch { }
    }
    if (left.length === 0 && !meta.emptySince) {
      meta.emptySince = Date.now();
      await this.putMeta(meta);
      await this.schedule(meta);
    }
  }

  broadcast(obj) {
    const out = JSON.stringify(obj);
    for (const s of this.members()) {
      try {
        s.send(out);
      } catch { }
    }
  }

  // ----- 生命周期：一个 alarm 负责所有到期检查 -----
  async schedule(meta) {
    let at;
    if (meta.state === 'ended') at = meta.endedAt + this.c.tombstoneMs;
    else if (meta.emptySince) at = meta.emptySince + (meta.everJoined ? this.c.emptyGraceMs : this.c.unjoinedMs);
    else at = meta.lastActivity + this.c.idleMs;
    await this.ctx.storage.setAlarm(at);
  }

  async alarm() {
    const meta = await this.getMeta();
    if (!meta) return;
    const now = Date.now();

    if (meta.state === 'ended') {
      if (now >= meta.endedAt + this.c.tombstoneMs) await this.ctx.storage.deleteAll();
      else await this.schedule(meta);
      return;
    }

    const live = this.members().length;
    if (live === 0) {
      if (!meta.emptySince) meta.emptySince = now;
      const limit = meta.emptySince + (meta.everJoined ? this.c.emptyGraceMs : this.c.unjoinedMs);
      if (now >= limit) return this.end(meta.everJoined ? 'empty' : 'unused');
    } else {
      meta.emptySince = null;
      if (now >= meta.lastActivity + this.c.idleMs) return this.end('idle');
    }
    await this.putMeta(meta);
    await this.schedule(meta);
  }

  async end(reason, by = '') {
    const meta = await this.getMeta();
    if (!meta || meta.state === 'ended') return false;
    Object.assign(meta, { state: 'ended', endedAt: Date.now(), reason, by, locked: false });
    await this.putMeta(meta);
    await this.ctx.storage.delete('tokens');
    const out = JSON.stringify({ type: 'ended', reason, by });
    for (const s of this.ctx.getWebSockets()) {
      try {
        s.send(out);
        s.close(4001, 'ended');
      } catch { }
    }
    await registry(this.env).remove(meta.id);
    await this.schedule(meta);
    return true;
  }
}

// =====================================================================
// Registry：全局唯一实例 —— 站点开关、活跃房间列表、建房限流
// =====================================================================
export class Registry extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.c = conf(env);
    this.recent = new Map(); // ip -> [时间戳]，仅内存，重启清零
  }

  async getOpen() {
    return (await this.ctx.storage.get('open')) === true;
  }
  async setOpen(v) {
    await this.ctx.storage.put('open', Boolean(v));
    return Boolean(v);
  }

  reserve(ip, admin) {
    if (admin) return true;
    const now = Date.now();
    const list = (this.recent.get(ip) || []).filter((t) => now - t < 600e3);
    if (list.length >= this.c.createLimit) return false;
    list.push(now);
    this.recent.set(ip, list);
    return true;
  }

  async add(id) {
    await this.ctx.storage.put(`room:${id}`, Date.now());
  }
  async remove(id) {
    await this.ctx.storage.delete(`room:${id}`);
  }
  async list() {
    const map = await this.ctx.storage.list({ prefix: 'room:' });
    return [...map.keys()].map((k) => k.slice(5));
  }
}