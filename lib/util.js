"use strict";

const crypto = require("crypto");
const os = require("os");

class AppError extends Error {
  constructor(code, message, status) {
    super(message);
    this.name = "AppError";
    this.code = code;
    this.status = status || 400;
  }
}

function randomHex(bytes) {
  return crypto.randomBytes(bytes || 8).toString("hex");
}

function randomDigits(n) {
  let s = "";
  for (let i = 0; i < n; i++) s += Math.floor(Math.random() * 10);
  if (s[0] === "0") s = "1" + s.slice(1);
  return s;
}

function clampInt(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
}

/** 按可信度排序的本机局域网 IPv4（排除回环/虚拟网卡/APIPA） */
function lanIps() {
  const list = [];
  const ifaces = os.networkInterfaces();
  Object.keys(ifaces).forEach((name) => {
    (ifaces[name] || []).forEach((item) => {
      const family = item.family;
      if (family !== "IPv4" && family !== 4) return;
      if (item.internal) return;
      const addr = item.address;
      if (!/^\d+\.\d+\.\d+\.\d+$/.test(addr)) return;
      if (addr.startsWith("169.254.")) return;
      let score = 1;
      if (addr.startsWith("192.168.")) score = 4;
      else if (addr.startsWith("10.")) score = 3;
      else if (/^172\.(1[6-9]|2\d|3[01])\./.test(addr)) score = 3;
      const low = String(name).toLowerCase();
      if (/(vmware|virtualbox|vethernet|wsl|hyper-v|docker|tailscale|zerotier|tap|tun)/.test(low)) {
        score -= 2;
      }
      list.push({ addr, score });
    });
  });
  list.sort((a, b) => b.score - a.score);
  const seen = new Set();
  const out = [];
  list.forEach((x) => {
    if (seen.has(x.addr)) return;
    seen.add(x.addr);
    out.push(x.addr);
  });
  return out.length ? out : ["127.0.0.1"];
}

/** CSV 单元格转义（防公式注入 + 引号转义） */
function csvCell(value) {
  let s = value === null || value === undefined ? "" : String(value);
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
  return '"' + s.replace(/"/g, '""') + '"';
}

module.exports = { AppError, randomHex, randomDigits, clampInt, lanIps, csvCell };
