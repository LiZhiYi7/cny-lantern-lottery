"use strict";

/** 极简 SSE 连接池：以 cid + role 为键，同一浏览器的大屏与后台互不踢线 */
class Hub {
  constructor() {
    this.clients = new Map();
    this._hb = setInterval(() => this.ping(), 15000);
    if (this._hb.unref) this._hb.unref();
  }

  _key(cid, role) {
    return String(cid) + "|" + String(role || "player");
  }

  add(cid, role, res, extra) {
    const key = this._key(cid, role);
    const prev = this.clients.get(key);
    if (prev && prev.res !== res) {
      try {
        prev.res.end();
      } catch (e) {}
    }
    const client = {
      key,
      cid,
      role,
      res,
      pid: (extra && extra.pid) || null,
      connectedAt: Date.now()
    };
    this.clients.set(key, client);
    return client;
  }

  remove(cid, role, res) {
    const key = this._key(cid, role);
    const c = this.clients.get(key);
    if (!c) return;
    if (res && c.res !== res) return; // 已被新连接替换
    this.clients.delete(key);
    try {
      c.res.end();
    } catch (e) {}
  }

  _write(c, msg) {
    if (!c || !c.res || c.res.writableEnded) {
      if (c) this.clients.delete(c.key);
      return;
    }
    try {
      c.res.write("data: " + JSON.stringify(msg) + "\n\n");
    } catch (e) {
      this.clients.delete(c.key);
    }
  }

  /** 默认投递给该 cid 的玩家连接（role=player） */
  send(cid, msg, role) {
    if (!cid) return;
    this._write(this.clients.get(this._key(cid, role || "player")), msg);
  }

  broadcast(msg, filter) {
    for (const c of Array.from(this.clients.values())) {
      if (filter && !filter(c)) continue;
      this._write(c, msg);
    }
  }

  ping() {
    for (const c of Array.from(this.clients.values())) {
      if (c.res.writableEnded) {
        this.clients.delete(c.key);
        continue;
      }
      try {
        c.res.write(": ping\n\n");
      } catch (e) {
        this.clients.delete(c.key);
      }
    }
  }

  count(role) {
    let n = 0;
    for (const c of this.clients.values()) if (!role || c.role === role) n++;
    return n;
  }

  closeAll() {
    for (const c of this.clients.values()) {
      try {
        c.res.end();
      } catch (e) {}
    }
    this.clients.clear();
  }
}

module.exports = { Hub };
