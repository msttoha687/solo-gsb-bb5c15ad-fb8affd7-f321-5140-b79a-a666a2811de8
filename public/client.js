/* 走词台公共脚本：API 封装、实时连接（断线重连）、提示条 */
(function () {
  'use strict';

  const store = {
    get editorToken() {
      return localStorage.getItem('editorToken') || '';
    },
    set editorToken(v) {
      if (v) localStorage.setItem('editorToken', v);
      else localStorage.removeItem('editorToken');
    },
    controlToken(showId) {
      return sessionStorage.getItem(`ctlToken:${showId}`) || '';
    },
    setControlToken(showId, v) {
      if (v) sessionStorage.setItem(`ctlToken:${showId}`, v);
      else sessionStorage.removeItem(`ctlToken:${showId}`);
    },
  };

  async function api(path, { method = 'GET', body = null, auth = false } = {}) {
    const headers = { 'Content-Type': 'application/json' };
    if (auth && store.editorToken) headers.Authorization = `Bearer ${store.editorToken}`;
    let res;
    try {
      res = await fetch(path, {
        method,
        headers,
        body: body === null ? undefined : JSON.stringify(body),
      });
    } catch (networkErr) {
      const e = new Error('无法连接服务器，请检查网络或服务是否重启');
      e.code = 'NETWORK_ERROR';
      throw e;
    }
    let data = {};
    try {
      data = await res.json();
    } catch {
      /* ignore */
    }
    if (!res.ok) {
      const e = new Error(data.message || `请求失败（HTTP ${res.status}）`);
      e.code = data.error || 'ERROR';
      e.status = res.status;
      e.data = data;
      throw e;
    }
    return data;
  }

  function getShowId() {
    const v = parseInt(new URLSearchParams(location.search).get('show'), 10);
    return Number.isInteger(v) && v > 0 ? v : null;
  }

  function esc(s) {
    return String(s ?? '').replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c]));
  }

  function fmtClock(ts) {
    if (!ts) return '--:--:--';
    const d = new Date(ts);
    const p = (n) => String(n).padStart(2, '0');
    return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
  }

  // ---- 提示条 ----------------------------------------------------------------
  let toastTimer = null;
  function toast(message, kind = 'info') {
    let el = document.getElementById('toast');
    if (!el) {
      el = document.createElement('div');
      el.id = 'toast';
      document.body.appendChild(el);
    }
    el.className = `toast show ${kind}`;
    el.textContent = message;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove('show'), kind === 'error' ? 6000 : 3000);
  }

  // ---- 实时连接（自动重连；服务重启后由首帧 state 恢复最新已确认状态） --------
  function connect(showId, handlers) {
    let ws = null;
    let closedByUser = false;
    let attempt = 0;
    let pingTimer = null;
    const getToken = typeof handlers.controlToken === 'function' ? handlers.controlToken : null;

    function setConn(status) {
      document.body.dataset.conn = status;
      const dot = document.getElementById('conn-dot');
      const txt = document.getElementById('conn-text');
      if (dot) dot.className = `conn-dot ${status}`;
      if (txt) {
        txt.textContent = { live: '实时已连接', connecting: '连接中…', down: '连接断开，重连中…' }[status];
      }
    }

    function open() {
      const proto = location.protocol === 'https:' ? 'wss' : 'ws';
      const ct = getToken ? getToken() : null;
      const qs = new URLSearchParams({ showId: String(showId) });
      if (ct) qs.set('controlToken', ct);
      ws = new WebSocket(`${proto}://${location.host}/ws?${qs.toString()}`);
      setConn('connecting');

      ws.onopen = () => {
        attempt = 0;
        setConn('live');
        clearInterval(pingTimer);
        pingTimer = setInterval(() => {
          if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'ping' }));
        }, 20000);
      };

      ws.onmessage = (ev) => {
        let msg;
        try {
          msg = JSON.parse(ev.data);
        } catch {
          return;
        }
        if (msg.type === 'state' && msg.state) handlers.onState(msg.state);
        if (msg.type === 'control') {
          if (msg.reason) handlers.onControl?.(msg.reason, msg.state);
          if (msg.state) handlers.onState(msg.state);
        }
      };

      ws.onclose = () => {
        clearInterval(pingTimer);
        if (closedByUser) return;
        setConn('down');
        const delay = Math.min(1000 * 2 ** attempt, 10000);
        attempt += 1;
        setTimeout(open, delay);
      };

      ws.onerror = () => ws && ws.close();
    }

    open();
    return {
      close() {
        closedByUser = true;
        clearInterval(pingTimer);
        ws && ws.close();
      },
    };
  }

  // 生成操作幂等 ID
  function newOpId() {
    if (window.crypto?.randomUUID) return window.crypto.randomUUID();
    return `op-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  }

  window.Prompter = { api, store, connect, toast, esc, fmtClock, getShowId, newOpId };
})();
