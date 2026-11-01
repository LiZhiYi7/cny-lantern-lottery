/* ==========================================================================
   大屏（投影端）逻辑 —— host-screen 维护
   数据来源：GET /api/state（首帧快照） + SSE /api/stream?role=host
   严格按 PROTOCOL.md §3 数据模型 / §5 SSE 事件 / §8 art.js 接口实现。
   写作用域：public/js/host.js
   ========================================================================== */
(function () {
  "use strict";

  var MAX_ACTORS = 96;          // 舞台最多同时渲染的头像数（防极端人数卡顿）
  var TICKER_MAX = 8;
  var PHASE_LABEL = { lobby: "大厅候场", playing: "灯阵挑战中", reveal: "开奖揭晓" };
  var STATUS_TAG = { joined: "", playing: "挑战中", won: "已通关", lost: "未通关" };
  var STATUS_CLASS = {
    joined: "actor--idle",
    playing: "actor--playing",
    won: "actor--won",
    lost: "actor--lost"
  };

  /* ------------------------------------------------------------ 工具 ---- */
  function $(id) {
    return document.getElementById(id);
  }
  function num(v) {
    var n = Number(v);
    return isFinite(n) ? n : 0;
  }
  function clamp(v, a, b) {
    return v < a ? a : v > b ? b : v;
  }
  function esc(s) {
    if (window.Net && typeof Net.escape === "function") return Net.escape(s);
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }
  function hashStr(str) {
    var h = 2166136261;
    str = String(str || "");
    for (var i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return h >>> 0;
  }
  function tickerKey(w) {
    if (!w) return "";
    var pr = w.prize || {};
    return num(w.at) + ":" + (w.pid || "") + ":" + (pr.id || pr.name || "");
  }

  /* ------------------------------------------------------------ 状态 ---- */
  var state = {
    session: null,
    game: null,
    offset: 0,
    phase: null,
    players: [],
    maxPlayers: 30,
    knownPids: Object.create(null),
    prevStatus: Object.create(null),
    title: "",
    sub: "",
    roomCode: "",
    joinedSeen: -1,
    qrUrl: "",
    prizeSig: "",
    ticker: [],
    tickerSig: "",
    tickerDomSig: "",
    awardQueue: [],
    awardBusy: false,
    awardGen: 0,
    revealKey: "",
    revealTimers: [],
    cdTimer: null,
    cdNum: null,
    cdFinished: false,
    layoutQueued: false,
    bootTimer: null,
    retryTimer: null,
    resizeTimer: null,
    stream: null
  };

  var scene = null;

  /* ------------------------------------------------- art.js 场景接入 ---- */
  function sscene(method) {
    if (!scene || typeof scene[method] !== "function") return null;
    try {
      return scene[method].apply(scene, Array.prototype.slice.call(arguments, 1));
    } catch (err) {
      console.warn("[host] art.js 调用失败:", method, err);
      return null;
    }
  }
  function sceneBurst(x, y, opts) {
    sscene("burst", x, y, opts);
  }
  function sceneCelebrate(n) {
    sscene("celebrate", n);
  }

  function initScene() {
    var canvas = $("bg");
    var phase = (state.session && state.session.phase) || "lobby";
    try {
      if (canvas && window.Art && typeof Art.createScene === "function") {
        scene = Art.createScene(canvas, { quality: "high", density: 1, phase: phase });
        if (scene && typeof scene.start === "function") scene.start();
        sscene("setPhase", phase);
      }
    } catch (err) {
      console.warn("[host] art.js 场景不可用，降级为 CSS 背景:", err);
      scene = null;
    }
    if (!scene) document.body.classList.add("host--fallback");
  }

  /* ------------------------------------------------------- 时钟同步 ---- */
  function now() {
    return Date.now() + num(state.offset);
  }
  function syncClock(session) {
    var st = num(session && session.serverTime);
    if (st > 1000000) state.offset = st - Date.now();
  }

  /* ------------------------------------------------------- 会话入口 ---- */
  function applySession(session) {
    if (!session || typeof session !== "object") return;
    syncClock(session);
    state.session = session;
    state.game = state.game || null;
    state.players = Array.isArray(session.players) ? session.players : [];
    var cfg = session.config || {};
    if (cfg.maxPlayers != null) state.maxPlayers = clamp(num(cfg.maxPlayers), 1, 999);

    syncPhase(session.phase || "lobby");
    renderHeader(session);
    renderRoom(session);
    syncTicker(session);

    if (state.phase === "playing") renderPlaying(session);
    else if (state.phase === "reveal") renderReveal(session);
    else renderLobby(session);

    scheduleLayout();
  }

  function syncPhase(phase) {
    phase = phase === "playing" || phase === "reveal" ? phase : "lobby";
    if (state.phase === phase) return;
    var prev = state.phase;
    state.phase = phase;
    document.body.setAttribute("data-phase", phase);
    $("vLobby").classList.toggle("hidden", phase !== "lobby");
    $("vPlaying").classList.toggle("hidden", phase !== "playing");
    $("vReveal").classList.toggle("hidden", phase !== "reveal");
    sscene("setPhase", phase);
    resetCountdown();

    if (phase === "reveal") {
      state.revealKey = "";
      clearRevealTimers();
      clearAwardCards(); // 开奖大屏优先，清掉残留的中奖浮层
      state.revealTimers.push(setTimeout(function () { sceneCelebrate(6); }, 240));
      state.revealTimers.push(setTimeout(function () { sceneCelebrate(4); }, 1200));
      state.revealTimers.push(setTimeout(function () { sceneCelebrate(3); }, 2400));
      sscene("setEnergy", 1);
    } else if (phase === "playing") {
      sscene("setEnergy", 0.8);
      startCountdownLoop();
    } else {
      sscene("setEnergy", 0.55);
      if (prev === "reveal") {
        state.prevStatus = Object.create(null);
      }
    }
  }

  function clearRevealTimers() {
    state.revealTimers.forEach(function (t) { clearTimeout(t); });
    state.revealTimers = [];
  }

  /* --------------------------------------------------------- 顶栏 ---- */
  function renderHeader(s) {
    var cfg = s.config || {};
    var title = cfg.title || "新春年会抽奖";
    var sub = cfg.subtitle || "扫码入场 · 灯阵夺魁 · 好运连连";
    if (state.title !== title) {
      state.title = title;
      $("hTitle").textContent = title;
      document.title = title + " · 大屏";
    }
    if (state.sub !== sub) {
      state.sub = sub;
      $("hSubtitle").textContent = sub;
    }

    var ph = state.phase || "lobby";
    var badge = $("hPhase");
    badge.textContent = PHASE_LABEL[ph] || ph;
    badge.classList.toggle("badge--live", ph !== "reveal");
    badge.classList.toggle("badge--gold", ph === "reveal");

    var diff = s.difficulty || {};
    if (diff.label) {
      $("hDiffText").textContent = diff.label + (diff.guaranteed ? " · 必得" : "");
      var dot = $("hDiffDot");
      dot.style.background = diff.color || "#4fd1a5";
      dot.style.color = diff.color || "#4fd1a5";
      $("hRuleDiff").textContent = diff.label;
      $("hRuleDesc").textContent = diff.guaranteed
        ? " · 完成即得奖品"
        : (num(diff.maxStrikes) > 0 ? " · " + diff.maxStrikes + " 次容错" : " · 零容错");
    }

    var st = s.stats || {};
    var awarded = num(st.awardedPrizes);
    var total = num(st.totalPrizes);
    if (!total && Array.isArray(s.prizes)) {
      s.prizes.forEach(function (p) { total += num(p.quantity); });
    }
    $("hAwardNum").textContent = awarded + " / " + total;
  }

  /* -------------------------------------------------- 房间号 / 二维码 ---- */
  function renderRoom(s) {
    var code = String(s.roomCode || "");
    var roomEl = $("hRoom");
    if (code && code !== state.roomCode) {
      var isReset = !!state.roomCode;
      state.roomCode = code;
      roomEl.textContent = code;
      roomEl.classList.remove("is-fresh");
      void roomEl.offsetWidth;
      roomEl.classList.add("is-fresh");
      if (isReset) {
        // 新一轮：清掉上一轮的本地舞台状态
        state.prevStatus = Object.create(null);
        state.knownPids = Object.create(null);
        state.ticker = [];
        state.tickerSig = "";
        state.tickerDomSig = "";
        state.revealKey = "";
        state.joinedSeen = -1;
        clearRevealTimers();
        clearAwardCards();
      }
    } else if (!code) {
      roomEl.textContent = "- - - - - -";
    }

    var url = s.joinUrl || (location.origin + "/play");
    if (url && url !== state.qrUrl) {
      state.qrUrl = url;
      var img = $("hQr");
      $("hQrFrame").classList.remove("qr-frame--error");
      img.src = "/api/qr.svg?text=" + encodeURIComponent(url);
      img.alt = "扫码加入房间 " + (code || "");
      $("hJoinUrl").textContent = url;
    }

    var joined = state.players.length;
    var max = state.maxPlayers;
    $("hJoined").textContent = joined;
    $("hMax").textContent = max;
    var bar = $("hJoinedBar");
    if (bar) bar.style.width = (max > 0 ? Math.min(100, (joined / max) * 100) : 0).toFixed(1) + "%";
    if (joined > state.joinedSeen && state.joinedSeen >= 0 && state.phase === "lobby") {
      var ring = $("hCountRing");
      ring.classList.remove("is-bump");
      void ring.offsetWidth;
      ring.classList.add("is-bump");
    }
    state.joinedSeen = joined;
  }

  /* ------------------------------------------------------- 大厅视图 ---- */
  function renderLobby(s) {
    var players = state.players;
    var sub;
    if (!players.length) {
      sub = "等待玩家扫码入场…";
    } else if (players.length >= state.maxPlayers) {
      sub = "已入场 " + players.length + " 位 · 房间已满，可以开赛";
    } else {
      sub = "已入场 " + players.length + " 位 · 等待主持人开赛";
    }
    $("hLobbySub").textContent = sub;
    $("lobbyEmpty").classList.toggle("is-hidden", players.length > 0);

    renderPrizes(s);
    syncActors($("actorsLobby"), players, "lobby");
  }

  function renderPrizes(s) {
    var prizes = Array.isArray(s.prizes) ? s.prizes.slice() : [];
    prizes.sort(function (a, b) { return num(a.order) - num(b.order); });

    var totalRemain = 0;
    prizes.forEach(function (p) { totalRemain += Math.max(0, num(p.remaining)); });
    $("hPrizeSum").textContent = "共 " + prizes.length + " 种 · 余 " + totalRemain + " 件";

    var sig = prizes
      .map(function (p) {
        return [p.id, p.name, p.emoji, p.quantity, p.awarded, p.remaining].join(":");
      })
      .join("|");
    if (sig === state.prizeSig) return;
    state.prizeSig = sig;

    var track = $("prizeTrack");
    if (!prizes.length) {
      track.innerHTML = '<div class="prize-card prize-card--empty">主持人尚未配置奖品</div>';
      return;
    }
    var MAX = 8;
    var shown = prizes.slice(0, MAX);
    var html = shown
      .map(function (p, i) {
        return (
          '<div class="prize-card" style="--d:' + (-i * 0.75).toFixed(2) + "s;--ry:" + (i % 2 ? "9deg" : "-9deg") + '">' +
          '<div class="prize-card__emoji">' + esc(p.emoji || "🎁") + "</div>" +
          '<div class="prize-card__name">' + esc(p.name || "神秘奖品") + "</div>" +
          '<div class="prize-card__meta"><b class="num">' + Math.max(0, num(p.remaining)) + "</b> / " + num(p.quantity) + " 件</div>" +
          "</div>"
        );
      })
      .join("");
    if (prizes.length > MAX) {
      html +=
        '<div class="prize-card prize-card--sum">' +
        '<div class="prize-card__emoji">🎁</div>' +
        '<div class="prize-card__name">+' + (prizes.length - MAX) + " 种</div>" +
        '<div class="prize-card__meta">共 ' + totalRemain + " 件</div>" +
        "</div>";
    }
    track.innerHTML = html;
  }

  /* ----------------------------------------------------- 游戏中视图 ---- */
  function renderPlaying(s) {
    var players = state.players;
    var won = 0;
    var playing = 0;
    var idle = 0;
    var lost = 0;
    players.forEach(function (p) {
      if (p.status === "won") won++;
      else if (p.status === "playing") playing++;
      else if (p.status === "lost") lost++;
      else idle++;
    });
    $("pWon").textContent = won;
    $("pPlaying").textContent = playing;
    $("pIdle").textContent = idle;

    var subParts = ["共 " + players.length + " 人"];
    if (lost) subParts.push("已淘汰 " + lost + " 人");
    if (won) subParts.push("通关 " + won + " 人");
    $("hPlaySub").textContent = players.length ? subParts.join(" · ") : "等待玩家…";

    var diff = s.difficulty || {};
    $("pDiffLabel").textContent = diff.label || "简单";
    var waves = 0;
    if (Array.isArray(diff.waves)) waves = diff.waves.length;
    else if (state.game && Array.isArray(state.game.waves)) waves = state.game.waves.length;
    else if (diff.waveCount != null) waves = num(diff.waveCount);
    $("pDiffWaves").textContent =
      (waves ? waves + " 波灯阵" : "灯阵挑战") + (diff.guaranteed ? " · 必得奖品" : "");
    $("pDiffDesc").textContent = diff.desc || "按顺序复现灯阵，注意每档允许的失误次数";
    $("pDiffPass").textContent = diff.estimatedPass || "—";

    renderTicker();
    syncActors($("actorsPlaying"), players, "playing");
  }

  /* --------------------------------------------------- 现场中奖 ticker ---- */
  function syncTicker(s) {
    var winners = Array.isArray(s.winners) ? s.winners : [];
    var fromSession = winners.slice(-TICKER_MAX).reverse();
    var local = state.ticker || [];
    var nowMs = Date.now();
    var extra = local.filter(function (w) {
      if (!w) return false;
      var k = tickerKey(w);
      if (fromSession.some(function (x) { return tickerKey(x) === k; })) return false;
      // 服务端 session 里还没反映出来的本地中奖，保留 15s
      return nowMs - num(w.__localAt || w.at) < 15000;
    });
    var merged = extra.concat(fromSession).slice(0, TICKER_MAX);
    var sig = merged.map(tickerKey).join("|");
    if (sig !== state.tickerSig) {
      state.tickerSig = sig;
      state.ticker = merged;
    }
  }

  function renderTicker() {
    var list = state.ticker || [];
    var sig = list.map(tickerKey).join("|");
    if (sig === state.tickerDomSig) return;
    var prevFirst = state.tickerDomSig ? state.tickerDomSig.split("|")[0] : "";
    var firstKey = list.length ? tickerKey(list[0]) : "";
    state.tickerDomSig = sig;

    var host = $("tickerList");
    if (!host) return;
    if (!list.length) {
      host.innerHTML = '<div class="ticker__empty">静候第一位通关者…</div>';
      return;
    }
    host.innerHTML = list
      .map(function (w) {
        var pr = w.prize || {};
        var isNew = firstKey && firstKey === tickerKey(w) && firstKey !== prevFirst;
        return (
          '<div class="ticker__row' + (isNew ? " is-new" : "") + '">' +
          '<span class="ticker__avatar">' + esc(w.avatar || "🎉") + "</span>" +
          '<span class="ticker__name">' + esc(w.name || "嘉宾") + "</span>" +
          '<span class="ticker__prize">' + esc(pr.emoji || "🎁") + " " + esc(pr.name || "奖品") + "</span>" +
          "</div>"
        );
      })
      .join("");
  }

  /* ------------------------------------------------------- 开奖视图 ---- */
  function statHtml(label, value) {
    return (
      '<div class="reveal-stat"><span class="reveal-stat__label">' + esc(label) +
      '</span><b class="num">' + esc(value) + "</b></div>"
    );
  }

  function renderReveal(s) {
    var winners = Array.isArray(s.winners) ? s.winners : [];
    var prizes = Array.isArray(s.prizes) ? s.prizes.slice() : [];

    // 统计
    var stats = s.stats || {};
    var joined = num(stats.joined) || state.players.length;
    var totalPrizes = num(stats.totalPrizes);
    if (!totalPrizes) {
      prizes.forEach(function (p) { totalPrizes += num(p.quantity); });
    }
    var awarded = num(stats.awardedPrizes);
    if (!awarded) awarded = winners.length;
    var remain = Math.max(0, totalPrizes - awarded);

    $("revealTitle").textContent = winners.length ? "恭喜中奖" : "本轮开奖";
    $("revealSub").textContent = winners.length
      ? "本轮共 " + winners.length + " 位嘉宾夺奖 · 好运连连"
      : "本轮共 0 位嘉宾夺奖 · 下一轮就是你的舞台";

    $("revealEmpty").classList.toggle("hidden", winners.length > 0);
    $("revealGroups").classList.toggle("hidden", winners.length === 0);
    $("revealHint").classList.toggle("hidden", winners.length === 0);

    $("revealStats").innerHTML =
      statHtml("参与人数", joined) +
      statHtml("中奖人数", winners.length) +
      statHtml("剩余奖品", remain) +
      statHtml("已出奖", awarded + " / " + totalPrizes);

    if (!winners.length) {
      state.revealKey = "";
      return;
    }

    // 按奖项分组（consolation 排最后，其余按奖品 order）
    var groups = [];
    var byKey = Object.create(null);
    winners.forEach(function (w) {
      var pr = w.prize || {};
      var key = pr.id || "n:" + (pr.name || "福袋");
      var g = byKey[key];
      if (!g) {
        g = byKey[key] = {
          key: key,
          name: pr.name || "新春福袋",
          emoji: pr.emoji || "🎁",
          consolation: !!pr.consolation,
          list: []
        };
        groups.push(g);
      }
      g.list.push(w);
    });
    var orderIndex = Object.create(null);
    prizes.forEach(function (p, i) {
      orderIndex[p.id] = p.order != null ? num(p.order) : i;
    });
    groups.sort(function (a, b) {
      if (a.consolation !== b.consolation) return a.consolation ? 1 : -1;
      var oa = orderIndex[a.key];
      var ob = orderIndex[b.key];
      if (oa == null) oa = 999;
      if (ob == null) ob = 999;
      return oa - ob;
    });

    var key = winners
      .map(function (w) {
        var pr = w.prize || {};
        return (w.pid || "") + ":" + (pr.id || pr.name || "");
      })
      .join("|");
    if (key === state.revealKey) return;
    state.revealKey = key;

    var delay = 0;
    var html = groups
      .map(function (g, gi) {
        var names = g.list
          .map(function (w) {
            // 逐条弹出，但整体延迟封顶在 ~1.6s，人多时也能很快看全
            var d = Math.min(delay, 20) * 80;
            delay++;
            return (
              '<span class="reveal-name" style="--d:' + d + 'ms">' +
              '<b class="reveal-name__avatar">' + esc(w.avatar || "🎉") + "</b>" +
              esc(w.name || "嘉宾") +
              "</span>"
            );
          })
          .join("");
        return (
          '<div class="reveal-group' + (g.consolation ? " reveal-group--consolation" : "") +
          '" style="--i:' + gi + '">' +
          '<div class="reveal-group__head">' +
          '<span class="reveal-group__emoji">' + esc(g.emoji) + "</span>" +
          '<span class="reveal-group__name">' + esc(g.name) + "</span>" +
          '<span class="reveal-group__count num">×' + g.list.length + "</span>" +
          "</div>" +
          '<div class="reveal-group__list">' + names + "</div>" +
          "</div>"
        );
      })
      .join("");
    $("revealGroups").innerHTML = html;
    // 中奖人数多时切换紧凑排版（多轮累计时也能一屏放下）
    var rgEl = $("revealGroups");
    rgEl.classList.toggle("is-dense", winners.length > 36);
    rgEl.classList.toggle("is-dense-2", winners.length > 80);
    requestAnimationFrame(fitRevealGroups);

    clearRevealTimers();
    var totalMs = Math.min(1600, 320 + delay * 80);
    state.revealTimers.push(setTimeout(function () { sceneCelebrate(5); }, totalMs));
    state.revealTimers.push(setTimeout(function () { sceneCelebrate(3); }, totalMs + 1300));
  }

  /** 奖项分组太多/太高时整体等比缩小，保证一屏展示不裁切 */
  function fitRevealGroups() {
    var body = $("revealBody");
    var rg = $("revealGroups");
    if (!body || !rg || rg.classList.contains("hidden")) return;
    rg.style.transform = "none";
    var kids = rg.children;
    if (!kids || !kids.length) return;
    var avail = body.clientHeight - 6;
    if (avail <= 0) return;
    // 内容比容器高时上下都会溢出，用子元素实测包围盒而不是 scrollHeight
    var top = Infinity;
    var bottom = -Infinity;
    for (var i = 0; i < kids.length; i++) {
      var r = kids[i].getBoundingClientRect();
      if (!r.height) continue;
      if (r.top < top) top = r.top;
      if (r.bottom > bottom) bottom = r.bottom;
    }
    var need = bottom - top;
    if (!isFinite(need) || need <= 0) return;
    if (need > avail) {
      var s = Math.max(0.45, avail / need);
      rg.style.transform = "scale(" + s.toFixed(3) + ")";
    }
  }

  /* -------------------------------------------------- 2.5D 舞台布局 ---- */
  function computeLayout(players, W, H) {
    var n = players.length;
    var out = [];
    if (!n || !W || !H) return out;

    var av = clamp(W * 0.07, 56, 106);        // 单头像基准边长（scale=1）
    var slotBase = av * 1.72;                 // 单人横向占位
    var rows = 2;
    var caps = [];
    var sum = 0;
    var k, i;

    // 找到能装下 n 人的最少排数（最多 5 排）
    for (rows = 2; rows <= 5; rows++) {
      caps = [];
      sum = 0;
      for (k = 0; k < rows; k++) {
        var tf = (k + 1) / rows;
        var s = 0.56 + 0.44 * tf;
        var c = Math.max(1, Math.floor((W * (0.7 + 0.3 * tf)) / (slotBase * s)));
        caps.push(c);
        sum += c;
      }
      if (sum >= n) break;
    }
    if (rows > 5) rows = 5;

    // 从前排（rows-1）往后排分配，多出来的人均摊到各排
    var take = [];
    for (k = 0; k < rows; k++) take.push(0);
    var remaining = n;
    for (k = rows - 1; k >= 0; k--) {
      var t = Math.min(caps[k], remaining);
      take[k] = t;
      remaining -= t;
    }
    if (remaining > 0) {
      for (k = rows - 1; k >= 0 && remaining > 0; k--) {
        var add = Math.ceil(remaining / (k + 1));
        take[k] += add;
        remaining -= add;
      }
    }

    // 纵向：前排靠屏幕下方，逐排向上堆叠；放不下时整体压缩间距
    var hScale = clamp(H / 560, 0.72, 1.15);
    var yFront = H * 0.945;
    var gaps = [];
    for (k = rows - 1; k >= 1; k--) {
      var tfK = (k + 1) / rows;
      var sK = (0.56 + 0.44 * tfK) * hScale;
      var figH = av * sK * 1.24 + 40 * sK;
      gaps.push(figH * 0.92 + 6);
    }
    var totalGap = 0;
    for (i = 0; i < gaps.length; i++) totalGap += gaps[i];
    if (totalGap > 0) {
      var avail = yFront - H * 0.1;
      if (totalGap > avail) {
        var f = avail / totalGap;
        for (i = 0; i < gaps.length; i++) gaps[i] *= f;
      }
    }
    var yByRow = [];
    yByRow[rows - 1] = yFront;
    for (k = rows - 2, i = 0; k >= 0; k--, i++) yByRow[k] = yByRow[k + 1] - gaps[i];

    for (k = rows - 1; k >= 0; k--) {
      var cnt = take[k];
      if (!cnt) continue;
      var tf2 = (k + 1) / rows;
      var s2 = (0.56 + 0.44 * tf2) * hScale;
      var rowW = W * (0.7 + 0.3 * tf2);
      var slot = Math.min(slotBase * s2, rowW / cnt);
      var scale = Math.min(s2, slot / slotBase);
      for (i = 0; i < cnt; i++) {
        var pid = players[out.length] ? players[out.length].pid : "";
        var h1 = hashStr(pid);
        var jx = (h1 % 7) - 3;
        var jy = ((h1 >> 3) % 7) - 3;
        var x = W / 2 + (i - (cnt - 1) / 2) * slot + jx;
        // 最外侧头像不要把名牌挤出舞台
        var halfW = av * scale * 0.94;
        if (x < halfW) x = halfW;
        if (x > W - halfW) x = W - halfW;
        out.push({
          x: x,
          y: yByRow[k] + jy,
          s: scale,
          av: av,
          z: 20 + k * 10
        });
      }
    }
    return out;
  }

  function layoutActors(host, players) {
    if (!host || !players.length) return;
    var W = host.clientWidth;
    var H = host.clientHeight;
    if (!W || !H) return;
    var map = host._actors || Object.create(null);
    var pos = computeLayout(players, W, H);
    for (var i = 0; i < pos.length && i < players.length; i++) {
      var el = map[players[i].pid];
      if (!el) continue;
      var p = pos[i];
      el.style.transform = "translate3d(" + p.x.toFixed(1) + "px," + p.y.toFixed(1) + "px,0)";
      el.style.zIndex = String(p.z);
      el.style.setProperty("--s", p.s.toFixed(3));
      el.style.setProperty("--av", p.av.toFixed(1) + "px");
    }
    if (pos.length) host.classList.add("is-laid-out");
  }

  function updateActor(el, p, mode) {
    var status = p.status || "joined";
    var cls = STATUS_CLASS[status] || "actor--idle";
    if (el._cls !== cls) {
      if (el._cls) el.classList.remove(el._cls);
      el.classList.add(cls);
      el._cls = cls;
    }
    el.setAttribute("data-status", status);

    var av = el.querySelector(".actor__avatar");
    var avatar = p.avatar || "🐲";
    if (av.textContent !== avatar) av.textContent = avatar;

    var nm = el.querySelector(".actor__name");
    var name = p.name || "嘉宾";
    if (nm.textContent !== name) nm.textContent = name;

    // 状态标签只在游戏阶段、且已出结果时显示，避免满屏小字
    var tag = el.querySelector(".actor__tag");
    var tagText = "";
    if (mode === "playing" && (status === "won" || status === "lost")) {
      tagText = STATUS_TAG[status] || "";
    }
    if (tag.textContent !== tagText) tag.textContent = tagText;

    // 中奖者头像旁挂一个奖品 emoji（不占额外行高）
    var pz = el.querySelector(".actor__prize");
    var pr = p.prize || null;
    var pzText = status === "won" && pr ? pr.emoji || "🎁" : "";
    if (pz.textContent !== pzText) pz.textContent = pzText;
    pz.title = status === "won" && pr ? pr.name || "" : "";

    // 刚通关：金色爆发 + 局部烟花
    if (status === "won" && state.prevStatus[p.pid] !== "won") {
      el.classList.remove("actor--just-won");
      void el.offsetWidth;
      el.classList.add("actor--just-won");
      setTimeout(function () { el.classList.remove("actor--just-won"); }, 1300);
      var r = el.getBoundingClientRect();
      if (r.width || r.height) {
        sceneBurst(r.left + r.width / 2, r.top + r.height * 0.32, { count: 20, power: 0.8 });
      }
    }
    state.prevStatus[p.pid] = status;
  }

  function syncActors(host, players, mode) {
    if (!host) return;
    var map = host._actors || (host._actors = Object.create(null));
    var list = players.length > MAX_ACTORS ? players.slice(0, MAX_ACTORS) : players;
    var seen = Object.create(null);
    var i;

    for (i = 0; i < list.length; i++) seen[list[i].pid] = true;
    Object.keys(map).forEach(function (pid) {
      if (!seen[pid]) {
        var el = map[pid];
        if (el && el.parentNode) el.parentNode.removeChild(el);
        delete map[pid];
      }
    });

    for (i = 0; i < list.length; i++) {
      var p = list[i];
      var node = map[p.pid];
      if (!node) {
        node = document.createElement("div");
        node.className = "actor";
        node.setAttribute("data-pid", p.pid);
        node.innerHTML =
          '<div class="actor__fig">' +
          '<div class="actor__shadow"></div>' +
          '<div class="actor__body">' +
          '<div class="actor__halo"></div>' +
          '<div class="actor__avatar"></div>' +
          '<div class="actor__plate"><span class="actor__name"></span><b class="actor__prize"></b></div>' +
          '<div class="actor__tag"></div>' +
          "</div>" +
          "</div>";
        host.appendChild(node);
        map[p.pid] = node;
        if (!state.knownPids[p.pid]) {
          state.knownPids[p.pid] = true;
          node.classList.add("actor--enter");
          (function (n) {
            setTimeout(function () { n.classList.remove("actor--enter"); }, 1100);
          })(node);
        }
      }
      updateActor(node, p, mode);
    }

    host._players = list;
    layoutActors(host, list);
  }

  function scheduleLayout() {
    if (state.layoutQueued) return;
    state.layoutQueued = true;
    requestAnimationFrame(function () {
      state.layoutQueued = false;
      var a = $("actorsLobby");
      var b = $("actorsPlaying");
      if (a) layoutActors(a, a._players || []);
      if (b) layoutActors(b, b._players || []);
      if (state.phase === "reveal") fitRevealGroups();
    });
  }

  /* ------------------------------------------------------- 倒计时 ---- */
  function startCountdownLoop() {
    if (state.cdTimer) return;
    state.cdTimer = setInterval(tickCountdown, 90);
    tickCountdown();
  }
  function stopCountdownLoop() {
    if (state.cdTimer) {
      clearInterval(state.cdTimer);
      state.cdTimer = null;
    }
  }
  function resetCountdown() {
    stopCountdownLoop();
    state.cdNum = null;
    state.cdFinished = false;
    hideCountdown();
  }
  function hideCountdown() {
    var el = $("countdown");
    if (el) el.classList.add("hidden");
  }

  function tickCountdown() {
    var s = state.session;
    if (!s) return;
    if (s.phase !== "playing") {
      resetCountdown();
      return;
    }
    var startAt = num(s.startAt) || (state.game ? num(state.game.startAt) : 0);
    var el = $("countdown");
    if (!startAt) {
      hideCountdown();
      return;
    }
    var remain = startAt - now();
    var numEl = $("countdownNum");

    if (remain > 0) {
      el.classList.remove("hidden");
      state.cdFinished = false;
      var n = clamp(Math.ceil(remain / 1000), 1, 3);
      if (state.cdNum !== n) {
        state.cdNum = n;
        numEl.classList.remove("is-go");
        numEl.textContent = String(n);
        numEl.classList.remove("is-pop");
        void numEl.offsetWidth;
        numEl.classList.add("is-pop");
        $("countdownText").textContent = "灯阵即将开启 · 共 " + (state.players.length || 1) + " 位挑战者";
        sscene("setEnergy", 0.55 + (3 - n) * 0.15);
      }
    } else if (!state.cdFinished) {
      state.cdFinished = true;
      el.classList.remove("hidden");
      numEl.classList.remove("is-pop");
      numEl.textContent = "开始";
      numEl.classList.add("is-go");
      $("countdownText").textContent = "灯阵已开启，加油！";
      sscene("setEnergy", 1);
      sceneCelebrate(2);
      setTimeout(hideCountdown, 1000);
    }
  }

  /* ------------------------------------------------------- 中奖浮层 ---- */
  function onAward(msg) {
    if (!msg) return;
    var prize = msg.prize || {};
    var winner = msg.winner || {
      pid: msg.pid,
      name: msg.name,
      avatar: msg.avatar,
      prize: prize,
      at: now()
    };
    winner.__localAt = Date.now();

    // ticker 立即更新
    var list = state.ticker.slice();
    var k = tickerKey(winner);
    var exists = false;
    for (var i = 0; i < list.length; i++) {
      if (tickerKey(list[i]) === k) {
        exists = true;
        break;
      }
    }
    if (!exists) {
      list.unshift(winner);
      state.ticker = list.slice(0, TICKER_MAX);
    }
    renderTicker();

    enqueueAwardCard(winner);

    sceneCelebrate(2);
    if (state.phase === "playing") sscene("setEnergy", 1);
  }

  function enqueueAwardCard(w) {
    state.awardQueue.push(w);
    if (!state.awardBusy) nextAwardCard();
  }

  function clearAwardCards() {
    state.awardGen = (state.awardGen || 0) + 1;
    state.awardQueue = [];
    state.awardBusy = false;
    var layer = $("awardLayer");
    if (layer) layer.innerHTML = "";
  }

  function nextAwardCard() {
    if (!state.awardQueue.length) {
      state.awardBusy = false;
      return;
    }
    state.awardBusy = true;
    var gen = state.awardGen || 0;
    var w = state.awardQueue.shift();
    showAwardCard(w);
    // 多人同时中奖时缩短单张停留，避免排队过长
    var life = state.awardQueue.length ? 2000 : 3000;
    setTimeout(function () {
      if (gen !== (state.awardGen || 0)) {
        // 期间被整体清空（例如切到开奖），继续消费新队列即可
        if (!state.awardBusy) nextAwardCard();
        return;
      }
      hideAwardCard();
      state.awardBusy = false;
      nextAwardCard();
    }, life);
  }

  function showAwardCard(w) {
    var layer = $("awardLayer");
    if (!layer) return;
    var pr = w.prize || {};
    layer.innerHTML =
      '<div class="award-card">' +
      '<div class="award-card__rays"></div>' +
      '<div class="award-card__panel">' +
      '<div class="award-card__eyebrow">灯阵连击 · 通关</div>' +
      '<div class="award-card__row">' +
      '<div class="award-card__avatar">' + esc(w.avatar || "🎉") + "</div>" +
      '<div class="award-card__who">' +
      '<div class="award-card__name">' + esc(w.name || "嘉宾") + "</div>" +
      '<div class="award-card__congrats">恭 喜 中 奖</div>' +
      "</div>" +
      "</div>" +
      '<div class="award-card__prize">' +
      '<span class="award-card__emoji">' + esc(pr.emoji || "🎁") + "</span>" +
      '<span class="award-card__pname">' + esc(pr.name || "新春福袋") +
      (pr.consolation ? " · 安慰奖" : "") + "</span>" +
      "</div>" +
      "</div>" +
      "</div>";
    var card = layer.firstChild;
    if (!card) return;
    setTimeout(function () {
      if (!card.parentNode) return;
      var r = card.getBoundingClientRect();
      var cx = r.left + r.width / 2;
      var cy = r.top + r.height / 2;
      sceneBurst(cx, cy, { count: 46, power: 1.15 });
      sceneBurst(r.left + r.width * 0.14, r.top + r.height * 0.28, { count: 24, power: 0.8 });
      sceneBurst(r.left + r.width * 0.86, r.top + r.height * 0.32, { count: 24, power: 0.8 });
    }, 90);
  }

  function hideAwardCard() {
    var layer = $("awardLayer");
    if (!layer) return;
    var card = layer.firstChild;
    if (!card) return;
    card.classList.add("is-out");
    setTimeout(function () {
      if (card.parentNode) card.parentNode.removeChild(card);
    }, 360);
  }

  /* --------------------------------------------------------- 提示 ---- */
  function toast(text, kind) {
    if (!text) return;
    var layer = $("toastLayer");
    if (!layer) return;
    var el = document.createElement("div");
    el.className =
      "toast" + (kind === "success" ? " toast--success" : kind === "warn" ? " toast--warn" : "");
    el.textContent = text;
    layer.appendChild(el);
    while (layer.children.length > 3) layer.removeChild(layer.firstChild);
    setTimeout(function () {
      el.classList.add("is-out");
      setTimeout(function () {
        if (el.parentNode) el.parentNode.removeChild(el);
      }, 360);
    }, 2600);
  }

  /* ----------------------------------------------------- 连接状态 ---- */
  function setConn(ok) {
    var el = $("hConn");
    if (!el) return;
    el.setAttribute("data-state", ok ? "on" : "off");
    $("hConnText").textContent = ok ? "实时连接" : "重连中…";
  }
  function setConnPending() {
    var el = $("hConn");
    if (!el) return;
    el.setAttribute("data-state", "pending");
    $("hConnText").textContent = "连接中";
  }

  /* --------------------------------------------------- 数据拉取兜底 ---- */
  function fetchState(silent) {
    if (!window.Net || typeof Net.get !== "function") return;
    Net.get("/api/state")
      .then(function (res) {
        if (res && res.ok && res.session) {
          applySession(res.session);
          setConn(true);
        } else if (!silent && !state.session) {
          bootWait();
        }
      })
      .catch(function () {});
  }

  function bootWait() {
    if (state.bootTimer) return;
    var tries = 0;
    state.bootTimer = setInterval(function () {
      tries++;
      if (tries > 60) {
        clearInterval(state.bootTimer);
        state.bootTimer = null;
        return;
      }
      Net.get("/api/state")
        .then(function (res) {
          if (res && res.ok && res.session) {
            clearInterval(state.bootTimer);
            state.bootTimer = null;
            applySession(res.session);
            setConn(true);
          }
        })
        .catch(function () {});
    }, 1600);
  }

  /* ------------------------------------------------------- SSE 接入 ---- */
  function connect() {
    if (!window.Net || typeof Net.stream !== "function") {
      setConn(false);
      $("hConnText").textContent = "脚本缺失";
      return;
    }
    var stream = Net.stream("host");
    state.stream = stream;

    stream.on("hello", function (msg) {
      setConn(true);
      applySession(msg.session);
    });
    stream.on("session", function (msg) {
      setConn(true);
      applySession(msg.session);
    });
    stream.on("game", function (msg) {
      state.game = msg.game || null;
      if (state.session && state.session.phase === "playing") {
        renderPlaying(state.session);
        startCountdownLoop();
      }
    });
    stream.on("award", onAward);
    stream.on("toast", function (msg) {
      toast(msg.text || "", msg.kind);
    });
    stream.on("error", function (msg) {
      toast(msg.message || "服务端提示", "warn");
    });
    stream.on("_open", function () {
      setConn(true);
      fetchState(true);
    });
    stream.on("_error", function () {
      setConn(false);
      if (state.retryTimer) return;
      state.retryTimer = setTimeout(function () {
        state.retryTimer = null;
        fetchState(true);
      }, 2600);
    });

    fetchState(false);
  }

  /* --------------------------------------------------------- 启动 ---- */
  function onResize() {
    if (state.resizeTimer) clearTimeout(state.resizeTimer);
    state.resizeTimer = setTimeout(function () {
      state.resizeTimer = null;
      sscene("resize");
      scheduleLayout();
    }, 110);
  }

  function init() {
    initScene();
    setConnPending();

    var img = $("hQr");
    if (img) {
      img.addEventListener("error", function () {
        var f = $("hQrFrame");
        if (f) f.classList.add("qr-frame--error");
      });
      img.addEventListener("load", function () {
        var f = $("hQrFrame");
        if (f) f.classList.remove("qr-frame--error");
      });
    }

    window.addEventListener("resize", onResize);
    window.addEventListener("orientationchange", onResize);

    if (window.ResizeObserver) {
      try {
        var ro = new ResizeObserver(function () { scheduleLayout(); });
        ["stageLobby", "stagePlaying"].forEach(function (id) {
          var el = $(id);
          if (el) ro.observe(el);
        });
      } catch (err) {}
    }

    if (document.fonts && document.fonts.ready && document.fonts.ready.then) {
      document.fonts.ready.then(scheduleLayout).catch(function () {});
    }

    connect();
    setTimeout(scheduleLayout, 300);
    setTimeout(scheduleLayout, 1200);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
