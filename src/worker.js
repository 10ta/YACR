import { DurableObject } from 'cloudflare:workers';

// ---------- 房间 ID：6 位，Crockford 风格 32 字符表（去掉 i l o u），不区分大小写 ----------
const ALPHA = '0123456789abcdefghjkmnpqrstvwxyz';
const ID_LEN = 6;
const ID_RE = new RegExp(`^[${ALPHA}]{${ID_LEN}}$`);
const UID_RE = /^[a-z0-9]{10,32}$/;
const newId = () =>
  [...crypto.getRandomValues(new Uint8Array(ID_LEN))].map((b) => ALPHA[b & 31]).join('');
const normalizeId = (s) =>
  String(s || '').toLowerCase().replace(/[^0-9a-z]/g, '').replace(/o/g, '0').replace(/[il]/g, '1');

// ---------- 配置 ----------
// 部署默认值来自 wrangler.jsonc 的 vars；其中一部分可以在管理后台覆盖（存在 Registry 里）。
const num = (v, d) => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : d;
};
const baseConf = (env) => ({
  emptyGraceMs: num(env.EMPTY_GRACE_SECONDS, 60) * 1e3, // 所有人离开后的宽限期
  unjoinedMs: num(env.UNJOINED_MINUTES, 5) * 60e3, // 创建后无人加入的失效时间
  tombstoneMs: num(env.TOMBSTONE_HOURS, 24) * 3600e3, // 结束后保留墓碑多久
});
// 后台可调的参数：键名、默认值（来自 vars）、允许范围
const SETTINGS = {
  idleMinutes: { env: 'IDLE_MINUTES', def: 30, min: 1, max: 1440 },
  maxMembers: { env: 'MAX_MEMBERS', def: 10, min: 2, max: 30 },
  maxFileMB: { env: 'MAX_FILE_MB', def: 100, min: 1, max: 500 },
  createLimit: { env: 'CREATE_LIMIT_PER_10MIN', def: 10, min: 1, max: 1000 },
};
const effectiveSettings = (env, overrides = {}) => {
  const out = {};
  for (const [k, s] of Object.entries(SETTINGS)) out[k] = num(overrides[k], num(env[s.env], s.def));
  return out;
};

const ICE_LIMIT = 20; // 每个 IP 每 10 分钟最多申请几次 ICE 服务器
const LOGIN_MAX_FAILS = 5; // 每个 IP 在窗口期内最多失败次数
const LOGIN_WINDOW_MS = 15 * 60e3;

const json = (data, status = 200, headers = {}) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers },
  });

const clip = (s, n) => String(s ?? '').slice(0, n);

// ---------- 经 VPS 反向代理访问时 ----------
// ALLOWED_ORIGINS：额外允许的页面来源（反代域名），逗号分隔，如 https://chat.example.com
// PROXY_SECRET：反代在 X-Yacr-Proxy 头里带上它，才信任 X-Yacr-Client-IP 里的真实访客 IP；
// 否则所有经反代的访客都会被当成同一个 IP（VPS 的 IP），按 IP 的限流和封禁就全乱了。
const allowedOrigins = (env) =>
  String(env.ALLOWED_ORIGINS || '')
    .split(',')
    .map((s) => s.trim().replace(/\/+$/, ''))
    .filter(Boolean);
const IP_RE = /^[0-9a-f.:]{3,45}$/i;
const clientIp = (req, env) => {
  const edge = req.headers.get('cf-connecting-ip') || 'unknown';
  const secret = env.PROXY_SECRET;
  if (!secret || !safeEqual(req.headers.get('x-yacr-proxy') || '', secret)) return edge;
  const real = (req.headers.get('x-yacr-client-ip') || '').trim();
  if (IP_RE.test(real) && !/^(127\.|::1$|::ffff:127\.)/.test(real)) return real;
  return `proxy:${edge}`; // 反代没拿到真实 IP（例如前面还有一层本机转发）
};

// ---------- 管理员鉴权 ----------
// cookie 里不存令牌原文，只存"过期时间.签名"，签名 = HMAC-SHA256(ADMIN_TOKEN, 过期时间)。
// 服务端无需存储会话；更换 ADMIN_TOKEN 后所有旧会话立即失效。
const COOKIE = 'rc_admin_s';
const LEGACY_COOKIE = 'rc_admin'; // 旧版存令牌原文的 cookie，登录/退出时顺手清掉
const SESSION_DAYS = 30;
const enc = new TextEncoder();
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
let hmacKey = { secret: null, key: null }; // 每个隔离实例缓存导入好的密钥
const sign = async (secret, msg) => {
  if (hmacKey.secret !== secret) {
    const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    hmacKey = { secret, key };
  }
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', hmacKey.key, enc.encode(`yacr-admin:${msg}`)));
  return btoa(String.fromCharCode(...sig)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};
const makeSession = async (env) => {
  const exp = Date.now() + SESSION_DAYS * 86400e3;
  return `${exp}.${await sign(env.ADMIN_TOKEN, exp)}`;
};
const isAdmin = async (req, env) => {
  const value = readCookie(req, COOKIE);
  if (!value || !env.ADMIN_TOKEN) return false;
  const [exp, sig] = value.split('.');
  if (!/^\d{13}$/.test(exp || '') || Number(exp) <= Date.now() || !sig) return false;
  return safeEqual(sig, await sign(env.ADMIN_TOKEN, exp));
};
const cookieHeaders = (session) => {
  const h = new Headers();
  const attrs = 'Path=/; HttpOnly; Secure; SameSite=Strict';
  h.append('set-cookie', session ? `${COOKIE}=${session}; ${attrs}; Max-Age=${SESSION_DAYS * 86400}` : `${COOKIE}=; ${attrs}; Max-Age=0`);
  h.append('set-cookie', `${LEGACY_COOKIE}=; ${attrs}; Max-Age=0`);
  return h;
};
const jsonWith = (data, headers) => {
  const r = json(data);
  for (const [k, v] of headers) r.headers.append(k, v);
  return r;
};

const registry = (env) => env.REGISTRY.get(env.REGISTRY.idFromName('global'));
const roomStub = (env, id) => env.ROOM.get(env.ROOM.idFromName(id));

// 站点开关（open：站点是否开放；create：访客能否新建房间）缓存 10 秒，避免每个请求都访问 Registry
let siteCache = { v: { open: false, create: false }, t: 0 };
const siteState = async (env) => {
  if (Date.now() - siteCache.t < 10e3) return siteCache.v;
  siteCache = { v: await registry(env).getSite(), t: Date.now() };
  return siteCache.v;
};

// ---------- TURN：Cloudflare Realtime TURN 临时凭证 ----------
// 需要 Secret：TURN_KEY_ID、TURN_KEY_API_TOKEN。未配置时只返回 STUN。
const STUN = [{ urls: 'stun:stun.cloudflare.com:3478' }];
const TURN_TTL_S = 4 * 3600;
let turnCache = { servers: null, until: 0 };
async function iceServers(env) {
  if (!env.TURN_KEY_ID || !env.TURN_KEY_API_TOKEN) return STUN;
  if (turnCache.servers && Date.now() < turnCache.until) return turnCache.servers;
  const r = await fetch(
    `https://rtc.live.cloudflare.com/v1/turn/keys/${env.TURN_KEY_ID}/credentials/generate-ice-servers`,
    {
      method: 'POST',
      headers: { authorization: `Bearer ${env.TURN_KEY_API_TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify({ ttl: TURN_TTL_S }),
    },
  );
  if (!r.ok) {
    console.error('TURN credentials failed', r.status, await r.text().catch(() => ''));
    return STUN;
  }
  const data = await r.json();
  // 浏览器会拦截 53 端口，没有 trickle ICE 时它会拖到超时，去掉
  const servers = (data.iceServers || [])
    .map((s) => {
      const urls = (Array.isArray(s.urls) ? s.urls : [s.urls]).filter((u) => !/:53(\?|$)/.test(u));
      return urls.length ? { ...s, urls } : null;
    })
    .filter(Boolean);
  if (!servers.length) return STUN;
  turnCache = { servers, until: Date.now() + (TURN_TTL_S * 1000) / 2 };
  return servers;
}

// ---------- Worker 入口：只处理 /api/* 与 /ws/*，其余静态文件不经过这里 ----------
export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    const path = url.pathname;
    const origin = req.headers.get('origin');
    if (origin && origin !== url.origin && !allowedOrigins(env).includes(origin)) {
      return json({ error: 'forbidden_origin' }, 403);
    }

    const admin = await isAdmin(req, env);
    const ip = clientIp(req, env);

    try {
      if (path === '/api/status') return json({ ...(await siteState(env)), admin });

      // ----- 管理员 -----
      if (path === '/api/admin/login' && req.method === 'POST') {
        if (!env.ADMIN_TOKEN) return json({ error: 'no_admin_token_configured' }, 500);
        const reg = registry(env);
        if (!(await reg.loginAllowed(ip))) return json({ error: 'too_many_attempts' }, 429);
        const { token } = await req.json().catch(() => ({}));
        const ok = Boolean(token) && safeEqual(String(token), env.ADMIN_TOKEN);
        await reg.loginResult(ip, ok);
        if (!ok) return json({ error: 'bad_token' }, 401);
        return jsonWith({ ok: true }, cookieHeaders(await makeSession(env)));
      }
      if (path === '/api/admin/logout' && req.method === 'POST') {
        return jsonWith({ ok: true }, cookieHeaders(null));
      }
      if (path.startsWith('/api/admin/')) {
        if (!admin) return json({ error: 'unauthorized' }, 401);
        return await adminApi(req, env, path);
      }

      // ----- 访客：站点关闭时一律拒绝（管理员除外） -----
      const site = await siteState(env);
      if (!admin && !site.open) return json({ error: 'closed' }, 503);

      // 新建房间，或用首页填写的房间号进入
      if (path === '/api/rooms' && req.method === 'POST') {
        const body = await req.json().catch(() => ({}));
        const uid = UID_RE.test(body.uid || '') ? body.uid : '';
        const wanted = body.id ? normalizeId(body.id) : '';
        if (wanted && !ID_RE.test(wanted)) return json({ error: 'bad_id' }, 400);

        if (wanted) {
          const st = await roomStub(env, wanted).status();
          if (st.exists && st.state === 'open') return json({ id: wanted, existing: true });
          if (st.exists) return json({ error: 'ended' }, 410);
        }

        // 访客新建房间的开关（默认关闭）：关闭时访客只能加入已有房间，管理员不受影响
        if (!admin && !site.create) return json({ error: 'no_create' }, 403);

        const gate = await registry(env).createGate(ip, uid, admin);
        if (!gate.ok) return json({ error: gate.reason }, gate.reason === 'banned' ? 403 : 429);

        const candidates = wanted ? [wanted] : [newId(), newId(), newId(), newId(), newId()];
        for (const id of candidates) {
          if ((await roomStub(env, id).init(id, gate.settings)).ok) {
            await registry(env).add(id);
            return json({ id });
          }
        }
        return json({ error: wanted ? 'taken' : 'busy' }, wanted ? 409 : 503);
      }

      let m = path.match(/^\/api\/rooms\/([^/]+)$/);
      if (m && req.method === 'GET') {
        const id = normalizeId(m[1]);
        if (!ID_RE.test(id)) return json({ exists: false, id });
        return json({ id, ...(await roomStub(env, id).status()) });
      }

      // ICE 服务器（含 TURN 临时凭证）：只发给持有有效回房令牌的房间成员
      if (path === '/api/ice' && req.method === 'POST') {
        const { room, token, uid } = await req.json().catch(() => ({}));
        const id = normalizeId(room);
        if (!ID_RE.test(id) || typeof token !== 'string') return json({ error: 'bad_request' }, 400);
        if (!admin) {
          const gate = await registry(env).iceGate(ip, uid);
          if (!gate.ok) return json({ error: gate.reason }, gate.reason === 'banned' ? 403 : 429);
        }
        // 只发给持有有效令牌的房间成员
        if (!(await roomStub(env, id).hasToken(token))) return json({ error: 'not_member' }, 403);
        return json({ iceServers: await iceServers(env) });
      }

      m = path.match(/^\/ws\/([^/]+)$/);
      if (m) {
        if (req.headers.get('upgrade') !== 'websocket') return json({ error: 'expected_websocket' }, 426);
        const id = normalizeId(m[1]);
        if (!ID_RE.test(id)) return json({ error: 'not_found' }, 404);
        const h = new Headers(req.headers);
        h.set('x-rc-admin', admin ? '1' : '0');
        h.set('x-rc-ip', ip);
        if (!admin && (await registry(env).isBanned(url.searchParams.get('uid'), ip))) h.set('x-rc-banned', '1');
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
  const body = req.method === 'POST' ? await req.json().catch(() => ({})) : {};

  if (path === '/api/admin/state' && req.method === 'GET') {
    const ids = await reg.list();
    const rooms = (await Promise.all(ids.map((id) => roomStub(env, id).info()))).filter(Boolean);
    return json({
      ...(await reg.getSite()),
      rooms,
      bans: await reg.listBans(),
      settings: effectiveSettings(env, await reg.getSettings()),
      settingsSpec: SETTINGS,
      turn: Boolean(env.TURN_KEY_ID && env.TURN_KEY_API_TOKEN),
    });
  }

  if (path === '/api/admin/open' && req.method === 'POST') {
    const v = await reg.setOpen(Boolean(body.open));
    siteCache = { v: await reg.getSite(), t: Date.now() };
    // 关站时结束所有房间
    if (!v) await Promise.all((await reg.list()).map((id) => roomStub(env, id).end('closed')));
    return json({ open: v });
  }

  if (path === '/api/admin/create' && req.method === 'POST') {
    await reg.setCreate(Boolean(body.allow));
    siteCache = { v: await reg.getSite(), t: Date.now() };
    return json(siteCache.v);
  }

  if (path === '/api/admin/settings' && req.method === 'POST') {
    const clean = {};
    for (const [k, s] of Object.entries(SETTINGS)) {
      const n = Number(body[k]);
      if (Number.isFinite(n)) clean[k] = Math.min(s.max, Math.max(s.min, Math.round(n)));
    }
    await reg.setSettings(clean);
    return json({ settings: effectiveSettings(env, await reg.getSettings()) });
  }

  if (path === '/api/admin/ban' && req.method === 'POST') {
    const uid = UID_RE.test(body.uid || '') ? body.uid : '';
    const ip = clip(body.ip, 64);
    if (!uid && !ip) return json({ error: 'bad_request' }, 400);
    await reg.ban({ uid, ip, name: clip(body.name, 24) });
    const ids = await reg.list();
    await Promise.all(ids.map((id) => roomStub(env, id).kick({ uid, ip })));
    return json({ ok: true });
  }

  if (path === '/api/admin/unban' && req.method === 'POST') {
    await reg.unban(clip(body.key, 120));
    return json({ ok: true });
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
    this.c = baseConf(env);
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
  // 房间创建时把当时的后台设置固定下来，之后改设置只影响新房间
  cfg(meta) {
    const s = meta?.settings || {};
    return { idleMs: num(s.idleMinutes, 30) * 60e3, maxMembers: num(s.maxMembers, 10), maxFileMB: num(s.maxFileMB, 100) };
  }

  async init(id, settings) {
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
      settings,
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
      full: count >= this.cfg(meta).maxMembers,
    };
  }

  async hasToken(token) {
    const meta = await this.getMeta();
    if (!meta || meta.state !== 'open') return false;
    return ((await this.ctx.storage.get('tokens')) || []).includes(token);
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

  presence(except) {
    const list = this.members().filter((s) => s.deserializeAttachment()?.cid !== except);
    const uids = list.map((s) => s.deserializeAttachment()?.uid).filter(Boolean);
    const out = JSON.stringify({ type: 'presence', count: list.length, uids });
    for (const s of list) {
      try {
        s.send(out);
      } catch { }
    }
    return list.length;
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

    if (req.headers.get('x-rc-banned') === '1') return reject('banned');
    const meta = await this.getMeta();
    if (!meta) return reject('not_found');
    if (meta.state !== 'open') return reject('ended');

    const url = new URL(req.url);
    const admin = req.headers.get('x-rc-admin') === '1';
    const rt = url.searchParams.get('rt') || '';
    const tokens = (await this.ctx.storage.get('tokens')) || [];
    const returning = Boolean(rt) && tokens.includes(rt);
    const cfg = this.cfg(meta);

    if (meta.locked && !returning && !admin) return reject('locked');
    if (!returning && !admin && this.members().length >= cfg.maxMembers) return reject('full');

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
        idleMs: cfg.idleMs,
        maxFileMB: cfg.maxFileMB,
        lastActivity: meta.lastActivity,
      }),
    );
    this.presence();
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
    const left = this.presence(ws.deserializeAttachment()?.cid);
    if (left === 0 && !meta.emptySince) {
      meta.emptySince = Date.now();
      await this.putMeta(meta);
      await this.schedule(meta);
    }
  }

  // 管理员封禁：断开匹配的连接，并通知其他人断开与他们的直连
  async kick({ uid, ip }) {
    const hit = [];
    for (const s of this.members()) {
      const a = s.deserializeAttachment();
      if (!a || a.admin) continue;
      if ((uid && a.uid === uid) || (ip && a.ip === ip)) {
        hit.push(a);
        try {
          s.send(JSON.stringify({ type: 'reject', reason: 'banned' }));
          s.close(4003, 'banned');
        } catch { }
      }
    }
    if (!hit.length) return 0;
    const out = JSON.stringify({ type: 'kicked', uids: hit.map((a) => a.uid) });
    for (const s of this.members()) {
      const a = s.deserializeAttachment();
      if (a && !hit.some((h) => h.cid === a.cid)) {
        try {
          s.send(out);
        } catch { }
      }
    }
    this.presence(hit.length === 1 ? hit[0].cid : undefined);
    return hit.length;
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
    else at = meta.lastActivity + this.cfg(meta).idleMs;
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
      if (now >= meta.lastActivity + this.cfg(meta).idleMs) return this.end('idle');
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
// Registry：全局唯一实例 —— 站点开关、房间列表、设置、封禁、限流
// =====================================================================
export class Registry extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.recent = new Map(); // 建房限流：ip -> [时间戳]，仅内存
  }

  async getOpen() {
    return (await this.ctx.storage.get('open')) === true;
  }
  async getSite() {
    const m = await this.ctx.storage.get(['open', 'create']);
    return { open: m.get('open') === true, create: m.get('create') === true };
  }
  async setCreate(v) {
    await this.ctx.storage.put('create', Boolean(v));
  }
  async setOpen(v) {
    await this.ctx.storage.put('open', Boolean(v));
    return Boolean(v);
  }

  async getSettings() {
    return (await this.ctx.storage.get('settings')) || {};
  }
  async setSettings(s) {
    await this.ctx.storage.put('settings', { ...(await this.getSettings()), ...s });
  }

  // 建房前的检查：封禁 + 限流，并返回当前生效的设置
  async createGate(ip, uid, admin) {
    const settings = effectiveSettings(this.env, await this.getSettings());
    if (admin) return { ok: true, settings };
    if (await this.isBanned(uid, ip)) return { ok: false, reason: 'banned' };
    const now = Date.now();
    const list = (this.recent.get(ip) || []).filter((t) => now - t < 600e3);
    if (list.length >= settings.createLimit) return { ok: false, reason: 'rate_limited' };
    list.push(now);
    this.recent.set(ip, list);
    return { ok: true, settings };
  }

  // TURN 凭证签发限流：每个 IP 每 10 分钟最多 ICE_LIMIT 次
  async iceGate(ip, uid) {
    if (await this.isBanned(uid, ip)) return { ok: false, reason: 'banned' };
    const now = Date.now();
    const key = `ice:${ip}`;
    const list = (this.recent.get(key) || []).filter((t) => now - t < 600e3);
    if (list.length >= ICE_LIMIT) return { ok: false, reason: 'rate_limited' };
    list.push(now);
    this.recent.set(key, list);
    return { ok: true };
  }

  // ----- 房间列表 -----
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

  // ----- 封禁 -----
  async ban({ uid, ip, name }) {
    const at = Date.now();
    if (uid) await this.ctx.storage.put(`ban:uid:${uid}`, { at, name, ip });
    if (ip) await this.ctx.storage.put(`ban:ip:${ip}`, { at, name, uid });
  }
  async unban(key) {
    if (key.startsWith('ban:')) await this.ctx.storage.delete(key);
  }
  async isBanned(uid, ip) {
    const keys = [];
    if (uid && UID_RE.test(uid)) keys.push(`ban:uid:${uid}`);
    if (ip) keys.push(`ban:ip:${ip}`);
    if (!keys.length) return false;
    return (await this.ctx.storage.get(keys)).size > 0;
  }
  async listBans() {
    const map = await this.ctx.storage.list({ prefix: 'ban:' });
    return [...map.entries()].map(([key, v]) => ({ key, ...v }));
  }

  // ----- 管理员登录限流（持久化，重启不清零） -----
  async loginAllowed(ip) {
    const rec = await this.ctx.storage.get(`login:${ip}`);
    if (!rec) return true;
    if (Date.now() - rec.first > LOGIN_WINDOW_MS) return true;
    return rec.fails < LOGIN_MAX_FAILS;
  }
  async loginResult(ip, ok) {
    const key = `login:${ip}`;
    if (ok) return this.ctx.storage.delete(key);
    const now = Date.now();
    let rec = await this.ctx.storage.get(key);
    if (!rec || now - rec.first > LOGIN_WINDOW_MS) rec = { first: now, fails: 0 };
    rec.fails += 1;
    await this.ctx.storage.put(key, rec);
  }
}
