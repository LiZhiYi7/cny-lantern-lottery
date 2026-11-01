"use strict";

/**
 * 难度档位（唯一数据源）。
 * 注意：最低档「简单」也是零容错、4+5 连灯阵的高速闪灯，属于「很难」的档位。
 * waves[].len      —— 每波灯序列长度
 * waves[].showMs   —— 每盏灯点亮时长（越短越难）
 * waves[].gapMs    —— 灯与灯之间的熄灭间隔
 * waves[].inputMs  —— 复现阶段总输入时限
 * maxStrikes       —— 允许的失误次数（0 = 错一次直接失败）
 */
const DIFFICULTIES = [
  {
    key: "easy",
    label: "简单",
    color: "#7fd1a4",
    //estimatedPass: "约 8%",
    //desc: "最低档也极难：4+5 盏灯高速闪现、零容错，错一盏即出局",
    guaranteed: false,
    maxStrikes: 3,
    waves: [
      { len: 3, showMs: 560, gapMs: 340, inputMs: 4600 },
      { len: 4, showMs: 520, gapMs: 330, inputMs: 5800 }
    ]
  },
  {
    key: "normal",
    label: "标准",
    color: "#8fc7ff",
    //estimatedPass: "约 4%",
    //desc: "序列更长、节奏更快，5+6 连灯阵容不得半点分神",
    guaranteed: false,
    maxStrikes: 2,
    waves: [
      { len: 4, showMs: 480, gapMs: 320, inputMs: 15000 },
      { len: 5, showMs: 440, gapMs: 310, inputMs: 15000 }
    ]
  },
  {
    key: "hard",
    label: "困难",
    color: "#f7c948",
    //estimatedPass: "约 2%",
    //desc: "三波连击 5+6+6，灯火如电，零失误才可通关",
    guaranteed: false,
    maxStrikes: 1,
    waves: [
      { len: 5, showMs: 440, gapMs: 300, inputMs: 15000 },
      { len: 6, showMs: 400, gapMs: 290, inputMs: 15500 },
      { len: 6, showMs: 380, gapMs: 280, inputMs: 15000 }
    ]
  },
  {
    key: "extreme",
    label: "极致",
    color: "#ff8a5b",
    //estimatedPass: "约 0.5%",
    //desc: "6+7+7 贴脸闪现，只留给眼力与手速的王者",
    guaranteed: false,
    maxStrikes: 0,
    waves: [
      { len: 6, showMs: 380, gapMs: 280, inputMs: 15000 },
      { len: 7, showMs: 340, gapMs: 270, inputMs: 15000 },
      { len: 7, showMs: 320, gapMs: 260, inputMs: 15000 }
    ]
  },
  {
    key: "prize",
    label: "获奖",
    color: "#ffd166",
    estimatedPass: "必得奖",
    desc: "全员福气档：完成挑战必得奖品，按库存发放",
    guaranteed: true,
    maxStrikes: 99,
    waves: [{ len: 3, showMs: 900, gapMs: 320, inputMs: 15000 }]
  }
];

const MAP = new Map(DIFFICULTIES.map((d) => [d.key, d]));

function get(key) {
  return MAP.get(key) || DIFFICULTIES[0];
}

function cloneWaves(waves) {
  return waves.map((w) => ({ ...w }));
}

/** 对外公开的难度信息（不允许暴露内部可变引用） */
function publicInfo(key) {
  const d = get(key);
  return {
    key: d.key,
    label: d.label,
    color: d.color,
    //desc: d.desc,
    //estimatedPass: d.estimatedPass,
    guaranteed: !!d.guaranteed,
    maxStrikes: d.maxStrikes,
    waveCount: d.waves.length,
    waves: cloneWaves(d.waves)
  };
}

function list() {
  return DIFFICULTIES.map((d) => publicInfo(d.key));
}

function isValid(key) {
  return MAP.has(key);
}

module.exports = { DIFFICULTIES, get, publicInfo, list, isValid, cloneWaves };
