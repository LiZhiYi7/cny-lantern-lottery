#!/usr/bin/env node
"use strict";

/* ==========================================================================
   新春年会抽奖系统 · QA 冒烟测试（零第三方依赖）

   用法：
     node tools/smoke-test.js                 # 默认 8790 端口，独立数据目录
     QA_PORT=8790 node tools/smoke-test.js    # 自定义端口

   行为：
   - 自己 fork 起 server.js（PORT=8790、DATA_DIR=_tmp/qa/data），等待 /api/health 就绪；
   - 覆盖 PROTOCOL.md §4 / §5 / §6 / §12 的验收项；
   - 测试结束 kill 子进程并清理 _tmp/qa/data（QA_KEEP=1 可保留现场）；
   - 不依赖任何已运行服务，不读写项目正式 data/，不影响 8080/8711/8712/8713。

   退出码：0 = 全部通过；1 = 存在断言失败。
   ========================================================================== */

const http = require("http");
const net = require("net");
const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");

const ROOT = path.resolve(__dirname, "..");
// 以 lib/difficulty.js 为唯一数据源生成期望值，参数调整后测试自动跟随
const difficulty = require(path.join(ROOT, "lib", "difficulty"));
const PORT = Number(process.env.QA_PORT || 8790);
const HOST = "127.0.0.1";
const BASE = "http://" + HOST + ":" + PORT;
const TMP = path.join(ROOT, "_tmp", "qa");
const DATA_DIR = path.join(TMP, "data");
const KEEP = process.env.QA_KEEP === "1";

const AVATARS = ["🐲", "🦁", "🐯", "🐰", "🐮", "🐴", "🐷", "🐵", "🐶", "🐱", "🦊", "🐼", "🐔"];

/* ------------------------------------------------------------------ 结果记录 */
const results = [];
const warnings = [];
const stats = { pass: 0, fail: 0 };

const C = {
  reset: "\x1b[0m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  cyan: "\x1b[36m",
  gray: "\x1b[90m"
};
const useColor = process.stdout.isTTY;
function c(code, s) {
  return useColor ? code + s + C.reset : s;
}

function section(title) {
  console.log("\n" + c(C.cyan, "── " + title + " " + "─".repeat(Math.max(0, 62 - title.length))));
}

async function t(name, fn) {
  const t0 = Date.now();
  try {
    await fn();
    stats.pass++;
    results.push({ name, ok: true, ms: Date.now() - t0 });
    console.log("  " + c(C.green, "✓") + " " + name + c(C.gray, " (" + (Date.now() - t0) + "ms)"));
  } catch (err) {
    stats.fail++;
    const msg = err && err.stack ? String(err.message || err) : String(err);
    results.push({ name, ok: false, ms: Date.now() - t0, error: msg });
    console.log("  " + c(C.red, "✗") + " " + name);
    console.log(c(C.red, "      " + msg.split("\n").join("\n      ")));
  }
}

function warn(msg) {
  warnings.push(msg);
  console.log("  " + c(C.yellow, "⚠") + " " + c(C.yellow, msg));
}

/* ------------------------------------------------------------------ 断言 */
function ok(cond, msg) {
  if (!cond) throw new Error(msg);
}
function eq(actual, expected, msg) {
  if (actual !== expected) {
    throw new Error(msg + "\n  期望: " + fmt(expected) + "\n  实际: " + fmt(actual));
  }
}
function ne(actual, unexpected, msg) {
  if (actual === unexpected) throw new Error(msg + "\n  不应等于: " + fmt(unexpected));
}
function near(actual, expected, tol, msg) {
  if (typeof actual !== "number" || Math.abs(actual - expected) > tol) {
    throw new Error(msg + "\n  期望: " + expected + " ± " + tol + "\n  实际: " + fmt(actual));
  }
}
function fmt(v) {
  if (typeof v === "string") return JSON.stringify(v.length > 300 ? v.slice(0, 300) + "…" : v);
  try {
    const s = JSON.stringify(v);
    return s && s.length > 500 ? s.slice(0, 500) + "…" : String(s);
  } catch (e) {
    return String(v);
  }
}
function show(res) {
  if (!res) return "(无响应)";
  let body = res.text || "";
  if (body.length > 900) body = body.slice(0, 900) + " …(截断)";
  return "HTTP " + res.status + " " + (res.headers && res.headers["content-type"] ? res.headers["content-type"] : "") +
    "\n  " + body.replace(/\n/g, "\n  ");
}
function expectStatus(res, status, extra) {
  if (res.status !== status) {
    throw new Error((extra ? extra + " " : "") + "期望 HTTP " + status + "\n  实际: " + show(res));
  }
}
function expectCode(res, code, extra) {
  ok(res.json && res.json.ok === false, (extra ? extra + " " : "") + "期望 ok:false 的失败响应\n  实际: " + show(res));
  if (res.json.code !== code) {
    throw new Error((extra ? extra + " " : "") + "期望错误码 " + code + "\n  实际: " + show(res));
  }
}

/* ------------------------------------------------------------------ HTTP 工具 */
function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function httpReq(method, pathname, opts) {
  opts = opts || {};
  return new Promise((resolve) => {
    const headers = Object.assign({}, opts.headers || {});
    let payload = null;
    if (opts.raw !== undefined) {
      payload = opts.raw;
      headers["Content-Type"] = headers["Content-Type"] || "application/json";
    } else if (opts.body !== undefined) {
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
          const buf = Buffer.concat(chunks);
          const text = buf.toString("utf8");
          let json = null;
          try {
            json = JSON.parse(text);
          } catch (e) {}
          resolve({ status: res.statusCode, headers: res.headers, buf: buf, text: text, json: json, error: null });
        });
        res.on("error", (err) => resolve({ status: 0, headers: {}, buf: Buffer.alloc(0), text: "", json: null, error: err }));
      }
    );
    req.on("timeout", () => req.destroy(new Error("请求超时")));
    req.on("error", (err) => resolve({ status: 0, headers: {}, buf: Buffer.alloc(0), text: "", json: null, error: err }));
    if (payload !== null) req.write(payload);
    req.end();
  });
}

function GET(pathname, cookie) {
  return httpReq("GET", pathname, { cookie: cookie });
}
function POST(pathname, body, cookie) {
  return httpReq("POST", pathname, { body: body === undefined ? {} : body, cookie: cookie });
}
function POST_RAW(pathname, raw, cookie) {
  return httpReq("POST", pathname, { raw: raw, cookie: cookie });
}

/* ------------------------------------------------------------------ SSE 客户端 */
function openSSE(pathname, cookie) {
  const st = {
    path: pathname,
    events: [],
    cursor: 0,
    ended: false,
    waiters: [],
    req: null,
    res: null
  };
  const headers = { Accept: "text/event-stream" };
  if (cookie) headers.Cookie = cookie;
  const req = http.request({ host: HOST, port: PORT, path: pathname, method: "GET", headers: headers });
  st.req = req;

  function pump() {
    for (let i = st.waiters.length - 1; i >= 0; i--) {
      const w = st.waiters[i];
      let idx = -1;
      for (let k = st.cursor; k < st.events.length; k++) {
        try {
          if (w.pred(st.events[k])) {
            idx = k;
            break;
          }
        } catch (e) {}
      }
      if (idx >= 0) {
        st.cursor = idx + 1;
        clearTimeout(w.timer);
        st.waiters.splice(i, 1);
        w.resolve(st.events[idx]);
      }
    }
    if (st.ended && st.waiters.length) {
      const list = st.waiters.splice(0);
      list.forEach((w) => {
        clearTimeout(w.timer);
        w.reject(
          new Error(
            "SSE 连接已结束但未收到期望事件: " + pathname + "\n  已收到事件: " + st.events.map((e) => e.t).join(", ")
          )
        );
      });
    }
  }

  req.on("response", (res) => {
    st.res = res;
    res.setEncoding("utf8");
    let buf = "";
    res.on("data", (chunk) => {
      buf += chunk;
      let idx;
      while ((idx = buf.indexOf("\n\n")) >= 0) {
        const frame = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        frame.split("\n").forEach((line) => {
          if (line.indexOf("data:") !== 0) return;
          const payload = line.slice(5).trim();
          if (!payload) return;
          try {
            st.events.push(JSON.parse(payload));
          } catch (e) {}
        });
      }
      pump();
    });
    res.on("end", () => {
      st.ended = true;
      pump();
    });
    res.on("close", () => {
      st.ended = true;
      pump();
    });
  });
  req.on("error", () => {
    st.ended = true;
    pump();
  });
  req.end();

  st.next = function (pred, timeoutMs, label) {
    return new Promise((resolve, reject) => {
      const w = { pred: pred, resolve: resolve, reject: reject };
      w.timer = setTimeout(() => {
        const i = st.waiters.indexOf(w);
        if (i >= 0) st.waiters.splice(i, 1);
        reject(
          new Error(
            "等待 SSE 事件超时 " + (timeoutMs || 5000) + "ms " + (label || "") +
              "\n  已收到事件: " + (st.events.map((e) => e.t).join(", ") || "(无)")
          )
        );
      }, timeoutMs || 5000);
      st.waiters.push(w);
      pump();
    });
  };
  st.close = function () {
    try {
      if (st.res) st.res.destroy();
    } catch (e) {}
    try {
      req.destroy();
    } catch (e) {}
    st.ended = true;
  };
  return st;
}

/* ------------------------------------------------------------------ 服务生命周期 */
let child = null;
let serverLog = "";

function childEnv() {
  const env = Object.assign({}, process.env);
  delete env.HOST_IP; // 强制走真实局域网探测
  env.PORT = String(PORT);
  env.DATA_DIR = DATA_DIR;
  return env;
}

function portInUse(port) {
  return new Promise((resolve) => {
    const sock = net.connect({ host: HOST, port: port });
    const done = (v) => {
      try {
        sock.destroy();
      } catch (e) {}
      resolve(v);
    };
    sock.setTimeout(800);
    sock.on("connect", () => done(true));
    sock.on("timeout", () => done(false));
    sock.on("error", () => done(false));
  });
}

async function waitReady(timeoutMs) {
  const t0 = Date.now();
  while (Date.now() - t0 < (timeoutMs || 20000)) {
    if (child && child.exitCode !== null) {
      throw new Error("被测服务进程提前退出（exitCode=" + child.exitCode + "），日志：\n" + serverLog.slice(-4000));
    }
    const r = await httpReq("GET", "/api/health", { timeout: 2000 });
    if (r.status === 200 && r.json && r.json.ok) return r.json;
    await sleep(120);
  }
  throw new Error("被测服务启动超时（" + (timeoutMs || 20000) + "ms），日志：\n" + serverLog.slice(-4000));
}

async function startServer() {
  child = spawn(process.execPath, ["server.js"], {
    cwd: ROOT,
    env: childEnv(),
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true
  });
  child.stdout.on("data", (d) => {
    serverLog += d.toString("utf8");
  });
  child.stderr.on("data", (d) => {
    serverLog += d.toString("utf8");
  });
  child.on("error", (err) => {
    serverLog += "[spawn error] " + err.message + "\n";
  });
  return waitReady(25000);
}

function stopServer() {
  return new Promise((resolve) => {
    const c = child;
    child = null;
    if (!c || c.exitCode !== null) return resolve();
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      resolve();
    };
    c.once("exit", finish);
    try {
      c.kill();
    } catch (e) {}
    setTimeout(() => {
      try {
        if (c.exitCode === null) c.kill("SIGKILL");
      } catch (e) {}
      finish();
    }, 3000);
  });
}

/* ------------------------------------------------------------------ 业务封装 */
let cookie = null;
let cidSeq = 0;

function newCid(tag) {
  cidSeq += 1;
  return "qa_" + (tag || "c") + "_" + cidSeq + "_" + Math.random().toString(36).slice(2, 8);
}

async function fetchSession() {
  const r = await GET("/api/state");
  expectStatus(r, 200, "GET /api/state");
  ok(r.json && r.json.session, "GET /api/state 缺少 session 字段");
  return r.json.session;
}

async function adminData() {
  const r = await GET("/api/admin/data", cookie);
  expectStatus(r, 200, "GET /api/admin/data");
  return r.json;
}

async function adminAction(type, extra) {
  const body = Object.assign({ type: type }, extra || {});
  return POST("/api/admin/action", body, cookie);
}

async function mustAdmin(type, extra) {
  const r = await adminAction(type, extra);
  expectStatus(r, 200, "后台操作 " + type);
  return r.json;
}

async function setConfig(patch) {
  return mustAdmin("config.set", patch);
}

async function login(pin) {
  return POST("/api/admin/login", { pin: pin });
}

async function loginOk() {
  const r = await login("8888");
  expectStatus(r, 200, "后台登录");
  const sc = r.headers["set-cookie"];
  ok(sc && sc[0], "登录成功但未下发 Set-Cookie");
  cookie = String(sc[0]).split(";")[0];
  return r;
}

async function joinOne(name, opts) {
  opts = opts || {};
  const cid = opts.cid || newCid("p");
  const code = opts.code || (await fetchSession()).roomCode;
  const r = await POST("/api/join", { cid: cid, code: code, name: name, avatar: opts.avatar });
  return { cid: cid, res: r, player: r.json && r.json.player };
}

/** reset 清场（换房间号），可选改难度；用 admin 身份 */
async function resetRound(opts) {
  opts = opts || {};
  const r = await adminAction("session.reset");
  expectStatus(r, 200, "session.reset");
  if (opts.difficulty) await setConfig({ difficulty: opts.difficulty });
  const session = await fetchSession();
  return session;
}

/** 建立一局：reset → join 玩家 → start，返回 { code, session, players:[{cid,player}], game } */
async function freshRound(opts) {
  opts = opts || {};
  const count = opts.count === undefined ? 1 : opts.count;
  await resetRound({ difficulty: opts.difficulty || "easy" });
  const players = [];
  for (let i = 0; i < count; i++) {
    const name = (opts.names && opts.names[i]) || "测试玩家" + (i + 1);
    const j = await joinOne(name, { avatar: AVATARS[i % AVATARS.length] });
    expectStatus(j.res, 200, "加入玩家 " + name);
    players.push(j);
  }
  const s = await mustAdmin("session.start");
  const session = s.data.session;
  ok(session.phase === "playing", "开赛后 phase 应为 playing，实际 " + fmt(session.phase));
  const game = await fetchGame(players[0]);
  return { code: session.roomCode, session: session, players: players, game: game };
}

async function fetchGame(p) {
  const r = await POST("/api/rejoin", { cid: p.cid, pid: p.player.pid, token: p.player.token });
  expectStatus(r, 200, "rejoin 取 game");
  ok(r.json.game, "rejoin 未返回 game 配置");
  return r.json.game;
}

function winWaves(game) {
  return game.waves.map((w) => ({
    cleared: true,
    hits: w.len,
    strikes: 0,
    ms: w.len * w.showMs + (w.len - 1) * w.gapMs + 400
  }));
}

function failWave(game, index) {
  const w = game.waves[index];
  return {
    cleared: false,
    hits: Math.max(0, w.len - 1),
    strikes: 1,
    ms: w.len * w.showMs + (w.len - 1) * w.gapMs + 400
  };
}

function submitResult(p, waves, extra) {
  return POST("/api/game/result", Object.assign({
    cid: p.cid,
    pid: p.player.pid,
    token: p.player.token,
    waves: waves,
    score: 1234
  }, extra || {}));
}

async function prizeState() {
  const d = await adminData();
  const byId = {};
  d.prizes.forEach((p) => {
    byId[p.id] = p;
  });
  const totalAwarded = d.prizes.reduce((s, p) => s + p.awarded, 0);
  return { prizes: d.prizes, byId: byId, totalAwarded: totalAwarded, winners: d.winners };
}

/* ==========================================================================
   主流程
   ========================================================================== */

async function main() {
  console.log(c(C.cyan, "\n🏮 新春年会抽奖系统 · QA 冒烟测试"));
  console.log(c(C.gray, "   项目目录: " + ROOT));
  console.log(c(C.gray, "   被测端口: " + PORT + "   数据目录: " + DATA_DIR));

  const projectDataDir = path.join(ROOT, "data");
  const projectDataExisted = fs.existsSync(projectDataDir);
  ok(path.resolve(DATA_DIR).startsWith(path.join(ROOT, "_tmp")), "DATA_DIR 必须位于 _tmp 下，避免污染正式 data/");

  /* 干净启动 */
  if (await portInUse(PORT)) {
    throw new Error("端口 " + PORT + " 已被占用。请先关闭占用进程（本脚本会自己起服务，不要复用已运行服务）。");
  }
  fs.rmSync(DATA_DIR, { recursive: true, force: true });
  fs.mkdirSync(DATA_DIR, { recursive: true });

  let health = null;
  try {
    health = await startServer();
    await sleep(200); // 等启动横幅打印

    /* ---------------------------------------------------------------- A 启动 */
    section("A. 启动与基础健康（§12-1）");

    await t("A1 启动横幅打印大屏/手机端/后台地址与房间号", async () => {
      ok(serverLog.indexOf("新春年会抽奖系统 已启动") >= 0, "启动横幅缺失，实际日志：\n" + serverLog.slice(0, 2000));
      ["大屏", "手机端", "后台管理", "房间号", "后台密码"].forEach((kw) => {
        ok(serverLog.indexOf(kw) >= 0, "启动横幅缺少「" + kw + "」，实际日志：\n" + serverLog.slice(0, 2000));
      });
      const m = serverLog.match(/房间号\s*[:：]\s*(\d{6})/);
      ok(m, "启动横幅未打印 6 位房间号，实际日志：\n" + serverLog.slice(0, 2000));
      const session = await fetchSession();
      eq(m[1], session.roomCode, "启动横幅房间号与 session.roomCode 不一致");
    });

    await t("A2 /api/health 返回 ok/phase/players/uptime 且端口为 " + PORT, async () => {
      const r = await GET("/api/health");
      expectStatus(r, 200, "GET /api/health");
      eq(r.json.ok, true, "health.ok 应为 true");
      eq(r.json.phase, "lobby", "health.phase 初始应为 lobby");
      eq(r.json.players, 0, "health.players 初始应为 0");
      ok(typeof r.json.uptime === "number", "health.uptime 应为数字，实际 " + fmt(r.json.uptime));
      eq(String(health.phase), "lobby", "就绪探测返回的 phase");
    });

    await t("A3 session 快照基础字段完整（§3.5）", async () => {
      const s = await fetchSession();
      eq(s.phase, "lobby", "初始 phase");
      ok(/^\d{6}$/.test(s.roomCode), "roomCode 必须是 6 位数字，实际 " + fmt(s.roomCode));
      ok(s.roomCode[0] !== "0", "roomCode 首位不应为 0，实际 " + fmt(s.roomCode));
      ok(/:\d+\/play$/.test(s.joinUrl), "joinUrl 应指向 /play，实际 " + fmt(s.joinUrl));
      ok(/:\d+\/$/.test(s.hostUrl), "hostUrl 应指向 /，实际 " + fmt(s.hostUrl));
      ok(s.joinUrl.indexOf(":" + PORT) >= 0, "joinUrl 端口应为 " + PORT + "，实际 " + fmt(s.joinUrl));
      ok(typeof s.serverTime === "number" && Math.abs(s.serverTime - Date.now()) < 5000, "serverTime 异常: " + fmt(s.serverTime));
      eq(s.sessionId, "", "lobby 阶段 sessionId 应为空");
      eq(s.startAt, null, "lobby 阶段 startAt 应为 null");
      eq(s.revealAt, null, "lobby 阶段 revealAt 应为 null");
      ["maxPlayers", "difficulty", "awardRule", "title", "subtitle"].forEach((k) => {
        ok(k in s.config, "session.config 缺少 " + k);
      });
      eq(s.config.maxPlayers, 30, "默认 maxPlayers");
      eq(s.config.difficulty, "easy", "默认 difficulty");
      eq(s.config.awardRule, "lowFirst", "默认 awardRule");
      eq(s.config.title, "龙腾新春 · 年会抽奖", "默认 title");
      ok(!("pin" in s.config), "session.config 不应下发 pin");
      ok(Array.isArray(s.prizes) && s.prizes.length === 5, "默认应有 5 个示例奖品，实际 " + (s.prizes && s.prizes.length));
      ok(Array.isArray(s.players) && s.players.length === 0, "初始 players 应为空");
      ok(Array.isArray(s.winners) && s.winners.length === 0, "初始 winners 应为空");
      eq(s.stats.joined, 0, "stats.joined");
      eq(s.stats.totalPrizes, 38, "默认奖品总量（1+2+5+10+20）");
    });

    await t("A4 session.difficulty 下发 5 档之一的完整信息（§2/§5）", async () => {
      const s = await fetchSession();
      const d = s.difficulty;
      ["key", "label", "desc", "color", "estimatedPass", "guaranteed", "waves", "maxStrikes"].forEach((k) => {
        ok(k in d, "session.difficulty 缺少字段 " + k + "，实际 " + fmt(d));
      });
      eq(d.key, "easy", "默认难度 key");
      eq(d.label, "简单", "默认难度 label");
      ok(d.desc && d.desc.length > 4, "难度 desc 应非空");
      ok(/^#/.test(d.color), "难度 color 应为色值，实际 " + fmt(d.color));
      ok(d.estimatedPass && d.estimatedPass.length > 0, "estimatedPass 应下发");
      eq(d.guaranteed, false, "easy 不是保底档");
      ok(Array.isArray(d.waves) && d.waves.length === 2, "easy 应有 2 波，实际 " + (d.waves && d.waves.length));
      d.waves.forEach((w, i) => {
        ["len", "showMs", "gapMs", "inputMs"].forEach((k) => ok(typeof w[k] === "number", "waves[" + i + "] 缺少 " + k));
        ok(w.len >= 2 && w.inputMs >= 1000, "waves[" + i + "] 数值异常: " + fmt(w));
      });
      eq(d.maxStrikes, difficulty.publicInfo("easy").maxStrikes, "简单档 maxStrikes 应与 lib/difficulty.js 一致");
      eq(d.waveCount, difficulty.publicInfo("easy").waveCount, "简单档 waveCount 应与配置一致");
    });

    /* ---------------------------------------------------------------- B 加入 */
    section("B. 房间码与加入校验（§1/§4.1/§12-2/§12-7）");

    await t("B1 错误房间号 → 400 BAD_CODE", async () => {
      const s = await fetchSession();
      const wrong = String((Number(s.roomCode) + 1) % 1000000).padStart(6, "0");
      const j = await joinOne("错误房间", { code: wrong });
      expectStatus(j.res, 400, "错误房间号加入");
      expectCode(j.res, "BAD_CODE", "错误房间号加入");
      ok(j.res.json.error && j.res.json.error.indexOf("房间号") >= 0, "错误提示应提到房间号，实际 " + fmt(j.res.json && j.res.json.error));
    });

    await t("B2 空昵称 / 全空格昵称 → 400 BAD_NAME", async () => {
      const s = await fetchSession();
      const r1 = await POST("/api/join", { cid: newCid("e"), code: s.roomCode, name: "" });
      expectStatus(r1, 400, "空昵称加入");
      expectCode(r1, "BAD_NAME", "空昵称加入");
      const r2 = await POST("/api/join", { cid: newCid("e"), code: s.roomCode, name: "   " });
      expectStatus(r2, 400, "全空格昵称加入");
      expectCode(r2, "BAD_NAME", "全空格昵称加入");
    });

    await t("B3 超长昵称（13 字 / 200 字）→ 400 BAD_NAME", async () => {
      const s = await fetchSession();
      const r1 = await POST("/api/join", { cid: newCid("l"), code: s.roomCode, name: "一二三四五六七八九十一二三" });
      expectStatus(r1, 400, "13 字昵称加入");
      expectCode(r1, "BAD_NAME", "13 字昵称加入");
      const r2 = await POST("/api/join", { cid: newCid("l"), code: s.roomCode, name: "超".repeat(200) });
      expectStatus(r2, 400, "200 字昵称加入");
      expectCode(r2, "BAD_NAME", "200 字昵称加入");
    });

    let playerA = null;
    await t("B4 正常加入：返回 pid/token，session 同步且不泄露 token", async () => {
      const s0 = await fetchSession();
      const j = await joinOne("张三", { avatar: "🐲" });
      playerA = j;
      expectStatus(j.res, 200, "正常加入");
      eq(j.res.json.ok, true, "join.ok");
      const p = j.res.json.player;
      ok(p && /^pl_[0-9a-f]+$/.test(p.pid), "pid 格式应为 pl_xxx，实际 " + fmt(p && p.pid));
      ok(p.token && p.token.length >= 16, "应返回 token，实际 " + fmt(p && p.token));
      eq(p.name, "张三", "昵称回显");
      eq(p.avatar, "🐲", "头像回显");
      eq(p.status, "joined", "新玩家 status 应为 joined");
      eq(p.wave, 0, "新玩家 wave");
      eq(p.score, 0, "新玩家 score");
      eq(p.result, null, "新玩家 result");
      eq(p.prize, null, "新玩家 prize");
      const s = await fetchSession();
      eq(s.players.length, 1, "session.players 应包含新玩家");
      eq(s.players[0].pid, p.pid, "session.players[0].pid");
      ok(!("token" in s.players[0]), "session.players 不应下发 token");
      eq(s.stats.joined, 1, "stats.joined");
      eq(s.stats.totalPrizes - s.stats.awardedPrizes, 38, "库存应与已发数一致");
      eq(s0.players.length, 0, "加入前玩家数应为 0");
      ok(JSON.stringify(j.res.json.session).indexOf(p.token) < 0, "join 返回的 session 中不应出现 token");
    });

    await t("B5 同 cid 重复加入 → 幂等返回同一玩家，不重复占位", async () => {
      const before = await fetchSession();
      const r = await POST("/api/join", { cid: playerA.cid, code: before.roomCode, name: "张三改名" });
      expectStatus(r, 200, "同 cid 重复加入");
      eq(r.json.player.pid, playerA.player.pid, "同 cid 应返回同一 pid");
      const after = await fetchSession();
      eq(after.players.length, before.players.length, "重复加入不应新增玩家");
      eq(after.players[0].name, "张三", "幂等返回时不应改昵称");
    });

    await t("B6 昵称边界 12 字可加入；前后空白被 trim", async () => {
      const j = await joinOne("  一二三四五六七八九十一二  ");
      expectStatus(j.res, 200, "12 字昵称加入");
      eq(j.res.json.player.name, "一二三四五六七八九十一二", "昵称应 trim 后保存");
      eq(Array.from(j.res.json.player.name).length, 12, "昵称应为 12 字");
    });

    await t("B7 非法头像回退为合法 emoji（不报错）", async () => {
      const j = await joinOne("头像测试", { avatar: "💩" });
      expectStatus(j.res, 200, "非法头像加入");
      ok(j.res.json.player.avatar !== "💩", "非法头像应被回退，实际 " + fmt(j.res.json.player.avatar));
      ok(AVATARS.indexOf(j.res.json.player.avatar) >= 0, "回退头像应为合法 emoji，实际 " + fmt(j.res.json.player.avatar));
    });

    await t("B8 GET /api/state?cid= 返回 you（当前 cid 绑定玩家）", async () => {
      const r = await GET("/api/state?cid=" + encodeURIComponent(playerA.cid));
      expectStatus(r, 200, "GET /api/state?cid");
      ok(r.json.you, "应返回 you 字段");
      eq(r.json.you.pid, playerA.player.pid, "you.pid");
      ok(!("token" in r.json.you), "you 不应包含 token");
      const r2 = await GET("/api/state?cid=not_exist_cid");
      expectStatus(r2, 200, "未知 cid 的 /api/state");
      eq(r2.json.you, null, "未知 cid 的 you 应为 null");
    });

    await t("B9 加入缺少 cid → 400 BAD_INPUT（§4.1 要求 cid）", async () => {
      const s = await fetchSession();
      const r = await POST("/api/join", { code: s.roomCode, name: "无cid玩家" });
      expectStatus(r, 400, "缺 cid 加入");
      expectCode(r, "BAD_INPUT", "缺 cid 加入");
      const after = await fetchSession();
      eq(after.players.length, r.json ? 3 : 0, "缺 cid 不应创建玩家");
    });

    /* ---------------------------------------------------------------- C 后台登录 */
    section("C. 后台登录与数据权限（§4.2）");

    await t("C1 未登录访问后台数据/写操作 → 401 UNAUTHORIZED", async () => {
      const r1 = await GET("/api/admin/data");
      expectStatus(r1, 401, "未登录 GET /api/admin/data");
      expectCode(r1, "UNAUTHORIZED", "未登录 GET /api/admin/data");
      const r2 = await POST("/api/admin/action", { type: "config.set", maxPlayers: 5 });
      expectStatus(r2, 401, "未登录 POST /api/admin/action");
      expectCode(r2, "UNAUTHORIZED", "未登录 POST /api/admin/action");
      const r3 = await GET("/api/export/winners.csv");
      expectStatus(r3, 401, "未登录导出 CSV");
    });

    await t("C2 错误 PIN → 401 BAD_PIN；正确 PIN → 200 且下发 HttpOnly cookie", async () => {
      const bad = await login("0000");
      expectStatus(bad, 401, "错误 PIN 登录");
      expectCode(bad, "BAD_PIN", "错误 PIN 登录");
      const good = await login("8888");
      expectStatus(good, 200, "正确 PIN 登录");
      eq(good.json.ok, true, "登录成功 ok");
      const sc = String(good.headers["set-cookie"] || "");
      ok(/adm=[0-9a-f]{10,}/.test(sc), "Set-Cookie 应包含 adm=<token>，实际 " + fmt(sc));
      ok(/HttpOnly/i.test(sc), "cookie 应为 HttpOnly，实际 " + fmt(sc));
      ok(/Path=\//.test(sc), "cookie Path 应为 /，实际 " + fmt(sc));
      cookie = sc.split(";")[0];
    });

    await t("C3 admin/data 结构完整、含 5 档难度、不泄露 pin", async () => {
      const r = await GET("/api/admin/data", cookie);
      expectStatus(r, 200, "GET /api/admin/data");
      const d = r.json;
      eq(d.ok, true, "admin/data ok");
      ["config", "prizes", "players", "winners", "session", "pinSet"].forEach((k) => {
        ok(k in d, "admin/data 缺少 " + k);
      });
      eq(d.pinSet, true, "pinSet 应为 true");
      ok(Array.isArray(d.difficulties) && d.difficulties.length === 5, "admin/data 应含 5 档难度，实际 " + (d.difficulties && d.difficulties.length));
      const keys = d.difficulties.map((x) => x.key);
      ["easy", "normal", "hard", "extreme", "prize"].forEach((k) => ok(keys.indexOf(k) >= 0, "缺少难度档 " + k + "，实际 " + fmt(keys)));
      d.difficulties.forEach((x) => {
        ["key", "label", "desc", "color", "estimatedPass", "maxStrikes", "waves"].forEach((k) => ok(k in x, "难度 " + x.key + " 缺少 " + k));
        ok(Array.isArray(x.waves) && x.waves.length >= 1, "难度 " + x.key + " waves 异常");
      });
      eq(d.difficulties.find((x) => x.key === "prize").maxStrikes, 99, "获奖档 maxStrikes 应为 99");
      ok(!("pin" in d.config), "adminData.config 不应包含 pin 字段");
      const raw = JSON.stringify(d);
      ok(!/"pin"\s*:/.test(raw), "adminData 响应出现 pin 字段（泄露风险）");
      ok(raw.indexOf('"8888"') < 0, "adminData 响应出现明文 PIN 值 8888（泄露）");
      eq(d.session.phase, "lobby", "adminData.session.phase");
      ok(!("token" in (d.players[0] || {})), "adminData.players 不应下发 token");
      ok(Array.isArray(d.players) && d.players.length >= 1, "adminData.players 应包含当前玩家");
    });

    await t("C4 logout 后 cookie 失效；重新登录可恢复", async () => {
      const out = await POST("/api/admin/logout", {}, cookie);
      expectStatus(out, 200, "后台登出");
      const r = await GET("/api/admin/data", cookie);
      expectStatus(r, 401, "登出后 GET /api/admin/data");
      await loginOk();
      const r2 = await GET("/api/admin/data", cookie);
      expectStatus(r2, 200, "重新登录后 GET /api/admin/data");
    });

    /* ---------------------------------------------------------------- D 配置 */
    section("D. 配置修改：人数/难度/规则/标题/PIN（§4.2/§12-3）");

    await t("D1 非法配置值全部 400 BAD_INPUT", async () => {
      const cases = [
        { maxPlayers: 0 }, { maxPlayers: 201 }, { maxPlayers: 1.5 }, { maxPlayers: "abc" },
        { difficulty: "impossible" }, { difficulty: "" },
        { awardRule: "unknown" }, { awardRule: "first" },
        { title: "" }, { title: "一二三四五六七八九十一二三四五六七八九十一" },
        { subtitle: "字".repeat(31) },
        { pin: "123" }, { pin: "123456789" }, { pin: "abcd" }, { pin: "12345678a" }
      ];
      for (const cse of cases) {
        const r = await adminAction("config.set", cse);
        if (r.status !== 400 || !r.json || r.json.code !== "BAD_INPUT") {
          throw new Error("非法配置未按预期拒绝: " + fmt(cse) + "\n  实际: " + show(r));
        }
      }
    });

    await t("D2 合法配置修改即时生效并出现在 session 快照", async () => {
      await setConfig({
        maxPlayers: 12,
        awardRule: "highFirst",
        title: "新春测试 · 灯阵夺魁",
        subtitle: "QA 副标题 · 好运连连"
      });
      let s = await fetchSession();
      eq(s.config.maxPlayers, 12, "session.config.maxPlayers 未同步");
      eq(s.config.awardRule, "highFirst", "session.config.awardRule 未同步");
      eq(s.config.title, "新春测试 · 灯阵夺魁", "session.config.title 未同步");
      eq(s.config.subtitle, "QA 副标题 · 好运连连", "session.config.subtitle 未同步");
      const d = await adminData();
      eq(d.config.maxPlayers, 12, "adminData.config.maxPlayers 未同步");
      await setConfig({ difficulty: "normal" });
      s = await fetchSession();
      eq(s.config.difficulty, "normal", "session.config.difficulty 未同步");
      eq(s.difficulty.key, "normal", "session.difficulty.key 未同步");
      eq(s.difficulty.waves.length, 2, "normal 应有 2 波");
      eq(s.difficulty.maxStrikes, difficulty.publicInfo("normal").maxStrikes, "normal maxStrikes 应与配置一致");
      await setConfig({ difficulty: "hard" });
      s = await fetchSession();
      eq(s.difficulty.key, "hard", "切换 hard");
      eq(s.difficulty.waves.length, 3, "hard 应有 3 波");
      await setConfig({ difficulty: "extreme" });
      s = await fetchSession();
      eq(s.difficulty.waves.length, 3, "extreme 应有 3 波");
      ok(s.difficulty.waves[1].len > s.difficulty.waves[0].len, "extreme 第 2 波灯数应多于第 1 波");
      await setConfig({ difficulty: "prize" });
      s = await fetchSession();
      eq(s.difficulty.guaranteed, true, "prize 档 guaranteed=true");
      eq(s.difficulty.maxStrikes, 99, "prize 档 maxStrikes=99");
      eq(s.difficulty.waves.length, 1, "prize 档 1 波");
    });

    await t("D5 5 档难度由服务端下发且逐级加难（参数与 lib/difficulty.js 一致，§2）", async () => {
      const d = await adminData();
      const keys = ["easy", "normal", "hard", "extreme", "prize"];
      const byKey = {};
      d.difficulties.forEach((x) => {
        byKey[x.key] = x;
      });
      keys.forEach((k) => ok(byKey[k], "缺少难度档 " + k));
      ["easy", "normal", "hard", "extreme"].forEach((k) => {
        const expect = difficulty.publicInfo(k);
        eq(byKey[k].maxStrikes, expect.maxStrikes, k + " 档 maxStrikes 应与配置一致");
        eq(byKey[k].guaranteed, false, k + " 档不应是保底档");
        eq(JSON.stringify(byKey[k].waves), JSON.stringify(expect.waves), k + " 档 waves 应与配置一致");
      });
      eq(byKey.prize.guaranteed, true, "prize 档应为保底");
      eq(byKey.prize.maxStrikes, 99, "prize 档 maxStrikes");
      const total = (k) => byKey[k].waves.reduce((s, w) => s + w.len, 0);
      // 难度阶梯：总灯数单调不减、容错次数单调不增
      let prevTotal = 0;
      let prevStrikes = 999;
      ["easy", "normal", "hard", "extreme"].forEach((k) => {
        ok(total(k) >= prevTotal, k + " 档总灯数应不低于上一档：" + k + "=" + total(k) + " prev=" + prevTotal);
        ok(byKey[k].maxStrikes <= prevStrikes, k + " 档容错次数应不高于上一档：" + k + "=" + byKey[k].maxStrikes + " prev=" + prevStrikes);
        prevTotal = total(k);
        prevStrikes = byKey[k].maxStrikes;
      });
      ["easy", "normal", "hard", "extreme"].forEach((k) => {
        ok(byKey[k].estimatedPass && byKey[k].estimatedPass.length > 0, k + " 档 estimatedPass 应下发");
        ok(byKey[k].desc && byKey[k].desc.length > 6, k + " 档 desc 应可读");
        byKey[k].waves.forEach((w, i) => {
          ok(w.len >= 2 && w.showMs >= 100 && w.inputMs >= 1000, k + " 档 waves[" + i + "] 参数异常: " + fmt(w));
        });
      });
      // session 下发的当前难度应与 adminData 一致
      await setConfig({ difficulty: "easy" });
      const s = await fetchSession();
      eq(s.difficulty.maxStrikes, byKey.easy.maxStrikes, "session.difficulty.maxStrikes 应与配置一致");
      eq(s.difficulty.waveCount, byKey.easy.waves.length, "session.difficulty.waveCount");
    });

    await t("D3 修改 PIN 后当前登录会话保持有效（§4.2）", async () => {
      await setConfig({ pin: "9999" });
      const r = await GET("/api/admin/data", cookie);
      expectStatus(r, 200, "改 PIN 后旧 cookie 应保持登录");
      const old = await login("8888");
      expectStatus(old, 401, "旧 PIN 应失效");
      const fresh = await login("9999");
      expectStatus(fresh, 200, "新 PIN 应可登录");
      await setConfig({ pin: "8888" });
      const again = await GET("/api/admin/data", cookie);
      expectStatus(again, 200, "PIN 改回 8888 后 cookie 仍有效");
      await loginOk();
    });

    await t("D4 修改标题后大屏通过 SSE 收到最新 session", async () => {
      const sse = openSSE("/api/stream?cid=" + newCid("cfg") + "&role=host");
      try {
        await sse.next((e) => e.t === "hello", 4000, "hello");
        await setConfig({ title: "SSE 同步标题" });
        const ev = await sse.next((e) => e.t === "session" && e.session && e.session.config.title === "SSE 同步标题", 4000, "标题同步 session");
        eq(ev.session.config.title, "SSE 同步标题", "SSE session.config.title");
      } finally {
        sse.close();
      }
      await setConfig({ title: "龙腾新春 · 年会抽奖" });
    });

    /* ---------------------------------------------------------------- E 奖品 */
    section("E. 奖品增删改与库存（§3.2/§4.2/§12-3）");

    await t("E1 新增奖品追加到末尾并立即出现在 session", async () => {
      const before = await adminData();
      const r = await adminAction("prize.add", { name: "QA 测试奖品", emoji: "🎯", quantity: 7, note: "qa" });
      expectStatus(r, 200, "prize.add");
      const after = await adminData();
      eq(after.prizes.length, before.prizes.length + 1, "奖品数量应 +1");
      const added = after.prizes[after.prizes.length - 1];
      eq(added.name, "QA 测试奖品", "新奖品名称");
      eq(added.emoji, "🎯", "新奖品 emoji");
      eq(added.quantity, 7, "新奖品数量");
      eq(added.awarded, 0, "新奖品 awarded");
      eq(added.remaining, 7, "新奖品 remaining");
      eq(added.note, "qa", "新奖品备注");
      const s = await fetchSession();
      eq(s.prizes.length, after.prizes.length, "session.prizes 未同步");
      eq(s.prizes[s.prizes.length - 1].id, added.id, "session.prizes 末尾应为新奖品");
    });

    await t("E2 奖品非法值 → 400 BAD_INPUT", async () => {
      const cases = [
        { name: "", quantity: 1 },
        { name: "一等奖".repeat(8), quantity: 1 },
        { name: "非法数量", quantity: -1 },
        { name: "非法数量", quantity: 1000 },
        { name: "非法数量", quantity: 1.5 },
        { name: "非法数量", quantity: "abc" }
      ];
      for (const cse of cases) {
        const r = await adminAction("prize.add", cse);
        if (r.status !== 400 || !r.json || r.json.code !== "BAD_INPUT") {
          throw new Error("非法奖品未被拒绝: " + fmt(cse) + "\n  实际: " + show(r));
        }
      }
      const r2 = await adminAction("prize.update", { id: "p_doesnotexist", name: "x" });
      expectStatus(r2, 404, "更新不存在的奖品");
      expectCode(r2, "NOT_FOUND", "更新不存在的奖品");
      const r3 = await adminAction("prize.remove", { id: "p_doesnotexist" });
      expectStatus(r3, 404, "删除不存在的奖品");
    });

    await t("E3 修改奖品名称/数量/emoji/备注生效", async () => {
      const d = await adminData();
      const target = d.prizes[d.prizes.length - 1];
      const r = await adminAction("prize.update", {
        id: target.id, name: "改后奖品", emoji: "🏆", quantity: 3, note: "已修改"
      });
      expectStatus(r, 200, "prize.update");
      const after = await adminData();
      const p = after.prizes.find((x) => x.id === target.id);
      eq(p.name, "改后奖品", "奖品名称未更新");
      eq(p.emoji, "🏆", "奖品 emoji 未更新");
      eq(p.quantity, 3, "奖品数量未更新");
      eq(p.note, "已修改", "奖品备注未更新");
      eq(p.remaining, 3, "remaining 应按新数量重算");
      const s = await fetchSession();
      eq(s.prizes.find((x) => x.id === target.id).name, "改后奖品", "session 中奖品未同步");
    });

    await t("E4 删除奖品成功并保持顺序（order 重排）", async () => {
      const before = await adminData();
      const target = before.prizes[before.prizes.length - 1];
      const r = await adminAction("prize.remove", { id: target.id });
      expectStatus(r, 200, "prize.remove");
      const after = await adminData();
      eq(after.prizes.length, before.prizes.length - 1, "删除后数量");
      ok(!after.prizes.some((x) => x.id === target.id), "被删奖品仍在列表中");
      after.prizes.forEach((p, i) => eq(p.order, i, "order 应重排为索引（第 " + i + " 项）"));
    });

    await t("E5 prize.reseed 恢复 5 项示例奖品且 awarded 归零", async () => {
      await mustAdmin("prize.reseed");
      const d = await adminData();
      eq(d.prizes.length, 5, "reseed 后应有 5 项");
      eq(d.prizes.reduce((s, p) => s + p.awarded, 0), 0, "reseed 后 awarded 应归零");
      eq(d.prizes.reduce((s, p) => s + p.quantity, 0), 38, "reseed 后总数量 38");
      d.prizes.forEach((p) => eq(p.remaining, p.quantity, "reseed 后 remaining 应等于 quantity"));
    });

    /* ---------------------------------------------------------------- F 人数上限 */
    section("F. 人数上限与满员拒绝（§4.1/§12-7）");

    await t("F1 人数达到 maxPlayers → 400 ROOM_FULL（同 cid 仍幂等放行）", async () => {
      await resetRound();
      await setConfig({ maxPlayers: 2 });
      const p1 = await joinOne("满员甲");
      expectStatus(p1.res, 200, "第 1 人加入");
      const p2 = await joinOne("满员乙");
      expectStatus(p2.res, 200, "第 2 人加入");
      const p3 = await joinOne("第 3 人");
      expectStatus(p3.res, 400, "第 3 人加入应被拒");
      expectCode(p3.res, "ROOM_FULL", "第 3 人加入");
      ok(p3.res.json.error.indexOf("人数") >= 0 || p3.res.json.error.indexOf("满") >= 0, "错误提示应说明人数已满，实际 " + fmt(p3.res.json.error));
      const s = await fetchSession();
      eq(s.players.length, 2, "满员拒绝后玩家数不应变化");
      const again = await POST("/api/join", { cid: p1.cid, code: s.roomCode, name: "满员甲" });
      expectStatus(again, 200, "满员时同 cid 重复加入应幂等返回");
      eq(again.json.player.pid, p1.player.pid, "同 cid 幂等 pid");
      await setConfig({ maxPlayers: 30 });
    });

    /* ---------------------------------------------------------------- G 开赛 */
    section("G. 开赛与 game 事件（§1/§5/§6）");

    await t("G1 无玩家时开始 → 400 NO_PLAYERS", async () => {
      await resetRound();
      const r = await adminAction("session.start");
      expectStatus(r, 400, "空房开赛");
      expectCode(r, "NO_PLAYERS", "空房开赛");
    });

    await t("G2 reset 更换房间号并清空玩家，保留奖品与中奖记录", async () => {
      const before = await adminData();
      // 先造一个中奖记录（用 prize 难度快速通关）
      await resetRound({ difficulty: "prize" });
      const j = await joinOne("留痕玩家");
      expectStatus(j.res, 200, "加入留痕玩家");
      await mustAdmin("session.start");
      const game = await fetchGame(j);
      const sub = await submitResult(j, winWaves(game));
      expectStatus(sub, 200, "留痕玩家提交");
      ok(sub.json.win === true, "prize 难度应可中奖，实际 " + show(sub));
      const beforeReset = await adminData();
      ok(beforeReset.winners.length >= 1, "应已产生中奖记录");
      const oldCode = beforeReset.session.roomCode;
      const oldAwarded = beforeReset.prizes.reduce((s, p) => s + p.awarded, 0);
      await mustAdmin("session.reset");
      const after = await adminData();
      ne(after.session.roomCode, oldCode, "reset 后房间号应更换");
      ok(/^\d{6}$/.test(after.session.roomCode), "新房间号应为 6 位数字");
      eq(after.session.phase, "lobby", "reset 后 phase 应为 lobby");
      eq(after.players.length, 0, "reset 后应清空玩家");
      eq(after.winners.length, beforeReset.winners.length, "reset 应保留中奖名单");
      eq(after.prizes.reduce((s, p) => s + p.awarded, 0), oldAwarded, "reset 应保留库存扣减");
      eq(after.session.stats.joined, 0, "reset 后 stats.joined 应为 0");
    });

    let roundG = null;
    await t("G3 开赛：phase/startAt/sessionId 正确，game 事件含 seed/startAt/waves/maxStrikes", async () => {
      await resetRound({ difficulty: "easy" });
      const sse = openSSE("/api/stream?cid=" + newCid("game") + "&role=host");
      try {
        await sse.next((e) => e.t === "hello", 4000, "hello");
        const j1 = await joinOne("开赛甲", { avatar: "🐲" });
        const j2 = await joinOne("开赛乙", { avatar: "🦁" });
        expectStatus(j1.res, 200, "甲加入");
        expectStatus(j2.res, 200, "乙加入");
        const t0 = Date.now();
        const startRes = await adminAction("session.start");
        expectStatus(startRes, 200, "session.start");
        const session = startRes.json.data.session;
        eq(session.phase, "playing", "start 后 phase 应为 playing");
        ok(/^s_[0-9a-f]+$/.test(session.sessionId), "sessionId 格式应为 s_xxx，实际 " + fmt(session.sessionId));
        ok(typeof session.startAt === "number", "playing 阶段 startAt 应为时间戳");
        near(session.startAt - t0, 3200, 900, "startAt 应约为 now+3200ms（3 秒倒计时）");
        ok(session.revealAt === null, "playing 阶段 revealAt 应为 null");
        eq(session.players.length, 2, "playing 阶段玩家数");
        eq(session.players[0].status, "playing", "玩家状态应变为 playing");
        eq(session.stats.playing, 2, "stats.playing");

        const gameEv = await sse.next((e) => e.t === "game", 5000, "game 事件");
        const g = gameEv.game;
        ["sessionId", "startAt", "difficulty", "waves", "maxStrikes", "minMs", "seed"].forEach((k) => {
          ok(k in g, "game 事件缺少 " + k + "，实际 " + fmt(g));
        });
        eq(g.sessionId, session.sessionId, "game.sessionId 应与 session 一致");
        eq(g.startAt, session.startAt, "game.startAt 应与 session 一致");
        eq(g.difficulty, "easy", "game.difficulty");
        eq(g.maxStrikes, difficulty.publicInfo("easy").maxStrikes, "game.maxStrikes 应与配置一致");
        ok(Number.isInteger(g.seed) && g.seed > 0, "game.seed 应为正整数随机种子，实际 " + fmt(g.seed));
        ok(Array.isArray(g.waves) && g.waves.length === 2, "easy game.waves 应为 2 波");
        g.waves.forEach((w, i) => {
          ["len", "showMs", "gapMs", "inputMs"].forEach((k) => ok(typeof w[k] === "number", "game.waves[" + i + "] 缺少 " + k));
        });
        const expectMin = g.waves.reduce((s, w) => s + w.len * w.showMs + (w.len - 1) * w.gapMs, 0);
        eq(g.minMs, expectMin, "game.minMs 应为各波理论最短耗时之和");
        const s = await fetchSession();
        eq(s.sessionId, g.sessionId, "session.sessionId 同步");
        roundG = { players: [j1, j2], game: g };
      } finally {
        sse.close();
      }
    });

    await t("G4 开赛后加入 → 400 GAME_STARTED", async () => {
      const s = await fetchSession();
      const r = await POST("/api/join", { cid: newCid("late"), code: s.roomCode, name: "迟到玩家" });
      expectStatus(r, 400, "开赛后加入");
      expectCode(r, "GAME_STARTED", "开赛后加入");
      ok(r.json.error.indexOf("开始") >= 0, "错误提示应说明已开始，实际 " + fmt(r.json.error));
    });

    await t("G5 开赛后 rejoin 恢复身份（刷新手机页场景，§12-8）", async () => {
      const p = roundG.players[0];
      const r = await POST("/api/rejoin", { cid: p.cid, pid: p.player.pid, token: p.player.token });
      expectStatus(r, 200, "开赛后 rejoin");
      eq(r.json.player.pid, p.player.pid, "rejoin 返回同一玩家");
      eq(r.json.player.status, "playing", "rejoin 后状态应为 playing");
      ok(r.json.game && r.json.game.seed, "rejoin 应返回 game（用于恢复灯阵序列）");
      const bad = await POST("/api/rejoin", { cid: p.cid, pid: p.player.pid, token: "deadbeefdeadbeef" });
      expectStatus(bad, 403, "错误 token rejoin");
      expectCode(bad, "BAD_TOKEN", "错误 token rejoin");
    });

    /* ---------------------------------------------------------------- H 成绩判定 */
    section("H. 成绩判定：中奖/未中奖/作弊/重复提交（§6/§12-5）");

    let roundH1 = null;
    await t("H1 全通过 → 中奖，库存 -1，stats/winners 同步", async () => {
      const round = await freshRound({ difficulty: "easy", count: 1, names: ["通关玩家"] });
      const before = await prizeState();
      const res = await submitResult(round.players[0], winWaves(round.game));
      expectStatus(res, 200, "提交通关成绩");
      const b = res.json;
      eq(b.win, true, "全部波通过应中奖，实际 " + show(res));
      ok(b.prize && b.prize.id, "中奖应返回 prize，实际 " + fmt(b.prize));
      eq(b.prize.consolation, false, "有库存时不应是福袋");
      eq(b.player.status, "won", "中奖玩家状态应为 won");
      eq(b.player.result.win, true, "player.result.win");
      eq(b.player.result.waves, 2, "result.waves 应为 2");
      eq(b.player.result.cleared, 2, "result.cleared 应为 2");
      eq(b.player.result.strikes, 0, "result.strikes 应为 0");
      eq(b.player.result.hits, round.game.waves.reduce((s, w) => s + w.len, 0), "result.hits 应为各波长度之和");
      const after = await prizeState();
      eq(after.totalAwarded, before.totalAwarded + 1, "库存 awarded 应 +1");
      eq(after.byId[b.prize.id].awarded, before.byId[b.prize.id].awarded + 1, "对应奖品 awarded 应 +1");
      eq(after.byId[b.prize.id].remaining, after.byId[b.prize.id].quantity - after.byId[b.prize.id].awarded, "remaining 公式");
      eq(after.winners.length, before.winners.length + 1, "winners 应 +1");
      const w = after.winners[after.winners.length - 1];
      eq(w.pid, round.players[0].player.pid, "winner.pid");
      eq(w.name, "通关玩家", "winner.name");
      eq(w.prize.id, b.prize.id, "winner.prize.id");
      eq(w.prize.consolation, false, "winner.prize.consolation");
      eq(w.difficulty, "easy", "winner.difficulty");
      ok(typeof w.at === "number" && Math.abs(w.at - Date.now()) < 10000, "winner.at 应为时间戳");
      const s = await fetchSession();
      eq(s.stats.wins, 1, "session.stats.wins 应为 1");
      eq(s.stats.losses, 0, "session.stats.losses 应为 0");
      eq(s.stats.awardedPrizes, after.totalAwarded, "stats.awardedPrizes 应等于库存 awarded 总和");
      roundH1 = round;
    });

    await t("H2 重复提交 → duplicate:true 且不重复发奖", async () => {
      const p = roundH1.players[0];
      const before = await prizeState();
      const res = await submitResult(p, winWaves(roundH1.game));
      expectStatus(res, 200, "重复提交");
      eq(res.json.duplicate, true, "重复提交应标记 duplicate，实际 " + show(res));
      eq(res.json.win, true, "duplicate 应回显首次结果");
      const after = await prizeState();
      eq(after.totalAwarded, before.totalAwarded, "重复提交不应重复扣库存");
      eq(after.winners.length, before.winners.length, "重复提交不应新增中奖记录");
    });

    await t("H3 错一步 → 未中奖，不扣库存", async () => {
      const round = await freshRound({ difficulty: "easy", count: 1, names: ["错一步玩家"] });
      const before = await prizeState();
      const waves = winWaves(round.game);
      waves[round.game.waves.length - 1] = failWave(round.game, round.game.waves.length - 1);
      const res = await submitResult(round.players[0], waves);
      expectStatus(res, 200, "提交错一步成绩");
      eq(res.json.win, false, "错一步不应中奖，实际 " + show(res));
      eq(res.json.player.status, "lost", "未中奖玩家状态应为 lost");
      eq(res.json.player.result.cleared, 1, "result.cleared 应为 1");
      eq(res.json.player.result.win, false, "result.win");
      eq(res.json.prize, null, "未中奖不应返回奖品");
      const after = await prizeState();
      eq(after.totalAwarded, before.totalAwarded, "未中奖不应扣库存");
      eq(after.winners.length, before.winners.length, "未中奖不应新增中奖记录");
      const s = await fetchSession();
      eq(s.stats.losses, 1, "stats.losses 应为 1");
    });

    await t("H4 瞬时 ms 作弊（ms 远小于理论最短）→ 未中奖", async () => {
      const round = await freshRound({ difficulty: "easy", count: 1, names: ["作弊玩家"] });
      const before = await prizeState();
      const waves = round.game.waves.map((w) => ({ cleared: true, hits: w.len, strikes: 0, ms: 10 }));
      const res = await submitResult(round.players[0], waves);
      expectStatus(res, 200, "提交瞬时作弊成绩");
      eq(res.json.win, false, "瞬时 ms 作弊不应中奖，实际 " + show(res));
      eq(res.json.player.status, "lost", "作弊玩家状态应为 lost");
      const after = await prizeState();
      eq(after.totalAwarded, before.totalAwarded, "作弊不应扣库存");
    });

    await t("H5 hits 越界（hits > len）→ 400 BAD_INPUT，不产生结果不发奖（§6）", async () => {
      const round = await freshRound({ difficulty: "easy", count: 1, names: ["越界玩家"] });
      const before = await prizeState();
      const waves = round.game.waves.map((w) => ({
        cleared: true,
        hits: w.len + 5,
        strikes: 0,
        ms: w.len * w.showMs + (w.len - 1) * w.gapMs + 400
      }));
      const res = await submitResult(round.players[0], waves);
      expectStatus(res, 400, "hits 越界提交");
      expectCode(res, "BAD_INPUT", "hits 越界提交");
      const after = await prizeState();
      eq(after.totalAwarded, before.totalAwarded, "hits 越界不应发奖");
      const d = await adminData();
      const me = d.players.find((p) => p.pid === round.players[0].player.pid);
      eq(me.result, null, "hits 越界被拒后玩家不应产生 result（可重试）");
      eq(me.status, "playing", "hits 越界被拒后玩家状态应保持 playing");
    });

    await t("H5b hits/strikes/ms 非法类型与越界 → 400 BAD_INPUT", async () => {
      const cases = [
        (w) => Object.assign({}, w, { hits: -1 }),
        (w) => Object.assign({}, w, { hits: 1.5 }),
        (w) => Object.assign({}, w, { hits: 999 }),
        (w) => Object.assign({}, w, { strikes: 1000 }),
        (w) => Object.assign({}, w, { strikes: -1 }),
        (w) => Object.assign({}, w, { ms: 600001 }),
        (w) => Object.assign({}, w, { ms: "abc" })
      ];
      for (let i = 0; i < cases.length; i++) {
        const round = await freshRound({ difficulty: "easy", count: 1, names: ["非法参数" + (i + 1)] });
        const waves = winWaves(round.game);
        waves[0] = cases[i](waves[0]);
        const res = await submitResult(round.players[0], waves);
        if (res.status !== 400 || !res.json || res.json.code !== "BAD_INPUT") {
          throw new Error("非法成绩参数未被拒绝（第 " + (i + 1) + " 组）\n  实际: " + show(res));
        }
      }
    });

    await t("H6 waves 数量与配置不符 → 400 BAD_INPUT", async () => {
      const round = await freshRound({ difficulty: "easy", count: 1, names: ["缺波玩家"] });
      const waves = winWaves(round.game).slice(0, 1);
      const res = await submitResult(round.players[0], waves);
      expectStatus(res, 400, "waves 数量不符");
      expectCode(res, "BAD_INPUT", "waves 数量不符");
      const res2 = await submitResult(round.players[0], []);
      expectStatus(res2, 400, "waves 为空");
      expectCode(res2, "BAD_INPUT", "waves 为空");
    });

    await t("H7 错误 token / 不存在玩家提交 → 403/404", async () => {
      const round = await freshRound({ difficulty: "easy", count: 1, names: ["令牌玩家"] });
      const bad = await POST("/api/game/result", {
        cid: round.players[0].cid,
        pid: round.players[0].player.pid,
        token: "wrong-token-wrong-token",
        waves: winWaves(round.game)
      });
      expectStatus(bad, 403, "错误 token 提交");
      expectCode(bad, "BAD_TOKEN", "错误 token 提交");
      const ghost = await POST("/api/game/result", { cid: "x", pid: "pl_ghost", token: "t", waves: [] });
      expectStatus(ghost, 404, "不存在的玩家提交");
      expectCode(ghost, "PLAYER_NOT_FOUND", "不存在的玩家提交");
    });

    await t("H8 开奖后再次提交 → 返回首次结果（duplicate），不崩溃", async () => {
      const round = await freshRound({ difficulty: "easy", count: 2, names: ["开奖甲", "开奖乙"] });
      await submitResult(round.players[0], winWaves(round.game));
      await mustAdmin("session.reveal");
      const res = await submitResult(round.players[1], winWaves(round.game));
      expectStatus(res, 200, "开奖后提交未提交玩家的成绩");
      eq(res.json.duplicate, true, "开奖后提交应返回 duplicate（reveal 已记 lost）\n  实际: " + show(res));
      eq(res.json.win, false, "开奖后未提交玩家不应因后续提交中奖");
    });

    /* ---------------------------------------------------------------- I 自动/手动开奖 */
    section("I. 自动/手动开奖与未提交判定（§1/§12-6）");

    await t("I1 全员提交后约 2.5s 自动 reveal（大屏收到 session.phase=reveal）", async () => {
      const sse = openSSE("/api/stream?cid=" + newCid("rv") + "&role=host");
      try {
        await sse.next((e) => e.t === "hello", 4000, "hello");
        const round = await freshRound({ difficulty: "easy", count: 2, names: ["自动甲", "自动乙"] });
        let a = await submitResult(round.players[0], winWaves(round.game));
        expectStatus(a, 200, "甲提交");
        let b = await submitResult(round.players[1], [winWaves(round.game)[0], failWave(round.game, 1)]);
        expectStatus(b, 200, "乙提交");
        const tSubmit = Date.now();
        const ev = await sse.next((e) => e.t === "session" && e.session && e.session.phase === "reveal", 7000, "自动开奖 session");
        const elapsed = Date.now() - tSubmit;
        ok(elapsed >= 1800 && elapsed <= 6500, "自动开奖应在提交后约 2.5s，实际耗时 " + elapsed + "ms");
        eq(ev.session.phase, "reveal", "自动开奖后 phase");
        ok(typeof ev.session.revealAt === "number", "revealAt 应下发");
        eq(ev.session.stats.wins, 1, "自动开奖后 stats.wins");
        eq(ev.session.stats.losses, 1, "自动开奖后 stats.losses");
        const d = await adminData();
        eq(d.players.find((p) => p.pid === round.players[0].player.pid).status, "won", "甲应为 won");
        eq(d.players.find((p) => p.pid === round.players[1].player.pid).status, "lost", "乙应为 lost");
      } finally {
        sse.close();
      }
    });

    await t("I2 手动 session.reveal：未提交玩家记 lost + result.missed", async () => {
      const round = await freshRound({ difficulty: "easy", count: 2, names: ["提前甲", "未提交乙"] });
      await submitResult(round.players[0], winWaves(round.game));
      const r = await adminAction("session.reveal");
      expectStatus(r, 200, "手动开奖");
      const s = r.json.data.session;
      eq(s.phase, "reveal", "手动开奖后 phase");
      eq(s.players.find((p) => p.pid === round.players[1].player.pid).status, "lost", "未提交玩家应记 lost");
      const skipped = s.players.find((p) => p.pid === round.players[1].player.pid);
      ok(skipped.result && skipped.result.missed === true, "未提交玩家 result.missed 应为 true，实际 " + fmt(skipped.result));
      eq(skipped.result.win, false, "未提交玩家 result.win");
      eq(s.players.find((p) => p.pid === round.players[0].player.pid).status, "won", "已中奖玩家不应被改成 lost");
      const sse = await fetchSession();
      eq(sse.phase, "reveal", "fetchSession phase");
    });

    await t("I3 reveal 阶段重复 start/reveal → 400 BAD_PHASE", async () => {
      const r1 = await adminAction("session.start");
      expectStatus(r1, 400, "reveal 阶段 start");
      expectCode(r1, "BAD_PHASE", "reveal 阶段 start");
      const r2 = await adminAction("session.reveal");
      expectStatus(r2, 400, "reveal 阶段重复 reveal");
      expectCode(r2, "BAD_PHASE", "reveal 阶段重复 reveal");
      const r3 = await adminAction("session.start");
      expectCode(r3, "BAD_PHASE", "再次 start");
    });

    await t("I4 主持人手动发奖 player.award：立即发库存奖品，重复发奖拒绝", async () => {
      await resetRound({ difficulty: "easy" });
      const j = await joinOne("手动发奖玩家");
      expectStatus(j.res, 200, "手动发奖玩家加入");
      const before = await prizeState();
      const r = await adminAction("player.award", { pid: j.player.pid });
      expectStatus(r, 200, "player.award");
      const d = r.json.data;
      const me = d.players.find((p) => p.pid === j.player.pid);
      eq(me.status, "won", "手动发奖后玩家状态应为 won");
      ok(me.prize && me.prize.id, "手动发奖应下发奖品，实际 " + fmt(me.prize));
      eq(me.result.win, true, "手动发奖应写入 win 结果");
      const after = await prizeState();
      eq(after.totalAwarded, before.totalAwarded + 1, "手动发奖应扣 1 库存");
      eq(after.winners.length, before.winners.length + 1, "手动发奖应写入中奖名单");
      const again = await adminAction("player.award", { pid: j.player.pid });
      expectStatus(again, 400, "重复手动发奖");
      expectCode(again, "ALREADY_AWARDED", "重复手动发奖");
      const ghost = await adminAction("player.award", { pid: "pl_ghost" });
      expectStatus(ghost, 404, "给不存在玩家发奖");
      expectCode(ghost, "PLAYER_NOT_FOUND", "给不存在玩家发奖");
    });

    await t("I5 踢人 player.kick：玩家被移除且其 SSE 收到 kicked 事件", async () => {
      await resetRound({ difficulty: "easy" });
      const j = await joinOne("被踢玩家");
      expectStatus(j.res, 200, "被踢玩家加入");
      const sse = openSSE(
        "/api/stream?cid=" + encodeURIComponent(j.cid) + "&role=player&pid=" + encodeURIComponent(j.player.pid) +
          "&token=" + encodeURIComponent(j.player.token)
      );
      try {
        await sse.next((e) => e.t === "hello", 4000, "被踢玩家 hello");
        const r = await adminAction("player.kick", { pid: j.player.pid });
        expectStatus(r, 200, "player.kick");
        const ev = await sse.next((e) => e.t === "kicked", 4000, "kicked 事件");
        ok(ev.reason && ev.reason.length > 0, "kicked 事件应带 reason");
        const s = await fetchSession();
        eq(s.players.length, 0, "被踢玩家应从列表移除");
        eq(s.stats.joined, 0, "踢人后 stats.joined 应为 0");
        const ghost = await adminAction("player.kick", { pid: "pl_ghost" });
        expectStatus(ghost, 404, "踢不存在玩家");
        expectCode(ghost, "PLAYER_NOT_FOUND", "踢不存在玩家");
      } finally {
        sse.close();
      }
    });

    await t("I6 reset 广播 toast 事件（含新房间号提示，§5）", async () => {
      const sse = openSSE("/api/stream?cid=" + newCid("toast") + "&role=host");
      try {
        await sse.next((e) => e.t === "hello", 4000, "hello");
        const r = await adminAction("session.reset");
        expectStatus(r, 200, "reset");
        const newCode = r.json.data.session.roomCode;
        const ev = await sse.next((e) => e.t === "toast", 4000, "toast 事件");
        ok(ev.text && ev.text.indexOf(newCode) >= 0, "toast 文本应包含新房间号 " + newCode + "，实际 " + fmt(ev.text));
        eq(ev.kind, "info", "toast.kind 应为 info");
      } finally {
        sse.close();
      }
    });

    /* ---------------------------------------------------------------- J 福袋 */
    section("J. 库存耗尽 → 福袋安慰奖（§3.2）");

    await t("J1 所有奖品库存为 0 时中奖 → console consolation 新春福袋", async () => {
      const d0 = await adminData();
      for (const p of d0.prizes) {
        const r = await adminAction("prize.update", { id: p.id, quantity: 0 });
        expectStatus(r, 200, "清空库存 " + p.id);
      }
      const cleared = await prizeState();
      eq(cleared.prizes.every((p) => p.remaining === 0), true, "所有奖品 remaining 应为 0");
      const round = await freshRound({ difficulty: "prize", count: 1, names: ["福袋玩家"] });
      const before = await prizeState();
      const res = await submitResult(round.players[0], winWaves(round.game));
      expectStatus(res, 200, "库存耗尽时提交");
      eq(res.json.win, true, "prize 难度应通关");
      eq(res.json.prize.consolation, true, "库存耗尽应发福袋，实际 " + fmt(res.json.prize));
      eq(res.json.prize.name, "新春福袋", "福袋名称");
      eq(res.json.prize.emoji, "🧧", "福袋 emoji");
      eq(res.json.prize.id, null, "福袋 id 应为 null");
      const after = await prizeState();
      eq(after.totalAwarded, before.totalAwarded, "福袋不应扣库存");
      const w = after.winners[after.winners.length - 1];
      eq(w.prize.consolation, true, "winner.prize.consolation 应为 true");
      eq(w.name, "福袋玩家", "winner.name");
      await mustAdmin("prize.reseed");
      const reseeded = await prizeState();
      eq(reseeded.totalAwarded, 0, "reseed 后库存归零");
    });

    /* ---------------------------------------------------------------- K 抽奖规则 */
    section("K. 抽奖规则 lowFirst / highFirst / random（§3.1/§4.2）");

    await t("K1 lowFirst 先发末位低价值奖品", async () => {
      await mustAdmin("prize.reseed");
      await setConfig({ awardRule: "lowFirst" });
      const round = await freshRound({ difficulty: "prize", count: 1, names: ["低位奖玩家"] });
      const res = await submitResult(round.players[0], winWaves(round.game));
      expectStatus(res, 200, "lowFirst 提交");
      eq(res.json.win, true, "lowFirst 应通关");
      ok(res.json.prize.name.indexOf("幸运奖") >= 0, "lowFirst 应先发末位「幸运奖」，实际 " + fmt(res.json.prize.name));
    });

    await t("K2 highFirst 先发首位高价值奖品", async () => {
      await mustAdmin("prize.reseed");
      await setConfig({ awardRule: "highFirst" });
      const round = await freshRound({ difficulty: "prize", count: 1, names: ["高位奖玩家"] });
      const res = await submitResult(round.players[0], winWaves(round.game));
      expectStatus(res, 200, "highFirst 提交");
      eq(res.json.win, true, "highFirst 应通关");
      ok(res.json.prize.name.indexOf("特等奖") >= 0, "highFirst 应先发首位「特等奖」，实际 " + fmt(res.json.prize.name));
    });

    await t("K3 random 规则在有库存奖池内发放", async () => {
      await mustAdmin("prize.reseed");
      await setConfig({ awardRule: "random" });
      const inStock = (await prizeState()).prizes.filter((p) => p.remaining > 0).map((p) => p.id);
      const round = await freshRound({ difficulty: "prize", count: 1, names: ["随机奖玩家"] });
      const res = await submitResult(round.players[0], winWaves(round.game));
      expectStatus(res, 200, "random 提交");
      eq(res.json.win, true, "random 应通关");
      ok(inStock.indexOf(res.json.prize.id) >= 0, "random 发出的奖品应在有库存奖池内，实际 " + fmt(res.json.prize));
    });

    await t("K4 已发数量 > 新数量时允许修改且 remaining=0（§4.2）", async () => {
      const d = await adminData();
      const target = d.prizes.find((p) => p.awarded > 0);
      ok(target, "应存在已发放的奖品用于测试");
      const r = await adminAction("prize.update", { id: target.id, quantity: 0 });
      expectStatus(r, 200, "quantity < awarded 修改");
      const after = await adminData();
      const p = after.prizes.find((x) => x.id === target.id);
      eq(p.quantity, 0, "quantity 应为 0");
      eq(p.awarded, target.awarded, "awarded 不应被修改");
      eq(p.remaining, 0, "remaining 应为 0");
      await adminAction("prize.update", { id: target.id, quantity: target.quantity });
    });

    /* ---------------------------------------------------------------- L CSV/QR/重置 */
    section("L. CSV 导出 / 二维码 / 重置与清空（§4.1/§4.2/§12-6）");

    await t("L1 winner.clear 清空中奖名单但保留库存扣减", async () => {
      const before = await prizeState();
      ok(before.winners.length > 0, "前置条件：应存在中奖记录");
      const r = await adminAction("winner.clear");
      expectStatus(r, 200, "winner.clear");
      const after = await prizeState();
      eq(after.winners.length, 0, "winner.clear 后名单应为空");
      eq(after.totalAwarded, before.totalAwarded, "winner.clear 不应影响库存扣减");
    });

    await t("L2 CSV 导出：附件头 + UTF-8 BOM + 表头与中奖数据（需后台 cookie）", async () => {
      // 重新造一条中奖记录
      await mustAdmin("prize.reseed");
      const round = await freshRound({ difficulty: "prize", count: 1, names: ["CSV玩家"] });
      const sub = await submitResult(round.players[0], winWaves(round.game));
      expectStatus(sub, 200, "CSV 场景提交");
      const r = await GET("/api/export/winners.csv", cookie);
      expectStatus(r, 200, "GET CSV");
      const ct = String(r.headers["content-type"] || "");
      ok(ct.indexOf("application/octet-stream") >= 0 || ct.indexOf("text/csv") >= 0, "CSV Content-Type 异常: " + fmt(ct));
      const cd = String(r.headers["content-disposition"] || "");
      ok(/attachment/i.test(cd), "CSV 应带 Content-Disposition: attachment，实际 " + fmt(cd));
      ok(/\.csv/i.test(cd), "附件名应为 .csv，实际 " + fmt(cd));
      ok(r.buf.length > 0, "CSV 内容为空");
      eq(r.buf.length, Number(String(r.headers["content-length"] || r.buf.length)), "Content-Length 应与实际字节数一致");
      eq(r.buf[0], 0xef, "CSV 必须以 UTF-8 BOM(EF BB BF) 开头，实际首字节 0x" + r.buf[0].toString(16) + "\n  响应前 120 字节: " + JSON.stringify(r.buf.slice(0, 120).toString("utf8")));
      eq(r.buf[1], 0xbb, "CSV BOM 第二字节");
      eq(r.buf[2], 0xbf, "CSV BOM 第三字节");
      const text = r.text.replace(/^\uFEFF/, "");
      ok(text[0] !== '"' || text.indexOf('"序号"') === 0, "CSV 内容不应被 JSON 字符串包裹，实际开头: " + JSON.stringify(text.slice(0, 80)));
      ["序号", "奖品", "中奖人", "头像", "难度", "时间"].forEach((k) => ok(text.indexOf(k) >= 0, "CSV 表头缺少「" + k + "」，实际内容: " + JSON.stringify(text.slice(0, 200))));
      ok(text.indexOf("CSV玩家") >= 0, "CSV 应包含中奖者昵称，实际内容: " + JSON.stringify(text.slice(0, 300)));
      ok(text.indexOf("\r\n") > 0, "CSV 行分隔应为 CRLF");
      const lines = text.split("\r\n").filter(Boolean);
      ok(lines.length >= 2, "CSV 至少应有表头 + 1 行数据，实际 " + lines.length + " 行");
      lines.forEach((line) => {
        const quotes = (line.match(/"/g) || []).length;
        eq(quotes % 2, 0, "CSV 行列引号应成对: " + line);
      });
    });

    await t("L3 二维码 SVG 返回合法图片；缺 text 参数 → 400", async () => {
      const target = BASE.replace(HOST, "127.0.0.1") + "/play";
      const r = await GET("/api/qr.svg?text=" + encodeURIComponent(target));
      expectStatus(r, 200, "GET /api/qr.svg");
      ok(String(r.headers["content-type"] || "").indexOf("image/svg+xml") >= 0, "二维码 Content-Type 应为 image/svg+xml，实际 " + fmt(r.headers["content-type"]));
      ok(/<svg[\s>]/.test(r.text), "二维码响应应包含 <svg>，实际前 120 字: " + fmt(r.text.slice(0, 120)));
      const r2 = await GET("/api/qr.svg");
      expectStatus(r2, 400, "缺 text 参数");
      expectCode(r2, "BAD_INPUT", "缺 text 参数");
    });

    await t("L4 重置：换房间号、清玩家，保留库存与中奖名单", async () => {
      const before = await adminData();
      ok(before.winners.length > 0, "前置条件：应存在中奖记录");
      const oldCode = before.session.roomCode;
      const r = await adminAction("session.reset");
      expectStatus(r, 200, "session.reset");
      const after = await adminData();
      ne(after.session.roomCode, oldCode, "reset 应更换房间号");
      eq(after.session.phase, "lobby", "reset 后应为 lobby");
      eq(after.players.length, 0, "reset 后玩家应清空");
      eq(after.session.stats.joined, 0, "reset 后 stats.joined");
      eq(after.winners.length, before.winners.length, "reset 应保留中奖名单");
      eq(after.prizes.reduce((s, p) => s + p.awarded, 0), before.prizes.reduce((s, p) => s + p.awarded, 0), "reset 应保留库存扣减");
      eq(after.session.sessionId, "", "reset 后 sessionId 应清空");
      eq(after.session.startAt, null, "reset 后 startAt 应为 null");
      eq(after.session.revealAt, null, "reset 后 revealAt 应为 null");
    });

    /* ---------------------------------------------------------------- M 错误与静态 */
    section("M. 错误处理 / 路径穿越 / 静态资源（§0/§4）");

    await t("M1 未知后台 action → 400 UNKNOWN_ACTION", async () => {
      const r = await adminAction("hack.everything");
      expectStatus(r, 400, "未知 action");
      expectCode(r, "UNKNOWN_ACTION", "未知 action");
    });

    await t("M2 非法 JSON 请求体 → 400 BAD_JSON", async () => {
      const r = await POST_RAW("/api/join", "{oops not json", null);
      expectStatus(r, 400, "非法 JSON");
      expectCode(r, "BAD_JSON", "非法 JSON");
      const r2 = await POST_RAW("/api/join", "[]", null);
      expectStatus(r2, 400, "数组请求体");
      expectCode(r2, "BAD_JSON", "数组请求体");
    });

    await t("M3 超大请求体（>128KB）→ 413 BODY_TOO_LARGE 且服务不崩溃", async () => {
      const raw = '{"cid":"big","code":"123456","name":"' + "A".repeat(200 * 1024) + '"}';
      const r = await POST_RAW("/api/join", raw, null);
      ok(!r.error, "超大请求体应返回 HTTP 413，实际连接异常: " + (r.error && r.error.message));
      expectStatus(r, 413, "超大请求体");
      expectCode(r, "BODY_TOO_LARGE", "超大请求体");
      const h = await GET("/api/health");
      expectStatus(h, 200, "超大请求体后服务应仍存活");
    });

    await t("M4 路径穿越无法读取 server.js 等服务端源码", async () => {
      const paths = [
        "/../server.js",
        "/..%2f..%2fserver.js",
        "/%2e%2e/%2e%2e/server.js",
        "/css/../../server.js",
        "/..%2f..%2f..%2fWindows%2fwin.ini",
        "/%2e%2e%2fpackage.json"
      ];
      for (const p of paths) {
        const r = await GET(p);
        ok(r.status === 404 || r.status === 400, "路径穿越 " + p + " 应返回 404/400，实际 " + r.status);
        ok(r.text.indexOf("require(") < 0, "路径穿越 " + p + " 泄漏了 JS 源码");
        ok(r.text.indexOf('"dependencies"') < 0, "路径穿越 " + p + " 泄漏了 package.json");
      }
    });

    await t("M5 未知 API → 404 NOT_FOUND；未知静态路径 → 404 页面", async () => {
      const r = await GET("/api/does-not-exist");
      expectStatus(r, 404, "未知 API");
      expectCode(r, "NOT_FOUND", "未知 API");
      const r2 = await GET("/no-such-page.html");
      expectStatus(r2, 404, "未知静态路径");
      ok(r2.text.indexOf("404") >= 0, "404 页面内容异常");
      ok(/text\/html/.test(String(r2.headers["content-type"] || "")), "404 应为 HTML 页面，实际 " + fmt(r2.headers["content-type"]));
      const r3 = await GET("/api/join");
      expectStatus(r3, 405, "GET /api/join（方法不匹配）应返回 405");
      expectCode(r3, "METHOD_NOT_ALLOWED", "GET /api/join（方法不匹配）");
    });

    await t("M6 三端页面与共享静态资源可访问（/、/play、/admin、net.js、theme.css）", async () => {
      for (const p of ["/", "/play", "/admin"]) {
        const r = await GET(p);
        expectStatus(r, 200, "GET " + p);
        ok(/text\/html/.test(String(r.headers["content-type"] || "")), p + " 应为 HTML，实际 " + fmt(r.headers["content-type"]));
        ok(r.text.indexOf("<!doctype html") >= 0 || r.text.indexOf("<!DOCTYPE html") >= 0, p + " 缺少 doctype");
        ok(r.text.indexOf("net.js") >= 0, p + " 未引用 net.js");
      }
      const js = await GET("/js/net.js");
      expectStatus(js, 200, "GET /js/net.js");
      ok(/javascript/.test(String(js.headers["content-type"] || "")), "net.js Content-Type");
      const css = await GET("/css/theme.css");
      expectStatus(css, 200, "GET /css/theme.css");
      ok(/text\/css/.test(String(css.headers["content-type"] || "")), "theme.css Content-Type");
      const csp = String(js.headers["content-security-policy"] || "");
      ok(csp.length > 0, "静态资源应带 CSP 头（防外链资源）");
      ok(csp.indexOf("default-src 'self'") >= 0, "CSP default-src 应为 'self'，实际 " + fmt(csp));
    });

    await t("M7 页面引用的本地资源均存在（无外链、无 404 资源）", async () => {
      const pages = ["/", "/play", "/admin"];
      const missing = [];
      for (const p of pages) {
        const r = await GET(p);
        const re = /(?:src|href)="([^"]+)"/g;
        let m;
        while ((m = re.exec(r.text))) {
          const u = m[1];
          if (!u || u[0] === "#" || u.indexOf("data:") === 0) continue;
          if (u.indexOf("/api/") === 0) continue; // 接口链接（如下载 CSV）不在静态资源检查范围
          ok(!/^https?:\/\//i.test(u), p + " 出现外链资源（禁止外网资源）：" + u);
          if (u.indexOf("http") === 0) continue;
          const rr = await GET(u);
          if (rr.status !== 200) missing.push(p + " → " + u + " (HTTP " + rr.status + ")");
        }
      }
      if (missing.length) {
        warn("页面引用的静态资源尚未就绪/缺失（开发中可忽略，交付前必须补全）：\n      " + missing.join("\n      "));
      }
    });

    /* ---------------------------------------------------------------- N SSE */
    section("N. SSE 事件与断线重连（§5/§12-2/§12-6）");

    await t("N1 host 连接收到 hello（含 role/session）；role/cid 参数校验", async () => {
      const sse = openSSE("/api/stream?cid=" + newCid("h1") + "&role=host");
      try {
        const ev = await sse.next((e) => e.t === "hello", 4000, "hello");
        eq(ev.role, "host", "hello.role");
        ok(typeof ev.serverTime === "number", "hello.serverTime");
        ok(ev.session && ev.session.roomCode, "hello 应携带 session");
        eq(ev.session.phase, "lobby", "hello.session.phase");
      } finally {
        sse.close();
      }
      const bad = await GET("/api/stream?cid=x&role=alien");
      expectStatus(bad, 400, "非法 role");
      expectCode(bad, "BAD_INPUT", "非法 role");
      const noCid = await GET("/api/stream?role=host");
      expectStatus(noCid, 400, "缺 cid");
      expectCode(noCid, "BAD_INPUT", "缺 cid");
      const adminNoAuth = await GET("/api/stream?cid=x&role=admin");
      expectStatus(adminNoAuth, 401, "未登录 admin SSE");
      expectCode(adminNoAuth, "UNAUTHORIZED", "未登录 admin SSE");
    });

    await t("N2 玩家加入后大屏实时收到含该玩家的 session 事件", async () => {
      await resetRound();
      const sse = openSSE("/api/stream?cid=" + newCid("h2") + "&role=host");
      try {
        await sse.next((e) => e.t === "hello", 4000, "hello");
        const j = await joinOne("实时加入玩家");
        expectStatus(j.res, 200, "加入");
        const ev = await sse.next(
          (e) => e.t === "session" && e.session && e.session.players.some((p) => p.pid === j.player.pid),
          4000,
          "玩家入场 session"
        );
        const me = ev.session.players.find((p) => p.pid === j.player.pid);
        eq(me.name, "实时加入玩家", "session 中玩家昵称");
        eq(me.status, "joined", "session 中玩家状态");
        eq(ev.session.stats.joined, 1, "stats.joined");
      } finally {
        sse.close();
      }
    });

    await t("N3 开赛广播 game 事件；提交成绩广播 award + you 事件", async () => {
      await resetRound();
      const hostSSE = openSSE("/api/stream?cid=" + newCid("h3") + "&role=host");
      try {
        await hostSSE.next((e) => e.t === "hello", 4000, "hello");
        const j = await joinOne("事件玩家");
        expectStatus(j.res, 200, "事件玩家加入");
        const playerSSE = openSSE(
          "/api/stream?cid=" + encodeURIComponent(j.cid) + "&role=player&pid=" + encodeURIComponent(j.player.pid) +
            "&token=" + encodeURIComponent(j.player.token)
        );
        try {
          const hello = await playerSSE.next((e) => e.t === "hello", 4000, "玩家 hello");
          eq(hello.role, "player", "玩家 hello.role");
          ok(hello.you, "玩家 hello 应携带 you");
          eq(hello.you.pid, j.player.pid, "hello.you.pid");

          await mustAdmin("session.start");
          const gameEv = await hostSSE.next((e) => e.t === "game", 5000, "game 事件");
          ok(gameEv.game.sessionId, "game.sessionId");
          const sessionEv = await hostSSE.next((e) => e.t === "session" && e.session.phase === "playing", 5000, "playing session");
          eq(sessionEv.session.phase, "playing", "playing session");

          const game = await fetchGame(j);
          const sub = await submitResult(j, winWaves(game));
          expectStatus(sub, 200, "提交成绩");
          const award = await hostSSE.next((e) => e.t === "award", 5000, "award 事件");
          eq(award.pid, j.player.pid, "award.pid");
          eq(award.name, "事件玩家", "award.name");
          ok(award.prize && award.prize.name, "award.prize");
          ok(award.winner && award.winner.pid === j.player.pid, "award.winner");
          const you = await playerSSE.next((e) => e.t === "you", 5000, "you 事件");
          eq(you.player.pid, j.player.pid, "you.player.pid");
          eq(you.player.status, "won", "you.player.status 应为 won");
          ok(you.player.prize, "you.player.prize 应下发");
        } finally {
          playerSSE.close();
        }
      } finally {
        hostSSE.close();
      }
    });

    await t("N4 SSE 断线重连后立即收到 hello + session（刷新恢复）", async () => {
      const cid = newCid("reconnect");
      const first = openSSE("/api/stream?cid=" + cid + "&role=host");
      await first.next((e) => e.t === "hello", 4000, "首次 hello");
      first.close();
      await sleep(200);
      const second = openSSE("/api/stream?cid=" + cid + "&role=host");
      try {
        const hello = await second.next((e) => e.t === "hello", 4000, "重连 hello");
        ok(hello.session && hello.session.roomCode, "重连 hello 应携带 session");
        eq(hello.role, "host", "重连 hello.role");
        await setConfig({ title: "重连同步标题" });
        const ev = await second.next(
          (e) => e.t === "session" && e.session && e.session.config.title === "重连同步标题",
          4000,
          "重连后 session 推送"
        );
        eq(ev.session.config.title, "重连同步标题", "重连后应继续收到 session");
      } finally {
        second.close();
        await setConfig({ title: "龙腾新春 · 年会抽奖" });
      }
    });

    await t("N5 同 cid 不同 role（大屏 + 后台同机）互不踢线；同 role 重连替换旧连接（§5）", async () => {
      const cid = newCid("dup");
      const hostA = openSSE("/api/stream?cid=" + encodeURIComponent(cid) + "&role=host");
      const adminB = openSSE("/api/stream?cid=" + encodeURIComponent(cid) + "&role=admin", cookie);
      let hostC = null;
      try {
        await hostA.next((e) => e.t === "hello", 4000, "host A hello");
        await adminB.next((e) => e.t === "hello", 4000, "admin B hello");
        await sleep(700);
        eq(hostA.ended, false, "同 cid 的 host 连接不应被 admin 连接踢掉（§5 互不踢线）");
        eq(adminB.ended, false, "同 cid 的 admin 连接不应被踢掉");
        // 同 role 同 cid 再次连接 → 替换旧连接（EventSource 重连语义）
        hostC = openSSE("/api/stream?cid=" + encodeURIComponent(cid) + "&role=host");
        await hostC.next((e) => e.t === "hello", 4000, "host C hello");
        await sleep(700);
        eq(hostA.ended, true, "同 cid + 同 role 重连应替换旧连接");
        eq(hostC.ended, false, "新连接应保持在线");
        eq(adminB.ended, false, "admin 连接不受 host 重连影响");
      } finally {
        hostA.close();
        adminB.close();
        if (hostC) hostC.close();
      }
    });

    /* ---------------------------------------------------------------- O 持久化 */
    section("O. 数据持久化：重启后保留配置/库存/中奖名单（§0/§12-9）");

    await t("O1 重启 server.js 后 config/prizes/winners 保留，运行态重置", async () => {
      await setConfig({ title: "持久化标题", maxPlayers: 20, difficulty: "hard" });
      const before = await adminData();
      ok(before.winners.length > 0, "前置条件：应有中奖记录");
      const expect = {
        title: before.config.title,
        maxPlayers: before.config.maxPlayers,
        difficulty: before.config.difficulty,
        prizeCount: before.prizes.length,
        awarded: before.prizes.reduce((s, p) => s + p.awarded, 0),
        winners: before.winners.length
      };
      await stopServer();
      await startServer();
      await sleep(300);
      // 重启后内存 token 失效，需要重新登录
      cookie = null;
      await loginOk();
      const after = await adminData();
      eq(after.config.title, expect.title, "重启后标题应保留");
      eq(after.config.maxPlayers, expect.maxPlayers, "重启后人数上限应保留");
      eq(after.config.difficulty, expect.difficulty, "重启后难度应保留");
      eq(after.prizes.length, expect.prizeCount, "重启后奖品数量应保留");
      eq(after.prizes.reduce((s, p) => s + p.awarded, 0), expect.awarded, "重启后库存扣减应保留");
      eq(after.winners.length, expect.winners, "重启后中奖名单应保留");
      eq(after.session.phase, "lobby", "重启后运行态应为 lobby");
      eq(after.players.length, 0, "重启后玩家（内存）应为空");
      const s = await fetchSession();
      ok(/^\d{6}$/.test(s.roomCode), "重启后应有新的 6 位房间号");
    });

    /* ---------------------------------------------------------------- P 环境 */
    section("P. 环境隔离与日志健康");

    await t("P1 测试数据隔离：不污染项目正式 data/ 目录", async () => {
      eq(fs.existsSync(projectDataDir), projectDataExisted, "测试过程创建/删除了项目 data/ 目录（污染正式数据）");
      ok(path.resolve(DATA_DIR).indexOf(path.join(ROOT, "_tmp", "qa")) === 0, "DATA_DIR 必须位于 _tmp/qa/");
      ok(fs.existsSync(path.join(DATA_DIR, "state.json")), "测试数据目录应有 state.json 落盘");
    });

    await t("P2 服务端日志无未处理异常 / 崩溃堆栈", async () => {
      const bad = ["未处理异常", "uncaughtException", "unhandledRejection", "请求处理失败"];
      const hits = bad.filter((k) => serverLog.indexOf(k) >= 0);
      if (hits.length) {
        const tail = serverLog.slice(-2500);
        throw new Error("服务端日志出现异常关键字 " + fmt(hits) + "，日志尾部：\n" + tail);
      }
    });

    await t("P3 测试完成后服务仍健康（无资源泄漏导致失活）", async () => {
      const r = await GET("/api/health");
      expectStatus(r, 200, "最终 health");
      eq(r.json.ok, true, "最终 health.ok");
    });
  } finally {
    /* 收尾：关闭服务、清理临时数据 */
    await stopServer();
    if (!KEEP) {
      try {
        fs.rmSync(DATA_DIR, { recursive: true, force: true });
      } catch (e) {}
    }
    try {
      fs.mkdirSync(TMP, { recursive: true });
      fs.writeFileSync(
        path.join(TMP, "smoke-result.json"),
        JSON.stringify({ at: new Date().toISOString(), stats: stats, results: results, warnings: warnings }, null, 2),
        "utf8"
      );
    } catch (e) {}
  }

  /* 汇总 */
  console.log("\n" + "═".repeat(70));
  console.log("  冒烟测试结果: " + c(C.green, stats.pass + " 通过") + " / " + (stats.fail ? c(C.red, stats.fail + " 失败") : "0 失败") +
    " / " + (warnings.length ? c(C.yellow, warnings.length + " 提示") : "0 提示"));
  if (stats.fail) {
    console.log("\n  失败项:");
    results.filter((r) => !r.ok).forEach((r, i) => console.log("   " + (i + 1) + ". " + r.name + "\n      " + String(r.error).split("\n").join("\n      ")));
    console.log("\n  服务端日志尾部:\n" + c(C.gray, serverLog.slice(-3000).split("\n").slice(-40).join("\n")));
  }
  if (warnings.length) {
    console.log("\n  提示/待改进项:");
    warnings.forEach((w, i) => console.log("   " + (i + 1) + ". " + w.split("\n").join("\n      ")));
  }
  console.log("  结果明细已写入: " + path.join(TMP, "smoke-result.json"));
  console.log("═".repeat(70) + "\n");
  process.exitCode = stats.fail ? 1 : 0;
}

process.on("exit", () => {
  try {
    if (child) child.kill();
  } catch (e) {}
});

main().catch(async (err) => {
  console.error("\n" + c(C.red, "✗ 冒烟测试未完成：") + (err && err.stack ? err.stack : err));
  try {
    if (child) child.kill();
  } catch (e) {}
  process.exit(1);
});
