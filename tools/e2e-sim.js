#!/usr/bin/env node
"use strict";

/* ==========================================================================
   新春年会抽奖系统 · QA 并发仿真（30 人规模，零第三方依赖）

   用法：
     node tools/e2e-sim.js                 # 默认 8790 端口
     QA_PORT=8790 node tools/e2e-sim.js

   行为：
   - 自己 fork 起 server.js（PORT=8790、DATA_DIR=_tmp/qa/data-e2e），等待 /api/health 就绪；
   - 场景 1：30 名玩家并发加入 → 并发开赛 → 60%（18 人）中奖、40%（12 人）失败并发提交；
   - 校验：库存扣减总量 = 中奖人数、winners 长度与名单一致、stats 一致、无 500、
           无重复 pid、30 并发下 session 快照一致、无服务端异常日志；
   - 场景 2：一键全中奖把库存打空，校验福袋安慰奖（console consolation）数量与库存一致性；
   - 测试结束 kill 子进程并清理临时数据（QA_KEEP=1 保留现场）；
   - 不依赖已运行服务，不读写项目正式 data/。

   退出码：0 = 全部通过；1 = 存在断言失败。
   ========================================================================== */

const http = require("http");
const net = require("net");
const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");

const ROOT = path.resolve(__dirname, "..");
const PORT = Number(process.env.QA_PORT || 8790);
const HOST = "127.0.0.1";
const TMP = path.join(ROOT, "_tmp", "qa");
const DATA_DIR = path.join(TMP, "data-e2e");
const KEEP = process.env.QA_KEEP === "1";

const PLAYER_COUNT = 30;
const WIN_RATE = 0.6;
const WINNER_COUNT = Math.round(PLAYER_COUNT * WIN_RATE); // 18

/* ------------------------------------------------------------------ 日志/断言 */
const useColor = process.stdout.isTTY;
const COL = {
  reset: "\x1b[0m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  cyan: "\x1b[36m",
  gray: "\x1b[90m"
};
function c(code, s) {
  return useColor ? code + s + COL.reset : s;
}
const checks = [];
let pass = 0;
let fail = 0;

function log(msg) {
  console.log(msg);
}
function head(msg) {
  console.log("\n" + c(COL.cyan, "── " + msg + " " + "─".repeat(Math.max(0, 62 - msg.length))));
}
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
function eq(actual, expected, msg) {
  if (actual !== expected) {
    const f = (v) => {
      try {
        return typeof v === "string" ? JSON.stringify(v) : JSON.stringify(v);
      } catch (e) {
        return String(v);
      }
    };
    throw new Error(msg + "\n  期望: " + f(expected) + "\n  实际: " + f(actual));
  }
}
function fmt(v) {
  try {
    const s = JSON.stringify(v);
    return s && s.length > 400 ? s.slice(0, 400) + "…" : String(s);
  } catch (e) {
    return String(v);
  }
}
function show(res) {
  const body = res.text.length > 600 ? res.text.slice(0, 600) + "…" : res.text;
  return "HTTP " + res.status + "\n  " + body.replace(/\n/g, "\n  ");
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/* ------------------------------------------------------------------ HTTP */
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
      { host: HOST, port: PORT, path: pathname, method: method, headers: headers, timeout: opts.timeout || 20000 },
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
          resolve({ status: res.statusCode, headers: res.headers, text: text, json: json, buf: buf, error: null });
        });
        res.on("error", (err) => resolve({ status: 0, headers: {}, text: "", json: null, error: err }));
      }
    );
    req.on("timeout", () => req.destroy(new Error("请求超时")));
    req.on("error", (err) => resolve({ status: 0, headers: {}, text: "", json: null, error: err }));
    if (payload !== null) req.write(payload);
    req.end();
  });
}

/* ------------------------------------------------------------------ 服务生命周期 */
let child = null;
let serverLog = "";

function childEnv() {
  const env = Object.assign({}, process.env);
  delete env.HOST_IP;
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
      throw new Error("被测服务提前退出，日志：\n" + serverLog.slice(-3000));
    }
    const r = await httpReq("GET", "/api/health", { timeout: 2000 });
    if (r.status === 200 && r.json && r.json.ok) return r.json;
    await sleep(100);
  }
  throw new Error("被测服务启动超时，日志：\n" + serverLog.slice(-3000));
}

async function startServer() {
  child = spawn(process.execPath, ["server.js"], {
    cwd: ROOT,
    env: childEnv(),
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true
  });
  child.stdout.on("data", (d) => (serverLog += d.toString("utf8")));
  child.stderr.on("data", (d) => (serverLog += d.toString("utf8")));
  return waitReady(25000);
}

function stopServer() {
  return new Promise((resolve) => {
    const c = child;
    child = null;
    if (!c || c.exitCode !== null) return resolve();
    let done = false;
    const finish = () => {
      if (!done) {
        done = true;
        resolve();
      }
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
let cidBase = "sim_" + Date.now().toString(36) + "_";

async function fetchSession() {
  const r = await httpReq("GET", "/api/state");
  ok(r.status === 200 && r.json && r.json.session, "GET /api/state 失败: " + show(r));
  return r.json.session;
}

async function adminAction(type, extra) {
  return httpReq("POST", "/api/admin/action", { body: Object.assign({ type: type }, extra || {}), cookie: cookie });
}

async function adminData() {
  const r = await httpReq("GET", "/api/admin/data", { cookie: cookie });
  ok(r.status === 200 && r.json, "GET /api/admin/data 失败: " + show(r));
  return r.json;
}

async function login(pin) {
  const r = await httpReq("POST", "/api/admin/login", { body: { pin: pin || "8888" } });
  ok(r.status === 200, "后台登录失败: " + show(r));
  const sc = r.headers["set-cookie"];
  ok(sc && sc[0], "后台登录未下发 cookie");
  cookie = String(sc[0]).split(";")[0];
}

async function mustAdmin(type, extra) {
  const r = await adminAction(type, extra);
  ok(r.status === 200, "后台操作 " + type + " 失败: " + show(r));
  return r.json;
}

async function setConfig(patch) {
  return mustAdmin("config.set", patch);
}

function winWaves(game) {
  return game.waves.map((w) => ({
    cleared: true,
    hits: w.len,
    strikes: 0,
    ms: w.len * w.showMs + (w.len - 1) * w.gapMs + 400
  }));
}

function loseWaves(game) {
  const waves = winWaves(game);
  const last = game.waves.length - 1;
  waves[last] = {
    cleared: false,
    hits: Math.max(0, game.waves[last].len - 1),
    strikes: 1,
    ms: game.waves[last].len * game.waves[last].showMs +
      (game.waves[last].len - 1) * game.waves[last].gapMs + 400
  };
  return waves;
}

async function getGame(players) {
  const p = players[0];
  const r = await httpReq("POST", "/api/rejoin", {
    body: { cid: p.cid, pid: p.player.pid, token: p.player.token },
    timeout: 5000
  });
  ok(r.status === 200 && r.json && r.json.game, "rejoin 取 game 失败: " + show(r));
  return r.json.game;
}

/** 并发加入 n 名玩家 */
async function joinPlayers(n, tag) {
  const session = await fetchSession();
  const code = session.roomCode;
  const tasks = [];
  for (let i = 0; i < n; i++) {
    const idx = String(i + 1).padStart(2, "0");
    tasks.push(
      httpReq("POST", "/api/join", {
        body: {
          cid: cidBase + tag + "_" + idx,
          code: code,
          name: tag + "玩家" + idx,
          avatar: ["🐲", "🦁", "🐯", "🐰", "🐮", "🐴", "🐷", "🐵", "🐶", "🐱"][i % 10]
        }
      })
    );
  }
  const results = await Promise.all(tasks);
  const joined = [];
  results.forEach((r, i) => {
    ok(r.status === 200, "玩家 " + (i + 1) + " 并发加入失败: " + show(r));
    ok(r.json && r.json.ok === true && r.json.player, "玩家 " + (i + 1) + " 加入响应异常: " + show(r));
    joined.push({ cid: cidBase + tag + "_" + String(i + 1).padStart(2, "0"), player: r.json.player, res: r });
  });
  return { code: code, players: joined, results: results };
}

/** 并发提交成绩，返回每个玩家的响应 */
async function submitAll(players, game, winnerCount, names) {
  const tasks = players.map((p, i) => {
    const win = i < winnerCount;
    const waves = win ? winWaves(game) : loseWaves(game);
    return httpReq("POST", "/api/game/result", {
      body: {
        cid: p.cid,
        pid: p.player.pid,
        token: p.player.token,
        waves: waves,
        score: Math.round(1000 + i * 13.7)
      },
      timeout: 15000
    });
  });
  return Promise.all(tasks);
}

/* ==========================================================================
   主流程
   ========================================================================== */
async function main() {
  log(c(COL.cyan, "\n🏮 新春年会抽奖系统 · QA 并发仿真（30 人）"));
  log(c(COL.gray, "   项目目录: " + ROOT));
  log(c(COL.gray, "   被测端口: " + PORT + "   数据目录: " + DATA_DIR));

  const projectDataDir = path.join(ROOT, "data");
  const projectDataExisted = fs.existsSync(projectDataDir);
  ok(path.resolve(DATA_DIR).startsWith(path.join(ROOT, "_tmp")), "DATA_DIR 必须位于 _tmp 下");

  if (await portInUse(PORT)) {
    throw new Error("端口 " + PORT + " 已被占用。请先关闭占用进程（本脚本会自己起服务）。");
  }
  fs.rmSync(DATA_DIR, { recursive: true, force: true });
  fs.mkdirSync(DATA_DIR, { recursive: true });

  let health = null;
  try {
    health = await startServer();
    await sleep(200);
    await login("8888");

    /* ---------------------------------------------------------- 场景 1 */
    head("场景 1：30 人并发加入 → 开赛 → 60% 中奖并发提交");

    let joinInfo = null;
    let game = null;

    await check("1.1 30 名玩家并发加入全部成功（无 500 / 无重复 pid / 无重复 token）", async () => {
      const t0 = Date.now();
      joinInfo = await joinPlayers(PLAYER_COUNT, "A");
      const joinMs = Date.now() - t0;
      const statuses = {};
      joinInfo.results.forEach((r) => {
        statuses[r.status] = (statuses[r.status] || 0) + 1;
      });
      eq(statuses[200], PLAYER_COUNT, "应全部 200，实际状态分布 " + fmt(statuses));
      const pids = joinInfo.players.map((p) => p.player.pid);
      const tokens = joinInfo.players.map((p) => p.player.token);
      const names = joinInfo.players.map((p) => p.player.name);
      eq(new Set(pids).size, PLAYER_COUNT, "pid 出现重复！");
      eq(new Set(tokens).size, PLAYER_COUNT, "token 出现重复！");
      eq(new Set(names).size, PLAYER_COUNT, "昵称出现重复！");
      ok(joinMs < 10000, "30 人并发加入耗时过长: " + joinMs + "ms");
      const session = await fetchSession();
      eq(session.players.length, PLAYER_COUNT, "session.players 应为 30");
      eq(session.stats.joined, PLAYER_COUNT, "stats.joined 应为 30");
      eq(session.phase, "lobby", "加入后仍为 lobby");
      ok(session.players.every((p) => !("token" in p)), "session.players 泄露 token");
      log(c(COL.gray, "      30 人并发加入耗时 " + joinMs + "ms"));
    });

    await check("1.2 人数达到上限后第 31 人加入被拒（ROOM_FULL）", async () => {
      const session = await fetchSession();
      const r = await httpReq("POST", "/api/join", {
        body: { cid: cidBase + "A_overflow", code: session.roomCode, name: "溢出玩家" }
      });
      eq(r.status, 400, "第 31 人应被拒，实际 " + show(r));
      eq(r.json && r.json.code, "ROOM_FULL", "第 31 人错误码");
      const s = await fetchSession();
      eq(s.players.length, PLAYER_COUNT, "拒绝后玩家数不应变化");
    });

    await check("1.3 并发开赛（3 次同时 session.start，仅 1 次成功）", async () => {
      const rs = await Promise.all([
        adminAction("session.start"),
        adminAction("session.start"),
        adminAction("session.start")
      ]);
      const okCount = rs.filter((r) => r.status === 200).length;
      eq(okCount, 1, "并发开赛应只有 1 次成功，实际成功 " + okCount + " 次；响应: " + fmt(rs.map((r) => ({ s: r.status, c: r.json && r.json.code }))));
      const session = await fetchSession();
      eq(session.phase, "playing", "开赛后 phase 应为 playing");
      eq(session.players.length, PLAYER_COUNT, "开赛后玩家数");
      eq(session.stats.playing, PLAYER_COUNT, "stats.playing 应为 30");
      ok(/^s_[0-9a-f]+$/.test(session.sessionId), "sessionId 异常");
      game = await getGame(joinInfo.players);
      ok(Array.isArray(game.waves) && game.waves.length >= 1, "game.waves 异常");
      eq(game.difficulty, session.difficulty.key, "game.difficulty 应与 session 一致");
    });

    await check("1.4 开赛后中途加入被拒（GAME_STARTED）", async () => {
      const session = await fetchSession();
      const r = await httpReq("POST", "/api/join", {
        body: { cid: cidBase + "A_late", code: session.roomCode, name: "迟到玩家" }
      });
      eq(r.status, 400, "开赛后加入应被拒: " + show(r));
      eq(r.json && r.json.code, "GAME_STARTED", "开赛后加入错误码");
    });

    await check("1.5 30 人并发提交成绩：全部 200、无 500、中奖数 = 18", async () => {
      const t0 = Date.now();
      const results = await submitAll(joinInfo.players, game, WINNER_COUNT, null);
      const submitMs = Date.now() - t0;
      const statuses = {};
      const codes = {};
      results.forEach((r) => {
        statuses[r.status] = (statuses[r.status] || 0) + 1;
        if (r.json && r.json.code) codes[r.json.code] = (codes[r.json.code] || 0) + 1;
        ok(r.status !== 500, "出现 500 响应: " + show(r));
        ok(r.status < 400 || (r.json && r.json.ok === false), "非预期响应: " + show(r));
      });
      eq(statuses[200], PLAYER_COUNT, "30 人提交应全部 200，实际 " + fmt(statuses) + " codes=" + fmt(codes));
      const wins = results.filter((r) => r.json && r.json.win === true).length;
      const losses = results.filter((r) => r.json && r.json.win === false).length;
      eq(wins, WINNER_COUNT, "中奖人数应为 " + WINNER_COUNT + "，实际 " + wins);
      eq(losses, PLAYER_COUNT - WINNER_COUNT, "未中奖人数");
      ok(submitMs < 15000, "30 人并发提交耗时过长: " + submitMs + "ms");
      log(c(COL.gray, "      30 人并发提交耗时 " + submitMs + "ms（中奖 " + wins + " / 未中奖 " + losses + "）"));
    });

    await check("1.6 库存扣减总量 = 中奖人数，且每项 awarded/remaining 自洽", async () => {
      const d = await adminData();
      const totalAwarded = d.prizes.reduce((s, p) => s + p.awarded, 0);
      eq(totalAwarded, WINNER_COUNT, "库存扣减总量应等于中奖人数 " + WINNER_COUNT + "，实际 " + totalAwarded);
      const totalQty = d.prizes.reduce((s, p) => s + p.quantity, 0);
      ok(totalAwarded <= totalQty, "已发数超过总量: " + totalAwarded + " > " + totalQty);
      d.prizes.forEach((p) => {
        eq(p.remaining, Math.max(0, p.quantity - p.awarded), "奖品 " + p.name + " remaining 计算错误");
        ok(p.awarded >= 0, "奖品 " + p.name + " awarded 为负");
      });
      eq(d.session.stats.awardedPrizes, totalAwarded, "session.stats.awardedPrizes 与库存不一致");
    });

    await check("1.7 winners 长度 = 中奖人数，名单与玩家一一对应且无重复", async () => {
      const d = await adminData();
      eq(d.winners.length, WINNER_COUNT, "winners 长度应为 " + WINNER_COUNT + "，实际 " + d.winners.length);
      const winnerPids = d.winners.map((w) => w.pid);
      eq(new Set(winnerPids).size, WINNER_COUNT, "winners 中出现重复 pid");
      const winnerNames = new Set(d.winners.map((w) => w.name));
      const expectNames = joinInfo.players.slice(0, WINNER_COUNT).map((p) => p.player.name);
      expectNames.forEach((n) => ok(winnerNames.has(n), "中奖名单缺少玩家 " + n));
      joinInfo.players.slice(WINNER_COUNT).forEach((p) => {
        ok(!winnerNames.has(p.player.name), "未中奖玩家 " + p.player.name + " 出现在中奖名单");
      });
      d.winners.forEach((w) => {
        ok(w.prize && w.prize.name, "winner 缺少 prize: " + fmt(w));
        ok(typeof w.at === "number" && Date.now() - w.at < 120000, "winner.at 异常: " + fmt(w.at));
        eq(w.difficulty, d.session.difficulty.key, "winner.difficulty 与当前难度不一致");
      });
    });

    await check("1.8 30 并发下的 session 快照一致（房间号/人数/stats 一致）", async () => {
      const tasks = joinInfo.players.map((p) =>
        httpReq("GET", "/api/state?cid=" + encodeURIComponent(p.cid), { timeout: 10000 })
      );
      const rs = await Promise.all(tasks);
      rs.forEach((r, i) => ok(r.status === 200 && r.json && r.json.session, "第 " + (i + 1) + " 个玩家拉取 session 失败: " + show(r)));
      const snapshots = rs.map((r) => r.json.session);
      const codes = new Set(snapshots.map((s) => s.roomCode));
      eq(codes.size, 1, "同一时刻房间号不一致: " + fmt(Array.from(codes)));
      const counts = new Set(snapshots.map((s) => s.players.length));
      eq(counts.size, 1, "同一时刻玩家数不一致: " + fmt(Array.from(counts)));
      eq(Array.from(counts)[0], PLAYER_COUNT, "快照玩家数应为 30");
      const winStats = new Set(snapshots.map((s) => s.stats.wins));
      eq(winStats.size, 1, "同一时刻 stats.wins 不一致: " + fmt(Array.from(winStats)));
      eq(Array.from(winStats)[0], WINNER_COUNT, "stats.wins 应为 " + WINNER_COUNT);
      const lossStats = new Set(snapshots.map((s) => s.stats.losses));
      eq(lossStats.size, 1, "stats.losses 不一致: " + fmt(Array.from(lossStats)));
      eq(Array.from(lossStats)[0], PLAYER_COUNT - WINNER_COUNT, "stats.losses 应为 " + (PLAYER_COUNT - WINNER_COUNT));
      const phases = new Set(snapshots.map((s) => s.phase));
      ok(
        Array.from(phases).every((p) => p === "playing" || p === "reveal"),
        "phase 应仅为 playing/reveal，实际 " + fmt(Array.from(phases))
      );
      // 每个玩家 you 字段应为其本人
      snapshots.forEach((s, i) => {
        ok(s.stats.joined === PLAYER_COUNT, "玩家 " + (i + 1) + " 快照 stats.joined 应为 30");
      });
      // 快照 serverTime 偏差应在合理范围
      const times = snapshots.map((s) => s.serverTime);
      ok(Math.max.apply(null, times) - Math.min.apply(null, times) < 10000, "30 个快照 serverTime 偏差过大: " + fmt(Math.min.apply(null, times)) + "~" + fmt(Math.max.apply(null, times)));
    });

    await check("1.9 全员提交后自动 reveal，运行态 stats 收敛", async () => {
      const t0 = Date.now();
      let session = await fetchSession();
      while (session.phase !== "reveal" && Date.now() - t0 < 8000) {
        await sleep(120);
        session = await fetchSession();
      }
      eq(session.phase, "reveal", "全员提交后应自动进入 reveal，实际 " + session.phase);
      ok(Date.now() - t0 <= 8000, "自动 reveal 超时");
      ok(typeof session.revealAt === "number" && session.revealAt > 0, "revealAt 应下发");
      eq(session.stats.wins, WINNER_COUNT, "reveal 后 stats.wins");
      eq(session.stats.losses, PLAYER_COUNT - WINNER_COUNT, "reveal 后 stats.losses");
      const d = await adminData();
      eq(d.players.filter((p) => p.status === "won").length, WINNER_COUNT, "won 玩家数");
      eq(d.players.filter((p) => p.status === "lost").length, PLAYER_COUNT - WINNER_COUNT, "lost 玩家数");
      const before = await adminData();
      eq(before.prizes.reduce((s, p) => s + p.awarded, 0), WINNER_COUNT, "reveal 不应再改库存");
    });

    /* ---------------------------------------------------------- 场景 2 */
    head("场景 2：一键全中奖把库存打空 → 福袋安慰奖");

    const STOCK = 5;
    await check("2.1 准备：重置、清空中奖名单并仅保留 5 件库存", async () => {
      await mustAdmin("session.reset");
      await setConfig({ difficulty: "easy" });
      await mustAdmin("prize.reseed");
      await mustAdmin("winner.clear");
      const d = await adminData();
      // 第一项保留 5 件，其余清零
      for (let i = 0; i < d.prizes.length; i++) {
        const q = i === 0 ? STOCK : 0;
        const r = await adminAction("prize.update", { id: d.prizes[i].id, quantity: q });
        ok(r.status === 200, "设置库存失败: " + show(r));
      }
      const after = await adminData();
      const totalQty = after.prizes.reduce((s, p) => s + p.quantity, 0);
      eq(totalQty, STOCK, "总库存应为 " + STOCK + "，实际 " + totalQty);
      eq(after.prizes.reduce((s, p) => s + p.awarded, 0), 0, "准备阶段已发数应为 0");
    });

    await check("2.2 30 人并发加入并开赛", async () => {
      joinInfo = await joinPlayers(PLAYER_COUNT, "B");
      const session = await fetchSession();
      eq(session.players.length, PLAYER_COUNT, "场景 2 玩家数应为 30");
      const r = await adminAction("session.start");
      eq(r.status, 200, "场景 2 开赛失败: " + show(r));
      game = await getGame(joinInfo.players);
      eq(game.difficulty, "easy", "场景 2 难度应为 easy");
    });

    await check("2.3 30 人全中奖并发提交：5 人拿真奖品，25 人福袋", async () => {
      const results = await submitAll(joinInfo.players, game, PLAYER_COUNT, null);
      const statuses = {};
      results.forEach((r) => {
        statuses[r.status] = (statuses[r.status] || 0) + 1;
      });
      eq(statuses[200], PLAYER_COUNT, "30 人应全部 200，实际 " + fmt(statuses));
      const wins = results.filter((r) => r.json && r.json.win === true).length;
      eq(wins, PLAYER_COUNT, "应 30 人全部中奖，实际 " + wins);
      const real = results.filter((r) => r.json && r.json.prize && !r.json.prize.consolation);
      const cons = results.filter((r) => r.json && r.json.prize && r.json.prize.consolation);
      eq(real.length, STOCK, "真奖品数量应等于库存 " + STOCK + "，实际 " + real.length);
      eq(cons.length, PLAYER_COUNT - STOCK, "福袋数量应为 " + (PLAYER_COUNT - STOCK) + "，实际 " + cons.length);
      cons.forEach((r) => {
        eq(r.json.prize.name, "新春福袋", "福袋名称");
        eq(r.json.prize.id, null, "福袋 id 应为 null");
        eq(r.json.prize.emoji, "🧧", "福袋 emoji");
      });
      const d = await adminData();
      const totalAwarded = d.prizes.reduce((s, p) => s + p.awarded, 0);
      eq(totalAwarded, STOCK, "库存打空后 awarded 总量应等于库存 " + STOCK + "，实际 " + totalAwarded);
      eq(d.prizes.reduce((s, p) => s + p.remaining, 0), 0, "剩余库存应全部为 0");
      eq(d.winners.length, PLAYER_COUNT, "winners 应为 30（含福袋）");
      eq(d.winners.filter((w) => w.prize.consolation === true).length, PLAYER_COUNT - STOCK, "winners 中福袋数量");
      eq(d.session.stats.wins, PLAYER_COUNT, "stats.wins 应为 30");
    });

    await check("2.4 打空库存后自动 reveal，且无 500 / 服务端无异常", async () => {
      const t0 = Date.now();
      let session = await fetchSession();
      while (session.phase !== "reveal" && Date.now() - t0 < 8000) {
        await sleep(150);
        session = await fetchSession();
      }
      eq(session.phase, "reveal", "场景 2 应自动 reveal，实际 " + session.phase);
      const bad = ["未处理异常", "uncaughtException", "unhandledRejection", "请求处理失败"].filter(
        (k) => serverLog.indexOf(k) >= 0
      );
      if (bad.length) {
        throw new Error("服务端日志出现异常关键字 " + fmt(bad) + "\n日志尾部:\n" + serverLog.slice(-2000));
      }
    });

    await check("2.5 测试数据隔离：未污染项目 data/，本项目临时目录落盘正常", async () => {
      eq(fs.existsSync(projectDataDir), projectDataExisted, "测试过程创建/删除了项目 data/ 目录");
      ok(fs.existsSync(path.join(DATA_DIR, "state.json")), "临时数据目录应有 state.json 落盘");
      ok(path.resolve(DATA_DIR).indexOf(path.join(ROOT, "_tmp", "qa")) === 0, "DATA_DIR 必须位于 _tmp/qa/");
    });
  } finally {
    await stopServer();
    if (!KEEP) {
      try {
        fs.rmSync(DATA_DIR, { recursive: true, force: true });
      } catch (e) {}
    }
    try {
      fs.mkdirSync(TMP, { recursive: true });
      fs.writeFileSync(
        path.join(TMP, "e2e-result.json"),
        JSON.stringify(
          {
            at: new Date().toISOString(),
            playerCount: PLAYER_COUNT,
            winRate: WIN_RATE,
            checks: checks
          },
          null,
          2
        ),
        "utf8"
      );
    } catch (e) {}
  }

  console.log("\n" + "═".repeat(70));
  console.log("  并发仿真结果: " + c(COL.green, pass + " 通过") + " / " + (fail ? c(COL.red, fail + " 失败") : "0 失败"));
  if (fail) {
    checks
      .filter((x) => !x.ok)
      .forEach((x, i) => console.log("   " + (i + 1) + ". " + x.name + "\n      " + String(x.error).split("\n").join("\n      ")));
    console.log("\n  服务端日志尾部:\n" + c(COL.gray, serverLog.slice(-2500)));
  }
  console.log("  结果明细已写入: " + path.join(TMP, "e2e-result.json"));
  console.log("═".repeat(70) + "\n");
  process.exitCode = fail ? 1 : 0;
}

process.on("exit", () => {
  try {
    if (child) child.kill();
  } catch (e) {}
});

main().catch((err) => {
  console.error("\n" + c(COL.red, "✗ 并发仿真未完成：") + (err && err.stack ? err.stack : err));
  try {
    if (child) child.kill();
  } catch (e) {}
  process.exit(1);
});
