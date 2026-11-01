/* ==========================================================================
   新春年会抽奖系统 · 网络与本地存储共享层（Lead 维护，禁止各页面修改）
   暴露全局 window.Net
   ========================================================================== */
(function () {
  "use strict";

  var LS_PREFIX = "xn_lottery_";

  function safeGet(key, def) {
    try {
      var v = localStorage.getItem(LS_PREFIX + key);
      return v === null ? def : v;
    } catch (e) {
      return def;
    }
  }
  function safeSet(key, val) {
    try {
      localStorage.setItem(LS_PREFIX + key, val);
      return true;
    } catch (e) {
      return false;
    }
  }
  function safeDel(key) {
    try {
      localStorage.removeItem(LS_PREFIX + key);
    } catch (e) {}
  }

  // 每个标签页一个稳定 clientId
  var CID = (function () {
    var k = "cid";
    var v = safeGet(k, null);
    if (!v || typeof v !== "string" || v.length < 6) {
      v = "c" + Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
      safeSet(k, v);
    }
    return v;
  })();

  function esc(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function fmtMs(ms) {
    var s = Math.max(0, Number(ms) || 0) / 1000;
    return s >= 10 ? s.toFixed(1) + "s" : s.toFixed(1) + "s";
  }

  function buildQuery(obj) {
    var parts = [];
    Object.keys(obj || {}).forEach(function (k) {
      if (obj[k] === undefined || obj[k] === null) return;
      parts.push(encodeURIComponent(k) + "=" + encodeURIComponent(obj[k]));
    });
    return parts.join("&");
  }

  /** SSE 流封装。role: host | player | admin */
  function stream(role, extra) {
    var params = { cid: CID, role: role || "host" };
    if (extra) Object.keys(extra).forEach(function (k) { params[k] = extra[k]; });
    var es = new EventSource("/api/stream?" + buildQuery(params));
    var handlers = Object.create(null);
    var api = {
      es: es,
      on: function (type, fn) {
        (handlers[type] || (handlers[type] = [])).push(fn);
        return api;
      },
      off: function (type, fn) {
        var arr = handlers[type];
        if (!arr) return api;
        var i = arr.indexOf(fn);
        if (i >= 0) arr.splice(i, 1);
        return api;
      },
      close: function () {
        try { es.close(); } catch (e) {}
      }
    };
    es.onmessage = function (e) {
      var msg;
      try { msg = JSON.parse(e.data); } catch (err) { return; }
      if (!msg || !msg.t) return;
      var list = (handlers[msg.t] || []).slice();
      if (handlers["*"]) list = list.concat(handlers["*"]);
      for (var i = 0; i < list.length; i++) {
        try { list[i](msg); } catch (err) {
          console.error("[Net] handler error", msg.t, err);
        }
      }
    };
    es.onopen = function () {
      var list = (handlers["_open"] || []).slice();
      for (var i = 0; i < list.length; i++) { try { list[i](); } catch (e) {} }
    };
    es.onerror = function () {
      var list = (handlers["_error"] || []).slice();
      for (var i = 0; i < list.length; i++) { try { list[i](); } catch (e) {} }
    };
    return api;
  }

  async function request(path, opts) {
    var res;
    try {
      res = await fetch(path, opts);
    } catch (err) {
      return { ok: false, error: "网络连接失败，请检查是否与主机在同一局域网", code: "NETWORK" };
    }
    var body = null;
    try { body = await res.json(); } catch (err) { body = null; }
    if (!body) {
      return { ok: false, error: "服务器返回异常（" + res.status + "）", code: "BAD_RESPONSE" };
    }
    if (!res.ok && body.ok !== false) body.ok = false;
    body.__status = res.status;
    return body;
  }

  function post(path, body) {
    return request(path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body || {}),
      credentials: "same-origin",
      cache: "no-store"
    });
  }

  function get(path) {
    return request(path, { method: "GET", credentials: "same-origin", cache: "no-store" });
  }

  /** 逐帧节流：requestAnimationFrame 合并绘制 */
  function rafBatch(fn) {
    var queued = false;
    return function () {
      if (queued) return;
      queued = true;
      requestAnimationFrame(function () {
        queued = false;
        fn();
      });
    };
  }

  window.Net = {
    cid: function () { return CID; },
    stream: stream,
    post: post,
    get: get,
    escape: esc,
    fmtMs: fmtMs,
    rafBatch: rafBatch,
    store: {
      get: function (k, def) { return safeGet(k, def); },
      set: function (k, v) { return safeSet(k, v); },
      del: function (k) { safeDel(k); }
    }
  };
})();
