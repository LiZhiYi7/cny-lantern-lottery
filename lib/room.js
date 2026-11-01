"use strict";

const { AppError, randomHex, randomDigits, clampInt } = require("./util");
const difficulty = require("./difficulty");

const AVATARS = ["🐲", "🦁", "🐯", "🐰", "🐮", "🐴", "🐷", "🐵", "🐶", "🐱", "🦊", "🐼", "🐔"];
const AWARD_RULES = ["lowFirst", "highFirst", "random"];

function publicPlayer(p) {
  return {
    pid: p.pid,
    name: p.name,
    avatar: p.avatar,
    status: p.status,
    ready: !!p.ready,
    wave: p.wave || 0,
    score: p.score || 0,
    result: p.result || null,
    prize: p.prize || null
  };
}

function nameLength(s) {
  return Array.from(String(s)).length;
}

class Room {
  constructor(opts) {
    this.store = opts.store;
    this.hub = opts.hub;
    this.urls = opts.urls || function () {
      return { joinUrl: "", hostUrl: "" };
    };
    this.players = new Map();
    this.phase = "lobby"; // lobby | playing | reveal
    this.roomCode = randomDigits(6);
    this.sessionId = "";
    this.startAt = null;
    this.revealAt = null;
    this.game = null;
    this._snapshotTimer = null;
    this._revealTimer = null;
    this._watchdog = null;
    this._autoRevealed = false;
  }

  get config() {
    return this.store.config;
  }

  /* ---------------- 查询 ---------------- */

  urlsNow() {
    try {
      return this.urls() || {};
    } catch (e) {
      return { joinUrl: "", hostUrl: "" };
    }
  }

  findByCid(cid) {
    if (!cid) return null;
    for (const p of this.players.values()) if (p.cid === cid) return p;
    return null;
  }

  requirePlayer(pid, token) {
    const p = this.players.get(pid);
    if (!p) throw new AppError("PLAYER_NOT_FOUND", "玩家不存在，请重新扫码进入", 404);
    if (token && p.token !== token) throw new AppError("BAD_TOKEN", "身份校验失败，请重新进入", 403);
    return p;
  }

  attachPlayer(cid, pid, token) {
    const p = this.players.get(pid);
    if (!p || p.token !== token) return null;
    if (cid) p.cid = cid;
    return p;
  }

  /* ---------------- 加入 / 重连 ---------------- */

  join(input) {
    const body = input || {};
    const cid = String(body.cid || "").trim();
    if (!cid) throw new AppError("BAD_INPUT", "缺少客户端标识，请刷新页面重试");
    if (this.phase !== "lobby") {
      throw new AppError("GAME_STARTED", "本轮已经开始了，请等待主持人开启下一轮");
    }
    const code = String(body.code || "").trim();
    if (code !== this.roomCode) {
      throw new AppError("BAD_CODE", "房间号不正确，请核对大屏上的 6 位数字");
    }
    const name = String(body.name || "").trim().replace(/\s+/g, " ");
    if (!nameLength(name)) throw new AppError("BAD_NAME", "请给自己起个昵称");
    if (nameLength(name) > 12) throw new AppError("BAD_NAME", "昵称最多 12 个字");

    // 同一标签页重复提交 → 直接返回已有玩家，避免重复占位
    const existing = this.findByCid(cid);
    if (existing) return existing;

    if (this.players.size >= this.config.maxPlayers) {
      throw new AppError("ROOM_FULL", "房间人数已满（" + this.config.maxPlayers + " 人），请等待空位");
    }

    let avatar = String(body.avatar || "").slice(0, 8);
    if (AVATARS.indexOf(avatar) < 0) avatar = AVATARS[this.players.size % AVATARS.length];

    const player = {
      pid: "pl_" + randomHex(5),
      token: randomHex(16),
      cid,
      name,
      avatar,
      status: "joined",
      ready: false,
      wave: 0,
      score: 0,
      result: null,
      prize: null,
      joinedAt: Date.now()
    };
    this.players.set(player.pid, player);
    this.pushSession();
    return player;
  }

  rejoin(input) {
    const body = input || {};
    const p = this.requirePlayer(body.pid, body.token);
    if (body.cid) p.cid = String(body.cid);
    if (this.phase === "playing" && p.status === "joined") p.status = "playing";
    this.pushSession();
    return p;
  }

  setReady(input) {
    const body = input || {};
    const p = this.requirePlayer(body.pid, body.token);
    p.ready = !!body.ready;
    this.pushSession();
    return p;
  }

  /* ---------------- 生命周期 ---------------- */

  start() {
    if (this.phase !== "lobby") throw new AppError("BAD_PHASE", "当前阶段无法开始游戏");
    if (this.players.size < 1) throw new AppError("NO_PLAYERS", "还没有玩家加入，无法开始");
    const diff = difficulty.get(this.config.difficulty);
    this._clearTimers();
    this.phase = "playing";
    this.sessionId = "s_" + randomHex(4);
    this.startAt = Date.now() + 3200;
    this.revealAt = null;
    this._autoRevealed = false;
    this.game = {
      sessionId: this.sessionId,
      startAt: this.startAt,
      seed: Math.floor(Math.random() * 0x7fffffff) + 1,
      difficulty: diff.key,
      maxStrikes: diff.maxStrikes,
      waves: diff.waves.map((w) => ({ ...w })),
      minMs: diff.waves.reduce(
        (sum, w) => sum + (w.len * w.showMs + (w.len - 1) * w.gapMs),
        0
      )
    };
    for (const p of this.players.values()) {
      p.status = "playing";
      p.ready = false;
      p.wave = 0;
      p.score = 0;
      p.result = null;
      p.prize = null;
    }
    this.hub.broadcast({ t: "game", game: this.game });
    this.pushSession(true);
    // 兜底：超时自动开奖
    this._watchdog = setTimeout(() => {
      if (this.phase === "playing") this.reveal();
    }, 120000);
    if (this._watchdog.unref) this._watchdog.unref();
    console.log("[room] 开始游戏", this.sessionId, "难度", diff.key, "人数", this.players.size);
    return this.game;
  }

  submitResult(input) {
    const body = input || {};
    const p = this.requirePlayer(body.pid, body.token);
    if (p.result) {
      return { win: p.result.win, prize: p.prize, player: publicPlayer(p), duplicate: true };
    }
    if (this.phase !== "playing" || !this.game) {
      throw new AppError("BAD_PHASE", "当前不在游戏阶段，无法提交成绩");
    }
    const waves = body.waves;
    if (!Array.isArray(waves) || waves.length !== this.game.waves.length) {
      throw new AppError("BAD_INPUT", "成绩数据不完整");
    }

    let chain = true;
    let clearedCount = 0;
    let totalHits = 0;
    let totalStrikes = 0;
    let totalMs = 0;

    for (let i = 0; i < this.game.waves.length; i++) {
      const cfg = this.game.waves[i];
      const w = waves[i] || {};
      const hits = Number(w.hits);
      const strikes = Number(w.strikes);
      const ms = Number(w.ms);
      // 严格校验：越界/非整数直接拒绝，避免 clamp 后伪造通关
      if (!Number.isInteger(hits) || hits < 0 || hits > cfg.len) {
        throw new AppError("BAD_INPUT", "成绩数据异常（第 " + (i + 1) + " 波命中数越界）");
      }
      if (!Number.isInteger(strikes) || strikes < 0 || strikes > 999) {
        throw new AppError("BAD_INPUT", "成绩数据异常（第 " + (i + 1) + " 波失误数越界）");
      }
      if (!Number.isInteger(ms) || ms < 0 || ms > 600000) {
        throw new AppError("BAD_INPUT", "成绩数据异常（第 " + (i + 1) + " 波耗时越界）");
      }
      // 理论最短耗时（留 250ms 容差），过短视为异常提交
      const minMs = Math.max(0, cfg.len * cfg.showMs + (cfg.len - 1) * cfg.gapMs - 250);
      const cleared =
        chain && !!w.cleared && hits >= cfg.len && strikes <= this.game.maxStrikes && ms >= minMs;
      if (cleared) {
        clearedCount += 1;
      } else {
        chain = false;
      }
      totalHits += hits;
      totalStrikes += strikes;
      totalMs += ms;
    }

    const win = chain && clearedCount === this.game.waves.length;
    const result = {
      win,
      waves: this.game.waves.length,
      cleared: clearedCount,
      hits: totalHits,
      strikes: totalStrikes,
      ms: totalMs,
      score: clampInt(body.score, 0, 99999, 0),
      at: Date.now()
    };

    p.result = result;
    p.wave = clearedCount;
    p.score = result.score;
    p.status = win ? "won" : "lost";

    if (win) this._grant(p);

    this.hub.send(p.cid, { t: "you", player: publicPlayer(p) });
    this.pushSession(true);
    this._maybeAutoReveal();
    return { win, prize: p.prize, player: publicPlayer(p) };
  }

  reveal() {
    if (this.phase !== "playing") throw new AppError("BAD_PHASE", "当前阶段无法开奖");
    this._clearTimers();
    for (const p of this.players.values()) {
      if (p.status !== "playing" && p.status !== "joined") continue;
      p.status = "lost";
      p.result = {
        win: false,
        missed: true,
        waves: 0,
        cleared: 0,
        hits: 0,
        strikes: 0,
        ms: 0,
        score: 0,
        at: Date.now()
      };
      this.hub.send(p.cid, { t: "you", player: publicPlayer(p) });
    }
    this.phase = "reveal";
    this.revealAt = Date.now();
    this.pushSession(true);
    console.log("[room] 开奖，中奖", this.store.winners.length);
  }

  reset() {
    const oldCode = this.roomCode;
    this._clearTimers();
    this.players.clear();
    this.phase = "lobby";
    this.sessionId = "";
    this.startAt = null;
    this.revealAt = null;
    this.game = null;
    this._autoRevealed = false;
    this.roomCode = randomDigits(6);
    this.hub.broadcast({
      t: "toast",
      text: "新一轮开始，房间号 " + this.roomCode + "，请重新扫码加入",
      kind: "info"
    });
    this.pushSession(true);
    console.log("[room] 重置，新房间号", this.roomCode, "（旧", oldCode + "）");
    return { roomCode: this.roomCode, oldCode };
  }

  kick(pid) {
    const p = this.players.get(pid);
    if (!p) throw new AppError("PLAYER_NOT_FOUND", "玩家不存在", 404);
    this.players.delete(pid);
    this.hub.send(p.cid, { t: "kicked", reason: "主持人已将你移出本房间" });
    this.pushSession(true);
    if (this.phase === "playing") this._maybeAutoReveal();
    return publicPlayer(p);
  }

  awardPlayer(pid) {
    const p = this.players.get(pid);
    if (!p) throw new AppError("PLAYER_NOT_FOUND", "玩家不存在", 404);
    if (p.prize) throw new AppError("ALREADY_AWARDED", "该玩家已经中奖了");
    if (!p.result) {
      p.result = {
        win: true,
        manual: true,
        waves: 0,
        cleared: 0,
        hits: 0,
        strikes: 0,
        ms: 0,
        score: 0,
        at: Date.now()
      };
    }
    p.status = "won";
    this._grant(p);
    this.hub.send(p.cid, { t: "you", player: publicPlayer(p) });
    this.pushSession(true);
    return publicPlayer(p);
  }

  /* ---------------- 后台操作 ---------------- */

  setConfig(patch) {
    const body = patch || {};
    const next = {};
    if (body.maxPlayers !== undefined) {
      const n = Number(body.maxPlayers);
      if (!Number.isInteger(n) || n < 1 || n > 200) {
        throw new AppError("BAD_INPUT", "玩家上限需为 1-200 的整数");
      }
      next.maxPlayers = n;
    }
    if (body.difficulty !== undefined) {
      if (!difficulty.isValid(body.difficulty)) throw new AppError("BAD_INPUT", "难度档位不合法");
      next.difficulty = body.difficulty;
    }
    if (body.awardRule !== undefined) {
      if (AWARD_RULES.indexOf(body.awardRule) < 0) throw new AppError("BAD_INPUT", "抽奖规则不合法");
      next.awardRule = body.awardRule;
    }
    if (body.pin !== undefined) {
      if (!/^\d{4,8}$/.test(String(body.pin))) throw new AppError("BAD_INPUT", "后台密码需为 4-8 位数字");
      next.pin = String(body.pin);
    }
    if (body.title !== undefined) {
      const t = String(body.title).trim();
      if (!t || nameLength(t) > 20) throw new AppError("BAD_INPUT", "活动标题需为 1-20 个字");
      next.title = t;
    }
    if (body.subtitle !== undefined) {
      const s = String(body.subtitle).trim();
      if (nameLength(s) > 30) throw new AppError("BAD_INPUT", "副标题最多 30 个字");
      next.subtitle = s;
    }
    this.store.setConfig(next);
    this.pushSession(true);
    return this.store.config;
  }

  addPrize(input) {
    const body = input || {};
    const name = String(body.name || "").trim();
    if (!name || nameLength(name) > 20) throw new AppError("BAD_INPUT", "奖品名称需为 1-20 个字");
    const quantity = Number(body.quantity);
    if (!Number.isInteger(quantity) || quantity < 0 || quantity > 999) {
      throw new AppError("BAD_INPUT", "奖品数量需为 0-999 的整数");
    }
    if (this.store.prizes.length >= 60) throw new AppError("BAD_INPUT", "奖品最多 60 项");
    const p = this.store.addPrize({
      name,
      emoji: String(body.emoji || "🎁").slice(0, 8),
      quantity,
      note: String(body.note || "").slice(0, 60)
    });
    this.pushSession(true);
    return p;
  }

  updatePrize(input) {
    const body = input || {};
    const p = this.store.findPrize(body.id);
    if (!p) throw new AppError("NOT_FOUND", "奖品不存在", 404);
    if (body.name !== undefined) {
      const name = String(body.name).trim();
      if (!name || nameLength(name) > 20) throw new AppError("BAD_INPUT", "奖品名称需为 1-20 个字");
    }
    if (body.quantity !== undefined) {
      const quantity = Number(body.quantity);
      if (!Number.isInteger(quantity) || quantity < 0 || quantity > 999) {
        throw new AppError("BAD_INPUT", "奖品数量需为 0-999 的整数");
      }
    }
    const updated = this.store.updatePrize(body);
    this.pushSession(true);
    return updated;
  }

  removePrize(id) {
    if (!id) throw new AppError("BAD_INPUT", "缺少奖品 id");
    const ok = this.store.removePrize(String(id));
    if (!ok) throw new AppError("NOT_FOUND", "奖品不存在", 404);
    this.pushSession(true);
    return true;
  }

  reseedPrizes() {
    this.store.reseedPrizes();
    this.pushSession(true);
    return this.store.prizes;
  }

  clearWinners() {
    this.store.clearWinners();
    this.pushSession(true);
    return true;
  }

  /* ---------------- 快照 ---------------- */

  snapshot() {
    const u = this.urlsNow();
    const cfg = this.store.config;
    const players = Array.from(this.players.values()).map(publicPlayer);
    const prizes = this.store.prizes.map((p) => ({
      id: p.id,
      name: p.name,
      emoji: p.emoji,
      quantity: p.quantity,
      awarded: p.awarded,
      remaining: Math.max(0, p.quantity - p.awarded),
      note: p.note,
      order: p.order
    }));
    const wins = players.filter((p) => p.status === "won").length;
    return {
      phase: this.phase,
      roomCode: this.roomCode,
      joinUrl: u.joinUrl || "",
      hostUrl: u.hostUrl || "",
      serverTime: Date.now(),
      sessionId: this.sessionId,
      startAt: this.startAt,
      revealAt: this.revealAt,
      config: {
        maxPlayers: cfg.maxPlayers,
        difficulty: cfg.difficulty,
        awardRule: cfg.awardRule,
        title: cfg.title,
        subtitle: cfg.subtitle
      },
      difficulty: difficulty.publicInfo(cfg.difficulty),
      prizes,
      winners: this.store.winners.slice(),
      players,
      stats: {
        joined: players.length,
        playing: players.filter((p) => p.status === "playing").length,
        wins,
        losses: players.filter((p) => p.status === "lost").length,
        totalPrizes: prizes.reduce((s, p) => s + p.quantity, 0),
        awardedPrizes: prizes.reduce((s, p) => s + p.awarded, 0)
      }
    };
  }

  adminData() {
    return {
      config: {
        maxPlayers: this.store.config.maxPlayers,
        difficulty: this.store.config.difficulty,
        awardRule: this.store.config.awardRule,
        title: this.store.config.title,
        subtitle: this.store.config.subtitle
      },
      pinSet: true,
      prizes: this.store.prizes.map((p) => ({
        ...p,
        remaining: Math.max(0, p.quantity - p.awarded)
      })),
      winners: this.store.winners.slice(),
      players: Array.from(this.players.values()).map(publicPlayer),
      session: this.snapshot(),
      difficulties: difficulty.list()
    };
  }

  /* ---------------- 内部 ---------------- */

  pushSession(immediate) {
    if (immediate) {
      if (this._snapshotTimer) {
        clearTimeout(this._snapshotTimer);
        this._snapshotTimer = null;
      }
      this.hub.broadcast({ t: "session", session: this.snapshot() });
      return;
    }
    if (this._snapshotTimer) return;
    this._snapshotTimer = setTimeout(() => {
      this._snapshotTimer = null;
      this.hub.broadcast({ t: "session", session: this.snapshot() });
    }, 60);
  }

  _clearTimers() {
    if (this._snapshotTimer) {
      clearTimeout(this._snapshotTimer);
      this._snapshotTimer = null;
    }
    if (this._revealTimer) {
      clearTimeout(this._revealTimer);
      this._revealTimer = null;
    }
    if (this._watchdog) {
      clearTimeout(this._watchdog);
      this._watchdog = null;
    }
  }

  _maybeAutoReveal() {
    if (this.phase !== "playing" || this._autoRevealed) return;
    const pending = Array.from(this.players.values()).filter(
      (p) => p.status === "playing" || p.status === "joined"
    );
    if (pending.length > 0 && this.players.size > 0) return;
    this._autoRevealed = true;
    if (this._revealTimer) clearTimeout(this._revealTimer);
    this._revealTimer = setTimeout(() => {
      this._revealTimer = null;
      if (this.phase === "playing") {
        try {
          this.reveal();
        } catch (e) {
          /* 已开奖则忽略 */
        }
      }
    }, 2500);
    if (this._revealTimer.unref) this._revealTimer.unref();
  }

  _pickPrize() {
    const inStock = this.store.prizes.filter((p) => p.quantity - p.awarded > 0);
    if (!inStock.length) {
      return { id: null, name: "新春福袋", emoji: "🧧", consolation: true };
    }
    const rule = this.store.config.awardRule;
    let target;
    if (rule === "highFirst") target = inStock[0];
    else if (rule === "random") target = inStock[Math.floor(Math.random() * inStock.length)];
    else target = inStock[inStock.length - 1]; // lowFirst：先发低价值，压轴留大奖
    target.awarded += 1;
    return { id: target.id, name: target.name, emoji: target.emoji, consolation: false };
  }

  _grant(player) {
    const prize = this._pickPrize();
    const winner = {
      pid: player.pid,
      name: player.name,
      avatar: player.avatar,
      prize,
      at: Date.now(),
      difficulty: this.store.config.difficulty
    };
    player.prize = prize;
    this.store.addWinner(winner);
    this.hub.broadcast({
      t: "award",
      pid: player.pid,
      name: player.name,
      avatar: player.avatar,
      prize,
      winner
    });
    return winner;
  }
}

module.exports = { Room, AVATARS, publicPlayer, nameLength };
