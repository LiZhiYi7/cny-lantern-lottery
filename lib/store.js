"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { clampInt } = require("./util");

const DEFAULT_CONFIG = {
  maxPlayers: 30,
  difficulty: "easy",
  awardRule: "lowFirst",
  pin: "8888",
  title: "龙腾新春 · 年会抽奖",
  subtitle: "扫码入场 · 灯阵夺魁 · 好运连连"
};

const DEFAULT_PRIZES = [
  { name: "特等奖 · 旗舰手机", emoji: "📱", quantity: 1, note: "全场唯一锦鲤" },
  { name: "一等奖 · 智能手表", emoji: "⌚", quantity: 2, note: "腕上添福" },
  { name: "二等奖 · 降噪耳机", emoji: "🎧", quantity: 5, note: "声声报喜" },
  { name: "三等奖 · 保温杯", emoji: "🥤", quantity: 10, note: "温暖一整年" },
  { name: "幸运奖 · 新春礼包", emoji: "🎁", quantity: 20, note: "福气满满" }
];

const AWARD_RULES = ["lowFirst", "highFirst", "random"];

function newPrizeId() {
  return "p_" + crypto.randomBytes(4).toString("hex");
}

function normalizePrize(raw, index) {
  const p = raw || {};
  return {
    id: typeof p.id === "string" && /^p_[0-9a-f]{6,}$/.test(p.id) ? p.id : newPrizeId(),
    name: String(p.name || "神秘奖品").trim().slice(0, 20) || "神秘奖品",
    emoji: String(p.emoji || "🎁").slice(0, 8),
    quantity: clampInt(p.quantity, 0, 999, 1),
    awarded: clampInt(p.awarded, 0, 999, 0),
    note: String(p.note || "").slice(0, 60),
    order: typeof index === "number" ? index : clampInt(p.order, 0, 999, 0)
  };
}

function normalizeConfig(raw) {
  const c = raw || {};
  return {
    maxPlayers: clampInt(c.maxPlayers, 1, 200, DEFAULT_CONFIG.maxPlayers),
    difficulty: typeof c.difficulty === "string" ? c.difficulty : DEFAULT_CONFIG.difficulty,
    awardRule: AWARD_RULES.indexOf(c.awardRule) >= 0 ? c.awardRule : DEFAULT_CONFIG.awardRule,
    pin: /^\d{4,8}$/.test(String(c.pin || "")) ? String(c.pin) : DEFAULT_CONFIG.pin,
    title: String(c.title || DEFAULT_CONFIG.title).slice(0, 40) || DEFAULT_CONFIG.title,
    subtitle: String(c.subtitle == null ? DEFAULT_CONFIG.subtitle : c.subtitle).slice(0, 60)
  };
}

function normalizeWinner(w) {
  if (!w || !w.prize) return null;
  return {
    pid: String(w.pid || ""),
    name: String(w.name || "").slice(0, 12),
    avatar: String(w.avatar || "🐲").slice(0, 8),
    prize: {
      id: w.prize.id || null,
      name: String(w.prize.name || "奖品").slice(0, 24),
      emoji: String(w.prize.emoji || "🎁").slice(0, 8),
      consolation: !!w.prize.consolation
    },
    at: Number(w.at) || Date.now(),
    difficulty: String(w.difficulty || "easy")
  };
}

class Store {
  constructor(dir) {
    this.dir = dir;
    this.file = path.join(dir, "state.json");
    this.config = { ...DEFAULT_CONFIG };
    this.prizes = [];
    this.winners = [];
    this.lastError = null;
    this.load();
  }

  load() {
    try {
      fs.mkdirSync(this.dir, { recursive: true });
    } catch (e) {
      /* 目录创建失败时保存会报错，读取走默认值 */
    }
    let data = null;
    try {
      if (fs.existsSync(this.file)) {
        const text = fs.readFileSync(this.file, "utf8");
        data = JSON.parse(text);
      }
    } catch (err) {
      this.lastError = "state.json 解析失败，已使用默认配置：" + err.message;
      try {
        fs.copyFileSync(this.file, this.file + ".corrupt-" + Date.now());
      } catch (e) {}
      data = null;
    }
    if (data && typeof data === "object") {
      this.config = normalizeConfig(data.config);
      this.prizes = Array.isArray(data.prizes) && data.prizes.length
        ? data.prizes.slice(0, 60).map(normalizePrize)
        : DEFAULT_PRIZES.map((p, i) => normalizePrize(p, i));
      this.winners = Array.isArray(data.winners)
        ? data.winners.slice(-500).map(normalizeWinner).filter(Boolean)
        : [];
    } else {
      this.config = { ...DEFAULT_CONFIG };
      this.prizes = DEFAULT_PRIZES.map((p, i) => normalizePrize(p, i));
      this.winners = [];
      this.save();
    }
    return this;
  }

  save() {
    const payload = {
      version: 2,
      savedAt: new Date().toISOString(),
      config: this.config,
      prizes: this.prizes,
      winners: this.winners
    };
    try {
      fs.mkdirSync(this.dir, { recursive: true });
      const tmp = this.file + ".tmp";
      fs.writeFileSync(tmp, JSON.stringify(payload, null, 2), "utf8");
      fs.renameSync(tmp, this.file);
      return true;
    } catch (err) {
      this.lastError = "保存失败：" + err.message;
      console.error("[store] 保存失败", err.message);
      return false;
    }
  }

  setConfig(patch) {
    this.config = Object.assign({}, this.config, patch || {});
    this.save();
    return this.config;
  }

  addPrize(input) {
    const p = normalizePrize(input, this.prizes.length);
    this.prizes.push(p);
    this.save();
    return p;
  }

  findPrize(id) {
    return this.prizes.find((p) => p.id === id) || null;
  }

  updatePrize(input) {
    const p = this.findPrize(input.id);
    if (!p) return null;
    if (input.name !== undefined) p.name = String(input.name).trim().slice(0, 20) || p.name;
    if (input.emoji !== undefined) p.emoji = String(input.emoji).slice(0, 8) || p.emoji;
    if (input.note !== undefined) p.note = String(input.note).slice(0, 60);
    if (input.quantity !== undefined) p.quantity = clampInt(input.quantity, 0, 999, p.quantity);
    if (input.awarded !== undefined) p.awarded = clampInt(input.awarded, 0, 999, p.awarded);
    this.save();
    return p;
  }

  removePrize(id) {
    const before = this.prizes.length;
    this.prizes = this.prizes.filter((p) => p.id !== id);
    this.prizes.forEach((p, i) => {
      p.order = i;
    });
    if (this.prizes.length !== before) this.save();
    return before !== this.prizes.length;
  }

  reseedPrizes() {
    this.prizes = DEFAULT_PRIZES.map((p, i) => normalizePrize(Object.assign({}, p, { awarded: 0 }), i));
    this.save();
    return this.prizes;
  }

  addWinner(winner) {
    const w = normalizeWinner(winner);
    if (!w) return null;
    this.winners.push(w);
    if (this.winners.length > 500) this.winners = this.winners.slice(-500);
    this.save();
    return w;
  }

  clearWinners() {
    this.winners = [];
    this.save();
  }
}

module.exports = { Store, DEFAULT_CONFIG, DEFAULT_PRIZES, AWARD_RULES, normalizePrize };
