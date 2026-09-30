// WebSocket 中转模式：用和 Trystero 房间相同的接口（makeAction / onPeerJoin / getPeers …）
// 包装一条到中转服务的 WebSocket，这样聊天逻辑不用区分两种模式。
// 这里的 peerId 是中转服务给每条连接分配的 id。

const CHUNK = 256 * 1024; // 文件分块大小
const WINDOW = 16; // 最多有多少块在途未确认
const ACK_EVERY = 8;
const enc = new TextEncoder();
const dec = new TextDecoder();

export function relayRoom(url, ticket, { onStatus } = {}) {
  let ws = null;
  let closed = false;
  let retry = 0;
  let timer = 0;
  let currentTicket = ticket;
  const peers = new Map(); // id -> uid
  const actions = new Map(); // name -> { cfg, api }
  const pending = new Map(); // 请求 id -> { resolve, reject, timer }
  const incoming = new Map(); // `${from}:${transferId}` -> 正在接收的文件
  const acks = new Map(); // transferId -> { acked, wake }
  let seq = 0;
  // 断线期间要广播的消息先排队，重连后补发（手机切到选图界面时连接常被系统断开）
  const outbox = [];
  const OUTBOX_MAX = 200;

  const room = {
    onPeerJoin: null,
    onPeerLeave: null,
    getPeers: () => Object.fromEntries([...peers.keys()].map((id) => [id, { close() { } }])),
    leave: async () => {
      closed = true;
      clearTimeout(timer);
      ws?.close(1000);
      for (const id of [...peers.keys()]) peerLeft(id);
    },
    updateTicket: (t) => (currentTicket = t),
    reconnectNow: () => {
      if (closed || ws?.readyState === WebSocket.OPEN || ws?.readyState === WebSocket.CONNECTING) return;
      clearTimeout(timer);
      retry = 0;
      open();
    },
    makeAction,
  };

  function peerJoined(id, uid) {
    if (peers.has(id)) return;
    peers.set(id, uid);
    room.onPeerJoin?.(id);
  }
  function peerLeft(id) {
    if (!peers.delete(id)) return;
    room.onPeerLeave?.(id);
  }

  function open() {
    if (closed) return;
    const sock = new WebSocket(`${url}${url.includes('?') ? '&' : '?'}t=${encodeURIComponent(currentTicket)}`);
    sock.binaryType = 'arraybuffer';
    ws = sock;
    sock.onopen = () => {
      retry = 0;
      onStatus?.('up');
    };
    sock.onmessage = (e) => (typeof e.data === 'string' ? onText(e.data) : onBinary(e.data));
    sock.onclose = (e) => {
      if (ws !== sock) return;
      // 断开时所有人视为离开，重连后服务端会重新告知在线的人
      for (const id of [...peers.keys()]) peerLeft(id);
      for (const [rid, p] of pending) {
        clearTimeout(p.timer);
        p.reject(new Error('disconnected'));
        pending.delete(rid);
      }
      incoming.clear();
      if (closed) return;
      onStatus?.('down');
      if (e.code === 4001 || e.code === 4003) return; // 房间结束 / 被移出：不重连
      timer = setTimeout(open, Math.min(15000, 1000 * 2 ** retry++));
    };
  }

  function rawSend(obj) {
    if (ws?.readyState !== WebSocket.OPEN) return false;
    ws.send(JSON.stringify(obj));
    return true;
  }

  function onText(text) {
    let m;
    try {
      m = JSON.parse(text);
    } catch {
      return;
    }
    if (m.t === 'hi') {
      const now = new Set(m.peers.map((p) => p.id));
      for (const id of [...peers.keys()]) if (!now.has(id)) peerLeft(id);
      for (const p of m.peers) peerJoined(p.id, p.uid);
      while (outbox.length && ws?.readyState === WebSocket.OPEN) ws.send(outbox.shift());
      return;
    }
    if (m.t === 'join') return peerJoined(m.id, m.uid);
    if (m.t === 'leave') return peerLeft(m.id);
    if (m.t !== 'm' || !peers.has(m.from)) return;

    if (m.a === '__ack') {
      const a = acks.get(m.d?.x);
      if (a) {
        a.acked = Math.max(a.acked, Number(m.d.i) || 0);
        a.wake?.();
      }
      return;
    }
    const action = actions.get(m.a);
    if (!action) return;
    const ctx = { peerId: m.from, metadata: m.meta };
    if (m.k === 'res') {
      const p = pending.get(m.rid);
      if (p) {
        clearTimeout(p.timer);
        pending.delete(m.rid);
        p.resolve(m.d);
      }
      return;
    }
    if (m.k === 'req') {
      Promise.resolve()
        .then(() => action.cfg.onRequest?.(m.d, { ...ctx, signal: new AbortController().signal }))
        .then((value) => rawSend({ t: 'm', a: m.a, k: 'res', rid: m.rid, d: value ?? null, to: [m.from] }))
        .catch(() => { });
      return;
    }
    action.api.onMessage?.(m.d, ctx);
  }

  // 二进制帧（服务端加过前缀）：[u8 发送者长度][发送者][u32 头长度][头 JSON][数据]
  function onBinary(buf) {
    const view = new DataView(buf);
    const fl = view.getUint8(0);
    const from = dec.decode(new Uint8Array(buf, 1, fl));
    const hl = view.getUint32(1 + fl);
    let h;
    try {
      h = JSON.parse(dec.decode(new Uint8Array(buf, 5 + fl, hl)));
    } catch {
      return;
    }
    if (!peers.has(from)) return;
    const action = actions.get(h.a);
    if (!action) return;
    const key = `${from}:${h.x}`;
    let t = incoming.get(key);
    if (!t) {
      if (h.i !== 0) return;
      t = { chunks: [], got: 0, total: h.n, meta: h.meta, type: h.type || '' };
      incoming.set(key, t);
    }
    t.chunks[h.i] = buf.slice(5 + fl + hl);
    t.got += 1;
    const ctx = { peerId: from, metadata: t.meta };
    action.api.onReceiveProgress?.(t.got / t.total, ctx);
    if (t.got % ACK_EVERY === 0 || t.got === t.total) {
      rawSend({ t: 'm', a: '__ack', d: { x: h.x, i: t.got }, to: [from] });
    }
    if (t.got === t.total) {
      incoming.delete(key);
      action.api.onMessage?.(new Blob(t.chunks, { type: t.type }), ctx);
    }
  }

  async function sendBinary(name, data, target, meta) {
    const blob = data instanceof Blob ? data : new Blob([data]);
    const total = Math.max(1, Math.ceil(blob.size / CHUNK));
    const x = `${Date.now().toString(36)}${(seq++).toString(36)}`;
    const state = { acked: 0, wake: null };
    acks.set(x, state);
    try {
      for (let i = 0; i < total; i++) {
        // 流量控制：在途太多就等对方确认；本地发送缓冲太多也等一等
        while (i - state.acked >= WINDOW || (ws && ws.bufferedAmount > 4 * CHUNK)) {
          if (closed || ws?.readyState !== WebSocket.OPEN) throw new Error('disconnected');
          await new Promise((r) => {
            state.wake = r;
            setTimeout(r, 200);
          });
        }
        const chunk = await blob.slice(i * CHUNK, (i + 1) * CHUNK).arrayBuffer();
        const hdr = enc.encode(
          JSON.stringify({ a: name, x, i, n: total, to: target, ...(i === 0 ? { meta, type: blob.type } : {}) }),
        );
        const frame = new Uint8Array(4 + hdr.length + chunk.byteLength);
        new DataView(frame.buffer).setUint32(0, hdr.length);
        frame.set(hdr, 4);
        frame.set(new Uint8Array(chunk), 4 + hdr.length);
        if (ws?.readyState !== WebSocket.OPEN) throw new Error('disconnected');
        ws.send(frame);
      }
    } finally {
      acks.delete(x);
    }
  }

  function makeAction(name, cfg = {}) {
    const toList = (t) => (t == null ? undefined : Array.isArray(t) ? t : [t]);
    const api = {
      onMessage: cfg.onMessage || null,
      onReceiveProgress: cfg.onReceiveProgress || null,
      send: async (data, opts = {}) => {
        const target = toList(opts.target);
        if (data instanceof Blob || data instanceof ArrayBuffer || ArrayBuffer.isView(data)) {
          // 文件逐个发给每个目标（中转服务只按 to 路由）
          for (const t of target || [...peers.keys()]) await sendBinary(name, data, [t], opts.metadata);
          return;
        }
        const msg = { t: 'm', a: name, d: data, meta: opts.metadata, to: target };
        // 发给指定连接的消息重连后对方 id 会变，不排队；广播消息排队等重连后补发
        if (!rawSend(msg) && !target && !closed && outbox.length < OUTBOX_MAX) outbox.push(JSON.stringify(msg));
      },
      request: (data, opts) =>
        new Promise((resolve, reject) => {
          const rid = `${Date.now().toString(36)}${(seq++).toString(36)}`;
          const timer = setTimeout(() => {
            pending.delete(rid);
            reject(new Error('timeout'));
          }, opts.timeoutMs || 10000);
          pending.set(rid, { resolve, reject, timer });
          if (!rawSend({ t: 'm', a: name, k: 'req', rid, d: data, to: [opts.target] })) {
            clearTimeout(timer);
            pending.delete(rid);
            reject(new Error('disconnected'));
          }
        }),
      requestMany: (data, opts) =>
        Promise.all(
          opts.targets.map((peerId) =>
            api
              .request(data, { target: peerId, timeoutMs: opts.timeoutMs })
              .then((value) => ({ peerId, status: 'fulfilled', value }))
              .catch((reason) => ({ peerId, status: 'rejected', reason })),
          ),
        ),
    };
    actions.set(name, { cfg, api });
    return api;
  }

  open();
  return room;
}
