/* ==========================================================================
   新春年会抽奖系统 · 后台管理逻辑（admin-panel 维护）
   依赖：window.Net（net.js）、theme.css、admin.css
   严格按 PROTOCOL.md §4.2 的 action 类型与字段调用服务端
   ========================================================================== */
(function () {
  "use strict";

  var $ = function (sel, root) { return (root || document).querySelector(sel); };
  var $$ = function (sel, root) {
    return Array.prototype.slice.call((root || document).querySelectorAll(sel));
  };
  var esc = function (s) { return Net.escape(s); };

  /* ------------------------------------------------------------------ */
  /* 常量                                                                */
  /* ------------------------------------------------------------------ */

  var PHASE_LABEL = { lobby: "等待入场", playing: "游戏进行中", reveal: "已揭晓" };
  var STATUS_LABEL = { joined: "已入场", playing: "闯关中", won: "已中奖", lost: "未中奖" };
  var STATUS_BADGE = { joined: "badge", playing: "badge badge--gold", won: "badge badge--jade", lost: "badge badge--red" };
  var RULE_LABEL = { lowFirst: "低价值优先", highFirst: "高价值优先", random: "随机" };
  var DIFF_ORDER = ["easy", "normal", "hard", "extreme", "prize"];

  /* 服务端未下发 difficulties 时的兜底（正常情况下用 /api/admin/data 的 difficulties） */
  var DIFF_FALLBACK = [
    { key: "easy", label: "简单", desc: "入门即硬核：8 盏灯、零失误才通关", estimatedPass: "约 8%", color: "#7fd1a4", guaranteed: false, waveCount: 2 },
    { key: "normal", label: "标准", desc: "4+5 连击 · 零容错", estimatedPass: "约 5%", color: "#7fc4d1", guaranteed: false, waveCount: 2 },
    { key: "hard", label: "困难", desc: "3 波连击 · 最长 5 灯 · 零容错", estimatedPass: "约 2%", color: "#e9b949", guaranteed: false, waveCount: 3 },
    { key: "extreme", label: "极致", desc: "3 波 · 最长 6 灯 · 极速闪现 · 零容错", estimatedPass: "约 0.6%", color: "#ef6a63", guaranteed: false, waveCount: 3 },
    { key: "prize", label: "获奖", desc: "全员福气：完成挑战必得奖品（按库存发放）", estimatedPass: "约 100%", color: "#f7d488", guaranteed: true, waveCount: 1 }
  ];

  var VIEW_META = {
    overview: { title: "总览", hint: "房间与现场状态一览" },
    prizes: { title: "奖品管理", hint: "库存、剩余与发放进度" },
    rules: { title: "规则设置", hint: "人数上限、难度、抽奖规则与文案" },
    players: { title: "玩家列表", hint: "现场玩家状态与手动发奖" },
    winners: { title: "中奖名单", hint: "实时中奖记录与导出" }
  };

  /* ------------------------------------------------------------------ */
  /* 状态                                                                */
  /* ------------------------------------------------------------------ */

  var state = {
    authed: false,
    appReady: false,
    conn: "connecting",
    config: null,
    prizes: [],
    players: [],
    winners: [],
    session: null,
    difficulties: null,
    pinSet: true,
    selectedDiff: "easy",
    selectedRule: "lowFirst",
    rulesDirty: false,
    rulesValid: true,
    activeView: "overview",
    es: null,
    hadOpen: false,
    connCheckTimer: null
  };

  /* 模态框 */
  var modal = { el: null, cancel: null, busy: false, lastFocus: null, keyHandler: null };

  /* ------------------------------------------------------------------ */
  /* 通用工具                                                            */
  /* ------------------------------------------------------------------ */

  function toast(text, kind) {
    var layer = $("#toastLayer");
    if (!layer || !text) return;
    var el = document.createElement("div");
    el.className = "toast" + (kind ? " toast--" + kind : "");
    el.textContent = text;
    layer.appendChild(el);
    while (layer.children.length > 4) layer.removeChild(layer.firstElementChild);
    setTimeout(function () {
      el.classList.add("toast--out");
      setTimeout(function () { if (el.parentNode) el.parentNode.removeChild(el); }, 320);
    }, 3200);
  }

  function toggleErr(sel, msg) {
    var el = $(sel);
    if (!el) return;
    if (msg) {
      el.textContent = msg;
      el.classList.remove("hidden");
    } else {
      el.textContent = "";
      el.classList.add("hidden");
    }
  }

  function safeColor(c) {
    return typeof c === "string" && /^#[0-9a-fA-F]{3,8}$/.test(c) ? c : "";
  }

  function fmtTime(at) {
    var d = new Date(Number(at) || 0);
    if (isNaN(d.getTime())) return "—";
    return [d.getHours(), d.getMinutes(), d.getSeconds()]
      .map(function (n) { return String(n).padStart(2, "0"); })
      .join(":");
  }

  function num(n, def) {
    var v = Number(n);
    return isFinite(v) ? v : (def || 0);
  }

  /** 与服务端 nameLength 一致：按码点计字数（emoji 记 1 个） */
  function charLen(s) {
    return Array.from(String(s == null ? "" : s)).length;
  }

  function hideSplash() {
    var sp = $("#bootSplash");
    if (!sp || sp.classList.contains("is-done")) return;
    sp.classList.add("is-done");
    setTimeout(function () { if (sp.parentNode) sp.parentNode.removeChild(sp); }, 520);
  }

  /** 按钮加载态 + 防重复点击 */
  async function withBtn(btn, fn) {
    if (!btn) return fn();
    if (btn.dataset.busy === "1") return;
    btn.dataset.busy = "1";
    btn.classList.add("is-busy");
    var wasDisabled = btn.disabled;
    btn.disabled = true;
    try {
      return await fn();
    } finally {
      if (btn.isConnected) {
        btn.classList.remove("is-busy");
        delete btn.dataset.busy;
        btn.disabled = wasDisabled;
      }
    }
  }

  /* ------------------------------------------------------------------ */
  /* 数据合并                                                            */
  /* ------------------------------------------------------------------ */

  function applyAdminData(d) {
    if (!d) return;
    if (d.config) state.config = d.config;
    if (Array.isArray(d.prizes)) state.prizes = d.prizes;
    if (Array.isArray(d.players)) state.players = d.players;
    if (Array.isArray(d.winners)) state.winners = d.winners;
    if (d.session) state.session = d.session;
    if (Array.isArray(d.difficulties)) state.difficulties = d.difficulties;
    if (typeof d.pinSet === "boolean") state.pinSet = d.pinSet;
  }

  function applySession(s) {
    if (!s) return;
    state.session = s;
    if (s.config) state.config = Object.assign({}, state.config || {}, s.config);
    if (Array.isArray(s.prizes)) state.prizes = s.prizes;
    if (Array.isArray(s.players)) state.players = s.players;
    if (Array.isArray(s.winners)) state.winners = s.winners;
    if (Array.isArray(s.difficulties)) state.difficulties = s.difficulties;
  }

  /* ------------------------------------------------------------------ */
  /* 网络：读数据 / 写操作                                               */
  /* ------------------------------------------------------------------ */

  var loadSeq = 0;
  var loadTimer = null;

  async function loadAll() {
    if (!state.authed) return;
    var seq = ++loadSeq;
    var res = await Net.get("/api/admin/data");
    if (seq !== loadSeq) return;
    if (res && res.__status === 401) { expireLogin(); return; }
    if (!res || res.ok !== true) return;
    applyAdminData(res);
    renderAll();
  }

  function scheduleRefresh(delay) {
    if (!state.authed) return;
    clearTimeout(loadTimer);
    loadTimer = setTimeout(function () {
      loadAll().catch(function () {});
    }, typeof delay === "number" ? delay : 220);
  }

  /**
   * 后台写操作统一入口。
   * 成功返回响应对象；失败已 toast，返回 null。401 自动回登录页。
   */
  async function postAction(payload) {
    var res = await Net.post("/api/admin/action", payload);
    if (res && res.__status === 401) { expireLogin(); return null; }
    if (!res || res.ok !== true) {
      toast((res && res.error) || "操作失败，请稍后重试", "warn");
      return null;
    }
    if (res.data) applyAdminData(res.data);
    else {
      if (res.config) state.config = res.config;
      if (Array.isArray(res.prizes)) state.prizes = res.prizes;
      if (Array.isArray(res.players)) state.players = res.players;
      if (Array.isArray(res.winners)) state.winners = res.winners;
      if (res.session) applySession(res.session);
    }
    scheduleRender();
    scheduleRefresh(500);
    return res;
  }

  /* ------------------------------------------------------------------ */
  /* 难度数据                                                            */
  /* ------------------------------------------------------------------ */

  function findFallback(key) {
    for (var i = 0; i < DIFF_FALLBACK.length; i++) {
      if (DIFF_FALLBACK[i].key === key) return DIFF_FALLBACK[i];
    }
    return null;
  }

  /** 合并服务端 5 档数据 + 当前 session.difficulty + 兜底 */
  function getDifficulties() {
    var serverList = Array.isArray(state.difficulties) ? state.difficulties : [];
    var cur = state.session && state.session.difficulty;
    var base = serverList.length ? serverList : DIFF_FALLBACK;
    var list = [];
    var seen = {};

    base.forEach(function (d) {
      if (!d || !d.key || seen[d.key]) return;
      var fb = findFallback(d.key) || {};
      var merged = Object.assign({}, fb, d);
      if (cur && cur.key === merged.key) {
        if (cur.label) merged.label = cur.label;
        if (cur.desc) merged.desc = cur.desc;
        if (cur.estimatedPass) merged.estimatedPass = cur.estimatedPass;
        if (safeColor(cur.color)) merged.color = cur.color;
        if (cur.guaranteed != null) merged.guaranteed = !!cur.guaranteed;
      }
      seen[merged.key] = true;
      list.push(merged);
    });

    DIFF_ORDER.forEach(function (k) {
      if (seen[k]) return;
      var fb = findFallback(k);
      if (fb) { seen[k] = true; list.push(Object.assign({}, fb)); }
    });

    list.sort(function (a, b) {
      var ia = DIFF_ORDER.indexOf(a.key);
      var ib = DIFF_ORDER.indexOf(b.key);
      return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
    });
    return list;
  }

  function findDiffByKey(key) {
    var list = getDifficulties();
    for (var i = 0; i < list.length; i++) if (list[i].key === key) return list[i];
    return null;
  }

  function currentDifficulty() {
    var s = state.session;
    if (s && s.difficulty && s.difficulty.key) {
      var merged = Object.assign({}, findDiffByKey(s.difficulty.key) || {}, s.difficulty);
      if (!merged.label) merged.label = s.difficulty.key;
      return merged;
    }
    var key = (state.config && state.config.difficulty) || "easy";
    return findDiffByKey(key) || findFallback(key) || DIFF_FALLBACK[0];
  }

  /* ------------------------------------------------------------------ */
  /* 渲染调度                                                            */
  /* ------------------------------------------------------------------ */

  var scheduleRender = Net.rafBatch ? Net.rafBatch(function () { renderAll(); }) : function () {
    if (scheduleRender._q) return;
    scheduleRender._q = true;
    requestAnimationFrame(function () { scheduleRender._q = false; renderAll(); });
  };

  function renderAll() {
    if (!state.appReady) return;
    renderTopbar();
    renderNavBadges();
    renderOverview();
    renderPrizes();
    renderRules();
    renderPlayers();
    renderWinners();
  }

  /* ------------------------------------------------------------------ */
  /* 渲染：顶栏 / 导航                                                   */
  /* ------------------------------------------------------------------ */

  function renderTopbar() {
    var phase = (state.session && state.session.phase) || "lobby";
    var badge = $("#topPhase");
    if (badge) {
      badge.textContent = PHASE_LABEL[phase] || phase;
      badge.className = "badge " + (phase === "playing" ? "badge--gold" : phase === "reveal" ? "badge--jade" : "");
    }
    var hostLink = $("#hostLink");
    if (hostLink) {
      hostLink.href = (state.session && state.session.hostUrl) || "/";
      hostLink.title = "在新标签页打开大屏";
    }
    var title = (state.config && state.config.title) || "新春年会抽奖";
    document.title = title + " · 主持人后台";
  }

  function renderNavBadges() {
    var pz = $("#navPrizeBadge"), pl = $("#navPlayerBadge"), wn = $("#navWinnerBadge");
    if (pz) pz.textContent = state.prizes.length;
    if (pl) pl.textContent = state.players.length;
    if (wn) wn.textContent = state.winners.length;
  }

  /* ------------------------------------------------------------------ */
  /* 渲染：总览                                                          */
  /* ------------------------------------------------------------------ */

  function calcStats() {
    var prizes = state.prizes || [];
    var players = state.players || [];
    var totalQty = 0, awarded = 0, remain = 0;
    prizes.forEach(function (p) {
      var q = num(p.quantity);
      var a = num(p.awarded);
      totalQty += q;
      awarded += a;
      remain += (p.remaining == null ? Math.max(0, q - a) : num(p.remaining));
    });
    var stats = (state.session && state.session.stats) || {};
    var wins = players.filter(function (p) {
      return p.status === "won" || !!(p.prize && p.prize.name);
    }).length;
    return {
      joined: players.length,
      limit: num(state.config && state.config.maxPlayers),
      playing: players.filter(function (p) { return p.status === "playing"; }).length,
      wins: wins,
      winnersCount: state.winners.length,
      losses: players.filter(function (p) { return p.status === "lost"; }).length,
      totalQty: totalQty,
      awarded: awarded,
      remain: remain,
      prizeKinds: prizes.length,
      awardedPrizes: num(stats.awardedPrizes, awarded)
    };
  }

  function renderOverview() {
    var s = state.session || {};
    var cfg = state.config || {};
    var phase = s.phase || "lobby";
    var st = calcStats();

    /* 房间信息 */
    var roomEl = $("#ovRoomCode");
    if (roomEl) roomEl.textContent = s.roomCode || "------";
    var joinUrl = s.joinUrl || (location.origin + "/play");
    var urlInput = $("#ovJoinUrl");
    if (urlInput && document.activeElement !== urlInput) urlInput.value = joinUrl;
    var qr = $("#ovQr");
    if (qr) {
      var qrSrc = "/api/qr.svg?text=" + encodeURIComponent(joinUrl);
      if (qr.getAttribute("src") !== qrSrc) qr.setAttribute("src", qrSrc);
    }
    var phaseEl = $("#ovPhase");
    if (phaseEl) {
      phaseEl.textContent = PHASE_LABEL[phase] || phase;
      phaseEl.className = "badge " + (phase === "playing" ? "badge--gold" : phase === "reveal" ? "badge--jade" : "badge--gold");
    }
    var tip = $("#ovRoomTip");
    if (tip) {
      tip.textContent = phase === "lobby"
        ? "等待入场阶段可加入"
        : phase === "playing"
          ? "游戏进行中，暂停加入"
          : "已揭晓，重置后可重新加入";
    }

    /* 数据卡 */
    var setText = function (sel, txt) { var el = $(sel); if (el) el.textContent = txt; };
    setText("#statOnline", st.joined + " / " + st.limit);
    setText("#statPlaying", "闯关中 " + st.playing + " 人");
    /* 「累计中奖」与名单（session.winners）口径一致；本轮视角用玩家 status=won 作小字 */
    setText("#statWins", String(st.winnersCount));
    setText("#statJoinRate", st.joined
      ? "累计中奖率 " + Math.min(100, Math.round((st.winnersCount / st.joined) * 100)) + "%"
      : "累计中奖率 —");
    setText("#statRoundWins", "本轮 " + st.wins + " 人");
    setText("#statRemain", String(st.remain));
    setText("#statTotalQty", "总库存 " + st.totalQty);
    setText("#statPrizeKinds", String(st.prizeKinds));
    setText("#statAwarded", "已发 " + st.awarded);
    setText("#statLosses", String(st.losses));
    setText("#statAwardedPrizes", String(st.awardedPrizes));
    setText("#statTitle", cfg.title || "—");

    /* 当前难度 */
    var d = currentDifficulty();
    var diffBox = $("#ovDiffCard");
    if (diffBox) {
      var color = safeColor(d.color) || "#e9b949";
      var waves = d.waveCount || (Array.isArray(d.waves) ? d.waves.length : 0);
      diffBox.innerHTML =
        '<div class="ov-diff__row">' +
          '<span class="ov-diff__dot" style="--diff-color:' + color + '"></span>' +
          '<span class="ov-diff__name">' + esc(d.label || d.key || "—") + "</span>" +
          (d.guaranteed ? '<span class="badge badge--jade">全员必得</span>' : '<span class="badge badge--red">零容错</span>') +
        "</div>" +
        '<p class="ov-diff__desc">' + esc(d.desc || "") + "</p>" +
        '<div class="ov-diff__meta">' +
          (waves ? '<span class="chip">' + waves + " 波</span>" : "") +
          (d.estimatedPass ? '<span class="chip">预估通关率 ' + esc(d.estimatedPass) + "</span>" : "") +
          '<span class="chip">抽奖规则 · ' + esc(RULE_LABEL[cfg.awardRule] || "—") + "</span>" +
        "</div>";
    }

    /* 库存概览 */
    var stockBox = $("#ovStockList");
    if (stockBox) {
      var prizes = (state.prizes || []).slice().sort(function (a, b) { return num(a.order) - num(b.order); });
      if (!prizes.length) {
        stockBox.innerHTML = '<div class="ov-stock__empty">奖品库为空，去「奖品管理」添加</div>';
      } else {
        stockBox.innerHTML = prizes.map(function (p) {
          var q = num(p.quantity);
          var a = num(p.awarded);
          var r = p.remaining == null ? Math.max(0, q - a) : num(p.remaining);
          var pct = q > 0 ? Math.min(100, Math.max(0, (r / q) * 100)) : 0;
          var low = r <= 2;
          return '<div class="ov-stock__item">' +
            '<span class="ov-stock__emoji">' + esc(p.emoji || "🎁") + "</span>" +
            '<span class="ov-stock__name">' + esc(p.name || "—") + "</span>" +
            '<span class="ov-stock__remain' + (low ? " is-low" : "") + '">' + r + " / " + q + "</span>" +
            '<span class="ov-stock__bar' + (low ? " is-low" : "") + '"><span style="width:' + pct.toFixed(1) + '%"></span></span>' +
          "</div>";
        }).join("");
      }
    }

    /* 最新中奖 */
    var latest = $("#ovLatest");
    if (latest) {
      var wl = (state.winners || []).slice().sort(function (a, b) { return num(b.at) - num(a.at); }).slice(0, 3);
      if (!wl.length) {
        latest.innerHTML = '<div class="ov-latest__empty">还没有人中奖</div>';
      } else {
        latest.innerHTML = wl.map(function (w) {
          var p = w.prize || {};
          return '<div class="ov-latest__item">' +
            '<span class="ov-latest__avatar">' + esc(w.avatar || "🐲") + "</span>" +
            '<span class="ov-latest__who">' + esc(w.name || "—") + "</span>" +
            '<span class="ov-latest__prize">' + esc(p.emoji || "🎁") + " " + esc(p.name || "奖品") + "</span>" +
          "</div>";
        }).join("");
      }
    }

    /* 主操作 */
    var startBtn = $("#startBtn");
    var revealBtn = $("#revealBtn");
    if (startBtn) startBtn.disabled = phase !== "lobby" || st.joined < 1;
    if (revealBtn) revealBtn.disabled = phase !== "playing";
    var actionHint = $("#actionHint");
    if (actionHint) {
      if (phase === "lobby") {
        actionHint.textContent = st.joined < 1
          ? "等待玩家扫码入场：至少 1 名玩家才能开始"
          : "已有 " + st.joined + " 名玩家，点击「开始游戏」进入 3 秒倒计时";
      } else if (phase === "playing") {
        actionHint.textContent = "游戏进行中：可等待全员完成自动揭晓，或提前揭晓";
      } else {
        actionHint.textContent = "本轮已揭晓：可重置进入下一轮（房间号会更换）";
      }
    }
  }

  /* ------------------------------------------------------------------ */
  /* 渲染：奖品管理                                                      */
  /* ------------------------------------------------------------------ */

  function renderPrizes() {
    var list = (state.prizes || []).slice().sort(function (a, b) {
      var d = num(a.order) - num(b.order);
      return d !== 0 ? d : String(a.id).localeCompare(String(b.id));
    });
    var box = $("#prizeList");
    var empty = $("#prizeEmpty");
    if (!box) return;

    var st = calcStats();
    var summary = $("#prizeSummary");
    if (summary) {
      summary.textContent = "共 " + st.prizeKinds + " 项 · 总库存 " + st.totalQty +
        " 件 · 已发放 " + st.awarded + " 件 · 剩余 " + st.remain + " 件";
    }

    if (!list.length) {
      box.innerHTML = "";
      if (empty) empty.classList.remove("hidden");
      return;
    }
    if (empty) empty.classList.add("hidden");

    box.innerHTML = list.map(function (p) {
      var q = num(p.quantity);
      var a = num(p.awarded);
      var r = p.remaining == null ? Math.max(0, q - a) : num(p.remaining);
      var low = r > 0 && r <= 2;
      var out = r <= 0;
      var rowCls = "prize-row" + (out ? " is-out" : low ? " is-low" : "");
      var pillCls = "remain-pill" + (out ? " is-out" : low ? " is-low" : "");
      var flag = out
        ? '<span class="stock-flag stock-flag--out">已发完</span>'
        : low
          ? '<span class="stock-flag stock-flag--low">库存不足</span>'
          : "";
      return '<div class="' + rowCls + '" data-id="' + esc(p.id) + '">' +
        '<div class="prize-cell prize-cell--order"><span class="order-tag">' + (num(p.order) + 1) + "</span></div>" +
        '<div class="prize-cell prize-cell--main">' +
          '<span class="prize-emoji">' + esc(p.emoji || "🎁") + "</span>" +
          '<div class="grow">' +
            '<div class="prize-name">' + esc(p.name || "—") + flag + "</div>" +
            '<div class="prize-note">' + (p.note ? esc(p.note) : "无备注") + "</div>" +
          "</div>" +
        "</div>" +
        '<div class="prize-cell prize-cell--qty">' +
          '<button type="button" class="qty-btn" data-act="dec" aria-label="减少 ' + esc(p.name) + ' 数量"' + (q <= 0 ? " disabled" : "") + ">−</button>" +
          '<span class="qty-value num">' + q + "</span>" +
          '<button type="button" class="qty-btn" data-act="inc" aria-label="增加 ' + esc(p.name) + ' 数量"' + (q >= 999 ? " disabled" : "") + ">＋</button>" +
        "</div>" +
        '<div class="prize-cell prize-cell--awarded"><b class="num">' + a + "</b></div>" +
        '<div class="prize-cell prize-cell--remain"><span class="' + pillCls + '">' + r + "</span></div>" +
        '<div class="prize-cell prize-cell--actions">' +
          '<button type="button" class="btn btn--ghost btn--sm" data-act="edit">编辑</button>' +
          '<button type="button" class="btn btn--danger btn--sm" data-act="del">删除</button>' +
        "</div>" +
      "</div>";
    }).join("");
  }

  /* ------------------------------------------------------------------ */
  /* 渲染：规则设置                                                      */
  /* ------------------------------------------------------------------ */

  function renderRules() {
    var cfg = state.config || {};
    if (!state.rulesDirty) {
      state.selectedDiff = cfg.difficulty || "easy";
      state.selectedRule = cfg.awardRule || "lowFirst";
      var mp = $("#maxPlayersInput");
      if (mp && document.activeElement !== mp) mp.value = cfg.maxPlayers != null ? cfg.maxPlayers : "";
      var ti = $("#titleInput");
      if (ti && document.activeElement !== ti) ti.value = cfg.title || "";
      var si = $("#subtitleInput");
      if (si && document.activeElement !== si) si.value = cfg.subtitle || "";
      var pi = $("#pinNewInput");
      if (pi && document.activeElement !== pi) pi.value = "";
    }
    renderDiffCards();
    $$("#awardRuleSeg .seg__item").forEach(function (el) {
      var on = el.dataset.rule === state.selectedRule;
      el.classList.toggle("is-active", on);
      el.setAttribute("aria-checked", on ? "true" : "false");
    });
    validateRules();
  }

  function renderDiffCards() {
    var box = $("#diffGrid");
    if (!box) return;
    var list = getDifficulties();
    box.innerHTML = list.map(function (d) {
      var active = d.key === state.selectedDiff;
      var color = safeColor(d.color) || "#e9b949";
      var waves = d.waveCount || (Array.isArray(d.waves) ? d.waves.length : 0);
      var flags = "";
      if (d.key === "easy") {
        flags += '<span class="diff-card__flag diff-card__flag--hard">最低档也极难 · 零容错</span>';
      }
      if (d.guaranteed) {
        flags += '<span class="diff-card__flag diff-card__flag--guaranteed">全员必得 · 按库存</span>';
      }
      return '<button type="button" role="radio" aria-checked="' + (active ? "true" : "false") +
        '" class="diff-card' + (active ? " is-active" : "") + '" data-diff="' + esc(d.key) + '"' +
        ' style="--diff-color:' + color + '">' +
        '<span class="diff-card__head">' +
          '<span class="diff-card__dot"></span>' +
          '<span class="diff-card__label">' + esc(d.label || d.key) + "</span>" +
          flags +
        "</span>" +
        '<span class="diff-card__desc">' + esc(d.desc || "") + "</span>" +
        '<span class="diff-card__meta">' +
          (waves ? '<span class="chip">' + waves + " 波</span>" : "") +
          (d.estimatedPass ? '<span class="chip">预估 ' + esc(d.estimatedPass) + "</span>" : "") +
        "</span>" +
      "</button>";
    }).join("");
  }

  function validateRules() {
    var mpEl = $("#maxPlayersInput");
    var raw = mpEl ? mpEl.value.trim() : "";
    var mpErr = "";
    if (raw === "") mpErr = "请填写人数上限（1–200）";
    else if (!/^\d+$/.test(raw)) mpErr = "请输入整数";
    else if (Number(raw) < 1 || Number(raw) > 200) mpErr = "人数上限需在 1–200 之间";
    toggleErr("#maxPlayersErr", mpErr);

    var tiEl = $("#titleInput");
    var title = tiEl ? tiEl.value.trim() : "";
    var titleErr = "";
    if (!title) titleErr = "主标题不能为空";
    else if (charLen(title) > 20) titleErr = "主标题需为 1–20 个字";
    toggleErr("#titleErr", titleErr);

    var subEl = $("#subtitleInput");
    var subtitle = subEl ? subEl.value.trim() : "";
    var subtitleErr = charLen(subtitle) > 30 ? "副标题最多 30 个字" : "";
    toggleErr("#subtitleErr", subtitleErr);

    var pinEl = $("#pinNewInput");
    var pin = pinEl ? pinEl.value.trim() : "";
    var pinErr = pin && !/^\d{4,8}$/.test(pin) ? "PIN 需为 4–8 位数字" : "";
    toggleErr("#pinErr", pinErr);

    state.rulesValid = !mpErr && !titleErr && !subtitleErr && !pinErr;
    var save = $("#rulesSaveBtn");
    if (save) save.disabled = !state.rulesDirty || !state.rulesValid;
    var hint = $("#rulesDirtyHint");
    if (hint) {
      hint.textContent = state.rulesDirty
        ? (state.rulesValid ? "有未保存的修改，保存后生效" : "请先修正标红的输入")
        : "已与服务端同步";
      hint.classList.toggle("is-dirty", state.rulesDirty);
    }
    return state.rulesValid;
  }

  /* ------------------------------------------------------------------ */
  /* 渲染：玩家列表                                                      */
  /* ------------------------------------------------------------------ */

  function renderPlayers() {
    var list = state.players || [];
    var box = $("#playerList");
    var empty = $("#playerEmpty");
    if (!box) return;

    var st = calcStats();
    var limit = st.limit;
    var countBadge = $("#playersCountBadge");
    if (countBadge) countBadge.textContent = st.joined + " / " + limit;
    var summary = $("#playersSummary");
    if (summary) {
      summary.textContent = "在线 " + st.joined + " 人 · 闯关中 " + st.playing +
        " 人 · 本轮已中奖 " + st.wins + " 人 · 未通关 " + st.losses + " 人";
    }

    if (!list.length) {
      box.innerHTML = "";
      if (empty) empty.classList.remove("hidden");
      return;
    }
    if (empty) empty.classList.add("hidden");

    box.innerHTML = list.map(function (p, idx) {
      var status = p.status || "joined";
      var hasPrize = !!(p.prize && p.prize.name) || status === "won";
      var prizeHtml = hasPrize
        ? esc(p.prize && p.prize.emoji ? p.prize.emoji : "🎁") + " " + esc((p.prize && p.prize.name) || "已中奖")
        : "—";
      var result = "—";
      if (p.result) {
        if (p.result.manual) result = "手动发奖";
        else if (p.result.missed) result = "本轮未完成";
        else result = p.result.cleared + "/" + p.result.waves + " 波 · " + Net.fmtMs(p.result.ms);
      }
      var sub = "第 " + (idx + 1) + " 位" + (p.ready ? " · 已准备" : "");
      return '<div class="player-row" data-pid="' + esc(p.pid) + '">' +
        '<div class="player-who">' +
          '<span class="player-avatar">' + esc(p.avatar || "🐲") + "</span>" +
          '<div class="grow"><div class="player-name">' + esc(p.name || "—") + "</div>" +
            '<div class="player-sub">' + esc(sub) + "</div></div>" +
        "</div>" +
        '<div class="player-status"><span class="' + (STATUS_BADGE[status] || "badge") + '">' +
          esc(STATUS_LABEL[status] || status) + "</span></div>" +
        '<div class="player-prize' + (hasPrize ? "" : " player-prize--none") + '">' + prizeHtml + "</div>" +
        '<div class="player-score">' + esc(result) + "</div>" +
        '<div class="player-actions">' +
          '<button type="button" class="btn btn--gold btn--sm" data-act="award"' +
            (hasPrize ? ' disabled title="该玩家已中奖"' : ' title="手动发奖"') + ">发奖</button>" +
          '<button type="button" class="btn btn--danger btn--sm" data-act="kick">踢出</button>' +
        "</div>" +
      "</div>";
    }).join("");
  }

  /* ------------------------------------------------------------------ */
  /* 渲染：中奖名单                                                      */
  /* ------------------------------------------------------------------ */

  function renderWinners() {
    var list = (state.winners || []).slice().sort(function (a, b) { return num(b.at) - num(a.at); });
    var box = $("#winnerList");
    var empty = $("#winnerEmpty");
    if (!box) return;

    var countBadge = $("#winnersCountBadge");
    if (countBadge) countBadge.textContent = list.length + " 人";
    var summary = $("#winnersSummary");
    if (summary) {
      summary.textContent = list.length
        ? "共 " + list.length + " 位中奖 · 最新「" + (list[0].name || "—") + "」"
        : "还没有中奖记录";
    }

    if (!list.length) {
      box.innerHTML = "";
      if (empty) empty.classList.remove("hidden");
      return;
    }
    if (empty) empty.classList.add("hidden");

    box.innerHTML = list.map(function (w, i) {
      var p = w.prize || {};
      var d = findDiffByKey(w.difficulty);
      var diffLabel = d ? d.label : (w.difficulty || "—");
      return '<div class="winner-row' + (i === 0 ? " winner-row--new" : "") + '">' +
        '<div class="winner-rank">#' + (list.length - i) + "</div>" +
        '<div class="winner-who"><span class="winner-avatar">' + esc(w.avatar || "🐲") + "</span>" +
          '<span class="winner-name">' + esc(w.name || "—") + "</span></div>" +
        '<div class="winner-prize"><span class="winner-prize__emoji">' + esc(p.emoji || "🎁") + "</span>" +
          '<span class="winner-prize__name">' + esc(p.name || "奖品") + "</span>" +
          (p.consolation ? '<span class="winner-prize__consolation">福袋</span>' : "") + "</div>" +
        '<div class="winner-diff"><span class="chip">' + esc(diffLabel) + "</span></div>" +
        '<div class="winner-time">' + esc(fmtTime(w.at)) + "</div>" +
      "</div>";
    }).join("");
  }

  /* ------------------------------------------------------------------ */
  /* 模态框                                                              */
  /* ------------------------------------------------------------------ */

  function openModal(opts) {
    closeModal();
    modal.lastFocus = document.activeElement;
    var wrap = document.createElement("div");
    wrap.className = "admin-modal";
    wrap.innerHTML =
      '<div class="admin-modal__mask" data-modal-close></div>' +
      '<div class="admin-modal__box panel" role="dialog" aria-modal="true" aria-label="' + esc(opts.title) + '">' +
        '<div class="admin-modal__head">' +
          '<div class="panel__title">' + esc(opts.title) + "</div>" +
          '<button type="button" class="admin-modal__x" data-modal-close aria-label="关闭">✕</button>' +
        "</div>" +
        '<div class="admin-modal__body">' + opts.body + "</div>" +
      "</div>";
    document.body.appendChild(wrap);
    modal.el = wrap;
    wrap.addEventListener("click", function (e) {
      if (e.target.closest("[data-modal-close]")) {
        if (!modal.busy) closeModal();
      }
    });
    modal.keyHandler = function (e) {
      if (e.key === "Escape" && !modal.busy) {
        e.preventDefault();
        closeModal();
      }
    };
    document.addEventListener("keydown", modal.keyHandler);
    var focusEl = wrap.querySelector("input, textarea, select, .btn--gold");
    if (focusEl) setTimeout(function () { try { focusEl.focus(); } catch (err) {} }, 40);
    return wrap;
  }

  function closeModal() {
    if (!modal.el) return;
    document.removeEventListener("keydown", modal.keyHandler);
    modal.el.remove();
    modal.el = null;
    modal.busy = false;
    var cancel = modal.cancel;
    modal.cancel = null;
    if (cancel) cancel();
    if (modal.lastFocus && modal.lastFocus.focus) {
      try { modal.lastFocus.focus(); } catch (e) {}
    }
    modal.lastFocus = null;
  }

  function confirmModal(opts) {
    return new Promise(function (resolve) {
      var settled = false;
      var done = function (v) { if (!settled) { settled = true; resolve(v); } };
      var body =
        "<p>" + (opts.text || "") + "</p>" +
        (opts.list && opts.list.length
          ? '<ul class="modal-list">' + opts.list.map(function (x) { return "<li>" + x + "</li>"; }).join("") + "</ul>"
          : "") +
        (opts.note ? '<p class="modal-warn">' + opts.note + "</p>" : "") +
        '<div class="admin-modal__foot">' +
          '<button type="button" class="btn btn--ghost" data-modal-close>取消</button>' +
          '<button type="button" class="btn ' + (opts.danger ? "btn--danger" : "btn--gold") + '" id="modalOkBtn">' +
            esc(opts.confirmText || "确定") + "</button>" +
        "</div>";
      openModal({ title: opts.title || "请确认", body: body });
      modal.cancel = function () { done(false); };
      var okBtn = $("#modalOkBtn");
      if (okBtn) {
        okBtn.addEventListener("click", function () {
          if (modal.busy) return;
          done(true);
          closeModal();
        });
      }
    });
  }

  /* ------------------------------------------------------------------ */
  /* 登录 / 登出 / 连接                                                  */
  /* ------------------------------------------------------------------ */

  function showLoginError(msg) {
    var el = $("#loginError");
    if (!el) return;
    if (msg) {
      el.textContent = msg;
      el.classList.remove("hidden");
    } else {
      el.textContent = "";
      el.classList.add("hidden");
    }
    var card = $(".login-card");
    if (card && msg) {
      card.classList.remove("is-shake");
      void card.offsetWidth;
      card.classList.add("is-shake");
    }
  }

  function showLogin(msg) {
    closeStream();
    state.authed = false;
    state.appReady = false;
    document.body.classList.remove("is-app");
    hideSplash();
    var app = $("#appView");
    var login = $("#loginView");
    if (app) app.classList.add("hidden");
    if (login) login.classList.remove("hidden");
    showLoginError(msg || "");
    var pin = $("#pinInput");
    if (pin) {
      pin.value = "";
      setTimeout(function () { try { pin.focus(); } catch (e) {} }, 80);
    }
  }

  function expireLogin() {
    if (!state.authed) return;
    toast("登录已失效，请重新登录", "warn");
    showLogin("登录已失效，请重新输入 PIN");
  }

  function enterApp() {
    state.authed = true;
    state.appReady = true;
    document.body.classList.add("is-app");
    hideSplash();
    var login = $("#loginView");
    if (login) login.classList.add("hidden");
    var app = $("#appView");
    if (app) app.classList.remove("hidden");
    var pin = $("#pinInput");
    if (pin) pin.value = "";
    showLoginError("");
    setConn("connecting");
    renderAll();
    connectStream();
    switchView(state.activeView || "overview");
  }

  function closeStream() {
    if (state.es) {
      try { state.es.close(); } catch (e) {}
      state.es = null;
    }
    clearTimeout(state.connCheckTimer);
  }

  function connectStream() {
    if (!state.authed) return;
    closeStream();
    var es = Net.stream("admin");
    state.es = es;

    es.on("_open", function () {
      setConn("open");
    });
    es.on("_error", function () {
      var wasOpen = state.conn === "open";
      setConn("down");
      if (wasOpen) toast("连接已断开，正在自动重连…", "warn");
      clearTimeout(state.connCheckTimer);
      state.connCheckTimer = setTimeout(function () {
        if (!state.authed || state.conn === "open") return;
        /* SSE 断开：确认是网络问题还是 cookie 失效 */
        Net.get("/api/admin/data").then(function (res) {
          if (res && res.__status === 401) expireLogin();
        }).catch(function () {});
      }, 4000);
    });
    es.on("hello", function (msg) {
      var wasDown = state.conn === "down";
      setConn("open");
      if (msg && msg.session) applySession(msg.session);
      if (state.hadOpen && wasDown) toast("已重新连接，数据为最新", "success");
      state.hadOpen = true;
      scheduleRender();
    });
    es.on("session", function (msg) {
      if (msg && msg.session) {
        applySession(msg.session);
        scheduleRender();
      }
    });
    es.on("award", function (msg) {
      if (!msg || !msg.winner) return;
      var w = msg.winner;
      var exists = (state.winners || []).some(function (x) {
        return x.pid === w.pid && x.at === w.at;
      });
      if (!exists) {
        state.winners = (state.winners || []).concat([w]);
      }
      scheduleRender();
      var prize = msg.prize || w.prize || {};
      toast("🎉 " + (msg.name || w.name || "玩家") + " 抽中「" + (prize.name || "奖品") + "」", "success");
      scheduleRefresh(500);
    });
    es.on("toast", function (msg) {
      if (msg && msg.text) toast(msg.text, msg.kind);
    });
    es.on("error", function (msg) {
      if (msg && msg.message) toast(msg.message, "warn");
    });

    setConn("connecting");
  }

  function setConn(kind) {
    state.conn = kind;
    var el = $("#connState");
    if (el) {
      el.dataset.state = kind;
      var txt = el.querySelector(".conn__text");
      if (txt) {
        txt.textContent = kind === "open"
          ? "实时连接正常"
          : kind === "down"
            ? "连接断开，正在重连…"
            : "连接中…";
      }
    }
    var live = $("#topLive");
    if (live) {
      if (kind === "open") {
        live.className = "badge badge--live";
        live.textContent = "实时同步";
      } else if (kind === "down") {
        live.className = "badge badge--red";
        live.textContent = "连接断开 · 重连中";
      } else {
        live.className = "badge";
        live.textContent = "连接中…";
      }
    }
  }

  async function checkAuth() {
    var res = await Net.get("/api/admin/data");
    if (res && res.ok === true) {
      applyAdminData(res);
      enterApp();
      return true;
    }
    if (res && res.__status === 401) {
      showLogin("");
    } else {
      showLogin((res && res.error) || "暂时无法连接服务器，请确认服务已启动");
    }
    return false;
  }

  async function doLogout() {
    try { await Net.post("/api/admin/logout", {}); } catch (e) {}
    closeStream();
    state.authed = false;
    state.appReady = false;
    state.session = null;
    state.players = [];
    state.winners = [];
    showLogin("");
    toast("已退出登录", "");
  }

  /* ------------------------------------------------------------------ */
  /* 视图切换                                                            */
  /* ------------------------------------------------------------------ */

  function switchView(name) {
    if (!VIEW_META[name]) name = "overview";
    state.activeView = name;
    $$(".nav-item").forEach(function (el) {
      el.classList.toggle("is-active", el.dataset.view === name);
    });
    $$(".view").forEach(function (el) {
      el.classList.toggle("hidden", el.dataset.view !== name);
    });
    var meta = VIEW_META[name];
    var t = $("#viewTitle"), h = $("#viewHint");
    if (t) t.textContent = meta.title;
    if (h) h.textContent = meta.hint;
    window.scrollTo({ top: 0, behavior: "smooth" });
    scheduleRender();
  }

  /* ------------------------------------------------------------------ */
  /* 操作：现场                                                          */
  /* ------------------------------------------------------------------ */

  async function startGame(btn) {
    await withBtn(btn, async function () {
      var res = await postAction({ type: "session.start" });
      if (!res) return;
      toast("游戏已开始，进入 3 秒倒计时", "success");
    });
    renderAll();
  }

  async function revealGame(btn) {
    await withBtn(btn, async function () {
      var res = await postAction({ type: "session.reveal" });
      if (!res) return;
      toast("已提前揭晓，大屏进入开奖", "success");
    });
    renderAll();
  }

  async function resetSession(btn) {
    var winners = state.winners.length;
    var ok = await confirmModal({
      title: "重置本轮",
      text: "确定重置本轮吗？将回到「等待入场」阶段。",
      list: [
        "房间号会立即更换，旧房间号失效",
        "清空本轮所有玩家与游戏进度，玩家需重新扫码加入",
        "奖品库存与已发放数量保持不变，中奖名单保留（共 " + winners + " 条）"
      ],
      note: "现场观众需要重新扫码，请在放完奖、确认无人再入场后操作。",
      confirmText: "重置本轮",
      danger: true
    });
    if (!ok) return;
    await withBtn(btn, async function () {
      var res = await postAction({ type: "session.reset" });
      if (!res) return;
      state.rulesDirty = false;
      toast("已重置，新房间号已生效", "success");
    });
    renderAll();
  }

  /* ------------------------------------------------------------------ */
  /* 操作：奖品                                                          */
  /* ------------------------------------------------------------------ */

  function togglePrizeAddForm(show) {
    var form = $("#prizeAddForm");
    if (!form) return;
    var willShow = typeof show === "boolean" ? show : form.classList.contains("hidden");
    form.classList.toggle("hidden", !willShow);
    if (willShow) {
      toggleErr("#addErr", "");
      var name = $("#addName");
      if (name) setTimeout(function () { try { name.focus(); } catch (e) {} }, 40);
    }
  }

  async function addPrize(ev) {
    ev.preventDefault();
    var nameEl = $("#addName");
    var emojiEl = $("#addEmoji");
    var qtyEl = $("#addQty");
    var noteEl = $("#addNote");
    var name = nameEl ? nameEl.value.trim() : "";
    var emoji = (emojiEl && emojiEl.value.trim()) || "🎁";
    var qtyRaw = qtyEl ? qtyEl.value.trim() : "";
    var note = noteEl ? noteEl.value.trim() : "";
    var err = "";
    if (!name) err = "请填写奖品名称";
    else if (charLen(name) > 20) err = "奖品名称最多 20 个字";
    else if (!/^\d+$/.test(qtyRaw) || Number(qtyRaw) > 999) err = "数量需为 0–999 的整数";
    if (err) {
      toggleErr("#addErr", err);
      return;
    }
    toggleErr("#addErr", "");
    await withBtn($("#prizeAddSubmit"), async function () {
      var res = await postAction({
        type: "prize.add",
        name: name,
        emoji: emoji,
        quantity: Number(qtyRaw),
        note: note
      });
      if (!res) return;
      toast("已添加奖品「" + name + "」", "success");
      if (nameEl) nameEl.value = "";
      if (qtyEl) qtyEl.value = "1";
      if (noteEl) noteEl.value = "";
      if (emojiEl) emojiEl.value = "🎁";
      togglePrizeAddForm(false);
    });
    renderAll();
  }

  async function changePrizeQty(prize, delta, btn) {
    var q = num(prize.quantity);
    var next = Math.max(0, Math.min(999, q + delta));
    if (next === q) {
      toast(delta > 0 ? "数量上限为 999" : "数量不能小于 0", "warn");
      return;
    }
    await withBtn(btn, async function () {
      var res = await postAction({ type: "prize.update", id: prize.id, quantity: next });
      if (!res) return;
      scheduleRender();
    });
  }

  async function removePrize(prize, btn) {
    var ok = await confirmModal({
      title: "删除奖品",
      text: '确定删除奖品 <strong>' + esc(prize.emoji || "🎁") + " " + esc(prize.name) + "</strong> 吗？",
      note: "该奖品将从可发放库存中移除；中奖记录里保存的是快照，不受影响。",
      confirmText: "删除奖品",
      danger: true
    });
    if (!ok) return;
    await withBtn(btn, async function () {
      var res = await postAction({ type: "prize.remove", id: prize.id });
      if (!res) return;
      toast("已删除奖品「" + prize.name + "」", "success");
    });
    renderAll();
  }

  async function reseedPrizes(btn) {
    var ok = await confirmModal({
      title: "恢复示例奖品",
      text: "确定用示例奖品覆盖当前奖品库吗？",
      list: [
        "当前所有奖品配置会被示例奖品替换",
        "所有奖品的「已发」数量归零，剩余库存按示例数量重置",
        "中奖名单与玩家不受影响"
      ],
      note: "仅建议在活动开始前使用；如果本轮已经发过奖，库存统计会与名单不一致。",
      confirmText: "恢复示例",
      danger: true
    });
    if (!ok) return;
    await withBtn(btn, async function () {
      var res = await postAction({ type: "prize.reseed" });
      if (!res) return;
      toast("已恢复示例奖品", "success");
    });
    renderAll();
  }

  function openPrizeEdit(prize) {
    var p = prize;
    var body =
      '<form class="modal-form" id="prizeEditForm" novalidate>' +
        '<div class="modal-form__grid">' +
          '<div class="field"><label class="label" for="mEmoji">Emoji</label>' +
            '<input class="input modal-form__emoji" id="mEmoji" maxlength="8" value="' + esc(p.emoji || "🎁") + '"></div>' +
          '<div class="field"><label class="label" for="mName">奖品名称（1–20 字）</label>' +
            '<input class="input" id="mName" maxlength="20" value="' + esc(p.name || "") + '"></div>' +
        "</div>" +
        '<div class="modal-form__grid">' +
          '<div class="field"><label class="label" for="mQty">数量（0–999）</label>' +
            '<input class="input" id="mQty" type="number" min="0" max="999" step="1" value="' + num(p.quantity) + '"></div>' +
          '<div class="field"><label class="label" for="mNote">备注（可选，60 字内）</label>' +
            '<input class="input" id="mNote" maxlength="60" value="' + esc(p.note || "") + '"></div>' +
        "</div>" +
        '<p class="hint" style="margin-top:10px">已发放 <b class="num">' + num(p.awarded) +
          "</b> 件。若把总量改到低于已发放数量，剩余按 0 计算，已发记录不受影响。</p>" +
        '<p class="field-err hidden" id="mErr" role="alert"></p>' +
        '<div class="admin-modal__foot">' +
          '<button type="button" class="btn btn--ghost" data-modal-close>取消</button>' +
          '<button type="submit" class="btn btn--gold" id="mSubmit">保存修改</button>' +
        "</div>" +
      "</form>";
    openModal({ title: "编辑奖品", body: body });
    var form = $("#prizeEditForm");
    if (!form) return;
    form.addEventListener("submit", async function (ev) {
      ev.preventDefault();
      var name = $("#mName").value.trim();
      var emoji = $("#mEmoji").value.trim() || "🎁";
      var qtyRaw = $("#mQty").value.trim();
      var note = $("#mNote").value.trim();
      var err = "";
      if (!name) err = "请填写奖品名称";
      else if (charLen(name) > 20) err = "奖品名称最多 20 个字";
      else if (!/^\d+$/.test(qtyRaw) || Number(qtyRaw) > 999) err = "数量需为 0–999 的整数";
      if (err) {
        toggleErr("#mErr", err);
        return;
      }
      modal.busy = true;
      try {
        await withBtn($("#mSubmit"), async function () {
          var res = await postAction({
            type: "prize.update",
            id: p.id,
            name: name,
            emoji: emoji,
            quantity: Number(qtyRaw),
            note: note
          });
          if (!res) return;
          toast("奖品已更新", "success");
          closeModal();
          renderAll();
        });
      } finally {
        modal.busy = false;
      }
    });
  }

  /* ------------------------------------------------------------------ */
  /* 操作：规则                                                          */
  /* ------------------------------------------------------------------ */

  function markRulesDirty() {
    if (!state.rulesDirty) {
      state.rulesDirty = true;
    }
    validateRules();
  }

  async function saveRules(ev) {
    ev.preventDefault();
    if (!state.rulesValid) {
      validateRules();
      toast("请先修正标红的输入", "warn");
      return;
    }
    var cfg = state.config || {};
    var patch = {};
    var mpEl = $("#maxPlayersInput");
    var mp = mpEl ? Number(mpEl.value.trim()) : Number(cfg.maxPlayers);
    if (mp !== Number(cfg.maxPlayers)) patch.maxPlayers = mp;
    if (state.selectedDiff && state.selectedDiff !== cfg.difficulty) patch.difficulty = state.selectedDiff;
    if (state.selectedRule && state.selectedRule !== cfg.awardRule) patch.awardRule = state.selectedRule;
    var titleEl = $("#titleInput");
    var title = titleEl ? titleEl.value.trim() : (cfg.title || "");
    if (title !== (cfg.title || "")) patch.title = title;
    var subEl = $("#subtitleInput");
    var subtitle = subEl ? subEl.value.trim() : (cfg.subtitle || "");
    if (subtitle !== (cfg.subtitle || "")) patch.subtitle = subtitle;
    var pinEl = $("#pinNewInput");
    var pin = pinEl ? pinEl.value.trim() : "";
    if (pin) patch.pin = pin;

    if (!Object.keys(patch).length) {
      toast("设置没有变化，无需保存", "warn");
      return;
    }
    await withBtn($("#rulesSaveBtn"), async function () {
      var res = await postAction(Object.assign({ type: "config.set" }, patch));
      if (!res) return;
      state.rulesDirty = false;
      if (pinEl) pinEl.value = "";
      if (res.data && res.data.config) {
        state.selectedDiff = res.data.config.difficulty || state.selectedDiff;
        state.selectedRule = res.data.config.awardRule || state.selectedRule;
      }
      toast(patch.pin ? "设置已保存，新 PIN 已生效" : "设置已保存", "success");
      renderAll();
    });
  }

  function discardRules() {
    state.rulesDirty = false;
    var cfg = state.config || {};
    state.selectedDiff = cfg.difficulty || "easy";
    state.selectedRule = cfg.awardRule || "lowFirst";
    var pinEl = $("#pinNewInput");
    if (pinEl) pinEl.value = "";
    toggleErr("#maxPlayersErr", "");
    toggleErr("#titleErr", "");
    toggleErr("#subtitleErr", "");
    toggleErr("#pinErr", "");
    renderRules();
    toast("已放弃未保存的修改", "");
  }

  /* ------------------------------------------------------------------ */
  /* 操作：玩家                                                          */
  /* ------------------------------------------------------------------ */

  function findPlayer(pid) {
    for (var i = 0; i < state.players.length; i++) {
      if (state.players[i].pid === pid) return state.players[i];
    }
    return null;
  }

  async function kickPlayer(pid, btn) {
    var p = findPlayer(pid);
    if (!p) return;
    var ok = await confirmModal({
      title: "踢出玩家",
      text: '确定将玩家 <strong>' + esc(p.avatar || "🐲") + " " + esc(p.name) + "</strong> 移出本轮吗？",
      note: "该玩家的手机会收到被移除提示，需要重新扫码加入；已产生的中奖记录会保留。",
      confirmText: "踢出玩家",
      danger: true
    });
    if (!ok) return;
    await withBtn(btn, async function () {
      var res = await postAction({ type: "player.kick", pid: pid });
      if (!res) return;
      toast("已踢出玩家「" + p.name + "」", "success");
    });
    renderAll();
  }

  async function awardPlayer(pid, btn) {
    var p = findPlayer(pid);
    if (!p) return;
    if ((p.prize && p.prize.name) || p.status === "won") {
      toast("该玩家已经中奖，不能重复发奖", "warn");
      return;
    }
    var ok = await confirmModal({
      title: "手动发奖",
      text: "确定给 <strong>" + esc(p.avatar || "🐲") + " " + esc(p.name) + "</strong> 手动发放一件奖品吗？",
      note: "将按当前抽奖规则从剩余库存中发放（库存 -1），玩家立即中奖；库存全部发完时发放「新春福袋」安慰奖。",
      confirmText: "确认发奖",
      danger: false
    });
    if (!ok) return;
    await withBtn(btn, async function () {
      var res = await postAction({ type: "player.award", pid: pid });
      if (!res) return;
      toast("已为「" + p.name + "」发放奖品", "success");
    });
    renderAll();
  }

  /* ------------------------------------------------------------------ */
  /* 操作：名单                                                          */
  /* ------------------------------------------------------------------ */

  async function clearWinners(btn) {
    var n = state.winners.length;
    if (!n) {
      toast("中奖名单已经是空的", "warn");
      return;
    }
    var ok = await confirmModal({
      title: "清空中奖名单",
      text: "确定清空当前中奖名单（共 <strong>" + n + " 条</strong>）吗？",
      note: "只清除名单记录，不会恢复奖品库存，也不会重置玩家；此操作不可撤销。",
      confirmText: "清空名单",
      danger: true
    });
    if (!ok) return;
    await withBtn(btn, async function () {
      var res = await postAction({ type: "winner.clear" });
      if (!res) return;
      toast("中奖名单已清空", "success");
    });
    renderAll();
  }

  /* ------------------------------------------------------------------ */
  /* 复制加入地址                                                        */
  /* ------------------------------------------------------------------ */

  async function copyJoinUrl(btn) {
    var input = $("#ovJoinUrl");
    var text = (input && input.value) || "";
    if (!text) return;
    var ok = false;
    try {
      if (navigator.clipboard && window.isSecureContext) {
        await navigator.clipboard.writeText(text);
        ok = true;
      }
    } catch (e) { ok = false; }
    if (!ok) {
      try {
        if (input) {
          input.removeAttribute("readonly");
          input.select();
          input.setSelectionRange(0, text.length);
          ok = document.execCommand("copy");
          input.setAttribute("readonly", "readonly");
          input.blur();
        }
      } catch (e) { ok = false; }
    }
    if (ok) toast("加入地址已复制", "success");
    else toast("复制失败，请手动选中地址复制", "warn");
  }

  /* ------------------------------------------------------------------ */
  /* 事件绑定                                                            */
  /* ------------------------------------------------------------------ */

  function bind() {
    /* 登录 */
    var loginForm = $("#loginForm");
    if (loginForm) {
      loginForm.addEventListener("submit", async function (ev) {
        ev.preventDefault();
        var pinEl = $("#pinInput");
        var pin = pinEl ? pinEl.value.trim() : "";
        if (!/^\d{4,8}$/.test(pin)) {
          showLoginError("请输入 4–8 位数字 PIN");
          return;
        }
        await withBtn($("#loginBtn"), async function () {
          var res = await Net.post("/api/admin/login", { pin: pin });
          if (res && res.__status === 429) {
            showLoginError((res && res.error) || "尝试次数过多，请稍后再试");
            return;
          }
          if (!res || res.__status === 401 || res.code === "BAD_PIN") {
            showLoginError((res && res.error) || "PIN 不正确");
            return;
          }
          if (res.ok !== true) {
            showLoginError((res && res.error) || "登录失败，请重试");
            return;
          }
          var data = await Net.get("/api/admin/data");
          if (data && data.__status === 401) {
            showLoginError("登录状态未生效，请重试");
            return;
          }
          if (!data || data.ok !== true) {
            showLoginError((data && data.error) || "读取后台数据失败，请重试");
            return;
          }
          applyAdminData(data);
          showLoginError("");
          enterApp();
          toast("欢迎回来，主持人", "success");
        });
      });
    }
    var pinInput = $("#pinInput");
    if (pinInput) pinInput.addEventListener("input", function () { showLoginError(""); });

    /* 退出 */
    var logoutBtn = $("#logoutBtn");
    if (logoutBtn) logoutBtn.addEventListener("click", function () { withBtn(logoutBtn, doLogout); });

    /* 导航 */
    var nav = $(".sidebar__nav");
    if (nav) {
      nav.addEventListener("click", function (e) {
        var item = e.target.closest("[data-view]");
        if (item) switchView(item.dataset.view);
      });
    }
    $$("[data-goto]").forEach(function (el) {
      el.addEventListener("click", function () { switchView(el.dataset.goto); });
    });

    /* 总览主操作 */
    var startBtn = $("#startBtn");
    if (startBtn) startBtn.addEventListener("click", function () { startGame(startBtn); });
    var revealBtn = $("#revealBtn");
    if (revealBtn) revealBtn.addEventListener("click", function () { revealGame(revealBtn); });
    var resetBtn = $("#resetBtn");
    if (resetBtn) resetBtn.addEventListener("click", function () { resetSession(resetBtn); });
    var copyBtn = $("#copyUrlBtn");
    if (copyBtn) copyBtn.addEventListener("click", function () { copyJoinUrl(copyBtn); });

    /* 奖品 */
    var addBtn = $("#prizeAddBtn");
    if (addBtn) addBtn.addEventListener("click", function () { togglePrizeAddForm(); });
    var addCancel = $("#prizeAddCancel");
    if (addCancel) addCancel.addEventListener("click", function () { togglePrizeAddForm(false); });
    var addForm = $("#prizeAddForm");
    if (addForm) addForm.addEventListener("submit", addPrize);
    var reseedBtn = $("#prizeReseedBtn");
    if (reseedBtn) reseedBtn.addEventListener("click", function () { reseedPrizes(reseedBtn); });

    var prizeList = $("#prizeList");
    if (prizeList) {
      prizeList.addEventListener("click", function (e) {
        var btn = e.target.closest("[data-act]");
        if (!btn) return;
        var row = btn.closest("[data-id]");
        if (!row) return;
        var id = row.dataset.id;
        var prize = null;
        for (var i = 0; i < state.prizes.length; i++) {
          if (state.prizes[i].id === id) { prize = state.prizes[i]; break; }
        }
        if (!prize) return;
        var act = btn.dataset.act;
        if (act === "inc") changePrizeQty(prize, 1, btn);
        else if (act === "dec") changePrizeQty(prize, -1, btn);
        else if (act === "edit") openPrizeEdit(prize);
        else if (act === "del") removePrize(prize, btn);
      });
    }

    /* 规则 */
    var rulesForm = $("#rulesForm");
    if (rulesForm) {
      rulesForm.addEventListener("input", function (e) {
        if (e.target.closest("button")) return;
        markRulesDirty();
      });
      rulesForm.addEventListener("change", function (e) {
        if (e.target.closest("button")) return;
        markRulesDirty();
      });
      rulesForm.addEventListener("submit", saveRules);
    }
    var diffGrid = $("#diffGrid");
    if (diffGrid) {
      diffGrid.addEventListener("click", function (e) {
        var card = e.target.closest("[data-diff]");
        if (!card) return;
        var key = card.dataset.diff;
        if (key === state.selectedDiff) return;
        state.selectedDiff = key;
        state.rulesDirty = true;
        renderRules();
      });
    }
    var ruleSeg = $("#awardRuleSeg");
    if (ruleSeg) {
      ruleSeg.addEventListener("click", function (e) {
        var item = e.target.closest("[data-rule]");
        if (!item) return;
        var rule = item.dataset.rule;
        if (rule === state.selectedRule) return;
        state.selectedRule = rule;
        state.rulesDirty = true;
        renderRules();
      });
    }
    var discardBtn = $("#rulesDiscardBtn");
    if (discardBtn) discardBtn.addEventListener("click", discardRules);

    /* 玩家 */
    var refreshPlayers = $("#playersRefreshBtn");
    if (refreshPlayers) refreshPlayers.addEventListener("click", function () {
      withBtn(refreshPlayers, function () { return loadAll(); });
    });
    var playerList = $("#playerList");
    if (playerList) {
      playerList.addEventListener("click", function (e) {
        var btn = e.target.closest("[data-act]");
        if (!btn) return;
        var row = btn.closest("[data-pid]");
        if (!row) return;
        var pid = row.dataset.pid;
        var act = btn.dataset.act;
        if (act === "kick") kickPlayer(pid, btn);
        else if (act === "award") awardPlayer(pid, btn);
      });
    }

    /* 名单 */
    var clearBtn = $("#clearWinnersBtn");
    if (clearBtn) clearBtn.addEventListener("click", function () { clearWinners(clearBtn); });
    var exportBtn = $("#exportCsvBtn");
    if (exportBtn) {
      exportBtn.addEventListener("click", function (e) {
        /* 先确认登录态，避免下载到 401 响应 */
        Net.get("/api/admin/data").then(function (res) {
          if (res && res.__status === 401) {
            expireLogin();
          }
        }).catch(function () {});
      });
    }

    /* 回到前台时拉一次最新数据 */
    document.addEventListener("visibilitychange", function () {
      if (document.visibilityState === "visible" && state.authed) scheduleRefresh(0);
    });
  }

  /* ------------------------------------------------------------------ */
  /* 启动                                                                */
  /* ------------------------------------------------------------------ */

  function init() {
    bind();
    setConn("connecting");
    checkAuth().catch(function () { showLogin("暂时无法连接服务器，请确认服务已启动"); });
    /* 兜底：无论校验结果如何，1.5s 内必须移除启动遮罩 */
    setTimeout(hideSplash, 1500);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
