'use strict';

/* 全局通用：WebSocket RPC 客户端（自动重连、重订阅、心跳）、小工具 */

const $ = (sel, root = document) => root.querySelector(sel);

function h(tag, attrs = {}, children = []) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (k === 'class') el.className = v;
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
    else if (v !== null && v !== undefined) el.setAttribute(k, v);
  }
  for (const c of [].concat(children)) {
    if (c === null || c === undefined || c === false) continue;
    el.append(c.nodeType ? c : document.createTextNode(String(c)));
  }
  return el;
}

let clientSeq = 0;
function uid(prefix = 'op') {
  clientSeq += 1;
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}_${clientSeq}`;
}

class RpcSocket {
  constructor() {
    this.ws = null;
    this.connected = false;
    this.nextId = 1;
    this.pending = new Map();
    this.subscriptions = []; // [{channel, params, onSnapshot}]
    this.events = new EventTarget();
    this.reconnectDelay = 300;
    this.shouldRun = true;
    this.connect();
  }

  connect() {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const url = `${proto}://${location.host}/ws`;
    const ws = new WebSocket(url);
    this.ws = ws;

    ws.addEventListener('open', () => {
      this.connected = true;
      this.reconnectDelay = 300;
      this.events.dispatchEvent(new CustomEvent('status', { detail: { connected: true } }));
      // 重连后按当前订阅集恢复；去重，避免同一场次被订阅多次
      const seen = new Set();
      this.subscriptions = this.subscriptions.filter((sub) => {
        const key = `${sub.channel}:${sub.params.sessionId ?? sub.params.scriptId ?? ''}`;
        if (seen.has(key)) return false;
        seen.add(key);
        this.sendSubscribe(sub);
        return true;
      });
    });

    ws.addEventListener('message', (ev) => {
      let msg;
      try {
        msg = JSON.parse(ev.data);
      } catch {
        return;
      }
      if (msg.type === 'snapshot' || msg.type === 'subscribed' || msg.type === 'script_changed') {
        this.events.dispatchEvent(new CustomEvent(msg.type, { detail: msg }));
      } else if (msg.type === 'result') {
        const p = this.pending.get(msg.id);
        if (p) {
          this.pending.delete(msg.id);
          p.resolve(msg.result);
        }
      } else if (msg.type === 'error') {
        if (msg.id != null && this.pending.has(msg.id)) {
          const p = this.pending.get(msg.id);
          this.pending.delete(msg.id);
          const err = new Error(msg.message);
          err.code = msg.code;
          err.stateVersion = msg.stateVersion;
          p.reject(err);
        } else {
          this.events.dispatchEvent(new CustomEvent('serverError', { detail: msg }));
        }
      }
    });

    const onClose = () => {
      if (this.ws === ws) {
        this.connected = false;
        this.events.dispatchEvent(new CustomEvent('status', { detail: { connected: false } }));
        for (const [, p] of this.pending) {
          const err = new Error('连接已断开，操作未确认');
          err.code = 'DISCONNECTED';
          p.reject(err);
        }
        this.pending.clear();
        if (this.shouldRun) {
          setTimeout(() => this.connect(), this.reconnectDelay);
          this.reconnectDelay = Math.min(5000, this.reconnectDelay * 1.7);
        }
      }
    };
    ws.addEventListener('close', onClose);
    ws.addEventListener('error', onClose);
  }

  whenReady() {
    if (this.connected) return Promise.resolve();
    return new Promise((resolve) => {
      const check = () => {
        if (this.connected) resolve();
        else setTimeout(check, 100);
      };
      check();
    });
  }

  async call(method, params = {}, { timeoutMs = 15000 } = {}) {
    await this.whenReady();
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          const err = new Error('操作请求超时');
          err.code = 'TIMEOUT';
          reject(err);
        }
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (r) => {
          clearTimeout(timer);
          resolve(r);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      });
      this.ws.send(JSON.stringify({ type: 'rpc', id, method, params }));
    });
  }

  sendSubscribe(sub) {
    this.ws.send(
      JSON.stringify({
        type: 'subscribe',
        id: this.nextId++,
        channel: sub.channel,
        ...sub.params,
      })
    );
  }

  subscribe(channel, params = {}) {
    const sub = { channel, params };
    this.subscriptions.push(sub);
    if (this.connected) this.sendSubscribe(sub);
    return sub;
  }

  unsubscribe(sub) {
    this.subscriptions = this.subscriptions.filter((s) => s !== sub);
    if (this.connected) {
      this.ws.send(JSON.stringify({ type: 'unsubscribe', channel: sub.channel, ...sub.params }));
    }
  }
}

// 顶部连接状态条
function mountStatus(socket) {
  const bar = $('#conn-status');
  if (!bar) return;
  const render = (connected) => {
    bar.textContent = connected ? '● 已实时连接' : '○ 连接中断，正在自动重连…';
    bar.className = connected ? 'conn ok' : 'conn bad';
  };
  socket.events.addEventListener('status', (e) => render(e.detail.connected));
  render(socket.connected);
}

function toast(message, kind = 'info', ttl = 3500) {
  const box = $('#toasts');
  if (!box) {
    // eslint-disable-next-line no-alert
    if (kind === 'error') window.alert(message);
    return;
  }
  const el = h('div', { class: `toast ${kind}` }, message);
  box.append(el);
  setTimeout(() => {
    el.classList.add('fade');
    setTimeout(() => el.remove(), 400);
  }, ttl);
}

window.TP = { $, h, uid, RpcSocket, mountStatus, toast };
