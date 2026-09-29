import { Conn, joinRoom } from './relay.js';
import { identityFor, loadSelf } from './identity.js';

const APP_ID = 'roomchat';
const ALPHA = '0123456789abcdefghjkmnpqrstvwxyz';
const ID_RE = /^[0-9a-hjkmnp-tv-z]{6}$/;
const MAX_LEN = 4000;
const AUTO_FETCH_BYTES = 5 * 1024 * 1024; // 5 MB 以下的图片自动下载
const SYNC_LIMIT = 200;
const normalizeId = (s) =>
  String(s || '').toLowerCase().replace(/[^0-9a-z]/g, '').replace(/o/g, '0').replace(/[il]/g, '1');
const randomId = () => [...crypto.getRandomValues(new Uint8Array(6))].map((b) => ALPHA[b & 31]).join('');

// 调试：localStorage.rc_ice 写入 JSON 数组可覆盖 ICE 服务器（本地测试用 '[]'）
const ICE_OVERRIDE = (() => {
  try {
    const o = JSON.parse(localStorage.getItem('rc_ice'));
    return Array.isArray(o) ? o : null;
  } catch {
    return null;
  }
})();
const DEFAULT_ICE = [{ urls: 'stun:stun.cloudflare.com:3478' }];

const $ = (sel) => document.querySelector(sel);
const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
};

const me = loadSelf();

// ---------- 房间内状态（全部只在内存里） ----------
let roomId = '';
let conn = null;
let room = null;
let act = null;
let locked = false;
let ended = false;
let synced = false;
let lastActivitySent = 0;
let maxFileBytes = 100 * 1024 * 1024;
let presentUids = []; // 信令服务器上的在线成员（含自己），用来发现"有人在但连不上"
let stuckTimer = 0;
let unread = 0;
const peers = new Map(); // Trystero peerId -> 身份
const messages = []; // 按时间排序的消息（文字和媒体）
const nodes = new Map(); // 消息 id -> DOM 节点
const files = new Map(); // 媒体 id -> { blob, url }
const loading = new Map(); // 媒体 id -> { peerId, timer }

// 回房令牌：锁定的房间里刷新页面还能回来
const tokenKey = (id) => `rc_rt_${id}`;
const store = (fn) => {
  try {
    return fn();
  } catch {
    return null;
  }
};
const getToken = (id) => store(() => sessionStorage.getItem(tokenKey(id)));
const setToken = (id, t) => store(() => sessionStorage.setItem(tokenKey(id), t));
const clearToken = (id) => store(() => sessionStorage.removeItem(tokenKey(id)));

const endedText = (reason, by) =>
  ({
    member: `${by || '有人'}结束了房间，聊天记录已全部清除。`,
    empty: '所有人都离开了，房间已结束。',
    idle: '长时间没有新消息，房间已自动结束。',
    unused: '房间创建后一直没人加入，已经失效。',
    admin: '房间已被管理员结束。',
    closed: '站点已关闭，所有房间都已结束。',
  })[reason] || '房间已结束。';

// ---------- 状态页 ----------
function showScreen(title, text, { home = false, rejoin = false } = {}) {
  document.body.dataset.view = 'screen';
  $('#screen-title').textContent = title;
  $('#screen-text').textContent = text;
  $('#screen-home').hidden = !home;
  $('#screen-rejoin').hidden = !rejoin;
  document.title = title;
}

const showClosed = () => showScreen('网站维护中', '暂时无法创建或加入房间，请稍后再来。');
const showBanned = () => showScreen('无法进入', '你已被管理员禁止创建或加入房间。');
const showNoWebRTC = () =>
  showScreen(
    '浏览器禁用了直连',
    '聊天需要浏览器的 WebRTC 功能，但它当前不可用。请检查是否装了禁用 WebRTC 的扩展，或在隐私设置里关闭了它，改完后刷新页面。',
  );

async function api(path, opts) {
  try {
    const r = await fetch(path, opts);
    let body = {};
    try {
      body = await r.json();
    } catch { }
    return { status: r.status, ok: r.ok, body };
  } catch {
    return { status: 0, ok: false, body: {} };
  }
}
const post = (path, data) =>
  api(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(data || {}) });

// ---------- 启动 ----------
let isAdmin = false;
let canCreate = false; // 访客能否新建房间（管理员总是可以）

async function boot() {
  const st = await api('/api/status');
  if (!st.ok) return showScreen('无法连接', '服务器暂时连不上，请稍后刷新重试。');
  isAdmin = Boolean(st.body.admin);
  canCreate = isAdmin || Boolean(st.body.create);
  if (!st.body.open && !isAdmin) return showClosed();
  if (typeof RTCPeerConnection === 'undefined') return showNoWebRTC();

  const raw = decodeURIComponent(location.pathname.slice(1));
  if (!raw) return showHome();

  const id = normalizeId(raw);
  if (!ID_RE.test(id)) return showScreen('房间不存在', '检查一下链接是否完整，或者回到首页新建一个房间。', { home: true });
  if (id !== raw) history.replaceState(null, '', `/${id}`);

  const r = await api(`/api/rooms/${id}`);
  if (r.body.error === 'closed') return showClosed();
  if (!r.ok) return showScreen('无法连接', '服务器暂时连不上，请稍后刷新重试。');
  const s = r.body;
  if (!s.exists) return showScreen('房间不存在', '检查一下链接是否完整，或者回到首页新建一个房间。', { home: true });
  if (s.state === 'ended') return showScreen('房间已结束', endedText(s.reason, ''), { home: true });
  // 管理员可以进入锁定或已满的房间（服务端同样放行）
  const returning = Boolean(getToken(id)) || isAdmin;
  if (s.locked && !returning) return showScreen('房间已锁定', '房间里的人暂时不允许新成员加入。', { home: true });
  if (s.full && !returning) return showScreen('房间已满', '这个房间的人数已达上限。', { home: true });
  enter(id);
}

// ---------- 首页：预先生成一个房间号 ----------
function showHome() {
  document.body.dataset.view = 'home';
  const input = $('#home-id');
  // 不允许新建时：只能填朋友给的房间号加入
  document.body.classList.toggle('join-only', !canCreate);
  document.title = canCreate ? '开一个临时聊天室' : '加入聊天室';
  $('#home-title').textContent = canCreate ? '开一个临时聊天室' : '加入聊天室';
  $('#home-lead').textContent = canCreate
    ? '房间号已经生成好了，进去后把链接发给朋友。也可以换一个，或者填上朋友给你的房间号。'
    : '现在暂不开放新建房间。填上朋友给你的 6 位房间号，就能加入。';
  $('#home-go').textContent = canCreate ? '进入房间' : '加入房间';
  input.value = canCreate ? randomId() : '';
  input.placeholder = canCreate ? '' : '房间号';
  $('#home-me').replaceChildren(avatar(me, 'lg'), el('span', '', `你会以「${me.name}」的身份进入`));
  input.focus();
  input.select();
}

async function homeGo() {
  const err = $('#home-err');
  err.textContent = '';
  const id = normalizeId($('#home-id').value);
  if (!ID_RE.test(id)) return (err.textContent = '房间号是 6 位字母或数字。');
  const btn = $('#home-go');
  btn.disabled = true;
  const r = await post('/api/rooms', { id, uid: me.uid });
  btn.disabled = false;
  if (r.ok) return location.assign(`/${r.body.id}`);
  const e = r.body.error;
  if (e === 'closed') return showClosed();
  if (e === 'banned') return showBanned();
  err.textContent =
    {
      ended: canCreate ? '这个房间号刚用过，房间已经结束了，换一个吧。' : '这个房间已经结束了。',
      no_create: '没有找到这个房间。现在只能加入已有的房间，检查一下房间号是否正确。',
      taken: '这个房间号刚被人占用了，换一个吧。',
      rate_limited: '新建房间太频繁了，请过几分钟再试。',
      bad_id: '房间号是 6 位字母或数字。',
    }[e] || '没能进入房间，请稍后再试。';
}

// ---------- 进入房间 ----------
function enter(id) {
  roomId = id;
  document.body.dataset.view = 'chat';
  updateTitle();
  $('#room-code').textContent = id;
  renderMembers();
  system(`你是「${me.name}」。把链接发给朋友，他们打开就能加入。`);

  conn = new Conn(() => {
    const q = new URLSearchParams({ uid: me.uid, name: me.name });
    const rt = getToken(id);
    if (rt) q.set('rt', rt);
    return `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws/${id}?${q}`;
  });
  conn.addEventListener('data', (e) => onControl(e.detail));
  conn.addEventListener('down', () => {
    if (!ended && !conn.final) banner('与服务器的连接断了，正在重连。已经连上的人仍可以继续聊天。', 'down');
  });
  conn.addEventListener('up', () => $('#banner').dataset.kind === 'down' && banner(''));
  $('#input').focus();
}

async function onControl(m) {
  switch (m.type) {
    case 'welcome':
      setToken(roomId, m.token);
      setLocked(m.locked);
      if (m.maxFileMB) maxFileBytes = m.maxFileMB * 1024 * 1024;
      if (m.idleMs) $('#hint').textContent = `${Math.round(m.idleMs / 60000)} 分钟没有新消息，房间会自动结束。`;
      if (!room) {
        const ice = await loadIce(m.token);
        if (ended || room) return;
        try {
          startP2P(ice);
        } catch (err) {
          console.error('[p2p] init failed', err);
          teardown();
          showNoWebRTC();
        }
      }
      return;
    case 'presence':
      presentUids = Array.isArray(m.uids) ? m.uids.filter((u) => typeof u === 'string') : [];
      renderMembers();
      return;
    case 'state':
      setLocked(m.locked);
      system(m.locked ? `${m.by || '有人'}禁止了新人加入。` : `${m.by || '有人'}重新允许新人加入。`);
      return;
    case 'kicked':
      dropUids(m.uids || []);
      return;
    case 'ended':
      teardown();
      showScreen('房间已结束', endedText(m.reason, m.by), { home: true });
      return;
    case 'reject': {
      teardown();
      if (m.reason === 'banned') return showBanned();
      const t = {
        locked: ['房间已锁定', '房间里的人暂时不允许新成员加入。'],
        full: ['房间已满', '这个房间的人数已达上限。'],
        ended: ['房间已结束', '这个房间已经结束了。'],
        not_found: ['房间不存在', '检查一下链接是否完整，或者回到首页新建一个房间。'],
      }[m.reason] || ['无法加入', '请稍后再试。'];
      showScreen(t[0], t[1], { home: true });
    }
  }
}

// TURN 凭证由服务端签发，只给房间成员；失败时退回只用 STUN
async function loadIce(token) {
  if (ICE_OVERRIDE) return ICE_OVERRIDE;
  const r = await post('/api/ice', { room: roomId, token, uid: me.uid });
  if (r.ok && Array.isArray(r.body.iceServers) && r.body.iceServers.length) return r.body.iceServers;
  return DEFAULT_ICE;
}

// ---------- P2P ----------
function startP2P(iceServers) {
  // trickleIce: false —— 绕过 Trystero 0.25.x 的 offer 过期问题（约 57 秒后新人连不上）
  room = joinRoom(
    { appId: APP_ID, relayConfig: { conn }, trickleIce: false, rtcConfig: { iceServers } },
    roomId,
    { onJoinError: (e) => console.warn('[p2p]', e.error) },
  );
  const hello = room.makeAction('hello');
  const chat = room.makeAction('chat');
  const sync = room.makeAction('sync', { kind: 'request', onRequest: () => messages.slice(-SYNC_LIMIT) });
  const has = room.makeAction('has', { kind: 'request', onRequest: (d) => Boolean(d && files.has(d.id)) });
  const want = room.makeAction('want');
  const blob = room.makeAction('blob');
  act = { hello, chat, sync, has, want, blob };

  hello.onMessage = (d, { peerId }) => {
    if (!d || typeof d.uid !== 'string' || !/^[a-z0-9]{10,32}$/.test(d.uid)) return;
    const known = peers.has(peerId);
    const who = identityFor(d.uid);
    peers.set(peerId, who);
    renderMembers();
    if (!known && who.uid !== me.uid) system(`${who.name}加入了`);
  };
  chat.onMessage = (d) => receive(d, true);

  // 有人要某个文件：有就发给他
  want.onMessage = (d, { peerId }) => {
    const f = d && files.get(d.id);
    if (f) blob.send(f.blob, { target: peerId, metadata: { id: d.id } }).catch(() => { });
  };
  blob.onReceiveProgress = (p, { metadata }) => metadata && progress(metadata.id, p);
  blob.onMessage = (data, { metadata }) => {
    const id = metadata && metadata.id;
    const msg = id && messages.find((x) => x.id === id && x.type === 'media');
    if (!msg || files.has(id)) return;
    const b = data instanceof Blob ? data : new Blob([data], { type: msg.mime });
    if (b.size > maxFileBytes * 1.05) return;
    const typed = b.type === msg.mime ? b : new Blob([b], { type: msg.mime });
    clearTimeout(loading.get(id)?.timer);
    loading.delete(id);
    files.set(id, { blob: typed, url: URL.createObjectURL(typed) });
    renderMediaState(id);
  };

  room.onPeerJoin = (peerId) => {
    hello.send({ uid: me.uid }, { target: peerId });
    if (!synced) {
      synced = true;
      sync
        .request({}, { target: peerId, timeoutMs: 15000 })
        .then((list) => Array.isArray(list) && list.forEach((m) => receive(m, false)))
        .catch(() => (synced = false));
    }
  };
  room.onPeerLeave = (peerId) => {
    const who = peers.get(peerId);
    peers.delete(peerId);
    if (peers.size === 0) synced = false;
    renderMembers();
    if (who && ![...peers.values()].some((p) => p.uid === who.uid)) system(`${who.name}离开了`);
    // 正在从这个人那里下载的文件：换一个来源
    for (const [id, l] of loading) if (l.peerId === peerId) retryFetch(id);
  };
}

function dropUids(uids) {
  const all = room?.getPeers() || {};
  for (const [pid, who] of [...peers]) {
    if (!uids.includes(who.uid)) continue;
    try {
      all[pid]?.close();
    } catch { }
    peers.delete(pid);
    system(`${who.name}已被管理员移出房间`);
  }
  renderMembers();
}

function teardown() {
  if (ended) return;
  ended = true;
  clearTimeout(stuckTimer);
  try {
    room?.leave();
  } catch { }
  conn?.close();
  for (const f of files.values()) URL.revokeObjectURL(f.url);
  for (const l of loading.values()) clearTimeout(l.timer);
  files.clear();
  loading.clear();
  messages.length = 0;
  nodes.clear();
  peers.clear();
  $('#log').replaceChildren();
  closeViewer();
  clearToken(roomId);
}

// ---------- 消息 ----------
const MEDIA_RE = /^(image|audio|video)\/[\w.+-]{1,80}$/;
const kindOf = (mime) => (mime.startsWith('image/') ? 'image' : mime.startsWith('video/') ? 'video' : 'audio');

function clean(m) {
  if (!m || typeof m.id !== 'string' || typeof m.uid !== 'string' || !Number.isFinite(m.ts)) return null;
  const base = { id: m.id.slice(0, 40), uid: m.uid.slice(0, 32), ts: m.ts };
  if (m.type === 'media') {
    if (typeof m.mime !== 'string' || !MEDIA_RE.test(m.mime) || m.mime === 'image/svg+xml') return null;
    if (!Number.isFinite(m.size) || m.size <= 0 || m.size > maxFileBytes * 1.05) return null;
    const thumb =
      typeof m.thumb === 'string' && m.thumb.startsWith('data:image/jpeg;base64,') && m.thumb.length < 200000
        ? m.thumb
        : '';
    return {
      ...base,
      type: 'media',
      mime: m.mime,
      kind: kindOf(m.mime),
      name: String(m.name || '').slice(0, 120) || '未命名',
      size: m.size,
      thumb,
      w: Number(m.w) || 0,
      h: Number(m.h) || 0,
    };
  }
  if (typeof m.text !== 'string') return null;
  return { ...base, type: 'text', text: m.text.slice(0, MAX_LEN) };
}

function receive(raw, live) {
  const msg = clean(raw);
  if (!msg || nodes.has(msg.id)) return;
  let i = messages.length;
  while (i > 0 && messages[i - 1].ts > msg.ts) i--;
  messages.splice(i, 0, msg);
  renderMessage(msg, messages[i - 1], messages[i + 1]);
  if (live && msg.uid !== me.uid) notify(msg);
  if (msg.type === 'media' && msg.kind === 'image' && msg.size <= AUTO_FETCH_BYTES) fetchMedia(msg.id);
}

function send() {
  const input = $('#input');
  const text = input.value.replace(/\s+$/, '');
  if (!text.trim() || ended) return;
  if (!act) return banner('直连功能还没准备好，请稍等片刻再发。', 'notready');
  const m = { type: 'text', id: crypto.randomUUID(), uid: me.uid, ts: Date.now(), text: text.slice(0, MAX_LEN) };
  receive(m, false);
  act.chat.send(m);
  input.value = '';
  autosize();
  pingActivity();
}

function pingActivity() {
  const now = Date.now();
  if (now - lastActivitySent > 20000 && conn.send({ type: 'activity' })) lastActivitySent = now;
}

// ---------- 媒体：先广播"公告"，别人需要时再按需拉取 ----------
async function sendFiles(list) {
  for (const file of list) {
    if (ended) return;
    if (!act) return banner('直连功能还没准备好，请稍等片刻再发。', 'notready');
    if (!MEDIA_RE.test(file.type) || file.type === 'image/svg+xml') {
      banner(`「${file.name}」不是图片、音频或视频，没有发送。`, 'file');
      continue;
    }
    if (file.size > maxFileBytes) {
      banner(`「${file.name}」超过 ${fmtSize(maxFileBytes)} 的上限，没有发送。`, 'file');
      continue;
    }
    const kind = kindOf(file.type);
    const t = await makeThumb(file, kind).catch(() => null);
    const m = {
      type: 'media',
      id: crypto.randomUUID(),
      uid: me.uid,
      ts: Date.now(),
      mime: file.type,
      name: file.name,
      size: file.size,
      thumb: t?.data || '',
      w: t?.w || 0,
      h: t?.h || 0,
    };
    files.set(m.id, { blob: file, url: URL.createObjectURL(file) });
    receive(m, false);
    act.chat.send(m);
    pingActivity();
  }
}

// 缩略图：最长边 320 像素的 JPEG
async function makeThumb(file, kind) {
  let source;
  let w;
  let h;
  if (kind === 'image') {
    source = await createImageBitmap(file);
    w = source.width;
    h = source.height;
  } else if (kind === 'video') {
    source = await videoFrame(file);
    w = source.videoWidth;
    h = source.videoHeight;
  } else return null;
  const scale = Math.min(1, 320 / Math.max(w, h));
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(w * scale));
  c.height = Math.max(1, Math.round(h * scale));
  c.getContext('2d').drawImage(source, 0, 0, c.width, c.height);
  if (source.close) source.close();
  if (source.src) URL.revokeObjectURL(source.src);
  return { data: c.toDataURL('image/jpeg', 0.72), w, h };
}

function videoFrame(file) {
  return new Promise((resolve, reject) => {
    const v = document.createElement('video');
    v.muted = true;
    v.playsInline = true;
    v.preload = 'auto';
    const timer = setTimeout(() => reject(new Error('timeout')), 5000);
    v.onloadeddata = () => {
      v.currentTime = Math.min(0.5, (v.duration || 1) / 2);
    };
    v.onseeked = () => {
      clearTimeout(timer);
      resolve(v);
    };
    v.onerror = () => {
      clearTimeout(timer);
      reject(new Error('video'));
    };
    v.src = URL.createObjectURL(file);
  });
}

async function fetchMedia(id, exclude = []) {
  if (files.has(id) || (loading.has(id) && !exclude.length) || !act) return;
  const msg = messages.find((x) => x.id === id);
  if (!msg) return;
  // 优先找原发送者，其次问房间里谁有这个文件
  const ids = Object.keys(room.getPeers()).filter((p) => !exclude.includes(p));
  let source = ids.find((p) => peers.get(p)?.uid === msg.uid);
  if (!source && ids.length) {
    const res = await act.has.requestMany({ id }, { targets: ids, timeoutMs: 5000 }).catch(() => []);
    const ok = res.filter((r) => r.status === 'fulfilled' && r.value === true).map((r) => r.peerId);
    source = ok[Math.floor(Math.random() * ok.length)];
  }
  if (!source) {
    loading.delete(id);
    return renderMediaState(id, '发送者已离开，房间里也没有其他人有这个文件。');
  }
  const timer = setTimeout(() => retryFetch(id), 30000);
  loading.set(id, { peerId: source, timer, tried: [...exclude, source], p: 0 });
  renderMediaState(id);
  act.want.send({ id }, { target: source });
}

function retryFetch(id) {
  const l = loading.get(id);
  if (!l || files.has(id)) return;
  clearTimeout(l.timer);
  fetchMedia(id, l.tried);
}

function progress(id, p) {
  const l = loading.get(id);
  if (!l) return;
  l.p = p;
  clearTimeout(l.timer);
  l.timer = setTimeout(() => retryFetch(id), 30000);
  renderMediaState(id);
}

// ---------- 渲染 ----------
const timeFmt = new Intl.DateTimeFormat('zh-CN', { hour: '2-digit', minute: '2-digit' });
const fmtSize = (n) =>
  n < 1024 * 1024 ? `${Math.max(1, Math.round(n / 1024))} KB` : `${(n / 1024 / 1024).toFixed(n < 10 * 1024 * 1024 ? 1 : 0)} MB`;

function avatar(who, size = '') {
  const d = el('span', `dot ${size}`, who.emoji);
  d.style.background = who.color;
  d.title = who.name;
  return d;
}

const URL_RE = /https?:\/\/[^\s<>"'，。！？、）)\]]+/g;
function linkify(text) {
  const p = el('p', 'text');
  let last = 0;
  for (const m of text.matchAll(URL_RE)) {
    if (m.index > last) p.append(text.slice(last, m.index));
    const a = el('a', '', m[0]);
    a.href = m[0];
    a.target = '_blank';
    a.rel = 'noopener noreferrer nofollow';
    p.append(a);
    last = m.index + m[0].length;
  }
  if (last < text.length) p.append(text.slice(last));
  return p;
}

function renderMessage(msg, prev, next) {
  const who = identityFor(msg.uid);
  const mine = msg.uid === me.uid;
  const row = el('article', `msg${mine ? ' mine' : ''}`);
  if (prev && prev.uid === msg.uid && msg.ts - prev.ts < 120000) row.classList.add('cont');
  row.style.setProperty('--who', who.color);
  row.style.setProperty('--who-ink', who.ink);
  row.append(avatar(who));
  const body = el('div', 'body');
  // 别人的消息：一组消息的第一条上方显示名字；时间放在气泡内右下角（类似 Telegram）
  if (!mine) body.append(el('div', 'name', who.name));
  const stamp = el('time', 'stamp', timeFmt.format(msg.ts));
  stamp.dateTime = new Date(msg.ts).toISOString();
  if (msg.type === 'text') {
    const text = linkify(msg.text);
    text.append(stamp);
    body.append(text);
  } else {
    const card = mediaCard(msg);
    card.dataset.stamp = stamp.textContent;
    body.append(card);
  }
  row.append(body);
  nodes.set(msg.id, row);

  const log = $('#log');
  const stick = log.scrollHeight - log.scrollTop - log.clientHeight < 80;
  const before = next && nodes.get(next.id);
  if (before) log.insertBefore(row, before);
  else log.append(row);
  if (stick || mine) log.scrollTop = log.scrollHeight;
}

function mediaCard(msg) {
  const card = el('div', `media ${msg.kind}`);
  card.dataset.id = msg.id;
  card.dataset.stamp = timeFmt.format(msg.ts);
  if (msg.kind !== 'audio' && msg.w && msg.h) card.style.aspectRatio = `${msg.w} / ${msg.h}`;
  fillMedia(card, msg);
  return card;
}

function renderMediaState(id, error = '') {
  const card = nodes.get(id)?.querySelector('.media');
  const msg = messages.find((x) => x.id === id);
  if (card && msg) fillMedia(card, msg, error);
}

function fillMedia(card, msg, error = '') {
  const f = files.get(msg.id);
  const l = loading.get(msg.id);
  const parts = [];
  const info = el('div', 'media-info');
  info.append(el('span', 'media-name', msg.name), el('span', 'media-size', fmtSize(msg.size)));

  if (f) {
    const playable = msg.kind === 'image' || document.createElement(msg.kind).canPlayType(msg.mime) !== '';
    if (msg.kind === 'image') {
      const img = el('img');
      img.src = f.url;
      img.alt = msg.name;
      img.onclick = () => openViewer(f.url, msg.name);
      parts.push(img);
    } else if (playable) {
      const media = el(msg.kind);
      media.src = f.url;
      media.controls = true;
      media.preload = 'metadata';
      if (msg.kind === 'video') media.playsInline = true;
      if (card.dataset.autoplay) media.autoplay = true;
      parts.push(media);
    } else {
      parts.push(el('p', 'media-note', '这个格式浏览器放不了，可以保存到本地用其他软件打开。'));
    }
    const save = el('a', 'media-save', '保存');
    save.href = f.url;
    save.download = msg.name;
    info.append(save);
  } else {
    if (msg.thumb) {
      const img = el('img', 'thumb');
      img.src = msg.thumb;
      img.alt = '';
      parts.push(img);
    } else if (msg.kind === 'audio') {
      parts.push(el('div', 'media-icon', '♪'));
    }
    if (l) {
      const bar = el('div', 'bar');
      const fill = el('i');
      fill.style.width = `${Math.round((l.p || 0) * 100)}%`;
      bar.append(fill);
      parts.push(bar);
      info.append(el('span', 'media-state', l.p ? `${Math.round(l.p * 100)}%` : '请求中'));
    } else {
      const btn = el('button', 'media-load', msg.kind === 'image' ? '加载图片' : '播放');
      btn.type = 'button';
      btn.onclick = () => {
        card.dataset.autoplay = '1';
        fetchMedia(msg.id);
      };
      parts.push(btn);
      if (error) info.append(el('span', 'media-state err', error));
    }
  }
  if (card.dataset.stamp) info.append(el('time', 'stamp', card.dataset.stamp));
  card.replaceChildren(...parts, info);
}

// 图片查看：在页面内放大（不在新标签打开 blob，避免同源执行风险）
function openViewer(url, alt) {
  const v = $('#viewer');
  const img = v.querySelector('img');
  img.src = url;
  img.alt = alt;
  v.hidden = false;
}
function closeViewer() {
  const v = $('#viewer');
  v.hidden = true;
  v.querySelector('img').removeAttribute('src');
}

function system(text) {
  const log = $('#log');
  log.append(el('p', 'sys', text));
  log.scrollTop = log.scrollHeight;
}

function renderMembers() {
  const connected = new Map([[me.uid, me]]);
  for (const p of peers.values()) connected.set(p.uid, p);
  const pending = [...new Set(presentUids)].filter((u) => !connected.has(u)).map(identityFor);

  const dots = [...connected.values()].map((w, i) => {
    const d = avatar(w, 'lg');
    if (i === 0) d.classList.add('self');
    return d;
  });
  for (const w of pending) {
    const d = avatar(w, 'lg');
    d.classList.add('pending');
    d.title = `${w.name}（正在连接）`;
    dots.push(d);
  }
  const total = connected.size + pending.length;
  const count = pending.length
    ? `${total} 人在房间里，其中 ${pending.length} 人正在连接`
    : `${total} 人在房间里`;
  $('#members').replaceChildren(...dots, el('span', 'count', count));
  watchStuck(pending.length);
}

// 信令显示有人、但 20 秒内 P2P 仍没连上：多半是浏览器或网络限制了 WebRTC
function watchStuck(pending) {
  if (!pending) {
    clearTimeout(stuckTimer);
    stuckTimer = 0;
    if ($('#banner').dataset.kind === 'stuck') banner('');
    return;
  }
  if (stuckTimer) return;
  stuckTimer = setTimeout(() => {
    stuckTimer = 0;
    if (ended || !$('.members .pending')) return;
    banner(
      '有人在房间里，但一直没能和你直连上，所以互相收不到消息。常见原因：某一方的浏览器扩展或隐私设置限制了 WebRTC，或者网络不允许直连。',
      'stuck',
    );
  }, 20000);
}

function setLocked(v) {
  locked = Boolean(v);
  const b = $('#lock');
  b.setAttribute('aria-pressed', String(locked));
  b.textContent = locked ? '允许新人加入' : '禁止新人加入';
  $('#lock-chip').hidden = !locked;
}

function banner(text, kind = '') {
  const b = $('#banner');
  b.textContent = text;
  b.dataset.kind = text ? kind : '';
  b.hidden = !text;
}

function autosize() {
  const t = $('#input');
  t.style.height = 'auto';
  t.style.height = `${Math.min(t.scrollHeight, 160)}px`;
}

// ---------- 提醒：标题未读数 + 可选的系统通知 ----------
const notifyOn = () => store(() => localStorage.getItem('rc_notify')) === '1' && 'Notification' in window;

function updateTitle() {
  document.title = `${unread ? `(${unread}) ` : ''}房间 ${roomId}`;
}

function notify(msg) {
  if (!document.hidden) return;
  unread += 1;
  updateTitle();
  if (notifyOn() && Notification.permission === 'granted') {
    const who = identityFor(msg.uid);
    const body = msg.type === 'text' ? msg.text.slice(0, 80) : `发来一个${{ image: '图片', video: '视频', audio: '音频' }[msg.kind]}`;
    try {
      new Notification(who.name, { body, tag: `room-${roomId}` });
    } catch { }
  }
}

function renderBell() {
  const b = $('#bell');
  if (!('Notification' in window)) return (b.hidden = true);
  const on = notifyOn() && Notification.permission === 'granted';
  b.textContent = on ? '通知已开' : '开启通知';
  b.setAttribute('aria-pressed', String(on));
}

// ---------- 事件 ----------
function bind() {
  const input = $('#input');
  input.addEventListener('input', autosize);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      send();
    }
  });
  input.addEventListener('paste', (e) => {
    const list = [...(e.clipboardData?.files || [])];
    if (list.length) {
      e.preventDefault();
      sendFiles(list);
    }
  });
  $('#send').addEventListener('click', send);
  $('#attach').addEventListener('click', () => $('#file').click());
  $('#file').addEventListener('change', (e) => {
    sendFiles([...e.target.files]);
    e.target.value = '';
  });
  const chat = $('.chat');
  chat.addEventListener('dragover', (e) => {
    if ([...e.dataTransfer.types].includes('Files')) {
      e.preventDefault();
      chat.classList.add('dropping');
    }
  });
  chat.addEventListener('dragleave', (e) => e.target === chat && chat.classList.remove('dropping'));
  chat.addEventListener('drop', (e) => {
    chat.classList.remove('dropping');
    if (!e.dataTransfer.files.length) return;
    e.preventDefault();
    sendFiles([...e.dataTransfer.files]);
  });

  $('#copy-link').addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    const link = `${location.origin}/${roomId}`;
    try {
      await navigator.clipboard.writeText(link);
      btn.textContent = '已复制';
    } catch {
      prompt('复制这个链接发给朋友：', link);
    }
    setTimeout(() => (btn.textContent = '复制链接'), 1500);
  });

  $('#lock').addEventListener('click', () => {
    if (!conn?.send({ type: 'lock', value: !locked })) banner('暂时连不上服务器，稍后再试。', 'down');
  });

  $('#end').addEventListener('click', () => {
    if (!confirm('结束后所有人都会被移出，聊天记录全部清除。确定结束房间吗？')) return;
    if (!conn?.send({ type: 'end' })) banner('暂时连不上服务器，稍后再试。', 'down');
  });

  $('#leave').addEventListener('click', () => {
    const id = roomId;
    teardown();
    showScreen('你已离开房间', '房间还在继续。只要房间没有锁定，重新打开链接就能回来。', { home: true, rejoin: true });
    $('#screen-rejoin').onclick = () => location.assign(`/${id}`);
  });

  $('#bell').addEventListener('click', async () => {
    if (notifyOn() && Notification.permission === 'granted') {
      store(() => localStorage.setItem('rc_notify', '0'));
    } else {
      const p = Notification.permission === 'default' ? await Notification.requestPermission() : Notification.permission;
      if (p !== 'granted') banner('浏览器没有允许通知，可以在网站设置里打开。', 'notify');
      store(() => localStorage.setItem('rc_notify', p === 'granted' ? '1' : '0'));
    }
    renderBell();
  });
  renderBell();

  $('#viewer').addEventListener('click', closeViewer);
  document.addEventListener('keydown', (e) => e.key === 'Escape' && closeViewer());

  // 回到前台 / 网络恢复：清未读，立刻重连信令
  const wake = () => {
    if (document.hidden || !roomId || ended) return;
    unread = 0;
    updateTitle();
    conn?.reconnectNow();
  };
  document.addEventListener('visibilitychange', wake);
  window.addEventListener('online', wake);
  window.addEventListener('focus', wake);

  // 首页
  $('#home-shuffle').addEventListener('click', () => {
    $('#home-id').value = randomId();
    $('#home-err').textContent = '';
  });
  $('#home-go').addEventListener('click', homeGo);
  $('#home-id').addEventListener('keydown', (e) => e.key === 'Enter' && homeGo());
}

bind();
boot();
