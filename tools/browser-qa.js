#!/usr/bin/env node
"use strict";

/* ==========================================================================
   新春年会抽奖系统 · QA 浏览器验收（Edge headless + CDP，零第三方依赖）

   用法：
     node tools/browser-qa.js
     QA_PORT=8790 node tools/browser-qa.js

   行为：
   1) 自己 fork 起 server.js（PORT=8790、DATA_DIR=_tmp/qa/data-shot）；
   2) API 造场景：10 名玩家加入 → 开赛 → 6 中奖 4 失败 → 自动开奖；
   3) 启动 Edge headless（--remote-debugging-port=9333，每个页面独立 BrowserContext 保证
      localStorage/cookie 隔离），通过 CDP 截图并采集：
        - 页面 JS 异常 / console.error / 网络错误
        - 外链请求（验证「禁止任何外网资源」）
        - 横向/纵向溢出、绝对定位元素越界、canvas 实际亮度分布（黑屏探测）
        - 可见按钮尺寸（触控热区）
   4) 截图输出到 _tmp/qa/shots/，结果 JSON 输出到 _tmp/qa/browser-result.json；
   5) 结束 kill Edge / 服务端并清理临时数据（QA_KEEP=1 保留现场）。

   截图清单（_tmp/qa/shots/）：
     host-lobby-1920.png / host-lobby-1280.png / host-playing-1920.png / host-award-1920.png / host-reveal-1920.png
     player-join-390.png / player-join-375.png / player-countdown-390.png / player-playing-390.png
     player-result-390.png / player-lose-390.png
     admin-login-1920.png / admin-lobby-1920.png / admin-playing-1920.png / admin-reveal-1920.png

   退出码：0 = 页面无 JS 异常且无溢出/黑屏；1 = 存在问题（详见 JSON）。
   ========================================================================== */

const http = require("http");
const net = require("net");
const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");

const ROOT = path.resolve(__dirname, "..");
const PORT = Number(process.env.QA_PORT || 8790);
const HOST = "127.0.0.1";
const BASE = "http://" + HOST + ":" + PORT;
const TMP = path.join(ROOT, "_tmp", "qa");
const DATA_DIR = path.join(TMP, "data-shot");
const SHOT_DIR = path.join(TMP, "shots");
let CDP_PORT = Number(process.env.QA_CDP_PORT || 0);
let EDGE_PROFILE = path.join(TMP, "edge-profile-qa");
const KEEP = process.env.QA_KEEP === "1";
const EDGE_PATHS = [
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe"
];

/* ------------------------------------------------------------------ 日志 */
const useColor = process.stdout.isTTY;
const COL = { reset: "\x1b[0m", red: "\x1b[31m", green: "\x1b[32m", yellow: "\x1b[33m", cyan: "\x1b[36m", gray: "\x1b[90m" };
function c(code, s) {
  return useColor ? code + s + COL.reset : s;
}
const checks = [];
let pass = 0;
let fail = 0;
async function check(name, fn) {
  const t0 = Date.now();
  try {
    await fn();
    pass++;
    checks.push({ name, ok: true, ms: Date.now() - t0 });
    console.log("  " + c(COL.green, "✓") + " " + name + c(COL.gray, " (" + (Date.now() - t0) + "ms)"));
  } catch (err) {
    fail++;
    checks.push({ name, ok: false, error: String(err && err.message ? err.message : err) });
    console.log("  " + c(COL.red, "✗") + " " + name);
    console.log(c(COL.red, "      " + String(err && err.message ? err.message : err).split("\n").join("\n      ")));
  }
}
function ok(cond, msg) {
  if (!cond) throw new Error(msg);
}
function eq(a, b, msg) {
  if (a !== b) throw new Error(msg + "\n  期望: " + JSON.stringify(b) + "\n  实际: " + JSON.stringify(a));
}
function ne(a, b, msg) {
  if (a === b) throw new Error(msg + "\n  不应等于: " + JSON.stringify(b));
}
function fmt(v) {
  try {
    const s = JSON.stringify(v);
    return s && s.length > 500 ? s.slice(0, 500) + "…" : String(s);
  } catch (e) {
    return String(v);
  }
}
function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
function head(msg) {
  console.log("\n" + c(COL.cyan, "── " + msg + " " + "─".repeat(Math.max(0, 62 - msg.length))));
}
function log(msg) {
  console.log(msg);
}

/* ------------------------------------------------------------------ HTTP（夹具用） */
function httpReq(method, pathname, opts) {
  opts = opts || {};
  return new Promise((resolve) => {
    const headers = Object.assign({}, opts.headers || {});
    let payload = null;
    if (opts.body !== undefined) {
      payload = JSON.stringify(opts.body);
      headers["Content-Type"] = "application/json";
    }
    if (payload !== null) headers["Content-Length"] = Buffer.byteLength(payload);
    if (opts.cookie) headers.Cookie = opts.cookie;
    const req = http.request(
      { host: HOST, port: PORT, path: pathname, method: method, headers: headers, timeout: opts.timeout || 15000 },
      (res) => {
        const chunks = [];
        res.on("data", (d) => chunks.push(d));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          let json = null;
          try {
            json = JSON.parse(text);
          } catch (e) {}
          resolve({ status: res.statusCode, headers: res.headers, text: text, json: json, buf: Buffer.concat(chunks) });
        });
      }
    );
    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.on("error", (err) => resolve({ status: 0, headers: {}, text: "", json: null, error: err }));
    if (payload !== null) req.write(payload);
    req.end();
  });
}
const GET = (p, cookie) => httpReq("GET", p, { cookie });
const POST = (p, b, cookie) => httpReq("POST", p, { body: b === undefined ? {} : b, cookie });

/* ------------------------------------------------------------------ 服务端进程 */
let serverChild = null;
let serverLog = "";

function portInUse(port) {
  return new Promise((resolve) => {
    const s = net.connect({ host: HOST, port: port });
    const done = (v) => {
      try {
        s.destroy();
      } catch (e) {}
      resolve(v);
    };
    s.setTimeout(500);
    s.on("connect", () => done(true));
    s.on("timeout", () => done(false));
    s.on("error", () => done(false));
  });
}

/** 选一个真正空闲的 CDP 端口（避免与其他队友的 Edge 调试端口撞车） */
async function findFreePort(start, tries) {
  for (let p = start; p < start + (tries || 30); p++) {
    if (!(await portInUse(p))) return p;
  }
  throw new Error("找不到空闲 CDP 调试端口（" + start + "~" + (start + (tries || 30)) + "）");
}

/** 只清理本次 QA 专用 profile 的 Edge 进程（绝不触碰其他队友/用户的 Edge） */
function killEdgeByProfileToken(token) {
  return new Promise((resolve) => {
    const script =
      "Get-CimInstance Win32_Process -Filter \"Name='msedge.exe'\" | Where-Object { $_.CommandLine -and $_.CommandLine.Contains('" +
      token +
      "') } | ForEach-Object { & taskkill /PID $($_.ProcessId) /T /F 2>&1 | Out-Null }";
    const ps = spawn("powershell", ["-NoProfile", "-NonInteractive", "-Command", script], {
      stdio: "ignore",
      windowsHide: true
    });
    let done = false;
    const finish = () => {
      if (!done) {
        done = true;
        resolve();
      }
    };
    ps.on("exit", finish);
    ps.on("error", finish);
    setTimeout(finish, 15000);
  });
}

async function startServer() {
  const env = Object.assign({}, process.env);
  delete env.HOST_IP;
  env.PORT = String(PORT);
  env.DATA_DIR = DATA_DIR;
  serverChild = spawn(process.execPath, ["server.js"], { cwd: ROOT, env: env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
  serverChild.stdout.on("data", (d) => (serverLog += d.toString("utf8")));
  serverChild.stderr.on("data", (d) => (serverLog += d.toString("utf8")));
  const t0 = Date.now();
  while (Date.now() - t0 < 20000) {
    if (serverChild.exitCode !== null) throw new Error("服务端提前退出:\n" + serverLog.slice(-3000));
    const r = await GET("/api/health");
    if (r.status === 200) return;
    await sleep(120);
  }
  throw new Error("服务端启动超时:\n" + serverLog.slice(-3000));
}
function stopServer() {
  return new Promise((resolve) => {
    const ch = serverChild;
    serverChild = null;
    if (!ch || ch.exitCode !== null) return resolve();
    let done = false;
    const finish = () => {
      if (!done) {
        done = true;
        resolve();
      }
    };
    ch.once("exit", finish);
    try {
      ch.kill();
    } catch (e) {}
    setTimeout(() => {
      try {
        if (ch.exitCode === null) ch.kill("SIGKILL");
      } catch (e) {}
      finish();
    }, 3000);
  });
}

/* ------------------------------------------------------------------ CDP */
class CDP {
  constructor(wsUrl) {
    this.ws = new WebSocket(wsUrl);
    this.nextId = 0;
    this.pending = new Map();
    this.handlers = []; // {sessionId|null, method, fn}
    this.closed = false;
    this.ready = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("CDP WebSocket 连接超时: " + wsUrl)), 10000);
      this.ws.addEventListener("open", () => {
        clearTimeout(timer);
        resolve();
      });
      this.ws.addEventListener("error", (e) => {
        clearTimeout(timer);
        reject(new Error("CDP WebSocket 连接失败: " + (e && e.message ? e.message : e)));
      });
    });
    this.ws.addEventListener("message", (ev) => this._onMessage(ev));
    this.ws.addEventListener("close", (ev) => {
      this.closed = true;
      this.closeInfo = { code: ev && ev.code, reason: ev && ev.reason, at: new Date().toISOString() };
      for (const p of this.pending.values()) p.reject(new Error("CDP 连接已关闭 (" + JSON.stringify(this.closeInfo) + ")"));
      this.pending.clear();
    });
  }
  _onMessage(ev) {
    let msg;
    try {
      msg = JSON.parse(typeof ev.data === "string" ? ev.data : ev.data.toString());
    } catch (e) {
      return;
    }
    if (msg.id) {
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      if (msg.error) p.reject(new Error("CDP " + p.method + " 失败: " + JSON.stringify(msg.error)));
      else p.resolve(msg.result);
      return;
    }
    if (msg.method) {
      for (const h of this.handlers) {
        if (h.sessionId !== undefined && h.sessionId !== null && msg.sessionId !== h.sessionId) continue;
        if (h.method !== msg.method && h.method !== "*") continue;
        try {
          h.fn(msg.params || {}, msg.sessionId);
        } catch (e) {}
      }
    }
  }
  on(sessionId, method, fn) {
    this.handlers.push({ sessionId: sessionId, method: method, fn: fn });
  }
  send(method, params, sessionId) {
    const id = ++this.nextId;
    const payload = { id: id, method: method, params: params || {} };
    if (sessionId) payload.sessionId = sessionId;
    return new Promise((resolve, reject) => {
      if (this.closed) return reject(new Error("CDP 连接已关闭，无法发送 " + method));
      this.pending.set(id, { resolve: resolve, reject: reject, method: method });
      try {
        this.ws.send(JSON.stringify(payload));
      } catch (e) {
        this.pending.delete(id);
        reject(e);
      }
    });
  }
  close() {
    try {
      this.ws.close();
    } catch (e) {}
  }
}

let edgeChild = null;
let browser = null;

async function waitCdpReady(timeoutMs) {
  const t0 = Date.now();
  while (Date.now() - t0 < (timeoutMs || 20000)) {
    try {
      const r = await fetch("http://127.0.0.1:" + CDP_PORT + "/json/version");
      if (r.ok) {
        const info = await r.json();
        ok(info.webSocketDebuggerUrl, "CDP /json/version 缺少 webSocketDebuggerUrl");
        return info.webSocketDebuggerUrl;
      }
    } catch (e) {}
    await sleep(200);
  }
  throw new Error("Edge CDP 调试端口 " + CDP_PORT + " 未就绪");
}

async function launchEdge() {
  let edgePath = null;
  for (const p of EDGE_PATHS) if (fs.existsSync(p)) edgePath = p;
  ok(edgePath, "未找到 Edge 浏览器（" + EDGE_PATHS.join(" 或 ") + "）");
  const edgeLogPath = path.join(TMP, "edge-stderr.log");
  const edgeLogFd = fs.openSync(edgeLogPath, "a");
  edgeChild = spawn(
    edgePath,
    [
      "--headless=new",
      "--disable-gpu",
      "--hide-scrollbars",
      "--remote-debugging-port=" + CDP_PORT,
      "--remote-allow-origins=*",
      "--user-data-dir=" + EDGE_PROFILE,
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-extensions",
      "--disable-background-networking",
      "--disable-sync",
      "--disable-translate",
      "--mute-audio",
      "--window-size=1920,1080",
      "about:blank"
    ],
    { stdio: ["ignore", "ignore", edgeLogFd], windowsHide: true }
  );
  const wsUrl = await waitCdpReady(25000);
  ok(wsUrl.indexOf(":" + CDP_PORT + "/") >= 0, "CDP 调试地址端口不符（可能连到了别的 Edge 实例）: " + wsUrl);
  browser = new CDP(wsUrl);
  await browser.ready;
  browser.on("__browser__", "Inspector.detached", (p) => {
    console.log(c(COL.red, "      [CDP] 浏览器主动断开: " + JSON.stringify(p).slice(0, 300)));
  });
  browser.ws.addEventListener("close", (ev) => {
    console.log(c(COL.red, "      [CDP] WebSocket 关闭: code=" + (ev && ev.code) + " reason=" + (ev && ev.reason) + " edgeExit=" + (edgeChild ? edgeChild.exitCode : "n/a")));
  });
  return { edgePath: edgePath, wsUrl: wsUrl };
}

async function stopEdge() {
  const ch = edgeChild;
  edgeChild = null;
  if (browser) {
    try {
      await browser.send("Browser.close");
    } catch (e) {}
    try {
      browser.close();
    } catch (e) {}
    browser = null;
  }
  if (ch && ch.exitCode === null) {
    await new Promise((resolve) => {
      let done = false;
      const fin = () => {
        if (!done) {
          done = true;
          resolve();
        }
      };
      ch.once("exit", fin);
      setTimeout(fin, 5000);
    });
    try {
      spawn("taskkill", ["/PID", String(ch.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
    } catch (e) {}
    await sleep(500);
    try {
      if (ch.exitCode === null) ch.kill("SIGKILL");
    } catch (e) {}
  }
  // 兜底：只按本次专用 profile 名精确清理，不触碰其他 Edge 进程
  await killEdgeByProfileToken(path.basename(EDGE_PROFILE));
  await sleep(300);
}

/* ------------------------------------------------------------------ 页面对象 */
async function createPage(name, width, height, mobile) {
  const ctx = await browser.send("Target.createBrowserContext");
  const browserContextId = ctx.browserContextId;
  const target = await browser.send("Target.createTarget", { url: "about:blank", browserContextId: browserContextId });
  const attached = await browser.send("Target.attachToTarget", { targetId: target.targetId, flatten: true });
  const sessionId = attached.sessionId;
  const page = { name, width, height, mobile: !!mobile, sessionId, browserContextId, errors: [], requests: [], external: [] };

  await browser.send("Page.enable", {}, sessionId);
  await browser.send("Runtime.enable", {}, sessionId);
  await browser.send("Log.enable", {}, sessionId);
  await browser.send("Network.enable", {}, sessionId);
  await browser.send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: !!mobile }, sessionId);

  browser.on(sessionId, "Runtime.exceptionThrown", (p) => {
    if (page.suppressNetErrors) return; // 断网模拟窗口内的网络层异常不计为页面 bug
    const d = p.exceptionDetails || {};
    const desc = (d.exception && (d.exception.description || d.exception.value)) || d.text || "";
    page.errors.push({ kind: "exception", text: String(desc).split("\n")[0].slice(0, 400) });
  });
  browser.on(sessionId, "Runtime.consoleAPICalled", (p) => {
    if (p.type !== "error" && p.type !== "warning") return;
    if (page.suppressNetErrors) return;
    const text = (p.args || [])
      .map((a) => (a.value !== undefined ? String(a.value) : a.description || a.type || ""))
      .join(" ")
      .slice(0, 400);
    if (/willReadFrequently/.test(text)) return; // 本脚本 getImageData 采样导致的自伤警告
    page.errors.push({ kind: "console." + p.type, text: text });
  });
  browser.on(sessionId, "Log.entryAdded", (p) => {
    const e = p.entry || {};
    if (e.level !== "error" && e.level !== "warning") return;
    if (String(e.url || "").indexOf("favicon") >= 0) return;
    const text = String(e.text || "").slice(0, 400);
    if (/willReadFrequently/.test(text)) return; // 同上
    // headless 无用户手势导致的环境提示（真机在点击/触摸后即可正常播放音频与震动）
    if (/AudioContext was not allowed to start/.test(text) || /Blocked call to navigator\.vibrate/.test(text)) {
      page.envNotes = (page.envNotes || 0) + 1;
      return;
    }
    // 后台登录页在登录前会探测 /api/admin/data，401 是预期行为
    if (page.name === "admin" && /401 \(Unauthorized\)/.test(text)) {
      page.expectedAuthProbes = (page.expectedAuthProbes || 0) + 1;
      return;
    }
    page.errors.push({ kind: "log." + e.level, text: text });
  });
  browser.on(sessionId, "Network.requestWillBeSent", (p) => {
    const url = p.request && p.request.url;
    if (!url) return;
    page.requests.push(url);
    if (!/^(http:\/\/127\.0\.0\.1:|\/|data:|blob:|about:)/.test(url) && !url.startsWith(BASE)) {
      page.external.push(url);
    }
  });
  browser.on(sessionId, "Network.loadingFailed", (p) => {
    if (page.suppressNetErrors) return;
    page.errors.push({ kind: "network.fail", text: "请求失败: " + (p.errorText || "") + " " + (p.requestId || "") });
  });
  return page;
}

/** 阻塞/恢复 SSE 流（用于验证手机端「SSE 异常 → 4s 强制重连兜底」提示与自愈） */
async function setBlockedStreams(page, blocked) {
  page.suppressNetErrors = !!blocked;
  await browser.send(
    "Network.setBlockedURLs",
    { urls: blocked ? ["*api/stream*"] : [] },
    page.sessionId
  );
}

async function evalJs(page, expression) {
  const r = await browser.send(
    "Runtime.evaluate",
    { expression: expression, returnByValue: true, awaitPromise: true, userGesture: true },
    page.sessionId
  );
  if (r.exceptionDetails) {
    const d = r.exceptionDetails;
    throw new Error("页面脚本执行异常: " + ((d.exception && d.exception.description) || d.text));
  }
  return r.result ? r.result.value : undefined;
}

async function navigate(page, url, settleMs) {
  try {
    await browser.send("Page.navigate", { url: url }, page.sessionId);
  } catch (e) {
    // 某些情况下导航会抛无害错误
  }
  await sleep(settleMs === undefined ? 1500 : settleMs);
}

async function setViewport(page, width, height, mobile) {
  await browser.send(
    "Emulation.setDeviceMetricsOverride",
    { width: width, height: height, deviceScaleFactor: 1, mobile: !!mobile },
    page.sessionId
  );
  page.width = width;
  page.height = height;
  page.mobile = !!mobile;
  await sleep(900);
}

async function screenshot(page, fileName) {
  const r = await browser.send("Page.captureScreenshot", { format: "png", fromSurface: true }, page.sessionId);
  const abs = path.join(SHOT_DIR, fileName);
  fs.writeFileSync(abs, Buffer.from(r.data, "base64"));
  return abs;
}

const METRICS_EXPR = `(() => {
  const de = document.documentElement;
  const b = document.body;
  const canvases = Array.from(document.querySelectorAll("canvas")).map(cv => {
    let lumaRange = null, nonBlackRatio = null;
    try {
      const ctx = cv.getContext("2d");
      if (ctx && cv.width > 0 && cv.height > 0) {
        const w = Math.min(cv.width, 96), h = Math.min(cv.height, 96);
        const data = ctx.getImageData(0, 0, w, h).data;
        let min = 255, max = 0, nonBlack = 0;
        for (let i = 0; i < data.length; i += 4) {
          const l = (data[i] + data[i+1] + data[i+2]) / 3;
          if (l < min) min = l;
          if (l > max) max = l;
          if (l > 12) nonBlack++;
        }
        lumaRange = Math.round(max - min);
        nonBlackRatio = Math.round((nonBlack / (data.length / 4)) * 100) / 100;
      }
    } catch (e) { lumaRange = "err:" + e.message; }
    const r = cv.getBoundingClientRect();
    return { w: cv.width, h: cv.height, cssW: Math.round(r.width), cssH: Math.round(r.height), lumaRange: lumaRange, nonBlackRatio: nonBlackRatio };
  });
  const visibleButtons = Array.from(document.querySelectorAll("button, .btn, [role=button], a.btn"));
  const buttons = visibleButtons.map(x => {
    const r = x.getBoundingClientRect();
    const cs = getComputedStyle(x);
    return { text: (x.innerText || x.textContent || "").trim().slice(0, 24), w: Math.round(r.width), h: Math.round(r.height),
      visible: r.width > 1 && r.height > 1 && cs.display !== "none" && cs.visibility !== "hidden" && Number(cs.opacity) > 0.05 };
  }).filter(x => x.visible);
  const outside = [];
  Array.from(document.querySelectorAll("body *")).forEach(el => {
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return;
    const cs = getComputedStyle(el);
    if (cs.position === "fixed") return;
    if (r.right > innerWidth + 8 || r.left < -8) {
      outside.push({ tag: el.tagName, cls: String(el.className || "").slice(0, 40), left: Math.round(r.left), right: Math.round(r.right) });
    }
  });
  const text = ((b || de) && (b || de).innerText ? (b || de).innerText : "").replace(/\\s+/g, " ").trim();
  return {
    url: location.href,
    title: document.title,
    readyState: document.readyState,
    textLen: text.length,
    textSample: text.slice(0, 260),
    canvases: canvases,
    buttons: buttons.slice(0, 30),
    overflow: {
      scrollW: de.scrollWidth, clientW: de.clientWidth,
      scrollH: de.scrollHeight, clientH: de.clientHeight,
      innerW: innerWidth, innerH: innerHeight,
      overflowX: de.scrollWidth > de.clientWidth + 2,
      overflowY: de.scrollHeight > de.clientHeight + 2
    },
    outside: outside.slice(0, 12),
    bodyBg: getComputedStyle(b || de).backgroundColor,
    bodyColor: getComputedStyle(b || de).color
  };
})()`;

async function metrics(page) {
  return evalJs(page, METRICS_EXPR);
}

/* ------------------------------------------------------------------ 截图记录 */
const shots = [];
async function capture(page, fileName, note, opts) {
  opts = opts || {};
  const m = await metrics(page);
  await screenshot(page, fileName);
  const errors = page.errors.slice();
  const record = {
    file: fileName,
    note: note || "",
    viewport: page.width + "x" + page.height,
    metrics: m,
    errors: errors,
    envNotes: page.envNotes || 0,
    expectedAuthProbes: page.expectedAuthProbes || 0,
    externalRequests: page.external.slice()
  };
  shots.push(record);
  const flags = [];
  if (m.overflow.overflowX) flags.push("横向溢出 +" + (m.overflow.scrollW - m.overflow.clientW) + "px");
  if (m.overflow.overflowY) flags.push("纵向溢出 +" + (m.overflow.scrollH - m.overflow.clientH) + "px");
  if (m.outside.length) flags.push("越界元素 " + m.outside.length + " 个");
  if (errors.length) flags.push("JS/网络错误 " + errors.length + " 条");
  if (page.external.length) flags.push("外链请求 " + page.external.length + " 条");
  if (!opts.allowShortText && m.textLen < 8) flags.push("可见文本过少(" + m.textLen + " 字)");
  const luma = (m.canvases || []).map((cv) => cv.lumaRange);
  console.log(
    "  " + (flags.length ? c(COL.yellow, "•") : c(COL.green, "•")) + " " + fileName +
      c(COL.gray, "  " + page.width + "x" + page.height + "  文本 " + m.textLen + " 字  canvas亮度差 " + fmt(luma))
  );
  if (flags.length) console.log(c(COL.yellow, "      " + flags.join("；")));
  return record;
}

/* ------------------------------------------------------------------ 场景夹具 */
let cookie = null;
let players = [];

async function loginAdmin() {
  const r = await POST("/api/admin/login", { pin: "8888" });
  ok(r.status === 200, "后台登录失败: HTTP " + r.status);
  cookie = String(r.headers["set-cookie"][0]).split(";")[0];
}
async function action(type, extra) {
  const r = await POST("/api/admin/action", Object.assign({ type: type }, extra || {}), cookie);
  ok(r.status === 200, "后台操作 " + type + " 失败: HTTP " + r.status + " " + r.text.slice(0, 200));
  return r.json.data;
}
async function fetchSession() {
  const r = await GET("/api/state");
  ok(r.status === 200 && r.json && r.json.session, "无法读取 session");
  return r.json.session;
}
async function joinPlayers(n) {
  const s = await fetchSession();
  const tag = "shot_" + Date.now().toString(36);
  const tasks = [];
  const cids = [];
  for (let i = 0; i < n; i++) {
    const idx = String(i + 1).padStart(2, "0");
    const cid = tag + "_" + idx;
    cids.push(cid);
    tasks.push(
      POST("/api/join", {
        cid: cid,
        code: s.roomCode,
        name: "玩家" + idx,
        avatar: ["🐲", "🦁", "🐯", "🐰", "🐮", "🐴", "🐷", "🐵", "🐶", "🐱", "🦊", "🐼"][i % 12]
      })
    );
  }
  const rs = await Promise.all(tasks);
  players = rs.map((r, i) => {
    ok(r.status === 200, "玩家 " + (i + 1) + " 加入失败: " + r.text.slice(0, 200));
    return { cid: cids[i], player: r.json.player };
  });
  return players;
}

function winWaves(game) {
  return game.waves.map((w) => ({ cleared: true, hits: w.len, strikes: 0, ms: w.len * w.showMs + (w.len - 1) * w.gapMs + 400 }));
}
function loseWaves(game) {
  const waves = winWaves(game);
  const last = game.waves.length - 1;
  waves[last] = { cleared: false, hits: Math.max(0, game.waves[last].len - 1), strikes: 1, ms: game.waves[last].len * game.waves[last].showMs + (game.waves[last].len - 1) * game.waves[last].gapMs + 400 };
  return waves;
}
async function getGame() {
  const p = players[0];
  const r = await POST("/api/rejoin", { cid: p.cid, pid: p.player.pid, token: p.player.token });
  ok(r.status === 200 && r.json && r.json.game, "rejoin 取 game 失败");
  return r.json.game;
}
async function submit(p, waves) {
  return POST("/api/game/result", { cid: p.cid, pid: p.player.pid, token: p.player.token, waves: waves, score: 1234 });
}
async function waitReveal(timeoutMs) {
  const t0 = Date.now();
  let s = await fetchSession();
  while (s.phase !== "reveal" && Date.now() - t0 < (timeoutMs || 10000)) {
    await sleep(150);
    s = await fetchSession();
  }
  ok(s.phase === "reveal", "等待自动开奖超时，当前 phase=" + s.phase);
  return s;
}

function localStorageExpr(p, code) {
  return `(() => {
    const set = (k, v) => localStorage.setItem("xn_lottery_" + k, v);
    localStorage.removeItem("xn_lottery_game");
    localStorage.removeItem("xn_lottery_pending");
    set("pid", ${JSON.stringify(p.player.pid)});
    set("token", ${JSON.stringify(p.player.token)});
    set("name", ${JSON.stringify(p.player.name)});
    set("avatar", ${JSON.stringify(p.player.avatar)});
    set("code", ${JSON.stringify(code)});
    return localStorage.getItem("xn_lottery_pid");
  })()`;
}

/* ==========================================================================
   主流程
   ========================================================================== */
async function main() {
  console.log(c(COL.cyan, "\n🏮 新春年会抽奖系统 · QA 浏览器验收（Edge headless + CDP）"));
  console.log(c(COL.gray, "   项目目录: " + ROOT));
  console.log(c(COL.gray, "   被测端口: " + PORT + "   截图目录: " + SHOT_DIR));

  if (await portInUse(PORT)) throw new Error("端口 " + PORT + " 已被占用，请先关闭占用进程");

  // 选一个空闲的 CDP 端口 + 本次运行专用 profile（避免与其他同事的 Edge 撞车/互踢）
  CDP_PORT = process.env.QA_CDP_PORT ? Number(process.env.QA_CDP_PORT) : await findFreePort(9411, 40);
  if (await portInUse(CDP_PORT)) throw new Error("CDP 端口 " + CDP_PORT + " 已被占用");
  EDGE_PROFILE = path.join(TMP, "edge-profile-qa-" + CDP_PORT + "-" + Date.now().toString(36));
  console.log(c(COL.gray, "   Edge CDP 端口: " + CDP_PORT + "   profile: " + path.basename(EDGE_PROFILE)));

  fs.rmSync(DATA_DIR, { recursive: true, force: true });
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.rmSync(SHOT_DIR, { recursive: true, force: true });
  fs.mkdirSync(SHOT_DIR, { recursive: true });
  // 清理历史 QA 专用 profile（只删 edge-profile-qa-*，不动其他人的 profile）
  try {
    fs.readdirSync(TMP).forEach((name) => {
      if (name.indexOf("edge-profile-qa-") === 0) {
        try {
          fs.rmSync(path.join(TMP, name), { recursive: true, force: true });
        } catch (e) {}
      }
    });
  } catch (e) {}
  fs.mkdirSync(path.dirname(EDGE_PROFILE), { recursive: true });

  const projectDataExisted = fs.existsSync(path.join(ROOT, "data"));

  try {
    await startServer();
    await sleep(300);
    await loginAdmin();

    /* ---------------------------------------------------------- A. Lobby */
    head("阶段 A：lobby（10 名玩家已入场）");
    const code = (await fetchSession()).roomCode;
    await check("A0 Edge headless 启动并建立 CDP 连接", async () => {
      const info = await launchEdge();
      ok(browser, "CDP 连接未建立");
      ok(!browser.closed, "CDP 连接已关闭");
      console.log(c(COL.gray, "      Edge: " + info.edgePath + "  CDP: " + info.wsUrl));
    });
    await check("A1 10 名玩家并发入场，大屏/后台数据就绪", async () => {
      await joinPlayers(10);
      const s = await fetchSession();
      eq(s.phase, "lobby", "phase 应为 lobby");
      eq(s.players.length, 10, "玩家数应为 10");
    });

    const host = await createPage("host", 1920, 1080, false);
    const playerPage = await createPage("player", 390, 844, true);
    const adminPage = await createPage("admin", 1920, 1080, false);

    await check("A2 大屏 lobby 截图（1920×1080）", async () => {
      await navigate(host, BASE + "/", 3600);
      const rec = await capture(host, "host-lobby-1920.png", "大屏 · 等待玩家入场");
      assertPageHealthy(rec, "大屏 lobby");
      eq(rec.metrics.overflow.overflowX, false, "大屏 lobby 出现横向溢出");
      eq(rec.metrics.overflow.overflowY, false, "大屏 lobby 出现纵向溢出");
      ok(rec.metrics.textLen > 10, "大屏 lobby 可见文本过少（可能未渲染）");
      ok(/房间|加入|扫码|玩家/.test(rec.metrics.textSample), "大屏 lobby 文本未包含房间号/玩家等关键字: " + fmt(rec.metrics.textSample));
    });

    await check("A3 大屏 lobby 1280×720 自适应截图", async () => {
      await setViewport(host, 1280, 720, false);
      const rec = await capture(host, "host-lobby-1280.png", "大屏 · 1280×720 自适应");
      assertPageHealthy(rec, "大屏 1280");
      eq(rec.metrics.overflow.overflowX, false, "1280 宽度下出现横向溢出");
    });

    await check("A4 手机端加入页截图（390×844 与 375×812）", async () => {
      await navigate(playerPage, BASE + "/play", 2400);
      const rec = await capture(playerPage, "player-join-390.png", "手机端 · 加入页（未加入）");
      assertPageHealthy(rec, "手机加入页 390");
      eq(rec.metrics.overflow.overflowX, false, "手机加入页横向溢出");
      ok(/房间|昵称|加入/.test(rec.metrics.textSample), "加入页缺少房间号/昵称/加入关键字: " + fmt(rec.metrics.textSample));
      await setViewport(playerPage, 375, 812, true);
      const rec2 = await capture(playerPage, "player-join-375.png", "手机端 · 加入页 375×812");
      assertPageHealthy(rec2, "手机加入页 375");
      eq(rec2.metrics.overflow.overflowX, false, "375 宽度下加入页横向溢出");
      eq(
        rec2.metrics.overflow.overflowY,
        false,
        "375×812 加入页纵向溢出（§12-10 要求无溢出）：scrollHeight " +
          rec2.metrics.overflow.scrollH + " > clientHeight " + rec2.metrics.overflow.clientH
      );
      await setViewport(playerPage, 390, 844, true);
    });

    await check("A5 后台登录页截图（1920×1080）", async () => {
      await navigate(adminPage, BASE + "/admin", 2400);
      const rec = await capture(adminPage, "admin-login-1920.png", "后台 · PIN 登录页");
      assertPageHealthy(rec, "后台登录页");
      eq(rec.metrics.overflow.overflowX, false, "后台登录页横向溢出");
      ok(/密码|PIN|登录|后台/.test(rec.metrics.textSample), "后台登录页缺少登录关键字: " + fmt(rec.metrics.textSample));
    });

    await check("A6 后台登录后总览截图", async () => {
      const status = await evalJs(
        adminPage,
        `fetch("/api/admin/login", {method:"POST", headers:{"Content-Type":"application/json"}, body: JSON.stringify({pin:"8888"})}).then(r => r.status)`
      );
      eq(status, 200, "页面内登录接口返回非 200");
      await navigate(adminPage, BASE + "/admin", 3000);
      const rec = await capture(adminPage, "admin-lobby-1920.png", "后台 · 登录后总览（lobby）");
      assertPageHealthy(rec, "后台 lobby");
      eq(rec.metrics.overflow.overflowX, false, "后台 lobby 横向溢出");
      ok(/奖品|房间|开始|玩家/.test(rec.metrics.textSample), "后台总览缺少关键模块文本: " + fmt(rec.metrics.textSample));
    });

    /* ---------------------------------------------------------- B. Playing */
    head("阶段 B：playing（开赛倒计时 + 灯阵）");
    let game = null;
    await check("B1 后台开赛成功，game 配置下发", async () => {
      await action("session.start");
      const s = await fetchSession();
      eq(s.phase, "playing", "开赛后 phase");
      game = await getGame();
      ok(Array.isArray(game.waves) && game.waves.length >= 1, "game.waves 异常");
    });

    await check("B2 大屏 playing 截图", async () => {
      await setViewport(host, 1920, 1080, false);
      await navigate(host, BASE + "/", 4300);
      const rec = await capture(host, "host-playing-1920.png", "大屏 · 游戏中（倒计时/进度）");
      assertPageHealthy(rec, "大屏 playing");
      eq(rec.metrics.overflow.overflowX, false, "大屏 playing 横向溢出");
      ok(rec.metrics.textLen > 10, "大屏 playing 文本过少");
    });

    await check("B3 手机端倒计时 + 灯阵 playing 截图", async () => {
      await navigate(playerPage, BASE + "/play", 1400);
      await evalJs(playerPage, localStorageExpr(players[0], code));
      await navigate(playerPage, BASE + "/play", 1300);
      const rec1 = await capture(playerPage, "player-countdown-390.png", "手机端 · 3-2-1 倒计时");
      assertPageHealthy(rec1, "手机倒计时");
      ok(/3|2|1|准备|倒计时|开始/.test(rec1.metrics.textSample), "倒计时页文本异常: " + fmt(rec1.metrics.textSample));
      await sleep(2800);
      const rec2 = await capture(playerPage, "player-playing-390.png", "手机端 · 灯阵游戏中（记忆/复现）");
      assertPageHealthy(rec2, "手机灯阵");
      eq(rec2.metrics.overflow.overflowX, false, "手机灯阵横向溢出");
      ok((rec2.metrics.canvases || []).length > 0 || /灯|波|点|记忆|复现|剩余/.test(rec2.metrics.textSample), "灯阵页未见 canvas/灯阵文本");
    });

    await check("B4 后台 playing 截图", async () => {
      await navigate(adminPage, BASE + "/admin", 2400);
      const rec = await capture(adminPage, "admin-playing-1920.png", "后台 · 游戏中总览");
      assertPageHealthy(rec, "后台 playing");
      eq(rec.metrics.overflow.overflowX, false, "后台 playing 横向溢出");
    });

    /* ---------------------------------------------------------- C. Reveal */
    head("阶段 C：award / reveal（6 中奖 4 失败）");
    await check("C1 提交成绩过程中大屏出奖动画截图", async () => {
      // 先提交 4 名失败者，再逐个提交中奖者，期间抓大屏出奖动画
      for (let i = 6; i < 10; i++) {
        const r = await submit(players[i], loseWaves(game));
        eq(r.status, 200, "失败成绩提交失败: " + r.text.slice(0, 200));
      }
      for (let i = 0; i < 6; i++) {
        const r = await submit(players[i], winWaves(game));
        eq(r.status, 200, "中奖成绩提交失败: " + r.text.slice(0, 200));
        eq(r.json.win, true, "预期中奖但服务端判定失败: " + r.text.slice(0, 300));
        await sleep(420);
        if (i === 2) {
          const rec = await capture(host, "host-award-1920.png", "大屏 · 出奖瞬间（烟花 + 中奖卡片）");
          assertPageHealthy(rec, "大屏 award");
        }
      }
    });

    await check("C2 自动开奖后大屏 reveal 截图", async () => {
      await waitReveal(9000);
      await navigate(host, BASE + "/", 4200);
      const rec = await capture(host, "host-reveal-1920.png", "大屏 · 开奖（中奖名单）");
      assertPageHealthy(rec, "大屏 reveal");
      eq(rec.metrics.overflow.overflowX, false, "大屏 reveal 横向溢出");
      ok(/中奖|恭喜|名单|开奖/.test(rec.metrics.textSample), "大屏 reveal 缺少中奖名单文本: " + fmt(rec.metrics.textSample));
    });

    await check("C3 后台 reveal 截图（中奖名单 + 导出入口）", async () => {
      await navigate(adminPage, BASE + "/admin", 2600);
      const rec = await capture(adminPage, "admin-reveal-1920.png", "后台 · 开奖后中奖名单");
      assertPageHealthy(rec, "后台 reveal");
      eq(rec.metrics.overflow.overflowX, false, "后台 reveal 横向溢出");
      ok(/中奖|导出|名单/.test(rec.metrics.textSample), "后台 reveal 缺少中奖名单/导出文本: " + fmt(rec.metrics.textSample));
    });

    await check("C4 手机端中奖结算页截图", async () => {
      await evalJs(playerPage, localStorageExpr(players[0], code));
      await navigate(playerPage, BASE + "/play", 3000);
      const rec = await capture(playerPage, "player-result-390.png", "手机端 · 中奖结果（奖品卡）");
      assertPageHealthy(rec, "手机中奖结果");
      eq(rec.metrics.overflow.overflowX, false, "中奖结果页横向溢出");
      ok(/中奖|恭喜|领奖|奖品|龙腾|好运/.test(rec.metrics.textSample), "中奖结果页缺少奖品文案: " + fmt(rec.metrics.textSample));
    });

    await check("C5 手机端未中奖结算页截图", async () => {
      await evalJs(playerPage, localStorageExpr(players[9], code));
      await navigate(playerPage, BASE + "/play", 3000);
      const rec = await capture(playerPage, "player-lose-390.png", "手机端 · 未中奖结果");
      assertPageHealthy(rec, "手机未中奖结果");
      eq(rec.metrics.overflow.overflowX, false, "未中奖结果页横向溢出");
      ok(rec.metrics.textLen > 10, "未中奖结果页文本过少");
    });

    await check("C6 后台总览「累计中奖 / 累计中奖率 / 本轮 X 人」口径（admin-panel 修复项）", async () => {
      const readStats = () =>
        evalJs(
          adminPage,
          `(() => ({
            wins: (document.querySelector("#statWins") || {}).textContent,
            rate: (document.querySelector("#statJoinRate") || {}).textContent,
            round: (document.querySelector("#statRoundWins") || {}).textContent
          }))()`
        );
      await sleep(900);
      let st = await readStats();
      eq(String(st.wins).trim(), "6", "开奖后累计中奖应为 6，实际 " + fmt(st));
      eq(String(st.rate).trim(), "累计中奖率 60%", "累计中奖率应为 60%（6/10），实际 " + fmt(st.rate));
      eq(String(st.round).trim(), "本轮 6 人", "本轮中奖人数应为 6，实际 " + fmt(st.round));
      // 清空中奖名单：累计归 0，本轮视角保留（玩家 status 仍为 won）
      await action("winner.clear");
      await sleep(1200);
      st = await readStats();
      eq(String(st.wins).trim(), "0", "清空名单后累计中奖应归 0，实际 " + fmt(st.wins));
      eq(String(st.rate).trim(), "累计中奖率 0%", "清空名单后累计中奖率应为 0%，实际 " + fmt(st.rate));
      eq(String(st.round).trim(), "本轮 6 人", "清空名单不应改变本轮中奖人数，实际 " + fmt(st.round));
    });

    await check("C7 SSE 流被阻塞 → 手机端显示「网络波动，重连中…」；恢复后 4s 兜底自动重连（player-client 修复项）", async () => {
      const banner = () =>
        evalJs(
          playerPage,
          `(() => {
            const b = document.querySelector("#netBanner");
            const t = document.querySelector("#netBannerText");
            return { hidden: b ? b.classList.contains("hidden") : true, text: t ? t.textContent.trim() : "" };
          })()`
        );
      // CDP 无法直接断开已建立的 SSE，这里用「阻塞 stream 请求 + 重新加载页面」复现真实场景：
      // 页面能正常拉 /api/state，但 EventSource 建立失败 → 应显示重连提示，并由 4s 兜底持续重建连接。
      await setBlockedStreams(playerPage, true);
      await navigate(playerPage, BASE + "/play", 4500);
      let b = await banner();
      ok(!b.hidden, "SSE 被阻塞 4.5s 后手机端应显示网络波动横幅（实际仍 hidden）");
      ok(/网络波动|重连/.test(b.text), "断线横幅文案异常: " + fmt(b.text));
      await screenshot(playerPage, "player-offline-390.png");
      await setBlockedStreams(playerPage, false);
      const t0 = Date.now();
      let recovered = false;
      while (Date.now() - t0 < 12000) {
        await sleep(400);
        b = await banner();
        if (b.hidden) {
          recovered = true;
          break;
        }
      }
      ok(recovered, "恢复网络后 12s 内未自动重连（横幅仍在: " + fmt(b) + "）");
      log(c(COL.gray, "      SSE 恢复后自动重连耗时 " + (Date.now() - t0) + "ms（含 4s 强制重建兜底）"));
    });

    await check("C8 主持人 reset 后手机端自动回加入页并回填新房间号（player-client 修复项）", async () => {
      const before = await fetchSession();
      const oldCode = before.roomCode;
      await action("session.reset");
      await sleep(2600);
      const after = await fetchSession();
      ne(after.roomCode, oldCode, "reset 应更换房间号");
      const st = await evalJs(
        playerPage,
        `(() => {
          const j = document.querySelector("#screen-join");
          return {
            joinVisible: !!(j && !j.classList.contains("hidden")),
            pid: localStorage.getItem("xn_lottery_pid"),
            text: (document.body.innerText || "").slice(0, 500),
            hasNewCode: (document.body.innerText || "").indexOf(${JSON.stringify(after.roomCode)}) >= 0
          };
        })()`
      );
      ok(st.joinVisible, "reset 后手机端应回到加入页");
      eq(st.pid, null, "reset 后应清除本地玩家身份（pid）");
      ok(st.hasNewCode, "加入页应回填新房间号 " + after.roomCode + "，实际可见文本: " + fmt(st.text));
      await screenshot(playerPage, "player-reset-390.png");
      // 重置后后台口径应为：累计 0、本轮 0 人
      await sleep(1200);
      const adminSt = await evalJs(
        adminPage,
        `(() => ({
          wins: (document.querySelector("#statWins") || {}).textContent,
          round: (document.querySelector("#statRoundWins") || {}).textContent,
          joined: (document.querySelector("#statPlaying") || {}).textContent
        }))()`
      );
      eq(String(adminSt.wins).trim(), "0", "重置后累计中奖应为 0，实际 " + fmt(adminSt));
      eq(String(adminSt.round).trim(), "本轮 0 人", "重置后本轮中奖应为 0，实际 " + fmt(adminSt));
    });

    /* ---------------------------------------------------------- D. 汇总检查 */
    head("阶段 D：全局检查");
    await check("D1 所有截图页面均无 JS 异常 / console.error", async () => {
      const bad = shots.filter((s) => s.errors.length > 0);
      if (bad.length) {
        throw new Error(
          bad
            .map((s) => s.file + ":\n      " + s.errors.map((e) => "[" + e.kind + "] " + e.text).join("\n      "))
            .join("\n  ")
        );
      }
    });

    await check("D2 所有页面无外链/外网请求（§0 禁止任何外网资源）", async () => {
      const bad = shots.filter((s) => s.externalRequests.length > 0);
      if (bad.length) {
        throw new Error(bad.map((s) => s.file + ": " + s.externalRequests.join(", ")).join("\n  "));
      }
    });

    await check("D3 所有截图为非黑屏（文本/画布亮度有内容）", async () => {
      const bad = [];
      shots.forEach((s) => {
        const m = s.metrics;
        const luma = (m.canvases || []).map((cv) => cv.lumaRange).filter((x) => typeof x === "number");
        const bestLuma = luma.length ? Math.max.apply(null, luma) : 0;
        if (m.textLen < 8 && bestLuma < 12) bad.push(s.file + "（文本 " + m.textLen + " 字，画布亮度差 " + bestLuma + "）");
      });
      if (bad.length) throw new Error("疑似黑屏/未渲染：\n  " + bad.join("\n  "));
    });

    await check("D4 所有截图无横向溢出（§12-10）", async () => {
      const bad = shots.filter((s) => s.metrics.overflow.overflowX);
      if (bad.length) {
        throw new Error(
          bad.map((s) => s.file + " 内容宽 " + s.metrics.overflow.scrollW + " > 视口 " + s.metrics.overflow.clientW).join("\n  ")
        );
      }
    });

    await check("D5 移动端可见按钮触控热区（高度 ≥ 40px）", async () => {
      const mobileShots = shots.filter((s) => s.viewport.indexOf("390") === 0 || s.viewport.indexOf("375") === 0);
      const bad = [];
      mobileShots.forEach((s) => {
        s.metrics.buttons.forEach((b) => {
          if (b.text && (b.h < 40 || b.w < 40)) bad.push(s.file + " 按钮「" + b.text + "」 " + b.w + "x" + b.h);
        });
      });
      if (bad.length) throw new Error("移动端触控热区不足 44px（允许 40px 容差）：\n  " + bad.join("\n  "));
    });

    await check("D6 页面服务端渲染无 4xx/5xx 静态资源缺失", async () => {
      const missing = [];
      for (const p of ["/", "/play", "/admin"]) {
        const r = await GET(p);
        eq(r.status, 200, "页面 " + p + " 返回 " + r.status);
        const re = /(?:src|href)="([^"]+)"/g;
        let m;
        while ((m = re.exec(r.text))) {
          const u = m[1];
          if (!u || u[0] === "#" || u.indexOf("data:") === 0 || u.indexOf("/api/") === 0 || /^https?:/.test(u)) continue;
          const rr = await GET(u);
          if (rr.status !== 200) missing.push(p + " → " + u + " (HTTP " + rr.status + ")");
        }
      }
      if (missing.length) throw new Error("页面引用资源缺失（交付前必须齐全）：\n  " + missing.join("\n  "));
    });

    await check("D7 测试数据隔离与日志健康", async () => {
      eq(fs.existsSync(path.join(ROOT, "data")), projectDataExisted, "测试过程创建/删除了项目 data/ 目录");
      const bad = ["未处理异常", "uncaughtException", "unhandledRejection"].filter((k) => serverLog.indexOf(k) >= 0);
      if (bad.length) throw new Error("服务端日志出现异常: " + fmt(bad) + "\n" + serverLog.slice(-2000));
    });
  } finally {
    await stopEdge();
    await stopServer();
    if (!KEEP) {
      try {
        fs.rmSync(DATA_DIR, { recursive: true, force: true });
      } catch (e) {}
      try {
        fs.rmSync(EDGE_PROFILE, { recursive: true, force: true });
      } catch (e) {}
    }
    try {
      fs.mkdirSync(TMP, { recursive: true });
      fs.writeFileSync(
        path.join(TMP, "browser-result.json"),
        JSON.stringify({ at: new Date().toISOString(), shots: shots, checks: checks }, null, 2),
        "utf8"
      );
    } catch (e) {}
  }

  console.log("\n" + "═".repeat(70));
  console.log("  浏览器验收结果: " + c(COL.green, pass + " 通过") + " / " + (fail ? c(COL.red, fail + " 失败") : "0 失败") + "  截图 " + shots.length + " 张");
  if (fail) {
    checks
      .filter((x) => !x.ok)
      .forEach((x, i) => console.log("   " + (i + 1) + ". " + x.name + "\n      " + String(x.error).split("\n").join("\n      ")));
  }
  console.log("  截图目录: " + SHOT_DIR);
  console.log("  结果明细: " + path.join(TMP, "browser-result.json"));
  console.log("═".repeat(70) + "\n");
  process.exitCode = fail ? 1 : 0;
}

function assertPageHealthy(rec, label) {
  const errs = rec.errors || [];
  if (errs.length) {
    throw new Error(label + " 存在 JS/网络错误:\n  " + errs.map((e) => "[" + e.kind + "] " + e.text).join("\n  "));
  }
  ok(rec.metrics.readyState === "complete", label + " readyState 应为 complete，实际 " + rec.metrics.readyState);
  ok((rec.metrics.canvases || []).length > 0 || rec.metrics.textLen > 10, label + " 既无 canvas 也无文本（疑似白屏）");
  if (rec.metrics.outside.length) {
    console.log(c(COL.gray, "      （提示）" + label + " 有 " + rec.metrics.outside.length + " 个元素横向越界: " + fmt(rec.metrics.outside.slice(0, 3))));
  }
}

process.on("exit", () => {
  try {
    if (serverChild) serverChild.kill();
  } catch (e) {}
  try {
    if (edgeChild) spawn("taskkill", ["/PID", String(edgeChild.pid), "/T", "/F"], { stdio: "ignore" });
  } catch (e) {}
});

main().catch(async (err) => {
  console.error("\n" + c(COL.red, "✗ 浏览器验收未完成：") + (err && err.stack ? err.stack : err));
  try {
    await stopEdge();
  } catch (e) {}
  try {
    await stopServer();
  } catch (e) {}
  process.exit(1);
});
