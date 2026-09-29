import { Conn, joinRoom } from './relay.js';
import { identityFor, loadSelf } from './identity.js';

const APP_ID = 'roomchat';

// ICE 服务器：只用 Cloudflare STUN（国内一般可达）。不用 Google STUN，否则在它不可达的网络里
// 每次建连都要等 ICE 收集超时（Trystero 默认 15 秒）。以后加 TURN 也在这里追加。
// 调试：localStorage.rc_ice 可写入 JSON 数组覆盖（本地测试用 '[]'）。
const ICE_SERVERS = (() => {
  try {
    const o = JSON.parse(localStorage.getItem('rc_ice'));
    if (Array.isArray(o)) return o;
  } catch {}
  return [{ urls: 'stun:stun.cloudflare.com:3478' }];
})();
const ID_RE = /^[0-9a-hjkmnp-tv-z]{6}$/;
const MAX_LEN = 4000;
const normalizeId = (s) =>
  String(s || '').toLowerCase().replace(/[^0-9a-z]/g, '').replace(/o/g, '0').replace(/[il]/g, '1');

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
let present = 1; // 信令服务器上的在线人数（含自己），用来发现"有人在但连不上"
let stuckTimer = 0;
const peers = new Map(); // Trystero peerId -> 身份
const messages = []; // 按时间排序的聊天消息
const nodes = new Map(); // 消息 id -> DOM 节点

// 回房令牌：锁定的房间里刷新页面还能回来
const tokenKey = (id) => `rc_rt_${id}`;
const getToken = (id) => {
  try {
    return sessionStorage.getItem(tokenKey(id));
  } catch {
    return null;
  }
};
const setToken = (id, t) => {
  try {
    sessionStorage.setItem(tokenKey(id), t);
  } catch {}
};
const clearToken = (id) => {
  try {
    sessionStorage.removeItem(tokenKey(id));
  } catch {}
};

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
function showScreen(title, text, { newRoom = false, rejoin = false } = {}) {
  document.body.dataset.view = 'screen';
  $('#screen-title').textContent = title;
  $('#screen-text').textContent = text;
  $('#screen-new').hidden = !newRoom;
  $('#screen-rejoin').hidden = !rejoin;
  document.title = title;
}

const showClosed = () => showScreen('网站维护中', '暂时无法创建或加入房间，请稍后再来。');
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
    } catch {}
    return { status: r.status, ok: r.ok, body };
  } catch {
    return { status: 0, ok: false, body: {} };
  }
}

// ---------- 启动 ----------
async function boot() {
  const st = await api('/api/status');
  if (!st.ok) return showScreen('无法连接', '服务器暂时连不上，请稍后刷新重试。');
  if (!st.body.open && !st.body.admin) return showClosed();
  if (typeof RTCPeerConnection === 'undefined') return showNoWebRTC();

  const raw = decodeURIComponent(location.pathname.slice(1));
  if (!raw) {
    const r = await api('/api/rooms', { method: 'POST' });
    if (r.body.error === 'closed') return showClosed();
    if (r.status === 429) return showScreen('创建太频繁', '请过几分钟再新建房间。');
    if (!r.ok) return showScreen('创建失败', '请刷新页面重试。');
    history.replaceState(null, '', `/${r.body.id}`);
    return enter(r.body.id);
  }

  const id = normalizeId(raw);
  if (!ID_RE.test(id)) return showScreen('房间不存在', '检查一下链接是否完整，或者新建一个房间。', { newRoom: true });
  if (id !== raw) history.replaceState(null, '', `/${id}`);

  const r = await api(`/api/rooms/${id}`);
  if (r.body.error === 'closed') return showClosed();
  if (!r.ok) return showScreen('无法连接', '服务器暂时连不上，请稍后刷新重试。');
  const s = r.body;
  if (!s.exists) return showScreen('房间不存在', '检查一下链接是否完整，或者新建一个房间。', { newRoom: true });
  if (s.state === 'ended') return showScreen('房间已结束', endedText(s.reason, ''), { newRoom: true });
  const returning = Boolean(getToken(id));
  if (s.locked && !returning) return showScreen('房间已锁定', '房间里的人暂时不允许新成员加入。', { newRoom: true });
  if (s.full && !returning) return showScreen('房间已满', '这个房间的人数已达上限。', { newRoom: true });
  enter(id);
}

// ---------- 进入房间 ----------
function enter(id) {
  roomId = id;
  document.body.dataset.view = 'chat';
  document.title = `房间 ${id}`;
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
    if (!ended && !conn.final) banner('与服务器的连接断了，正在重连。已经连上的人仍可以继续聊天。');
  });
  conn.addEventListener('up', () => banner(''));

  try {
    startP2P();
  } catch (err) {
    console.error('[p2p] init failed', err);
    teardown();
    return showNoWebRTC();
  }
  $('#input').focus();
}

function onControl(m) {
  switch (m.type) {
    case 'welcome':
      setToken(roomId, m.token);
      setLocked(m.locked);
      if (m.idleMs) $('#hint').textContent = `${Math.round(m.idleMs / 60000)} 分钟没有新消息，房间会自动结束。`;
      return;
    case 'presence':
      present = Math.max(1, Number(m.count) || 1);
      renderMembers();
      return;
    case 'state':
      setLocked(m.locked);
      system(m.locked ? `${m.by || '有人'}禁止了新人加入。` : `${m.by || '有人'}重新允许新人加入。`);
      return;
    case 'ended':
      teardown();
      showScreen('房间已结束', endedText(m.reason, m.by), { newRoom: true });
      return;
    case 'reject': {
      teardown();
      const t = {
        locked: ['房间已锁定', '房间里的人暂时不允许新成员加入。'],
        full: ['房间已满', '这个房间的人数已达上限。'],
        ended: ['房间已结束', '这个房间已经结束了。'],
        not_found: ['房间不存在', '检查一下链接是否完整，或者新建一个房间。'],
      }[m.reason] || ['无法加入', '请稍后再试。'];
      showScreen(t[0], t[1], { newRoom: true });
    }
  }
}

// ---------- P2P ----------
function startP2P() {
  // trickleIce: false —— 绕过 Trystero 0.25.x 的 offer 过期问题（约 57 秒后新人连不上）
  room = joinRoom(
    { appId: APP_ID, relayConfig: { conn }, trickleIce: false, rtcConfig: { iceServers: ICE_SERVERS } },
    roomId,
    {
      onJoinError: (e) => console.warn('[p2p]', e.error),
    },
  );
  const hello = room.makeAction('hello');
  const chat = room.makeAction('chat');
  const sync = room.makeAction('sync', { kind: 'request', onRequest: () => messages.slice(-300) });
  act = { hello, chat, sync };

  hello.onMessage = (d, { peerId }) => {
    if (!d || typeof d.uid !== 'string' || !/^[a-z0-9]{10,32}$/.test(d.uid)) return;
    const known = peers.has(peerId);
    const who = identityFor(d.uid);
    peers.set(peerId, who);
    renderMembers();
    if (!known && who.uid !== me.uid) system(`${who.name}加入了`);
  };
  chat.onMessage = (d) => receive(d);

  room.onPeerJoin = (peerId) => {
    hello.send({ uid: me.uid }, { target: peerId });
    if (!synced) {
      synced = true;
      sync
        .request({}, { target: peerId, timeoutMs: 8000 })
        .then((list) => Array.isArray(list) && list.forEach(receive))
        .catch(() => (synced = false));
    }
  };
  room.onPeerLeave = (peerId) => {
    const who = peers.get(peerId);
    peers.delete(peerId);
    renderMembers();
    if (who && ![...peers.values()].some((p) => p.uid === who.uid)) system(`${who.name}离开了`);
  };
}

function teardown() {
  if (ended) return;
  ended = true;
  clearTimeout(stuckTimer);
  try {
    room?.leave();
  } catch {}
  conn?.close();
  messages.length = 0;
  nodes.clear();
  peers.clear();
  $('#log').replaceChildren();
  clearToken(roomId);
}

// ---------- 消息 ----------
function receive(m) {
  if (
    !m ||
    typeof m.id !== 'string' ||
    typeof m.uid !== 'string' ||
    typeof m.text !== 'string' ||
    !Number.isFinite(m.ts) ||
    nodes.has(m.id)
  )
    return;
  const msg = { id: m.id.slice(0, 40), uid: m.uid.slice(0, 32), ts: m.ts, text: m.text.slice(0, MAX_LEN) };
  let i = messages.length;
  while (i > 0 && messages[i - 1].ts > msg.ts) i--;
  messages.splice(i, 0, msg);
  renderMessage(msg, messages[i - 1], messages[i + 1]);
}

function send() {
  const input = $('#input');
  const text = input.value.replace(/\s+$/, '');
  if (!text.trim() || ended) return;
  if (!act) return banner('直连功能没有启动成功，消息发不出去。请刷新页面重试。');
  const m = { id: crypto.randomUUID(), uid: me.uid, ts: Date.now(), text: text.slice(0, MAX_LEN) };
  receive(m);
  act.chat.send(m);
  input.value = '';
  autosize();
  const now = Date.now();
  if (now - lastActivitySent > 20000 && conn.send({ type: 'activity' })) lastActivitySent = now;
}

// ---------- 渲染 ----------
const timeFmt = new Intl.DateTimeFormat('zh-CN', { hour: '2-digit', minute: '2-digit' });

function avatar(who, size = '') {
  const d = el('span', `dot ${size}`, who.initial);
  d.style.background = who.color;
  d.title = who.name;
  return d;
}

function renderMessage(msg, prev, next) {
  const who = identityFor(msg.uid);
  const mine = msg.uid === me.uid;
  const row = el('article', `msg${mine ? ' mine' : ''}`);
  if (prev && prev.uid === msg.uid && msg.ts - prev.ts < 120000) row.classList.add('cont');
  row.style.setProperty('--who', who.color);
  row.append(avatar(who));
  const body = el('div', 'body');
  const meta = el('div', 'meta');
  meta.append(el('span', 'name', mine ? '我' : who.name), el('time', 'time', timeFmt.format(msg.ts)));
  body.append(meta, el('p', 'text', msg.text));
  row.append(body);
  nodes.set(msg.id, row);

  const log = $('#log');
  const stick = log.scrollHeight - log.scrollTop - log.clientHeight < 80;
  const before = next && nodes.get(next.id);
  if (before) log.insertBefore(row, before);
  else log.append(row);
  if (stick || mine) log.scrollTop = log.scrollHeight;
}

function system(text) {
  const log = $('#log');
  log.append(el('p', 'sys', text));
  log.scrollTop = log.scrollHeight;
}

function renderMembers() {
  const box = $('#members');
  const list = [me];
  for (const p of peers.values()) if (!list.some((x) => x.uid === p.uid)) list.push(p);
  box.replaceChildren(
    ...list.map((w, i) => {
      const d = avatar(w, 'lg');
      if (i === 0) d.classList.add('self');
      return d;
    }),
    el('span', 'count', countText(1 + peers.size)),
  );
  watchStuck(1 + peers.size);
}

function countText(connected) {
  const pending = present - connected;
  if (pending <= 0) return `${connected} 人在房间里`;
  return `${present} 人在房间里，其中 ${pending} 人正在连接`;
}

// 信令显示有人、但 20 秒内 P2P 仍没连上：多半是浏览器或网络限制了 WebRTC
function watchStuck(connected) {
  if (present <= connected) {
    clearTimeout(stuckTimer);
    stuckTimer = 0;
    if ($('#banner').dataset.kind === 'stuck') banner('');
    return;
  }
  if (stuckTimer) return;
  stuckTimer = setTimeout(() => {
    stuckTimer = 0;
    if (ended || present <= 1 + peers.size) return;
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
  $('#send').addEventListener('click', send);

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
    if (!conn?.send({ type: 'lock', value: !locked })) banner('暂时连不上服务器，稍后再试。');
  });

  $('#end').addEventListener('click', () => {
    if (!confirm('结束后所有人都会被移出，聊天记录全部清除。确定结束房间吗？')) return;
    if (!conn?.send({ type: 'end' })) banner('暂时连不上服务器，稍后再试。');
  });

  $('#leave').addEventListener('click', () => {
    const id = roomId;
    teardown();
    showScreen('你已离开房间', '房间还在继续。只要房间没有锁定，重新打开链接就能回来。', {
      newRoom: true,
      rejoin: true,
    });
    $('#screen-rejoin').onclick = () => location.assign(`/${id}`);
  });
}

bind();
boot();