import { createTopicStrategy, toJson } from '@trystero-p2p/core';

// 到房间 Durable Object 的 WebSocket：断线自动重连，重连后自动补订阅。
// 同一条连接既跑 Trystero 信令（subscribe/publish），也跑房间控制消息（welcome/lock/ended…）。
export class Conn extends EventTarget {
  constructor(getUrl) {
    super();
    this.getUrl = getUrl;
    this.subs = new Map(); // topic -> 引用计数（leave/join 交错时避免误退订）
    this.final = false;
    this.retry = 0;
    this.ws = null;
    this.ready = new Promise((resolve) => (this.resolveReady = resolve));
    this.open();
  }

  open() {
    if (this.final) return;
    const ws = new WebSocket(this.getUrl());
    this.ws = ws;
    ws.onopen = () => {
      this.retry = 0;
      for (const topic of this.subs.keys()) ws.send(toJson({ type: 'subscribe', topic }));
      this.dispatchEvent(new Event('up'));
    };
    ws.onmessage = (e) => {
      let m;
      try {
        m = JSON.parse(e.data);
      } catch {
        return;
      }
      if (m.type === 'welcome') this.resolveReady(this);
      if (m.type === 'reject' || m.type === 'ended') this.final = true;
      this.dispatchEvent(new CustomEvent('data', { detail: m }));
    };
    ws.onclose = () => {
      if (this.ws !== ws) return;
      this.dispatchEvent(new Event('down'));
      if (this.final) return;
      const delay = Math.min(15000, 1000 * 2 ** this.retry++);
      setTimeout(() => this.open(), delay);
    };
  }

  send(obj) {
    if (this.ws?.readyState !== WebSocket.OPEN) return false;
    this.ws.send(toJson(obj));
    return true;
  }

  close() {
    this.final = true;
    this.ws?.close(1000);
  }
}

// Trystero 自定义信令策略：config.relayConfig.conn 传入上面的 Conn
export const joinRoom = createTopicStrategy({
  init: (config) => config.relayConfig.conn.ready,

  subscribeTopic: (conn, topic, onMessage) => {
    const n = conn.subs.get(topic) || 0;
    conn.subs.set(topic, n + 1);
    if (n === 0) conn.send({ type: 'subscribe', topic });
    const handler = (e) => {
      if (e.detail.topic === topic) onMessage(topic, e.detail.payload);
    };
    conn.addEventListener('data', handler);
    return () => {
      conn.removeEventListener('data', handler);
      const left = (conn.subs.get(topic) || 1) - 1;
      if (left > 0) return void conn.subs.set(topic, left);
      conn.subs.delete(topic);
      conn.send({ type: 'unsubscribe', topic });
    };
  },

  publishTopic: (conn, topic, payload) => {
    conn.send({ type: 'publish', topic, payload });
  },
});
