/* ==========================================================================
   手机端（玩家） · 新春年会抽奖系统
   public/play.html 的完整逻辑：加入 → 等待 → 3-2-1 → 灯阵·连击 → 结算 → 开奖
   依赖：window.Net（net.js，Lead 维护）、theme.css、player.css
   写作用域：public/js/player.js（仅本文件）
   ========================================================================== */
(function () {
  "use strict";

  /* ================= 常量 ================= */

  // 与服务端 lib/room.js AVATARS 对齐的 8 个动物头像（服务端 13 个中取 8）
  var AVATARS = ["🐲", "🦁", "🐯", "🐰", "🐼", "🦊", "🐵", "🐷"];
  var LANTERN_COUNT = 8;
  var AVATAR_GLYPHS = "福禄寿喜财";
  var CONFETTI_COLORS = ["#f7d488", "#e9b949", "#ff7a6b", "#5fe0b0", "#ffe6b3", "#ff9a72", "#fff6e6"];

  var SCREEN_IDS = {
    boot: "screen-boot",
    join: "screen-join",
    wait: "screen-wait",
    count: "screen-count",
    game: "screen-game",
    result: "screen-result"
  };

  var PRAISE = [
    "手速与眼力都在线，福气自然来",
    "灯阵全亮，新年好运已就位",
    "这一局稳得漂亮，红包拿来",
    "连击达成，马年大吉"
  ];

  /* ================= 状态 ================= */

  var state = {
    session: null,
    game: null,
    me: null,
    pid: null,
    token: null,
    sessionId: "",
    roomCode: "",
    phase: "",
    screen: "boot",
    avatar: AVATARS[0],
    // 游戏运行时
    gen: 0,
    counting: false,
    playing: false,
    wavesResult: [],
    score: 0,
    tapHandler: null,
    submitted: false,
    submitOk: false,
    submitLock: false,
    celebrated: false,
    joining: false,
    // 杂项
    stream: null,
    reconnectNeeded: false,
    streamGen: 0,
    reconnectTimer: 0,
    fallbackTimer: 0,
    flashTimer: 0,
    joinPoll: 0
  };

  var clock = { offset: 0, ready: false };
  var lanternEls = [];
  var els = {};

  /* ================= 小工具 ================= */

  function $(id) {
    return document.getElementById(id);
  }

  function cache() {
    [
      "roomCode", "pasteBtn", "codeHint", "nickname", "nameCount", "avatarList",
      "joinPoolList", "joinError", "joinBtn", "joinForm", "screen-join",
      "netBanner", "netBannerText", "toastLayer", "fx", "countNum", "countLabel",
      "waitAvatar", "waitName", "waitStatusText", "waitJoined", "waitMax",
      "diffBadge", "diffPass", "diffDesc", "diffWaves", "diffStrikes", "diffGuarantee",
      "waitPoolList", "poolTotal",
      "waveNow", "waveTotal", "gameScore", "strikeText", "gamePhase", "ring",
      "ringStage", "ringCenterTitle", "ringCenterSub", "inputTimer", "inputBar",
      "inputLeft", "gameTip", "waveFlash", "waveFlashTitle", "waveFlashSub",
      "resultFlag", "resultTitle", "resultSub", "prizeCard", "prizeLabel",
      "prizeEmoji", "prizeName", "prizeNote", "loseCard", "loseTitle", "loseText",
      "resultStats", "revealState", "revealText", "resultWait", "resultWaitText",
      "resultTip", "resultBless"
    ].forEach(function (id) {
      els[id] = $(id);
    });
  }

  function setHidden(node, hidden) {
    if (!node) return;
    if (hidden) node.classList.add("hidden");
    else node.classList.remove("hidden");
  }

  function setText(node, text) {
    if (node) node.textContent = text == null ? "" : String(text);
  }

  function setHtml(node, html) {
    if (node) node.innerHTML = html;
  }

  function sleep(ms) {
    return new Promise(function (resolve) {
      setTimeout(resolve, ms);
    });
  }

  function clampNum(v, min, max, def) {
    var n = Number(v);
    if (!isFinite(n)) return def;
    return Math.min(max, Math.max(min, n));
  }

  function vibrate(pattern) {
    try {
      if (navigator.vibrate) navigator.vibrate(pattern);
    } catch (e) {}
  }

  function now() {
    return Date.now() + clock.offset;
  }

  function syncTime(serverTime, rtt) {
    var st = Number(serverTime);
    if (!st) return;
    var mid = Date.now() - (rtt && rtt > 0 ? rtt / 2 : 0);
    clock.offset = st - mid;
    clock.ready = true;
  }

  function totalLenOf(cfgWaves) {
    var sum = 0;
    (cfgWaves || []).forEach(function (w) {
      sum += Number(w && w.len) || 0;
    });
    return sum;
  }

  function waveConfigs() {
    if (state.game && Array.isArray(state.game.waves) && state.game.waves.length) {
      return state.game.waves;
    }
    var d = state.session && state.session.difficulty;
    if (d && Array.isArray(d.waves) && d.waves.length) return d.waves;
    return [];
  }

  /* ================= 音效（WebAudio 程序化合成，无外部资源） ================= */

  var Sound = (function () {
    var ac = null;
    var reduced = false;
    try {
      reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    } catch (e) {}

    function ensure() {
      if (ac) return ac;
      try {
        var Ctor = window.AudioContext || window.webkitAudioContext;
        if (!Ctor) return null;
        ac = new Ctor();
      } catch (e) {
        ac = null;
      }
      return ac;
    }

    function unlock() {
      var c = ensure();
      if (c && c.state === "suspended") {
        try {
          c.resume();
        } catch (e) {}
      }
    }

    function tone(freq, dur, type, vol, delay) {
      if (reduced) return;
      var c = ensure();
      if (!c) return;
      try {
        var t0 = c.currentTime + (delay || 0);
        var osc = c.createOscillator();
        var gain = c.createGain();
        osc.type = type || "sine";
        osc.frequency.setValueAtTime(freq, t0);
        gain.gain.setValueAtTime(0.0001, t0);
        gain.gain.exponentialRampToValueAtTime(vol || 0.05, t0 + 0.014);
        gain.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
        osc.connect(gain);
        gain.connect(c.destination);
        osc.start(t0);
        osc.stop(t0 + dur + 0.03);
      } catch (e) {}
    }

    return {
      unlock: unlock,
      count: function (n) { tone(n === 1 ? 1046 : 660, 0.13, "sine", 0.055); },
      begin: function () { tone(740, 0.14, "triangle", 0.05); tone(1100, 0.2, "triangle", 0.05, 0.12); },
      lit: function (i) { tone(520 + ((i || 0) % 4) * 80, 0.1, "triangle", 0.042); },
      hit: function () { tone(880, 0.09, "triangle", 0.05); tone(1320, 0.12, "sine", 0.03, 0.02); },
      miss: function () { tone(180, 0.22, "sawtooth", 0.045); },
      pass: function () { tone(660, 0.12, "triangle", 0.05); tone(990, 0.16, "triangle", 0.045, 0.1); },
      timeout: function () { tone(240, 0.3, "sine", 0.045); },
      fail: function () { tone(300, 0.24, "sine", 0.05); tone(200, 0.34, "sine", 0.05, 0.13); },
      win: function () {
        [523, 659, 784, 1047].forEach(function (f, i) { tone(f, 0.26, "triangle", 0.05, i * 0.1); });
      },
      join: function () { tone(620, 0.1, "sine", 0.04); tone(930, 0.14, "sine", 0.04, 0.08); }
    };
  })();

  /* ================= 背景粒子 / 彩屑（canvas，程序化） ================= */

  var Fx = (function () {
    var canvas = null;
    var ctx = null;
    var dpr = 1;
    var W = 0;
    var H = 0;
    var raf = 0;
    var running = false;
    var particles = [];
    var reduced = false;
    var ambient = [];

    try {
      reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    } catch (e) {}

    function resize() {
      if (!canvas || !ctx) return;
      dpr = Math.min(2, window.devicePixelRatio || 1);
      W = window.innerWidth;
      H = window.innerHeight;
      canvas.width = Math.max(1, Math.round(W * dpr));
      canvas.height = Math.max(1, Math.round(H * dpr));
      canvas.style.width = W + "px";
      canvas.style.height = H + "px";
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      seedAmbient();
    }

    function seedAmbient() {
      ambient = [];
      if (reduced) return;
      var count = W < 380 ? 12 : 18;
      for (var i = 0; i < count; i++) {
        ambient.push({
          x: Math.random() * W,
          y: Math.random() * H,
          r: 0.8 + Math.random() * 1.8,
          vy: 0.18 + Math.random() * 0.5,
          vx: (Math.random() - 0.5) * 0.22,
          a: 0.12 + Math.random() * 0.42,
          ph: Math.random() * Math.PI * 2
        });
      }
    }

    function tick(ts) {
      if (!running) return;
      ctx.clearRect(0, 0, W, H);

      if (!reduced) {
        ctx.globalCompositeOperation = "lighter";
        for (var i = 0; i < ambient.length; i++) {
          var p = ambient[i];
          p.y -= p.vy;
          p.x += p.vx;
          if (p.y < -12) {
            p.y = H + 12;
            p.x = Math.random() * W;
          }
          if (p.x < -12) p.x = W + 12;
          if (p.x > W + 12) p.x = -12;
          var alpha = p.a * (0.55 + 0.45 * Math.sin(ts / 900 + p.ph));
          ctx.beginPath();
          ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
          ctx.fillStyle = "rgba(247,212,136," + alpha.toFixed(3) + ")";
          ctx.fill();
        }
        ctx.globalCompositeOperation = "source-over";
      }

      if (particles.length) {
        var alive = [];
        for (var j = 0; j < particles.length; j++) {
          var c = particles[j];
          c.vy += c.gravity;
          c.vx *= 0.995;
          c.x += c.vx;
          c.y += c.vy;
          c.rot += c.vr;
          c.life += 1;
          if (c.y > H + 50 || c.life > c.max) continue;
          alive.push(c);
          ctx.save();
          ctx.translate(c.x, c.y);
          ctx.rotate(c.rot);
          ctx.globalAlpha = Math.min(1, (c.max - c.life) / 40);
          ctx.fillStyle = c.color;
          ctx.fillRect(-c.w / 2, -c.h / 2, c.w, c.h);
          ctx.restore();
        }
        particles = alive;
        ctx.globalAlpha = 1;
      }

      raf = requestAnimationFrame(tick);
    }

    function start() {
      if (running || !ctx) return;
      running = true;
      raf = requestAnimationFrame(tick);
    }

    function stop() {
      running = false;
      if (raf) cancelAnimationFrame(raf);
      raf = 0;
    }

    function spawnConfetti(n) {
      if (!ctx) return;
      for (var i = 0; i < n; i++) {
        particles.push({
          x: Math.random() * W,
          y: -20 - Math.random() * H * 0.3,
          vx: (Math.random() - 0.5) * 1.8,
          vy: 1.6 + Math.random() * 2.4,
          gravity: 0.085,
          w: 5 + Math.random() * 6,
          h: 8 + Math.random() * 9,
          rot: Math.random() * Math.PI * 2,
          vr: (Math.random() - 0.5) * 0.24,
          color: CONFETTI_COLORS[(Math.random() * CONFETTI_COLORS.length) | 0],
          life: 0,
          max: 240 + Math.random() * 160
        });
      }
      start();
    }

    return {
      init: function () {
        canvas = $("fx");
        if (!canvas) return;
        try {
          ctx = canvas.getContext("2d");
        } catch (e) {
          ctx = null;
        }
        if (!ctx) {
          canvas.style.display = "none";
          return;
        }
        resize();
        start();
        window.addEventListener("resize", resize);
        window.addEventListener("orientationchange", function () {
          setTimeout(resize, 220);
        });
        document.addEventListener("visibilitychange", function () {
          if (document.hidden) stop();
          else start();
        });
      },
      confetti: function (n) {
        spawnConfetti(n || 80);
      },
      burst: function (x, y, n) {
        if (!ctx) return;
        for (var i = 0; i < (n || 24); i++) {
          var ang = Math.random() * Math.PI * 2;
          var sp = 1.8 + Math.random() * 4.2;
          particles.push({
            x: x,
            y: y,
            vx: Math.cos(ang) * sp,
            vy: Math.sin(ang) * sp - 1.2,
            gravity: 0.1,
            w: 4 + Math.random() * 5,
            h: 7 + Math.random() * 7,
            rot: Math.random() * Math.PI * 2,
            vr: (Math.random() - 0.5) * 0.3,
            color: CONFETTI_COLORS[(Math.random() * CONFETTI_COLORS.length) | 0],
            life: 0,
            max: 220 + Math.random() * 140
          });
        }
        start();
      }
    };
  })();

  /* ================= 界面切换 ================= */

  /** 中止当前局：递增 gen 使所有异步步骤失效，清理界面状态 */
  function abortPlay() {
    state.gen++;
    state.counting = false;
    state.playing = false;
    state.tapHandler = null;
    if (state.fallbackTimer) {
      clearTimeout(state.fallbackTimer);
      state.fallbackTimer = 0;
    }
    hideWaveFlash();
    clearLanternStates();
    setHidden(els.inputTimer, true);
    if (els.ring) els.ring.classList.remove("is-input");
  }

  function showScreen(name) {
    Object.keys(SCREEN_IDS).forEach(function (key) {
      var node = $(SCREEN_IDS[key]);
      if (!node) return;
      node.classList.toggle("hidden", key !== name);
      if (key === name) node.scrollTop = 0;
    });
    state.screen = name;
    if (name !== "join") stopJoinPoll();
    else startJoinPoll();
    // 切换时收起键盘，避免 iOS 输入框顶起布局
    if (name !== "join") {
      try {
        if (document.activeElement && document.activeElement.blur) document.activeElement.blur();
      } catch (e) {}
    }
    try {
      window.scrollTo(0, 0);
    } catch (e) {}
  }

  function toast(text, kind) {
    var layer = els.toastLayer;
    if (!layer || !text) return;
    var node = document.createElement("div");
    node.className = "toast" + (kind ? " toast--" + kind : "");
    node.textContent = String(text);
    layer.appendChild(node);
    while (layer.children.length > 3) layer.removeChild(layer.firstChild);
    setTimeout(function () {
      node.classList.add("toast--out");
      setTimeout(function () {
        if (node.parentNode) node.parentNode.removeChild(node);
      }, 320);
    }, 2600);
  }

  function showNetBanner(text) {
    if (els.netBannerText) els.netBannerText.textContent = text || "网络波动，重连中…";
    setHidden(els.netBanner, false);
  }

  function hideNetBanner() {
    setHidden(els.netBanner, true);
  }

  /* ================= 加入页 ================= */

  function getUrlCode() {
    try {
      var sp = new URLSearchParams(window.location.search);
      var raw = sp.get("code") || sp.get("room") || "";
      var digits = String(raw).replace(/\D/g, "").slice(0, 6);
      return digits.length === 6 ? digits : "";
    } catch (e) {
      return "";
    }
  }

  function renderAvatars() {
    var wrap = els.avatarList;
    if (!wrap) return;
    wrap.innerHTML = "";
    AVATARS.forEach(function (emoji) {
      var btn = document.createElement("button");
      btn.type = "button";
      btn.className = "avatar-btn";
      btn.dataset.avatar = emoji;
      btn.setAttribute("role", "radio");
      btn.setAttribute("aria-label", "头像 " + emoji);
      btn.textContent = emoji;
      if (emoji === state.avatar) {
        btn.classList.add("is-active");
        btn.setAttribute("aria-checked", "true");
      } else {
        btn.setAttribute("aria-checked", "false");
      }
      btn.addEventListener("click", function () {
        Sound.unlock();
        selectAvatar(emoji, true);
      });
      wrap.appendChild(btn);
    });
  }

  function selectAvatar(emoji, withVibe) {
    if (AVATARS.indexOf(emoji) < 0) return;
    state.avatar = emoji;
    var nodes = els.avatarList ? els.avatarList.querySelectorAll(".avatar-btn") : [];
    Array.prototype.forEach.call(nodes, function (btn) {
      var active = btn.dataset.avatar === emoji;
      btn.classList.toggle("is-active", active);
      btn.setAttribute("aria-checked", active ? "true" : "false");
    });
    if (withVibe) {
      Sound.unlock();
      vibrate(10);
    }
  }

  function updateNameCount() {
    var input = els.nickname;
    if (!input) return;
    var len = Array.from(input.value || "").length;
    if (len > 12) {
      input.value = Array.from(input.value).slice(0, 12).join("");
      len = 12;
    }
    setText(els.nameCount, len + "/12");
  }

  function clearJoinError() {
    if (!els.joinError) return;
    els.joinError.textContent = "";
    els.joinError.classList.remove("is-show");
  }

  function joinError(text, field) {
    if (els.joinError) {
      els.joinError.textContent = text;
      els.joinError.classList.remove("is-show");
      void els.joinError.offsetWidth;
      els.joinError.classList.add("is-show");
    }
    vibrate([20, 60, 20]);
    if (field === "room" && els.roomCode) els.roomCode.focus();
    else if (field === "name" && els.nickname) els.nickname.focus();
  }

  function setJoinLoading(on) {
    if (!els.joinBtn) return;
    els.joinBtn.classList.toggle("is-loading", !!on);
    els.joinBtn.disabled = !!on;
    els.joinBtn.textContent = on ? "入场中" : "进入会场";
  }

  function joinErrorText(res) {
    var code = res && res.code;
    if (code === "ROOM_FULL") return "房间已满员，请等待下一轮";
    if (code === "GAME_STARTED") return "本轮已经开赛，请等待主持人开启下一轮";
    if (code === "BAD_CODE") return "房间号不正确，请核对大屏上的 6 位数字";
    if (code === "BAD_NAME") return res && res.error ? res.error : "昵称需为 1–12 个字";
    if (code === "NETWORK") return "网络连接失败，请确认手机与主机在同一 Wi-Fi";
    return (res && res.error) || "入场失败，请稍后重试";
  }

  function readRoomCodeInput() {
    if (!els.roomCode) return "";
    return String(els.roomCode.value || "").replace(/\D/g, "").slice(0, 6);
  }

  function bindJoinEvents() {
    var room = els.roomCode;
    var nick = els.nickname;

    if (room) {
      room.addEventListener("input", function () {
        var digits = String(room.value || "").replace(/\D/g, "").slice(0, 6);
        if (room.value !== digits) room.value = digits;
        clearJoinError();
      });
      room.addEventListener("paste", function (ev) {
        try {
          var text = (ev.clipboardData || window.clipboardData).getData("text") || "";
          var digits = String(text).replace(/\D/g, "").slice(0, 6);
          if (digits) {
            ev.preventDefault();
            room.value = digits;
            clearJoinError();
            setText(els.codeHint, "已粘贴房间号，确认后入场");
          }
        } catch (e) {}
      });
      room.addEventListener("keydown", function (ev) {
        if (ev.key === "Enter") {
          ev.preventDefault();
          if (nick) nick.focus();
        }
      });
    }

    if (nick) {
      nick.addEventListener("input", function () {
        updateNameCount();
        clearJoinError();
      });
      nick.addEventListener("keydown", function (ev) {
        if (ev.key === "Enter") {
          ev.preventDefault();
          if (els.joinForm) doJoin(ev);
        }
      });
    }

    if (els.pasteBtn) {
      els.pasteBtn.addEventListener("click", function () {
        Sound.unlock();
        var finish = function (text) {
          var digits = String(text || "").replace(/\D/g, "").slice(0, 6);
          if (digits.length === 6) {
            if (els.roomCode) els.roomCode.value = digits;
            clearJoinError();
            toast("已填入房间号", "success");
            vibrate(10);
            if (els.nickname) els.nickname.focus();
          } else {
            toast("剪贴板里没有 6 位房间号", "warn");
          }
        };
        if (navigator.clipboard && navigator.clipboard.readText) {
          navigator.clipboard.readText().then(finish, function () {
            toast("无法读取剪贴板，请长按输入框粘贴", "warn");
            if (els.roomCode) els.roomCode.focus();
          });
        } else {
          toast("请长按房间号输入框粘贴", "info");
          if (els.roomCode) els.roomCode.focus();
        }
      });
    }

    if (els.joinForm) {
      els.joinForm.addEventListener("submit", doJoin);
    }
  }

  function doJoin(ev) {
    if (ev) ev.preventDefault();
    if (state.joining) return;
    var code = readRoomCodeInput();
    var name = String((els.nickname && els.nickname.value) || "").trim().replace(/\s+/g, " ");
    var nameLen = Array.from(name).length;

    clearJoinError();
    if (code.length !== 6) {
      joinError("请输入 6 位数字房间号", "room");
      return;
    }
    if (!nameLen) {
      joinError("请给自己起个昵称", "name");
      return;
    }
    if (nameLen > 12) {
      joinError("昵称最多 12 个字", "name");
      return;
    }

    state.joining = true;
    setJoinLoading(true);
    Sound.unlock();
    vibrate(12);

    Net.post("/api/join", {
      cid: Net.cid(),
      code: code,
      name: name,
      avatar: state.avatar
    }).then(function (res) {
      state.joining = false;
      setJoinLoading(false);
      if (!res || !res.ok) {
        joinError(joinErrorText(res), res && res.code === "BAD_NAME" ? "name" : "room");
        return;
      }
      var p = res.player || {};
      state.pid = p.pid;
      state.token = p.token;
      state.me = p;
      state.session = res.session || state.session;
      state.sessionId = res.session ? res.session.sessionId || "" : "";
      state.roomCode = res.session ? res.session.roomCode || "" : "";
      Net.store.set("pid", p.pid);
      Net.store.set("token", p.token);
      Net.store.set("name", p.name || name);
      Net.store.set("avatar", p.avatar || state.avatar);
      Net.store.set("code", code);
      if (res.session) syncTime(res.session.serverTime);
      Sound.join();
      vibrate(22);
      toast("入场成功，已就位", "success");
      clearJoinError();
      enterWait();
      connectStream();
    });
  }

  function renderJoinPool(session) {
    var list = els.joinPoolList;
    if (!list) return;
    updateJoinPhaseHint(session);
    if (!session) {
      setHtml(list, '<span class="muted">奖品池加载失败</span>');
      return;
    }
    var prizes = Array.isArray(session.prizes) ? session.prizes : [];
    if (!prizes.length) {
      setHtml(list, '<span class="muted">奖品池待公布</span>');
      return;
    }
    list.innerHTML = "";
    prizes.slice(0, 6).forEach(function (p) {
      var remaining = Number(p.remaining);
      if (!isFinite(remaining)) remaining = Math.max(0, (Number(p.quantity) || 0) - (Number(p.awarded) || 0));
      var item = document.createElement("span");
      item.className = "pool-mini__item" + (remaining <= 0 ? " is-empty" : "");
      var emoji = document.createElement("span");
      emoji.textContent = p.emoji || "🎁";
      var nameNode = document.createElement("b");
      nameNode.textContent = p.name || "奖品";
      var count = document.createElement("span");
      count.className = "pool-mini__count";
      count.textContent = remaining > 0 ? "剩 " + remaining : "已发完";
      item.appendChild(emoji);
      item.appendChild(nameNode);
      item.appendChild(count);
      list.appendChild(item);
    });
    if (prizes.length > 6) {
      var more = document.createElement("span");
      more.className = "pool-mini__item";
      more.textContent = "等 " + prizes.length + " 项";
      list.appendChild(more);
    }
    updateJoinPhaseHint(session);
  }

  function updateJoinPhaseHint(session) {
    if (!els.codeHint) return;
    var phase = session && session.phase;
    if (phase === "playing") {
      els.codeHint.textContent = "本轮已开赛 · 请等待主持人开启下一轮";
    } else if (phase === "reveal") {
      els.codeHint.textContent = "本轮已开奖 · 请等待主持人重置房间";
    } else if (session && session.roomCode) {
      els.codeHint.textContent = "扫大屏二维码可自动带入房间号";
    }
  }

  function showJoin() {
    abortPlay();
    state.gen++;
    showScreen("join");
    clearJoinError();
    renderJoinPool(state.session);
    updateJoinPhaseHint(state.session);
    if (state.session && state.session.roomCode && els.roomCode && !els.roomCode.value) {
      // 只补空值，避免覆盖用户正在输入的房间号
      els.roomCode.value = state.session.roomCode;
    }
    startJoinPoll();
    // 手机端：若无二维码带入的房间号，轻量自动聚焦（不强制弹键盘）
    if (!getUrlCode()) {
      setTimeout(function () {
        if (state.screen === "join" && els.roomCode && document.activeElement !== els.roomCode) {
          try {
            els.roomCode.focus({ preventScroll: true });
          } catch (e) {
            try {
              els.roomCode.focus();
            } catch (e2) {}
          }
        }
      }, 380);
    }
  }

  function startJoinPoll() {
    stopJoinPoll();
    state.joinPoll = setInterval(function () {
      if (state.screen !== "join") return;
      Net.get("/api/state?cid=" + encodeURIComponent(Net.cid())).then(function (res) {
        if (!res || !res.ok || !res.session) return;
        if (state.screen !== "join") return;
        state.session = res.session;
        syncTime(res.session.serverTime);
        renderJoinPool(res.session);
        if (res.you) state.me = res.you;
      });
    }, 5000);
  }

  function stopJoinPoll() {
    if (state.joinPoll) {
      clearInterval(state.joinPoll);
      state.joinPoll = 0;
    }
  }

  /* ================= 等待页 ================= */

  function enterWait() {
    if (!state.pid) {
      showJoin();
      return;
    }
    abortPlay();
    showScreen("wait");
    renderWait();
  }

  function renderWait() {
    var session = state.session || {};
    var me = state.me || {};
    setText(els.waitAvatar, me.avatar || Net.store.get("avatar", AVATARS[0]));
    setText(els.waitName, me.name || Net.store.get("name", "玩家"));
    var phase = session.phase || "lobby";
    setText(els.waitStatusText, phase === "playing" ? "主持人已开赛，准备中…" : "等待主持人开赛");

    var joined =
      session.stats && typeof session.stats.joined === "number"
        ? session.stats.joined
        : Array.isArray(session.players)
        ? session.players.length
        : 1;
    var max = (session.config && session.config.maxPlayers) || 30;
    setText(els.waitJoined, joined);
    setText(els.waitMax, max);

    var d = session.difficulty || {};
    var label = d.label || "简单";
    setText(els.diffBadge, d.guaranteed ? label + " · 福气档" : label);
    if (els.diffBadge) {
      els.diffBadge.style.color = d.color || "";
      els.diffBadge.style.borderColor = d.color ? d.color + "66" : "";
    }
    setText(els.diffPass, "预估通关 " + (d.estimatedPass || "—"));
    setText(els.diffDesc, d.desc || "按顺序复现灯阵，注意每档允许的失误次数");
    var waveCount = Number(d.waveCount) || (Array.isArray(d.waves) ? d.waves.length : 2);
    setText(els.diffWaves, waveCount + " 波");
    var maxStrikes = typeof d.maxStrikes === "number" ? d.maxStrikes : d.guaranteed ? 99 : 0;
    setText(els.diffStrikes, maxStrikes <= 0 ? "零失误" : "可失误 " + maxStrikes + " 次");
    setHidden(els.diffGuarantee, !d.guaranteed);

    renderPool(els.waitPoolList, session.prizes);
    var stats = session.stats || {};
    var total = Number(stats.totalPrizes);
    var awarded = Number(stats.awardedPrizes);
    if (isFinite(total)) {
      setText(els.poolTotal, "共 " + total + " 份 · 已发 " + (isFinite(awarded) ? awarded : 0) + " 份");
    } else {
      setText(els.poolTotal, "");
    }
  }

  function renderPool(listEl, prizes) {
    if (!listEl) return;
    if (!Array.isArray(prizes) || !prizes.length) {
      setHtml(listEl, '<p class="pool-empty">奖品池待公布</p>');
      return;
    }
    listEl.innerHTML = "";
    prizes.forEach(function (p) {
      var remaining = Number(p.remaining);
      if (!isFinite(remaining)) remaining = Math.max(0, (Number(p.quantity) || 0) - (Number(p.awarded) || 0));
      var item = document.createElement("div");
      item.className = "pool-item" + (remaining <= 0 ? " is-empty" : "");
      var emoji = document.createElement("span");
      emoji.className = "pool-item__emoji";
      emoji.textContent = p.emoji || "🎁";
      var name = document.createElement("span");
      name.className = "pool-item__name";
      name.textContent = p.name || "奖品";
      var meta = document.createElement("span");
      meta.className = "pool-item__meta";
      meta.textContent = remaining > 0 ? "剩 " + remaining + " 份" : "已发完";
      item.appendChild(emoji);
      item.appendChild(name);
      item.appendChild(meta);
      listEl.appendChild(item);
    });
  }

  /* ================= 游戏逻辑 ================= */

  function onGame(rawGame) {
    if (!rawGame || !state.pid) return;
    var game = normalizeGame(rawGame);
    if (!game) return;

    // 已有结果 / 已在结算 / 已完成 → 忽略重放
    if (state.me && (state.me.status === "won" || state.me.status === "lost")) return;
    if (state.screen === "result") return;

    if (state.game && state.game.sessionId && game.sessionId && state.game.sessionId !== game.sessionId) {
      // 新的一局（正常情况下 reset 会先清空身份）
      abortPlay();
    }
    if (state.counting || state.playing) {
      if (state.game && state.game.sessionId === game.sessionId) return;
      abortPlay();
    }

    state.game = game;
    persistGame(game);
    beginGame({ replay: false });
  }

  function normalizeGame(raw) {
    if (!raw) return null;
    var waves = Array.isArray(raw.waves) ? raw.waves : null;
    if (!waves || !waves.length) return null;
    var clean = waves.map(function (w) {
      return {
        len: clampNum(w && w.len, 1, 12, 3),
        showMs: clampNum(w && w.showMs, 80, 4000, 450),
        gapMs: clampNum(w && w.gapMs, 0, 2000, 120),
        inputMs: clampNum(w && w.inputMs, 600, 30000, 4500)
      };
    });
    var seed = Number(raw.seed);
    if (!isFinite(seed) || seed <= 0) {
      seed = seedFromString(String(raw.sessionId || (state.session && state.session.sessionId) || "newyear"));
    }
    return {
      sessionId: String(raw.sessionId || (state.session && state.session.sessionId) || ""),
      startAt: Number(raw.startAt) || 0,
      seed: seed >>> 0,
      difficulty: String(raw.difficulty || ""),
      maxStrikes: typeof raw.maxStrikes === "number" ? raw.maxStrikes : 0,
      minMs: Number(raw.minMs) || 0,
      waves: clean
    };
  }

  function deriveGameFromSession(session) {
    if (!session || !session.sessionId || !session.startAt) return null;
    var d = session.difficulty || {};
    if (!Array.isArray(d.waves) || !d.waves.length) return null;
    return normalizeGame({
      sessionId: session.sessionId,
      startAt: session.startAt,
      seed: seedFromString(String(session.sessionId)),
      difficulty: d.key,
      maxStrikes: typeof d.maxStrikes === "number" ? d.maxStrikes : d.guaranteed ? 99 : 0,
      waves: d.waves,
      minMs: 0
    });
  }

  function seedFromString(str) {
    var h = 2166136261 >>> 0;
    for (var i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = Math.imul(h, 16777619) >>> 0;
    }
    return (h % 2147483646) + 1;
  }

  /** mulberry32（与协议 §6 一致：mulberry32(seed + waveIndex)） */
  function mulberry32(a) {
    a = a >>> 0;
    return function () {
      a = (a + 0x6d2b79f5) >>> 0;
      var t = a;
      t = Math.imul(t ^ (t >>> 15), 1 | t);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function generateSequence(seed, waveIndex, len) {
    var rng = mulberry32((Number(seed) + (waveIndex | 0)) >>> 0);
    var out = [];
    var n = Math.max(1, Number(len) || 1);
    for (var i = 0; i < n; i++) {
      out.push(Math.floor(rng() * LANTERN_COUNT) % LANTERN_COUNT);
    }
    return out;
  }

  function persistGame(game) {
    try {
      Net.store.set("game", JSON.stringify(game));
    } catch (e) {}
  }

  function readPersistedGame(sessionId) {
    try {
      var raw = Net.store.get("game", "");
      if (!raw) return null;
      var g = JSON.parse(raw);
      if (!g || !Array.isArray(g.waves)) return null;
      if (sessionId && g.sessionId && g.sessionId !== sessionId) return null;
      return normalizeGame(g);
    } catch (e) {
      return null;
    }
  }

  function scheduleGameFallback() {
    if (state.game) return;
    clearTimeout(state.fallbackTimer);
    state.fallbackTimer = setTimeout(function () {
      if (state.game || !state.pid) return;
      if (state.screen !== "wait") return;
      if (!state.session || state.session.phase !== "playing") return;
      var g = readPersistedGame(state.sessionId) || deriveGameFromSession(state.session);
      if (g) {
        state.game = g;
        beginGame({ replay: false });
      }
    }, 1800);
  }

  function beginGame(opts) {
    opts = opts || {};
    if (!state.pid || !state.game) return;
    if (state.counting || state.playing) return;

    state.gen++;
    var gen = state.gen;
    state.counting = true;
    state.submitted = false;
    state.submitOk = false;
    state.submitLock = false;
    state.wavesResult = [];
    state.score = 0;
    state.celebrated = false;
    hideWaveFlash();
    resetHud();

    var remain;
    if (opts.replay) {
      remain = 3000;
      toast("重新开始本局", "warn");
    } else {
      var startAt = Number(state.game.startAt) || 0;
      remain = startAt ? startAt - now() : 3000;
      if (remain < 250) remain = 0;
      if (remain > 6000) remain = 6000;
    }

    if (remain <= 120) {
      state.counting = false;
      startPlay(gen);
      return;
    }

    showScreen("count");
    runCountdown(remain, gen, function () {
      state.counting = false;
      startPlay(gen);
    });
  }

  function runCountdown(remainMs, gen, onDone) {
    var track = document.querySelector(".count-track i");
    var endAt = Date.now() + remainMs;
    var total = Math.max(1, remainMs);
    var lastTick = null;

    function frame() {
      if (gen !== state.gen) return;
      var left = endAt - Date.now();
      if (left <= 0) {
        if (track) track.style.transform = "scaleX(1)";
        onDone();
        return;
      }
      var sec = Math.min(3, Math.max(1, Math.ceil(left / 1000)));
      if (sec !== lastTick) {
        lastTick = sec;
        setCountNumber(sec);
        Sound.count(sec);
        vibrate(12);
      }
      if (track) track.style.transform = "scaleX(" + Math.min(1, Math.max(0, 1 - left / total)).toFixed(4) + ")";
      requestAnimationFrame(frame);
    }
    frame();
  }

  function setCountNumber(n) {
    var node = els.countNum;
    if (!node) return;
    node.textContent = String(n);
    node.classList.remove("tick");
    void node.offsetWidth;
    node.classList.add("tick");
  }

  function startPlay(gen) {
    if (gen !== state.gen) return;
    if (!state.game) return;
    state.playing = true;
    state.counting = false;
    state.wavesResult = [];
    state.score = 0;
    buildRing();
    resetHud();
    hideWaveFlash();
    showScreen("game");
    setTip("第 1 波即将开始");
    setPhase("准备", "memory");
    setRingCenter("凝神", "记住灯笼亮起的顺序");
    Sound.begin();
    runWaves(gen);
  }

  function runWaves(gen) {
    var waves = state.game ? state.game.waves : [];
    (async function () {
      for (var i = 0; i < waves.length; i++) {
        if (gen !== state.gen) return;
        setWaveHud(i, waves.length);
        var res = await playWave(waves[i], i, gen);
        if (gen !== state.gen) return;
        state.wavesResult.push(res);
        state.score += res.score || 0;
        setScore(state.score);

        if (!res.cleared) {
          showFlash("本波失利", "灯阵熄灭了 · 本轮结束", true);
          Sound.fail();
          await sleep(1250);
          if (gen !== state.gen) return;
          finishGame(false);
          return;
        }

        var left = waves.length - i - 1;
        if (left > 0) {
          showFlash("第 " + (i + 1) + " 波通过", "还剩 " + left + " 波 · 保持专注", false);
          Sound.pass();
          await sleep(1250);
          if (gen !== state.gen) return;
          hideWaveFlash();
        } else {
          showFlash("全部灯阵点亮", "连击完成 · 正在核对成绩", false);
          await sleep(1100);
          if (gen !== state.gen) return;
          finishGame(true);
          return;
        }
      }
    })();
  }

  function computeWaveScore(cleared, hits, strikes, len, leftMs, totalMs) {
    if (cleared) {
      var bonus = totalMs > 0 ? Math.round((Math.max(0, leftMs) / totalMs) * 200) : 0;
      return 100 + len * 20 + bonus;
    }
    return Math.max(0, hits * 10 - strikes * 15);
  }

  function playWave(cfg, index, gen) {
    return new Promise(function (resolve) {
      var seq = generateSequence(state.game.seed, index, cfg.len);
      var len = seq.length;
      var hits = 0;
      var strikes = 0;
      var pointer = 0;
      var waveStart = Date.now();
      var timerEnd = 0;
      var timerTotal = Math.max(600, Number(cfg.inputMs) || 4000);
      var rafId = 0;
      var inputDone = true;
      var finished = false;

      function finish(cleared) {
        if (finished) return;
        finished = true;
        state.tapHandler = null;
        if (rafId) cancelAnimationFrame(rafId);
        rafId = 0;
        inputDone = true;
        setHidden(els.inputTimer, true);
        if (els.ring) els.ring.classList.remove("is-input");
        var elapsed = Math.max(0, Date.now() - waveStart);
        var leftMs = Math.max(0, timerEnd - Date.now());
        resolve({
          cleared: !!cleared,
          hits: hits,
          strikes: strikes,
          ms: elapsed,
          score: computeWaveScore(cleared, hits, strikes, len, leftMs, timerTotal)
        });
      }

      /* ---- 记忆阶段 ---- */
      setPhase("记住灯序", "memory");
      setRingCenter("凝神", "记住灯笼亮起的顺序");
      setTip("看仔细：" + len + " 盏灯将依次点亮");
      setHidden(els.inputTimer, true);
      clearLanternStates();

      var step = 0;
      function memoryNext() {
        if (gen !== state.gen) {
          finish(false);
          return;
        }
        if (step >= seq.length) {
          setRingCenter("准备复现", "按顺序点击灯笼");
          setPhase("准备", "memory");
          setTip("序列已结束，准备复现");
          setTimeout(function () {
            if (gen !== state.gen) {
              finish(false);
              return;
            }
            startInput();
          }, 300);
          return;
        }
        var idx = seq[step];
        lightLantern(idx);
        Sound.lit(step);
        vibrate(8);
        setTimeout(function () {
          if (gen !== state.gen) {
            finish(false);
            return;
          }
          unlightLantern(idx);
          step++;
          setTimeout(memoryNext, Math.max(0, Number(cfg.gapMs) || 120));
        }, Math.max(80, Number(cfg.showMs) || 450));
      }
      memoryNext();

      /* ---- 复现阶段 ---- */
      function startInput() {
        inputDone = false;
        pointer = 0;
        timerTotal = Math.max(600, Number(cfg.inputMs) || 4000);
        timerEnd = Date.now() + timerTotal;
        setPhase("请复现", "input");
        setRingCenter("请复现", "按亮起顺序点击 " + len + " 盏灯笼");
        setTip("点错一次本波即失败，注意顺序");
        setHidden(els.inputTimer, false);
        if (els.inputBar) els.inputBar.dataset.totalMs = String(timerTotal);
        updateTimer(1);
        if (els.ring) els.ring.classList.add("is-input");

        state.tapHandler = function (idx) {
          if (gen !== state.gen || inputDone) return;
          if (idx === seq[pointer]) {
            hits++;
            pointer++;
            setLanternState(idx, "is-hit", 320);
            vibrate(14);
            Sound.hit();
            var bonus = Math.round((Math.max(0, timerEnd - Date.now()) / timerTotal) * 200);
            popScore("+" + (100 + bonus));
            if (pointer >= len) {
              inputDone = true;
              setTip("复现成功！");
              finish(true);
            }
          } else {
            strikes++;
            setLanternState(idx, "is-miss", 420);
            vibrate([20, 40, 20]);
            Sound.miss();
            updateStrikeHud(strikes);
            if (strikes > state.game.maxStrikes) {
              inputDone = true;
              setTip("点错灯笼，本波失败");
              finish(false);
            }
          }
        };

        function loop() {
          if (inputDone || gen !== state.gen) return;
          var left = timerEnd - Date.now();
          if (left <= 0) {
            inputDone = true;
            setTip("超时了，本波失败");
            Sound.timeout();
            finish(false);
            return;
          }
          updateTimer(left / timerTotal);
          rafId = requestAnimationFrame(loop);
        }
        rafId = requestAnimationFrame(loop);
      }
    });
  }

  function buildRing() {
    var ring = els.ring;
    if (!ring) return;
    ring.innerHTML = "";
    lanternEls = [];
    for (var i = 0; i < LANTERN_COUNT; i++) {
      (function (index) {
        var angle = -90 + index * 45; // 0 在正上方，顺时针
        var rad = (angle * Math.PI) / 180;
        var x = 50 + Math.cos(rad) * 46;
        var y = 50 + Math.sin(rad) * 46;
        var depth = (Math.sin(rad) + 1) / 2; // 0 最远，1 最近
        var scale = 0.92 + depth * 0.12;

        var slot = document.createElement("div");
        slot.className = "lantern-slot";
        slot.style.setProperty("--x", x.toFixed(3));
        slot.style.setProperty("--y", y.toFixed(3));
        slot.style.setProperty("--s", scale.toFixed(3));

        var shadow = document.createElement("span");
        shadow.className = "lantern-shadow";

        var stand = document.createElement("div");
        stand.className = "lantern-stand";

        var btn = document.createElement("button");
        btn.type = "button";
        btn.className = "lantern";
        btn.dataset.i = String(index);
        btn.setAttribute("aria-label", "灯笼 " + (index + 1));
        btn.innerHTML =
          '<span class="l-halo"></span>' +
          '<span class="l-cord"></span>' +
          '<span class="l-cap l-cap--top"></span>' +
          '<span class="l-body"><span class="l-glyph">' +
          AVATAR_GLYPHS.charAt(index % AVATAR_GLYPHS.length) +
          "</span></span>" +
          '<span class="l-cap l-cap--bottom"></span>' +
          '<span class="l-tassel"></span>';
        btn.addEventListener("click", function (ev) {
          ev.preventDefault();
          if (state.tapHandler) state.tapHandler(index);
        });

        stand.appendChild(btn);
        slot.appendChild(shadow);
        slot.appendChild(stand);
        ring.appendChild(slot);
        lanternEls.push(btn);
      })(i);
    }
  }

  function lightLantern(i) {
    if (lanternEls[i]) lanternEls[i].classList.add("is-lit");
  }

  function unlightLantern(i) {
    if (lanternEls[i]) lanternEls[i].classList.remove("is-lit");
  }

  function setLanternState(i, cls, dur) {
    var btn = lanternEls[i];
    if (!btn) return;
    btn.classList.remove("is-hit", "is-miss");
    btn.classList.add(cls);
    setTimeout(function () {
      btn.classList.remove(cls);
    }, dur || 320);
  }

  function clearLanternStates() {
    lanternEls.forEach(function (btn) {
      btn.classList.remove("is-lit", "is-hit", "is-miss");
    });
  }

  function resetHud() {
    var waves = waveConfigs();
    setText(els.waveNow, 1);
    setText(els.waveTotal, waves.length || 1);
    setText(els.gameScore, 0);
    if (els.strikeText) {
      els.strikeText.textContent = "零失误";
      if (els.strikeText.parentNode) els.strikeText.parentNode.classList.remove("is-warn");
    }
    if (els.inputBar) {
      els.inputBar.style.transform = "scaleX(1)";
      els.inputBar.classList.remove("is-low");
    }
    setHidden(els.inputTimer, true);
    setScore(0);
  }

  function setWaveHud(index, total) {
    setText(els.waveNow, index + 1);
    setText(els.waveTotal, total);
  }

  function setScore(value) {
    setText(els.gameScore, Math.max(0, Math.round(Number(value) || 0)));
  }

  function updateStrikeHud(strikes) {
    if (!els.strikeText) return;
    var max = state.game ? state.game.maxStrikes : 0;
    if (max >= 99) {
      els.strikeText.textContent = "福气模式";
      return;
    }
    els.strikeText.textContent = strikes > 0 ? "失误 " + strikes : "零失误";
    if (els.strikeText.parentNode) els.strikeText.parentNode.classList.toggle("is-warn", strikes > 0);
  }

  function setPhase(label, kind) {
    var pill = els.gamePhase;
    if (!pill) return;
    pill.textContent = label;
    pill.classList.remove("is-input", "is-warn", "is-ok", "is-flash");
    if (kind === "input") pill.classList.add("is-input");
    else if (kind === "warn") pill.classList.add("is-warn");
    else if (kind === "ok") pill.classList.add("is-ok");
    void pill.offsetWidth;
    pill.classList.add("is-flash");
  }

  function setRingCenter(title, sub) {
    setText(els.ringCenterTitle, title);
    setText(els.ringCenterSub, sub);
  }

  function setTip(text) {
    setText(els.gameTip, text);
  }

  function updateTimer(ratio) {
    var r = Math.min(1, Math.max(0, ratio));
    if (els.inputBar) {
      els.inputBar.style.transform = "scaleX(" + r.toFixed(4) + ")";
      els.inputBar.classList.toggle("is-low", r < 0.32);
    }
    if (els.inputLeft) {
      var totalMs = Number(els.inputBar && els.inputBar.dataset.totalMs) || 0;
      els.inputLeft.textContent = totalMs ? ((r * totalMs) / 1000).toFixed(1) + "s" : "";
    }
  }

  function popScore(text) {
    var stage = els.ringStage;
    if (!stage) return;
    var node = document.createElement("span");
    node.className = "score-pop";
    node.textContent = text;
    stage.appendChild(node);
    setTimeout(function () {
      if (node.parentNode) node.parentNode.removeChild(node);
    }, 950);
  }

  function showFlash(title, sub, isFail) {
    if (!els.waveFlash) return;
    setText(els.waveFlashTitle, title);
    setText(els.waveFlashSub, sub || "");
    els.waveFlash.classList.toggle("is-fail", !!isFail);
    setHidden(els.waveFlash, false);
    requestAnimationFrame(function () {
      if (els.waveFlash) els.waveFlash.classList.add("show");
    });
    clearTimeout(state.flashTimer);
    state.flashTimer = setTimeout(function () {
      hideWaveFlash();
    }, 1080);
  }

  function hideWaveFlash() {
    clearTimeout(state.flashTimer);
    if (!els.waveFlash) return;
    els.waveFlash.classList.remove("show");
    setHidden(els.waveFlash, true);
  }

  /* ================= 结算 / 提交 ================= */

  function buildSubmitWaves(cfgWaves) {
    var out = [];
    for (var i = 0; i < cfgWaves.length; i++) {
      var cfg = cfgWaves[i];
      var r = state.wavesResult[i];
      if (r) {
        out.push({
          cleared: !!r.cleared,
          hits: Math.min(Number(cfg.len) || 0, Math.max(0, Math.round(r.hits || 0))),
          strikes: Math.max(0, Math.round(r.strikes || 0)),
          ms: Math.max(0, Math.round(r.ms || 0))
        });
      } else {
        out.push({ cleared: false, hits: 0, strikes: 0, ms: 0 });
      }
    }
    return out;
  }

  function summarizeLocal(win, waves, score, cfgWaves) {
    var cleared = 0;
    var hits = 0;
    var strikes = 0;
    var ms = 0;
    (waves || []).forEach(function (w) {
      if (w.cleared) cleared++;
      hits += Number(w.hits) || 0;
      strikes += Number(w.strikes) || 0;
      ms += Number(w.ms) || 0;
    });
    return {
      win: !!win,
      missed: false,
      manual: false,
      waves: (cfgWaves || []).length,
      totalWaves: (cfgWaves || []).length,
      cleared: cleared,
      hits: hits,
      strikes: strikes,
      ms: ms,
      score: Math.max(0, Math.round(Number(score) || 0)),
      totalLen: totalLenOf(cfgWaves)
    };
  }

  function summaryFromPlayer(player) {
    var r = (player && player.result) || {};
    var cfgWaves = waveConfigs();
    var hasWaves = r && typeof r.waves === "number";
    return {
      win: !!(r.win || (player && player.status === "won")),
      missed: !!r.missed,
      manual: !!r.manual,
      waves: hasWaves ? Number(r.waves) || 0 : cfgWaves.length,
      totalWaves: cfgWaves.length,
      cleared: Number(r.cleared) || 0,
      hits: Number(r.hits) || 0,
      strikes: Number(r.strikes) || 0,
      ms: Number(r.ms) || 0,
      score: Math.max(0, Math.round(Number(r.score) || 0)),
      totalLen: totalLenOf(cfgWaves)
    };
  }

  function finishGame(win) {
    state.playing = false;
    state.counting = false;
    state.gen++;
    state.tapHandler = null;
    clearLanternStates();
    setHidden(els.inputTimer, true);
    if (els.ring) els.ring.classList.remove("is-input");
    hideWaveFlash();

    var cfgWaves = state.game ? state.game.waves : [];
    var waves = buildSubmitWaves(cfgWaves);
    var score = state.score;
    var summary = summarizeLocal(win, waves, score, cfgWaves);

    showResult(summary, null, { pending: true });
    if (win) celebrate();
    else Sound.fail();

    var pending = {
      sessionId: state.sessionId || (state.game && state.game.sessionId) || "",
      waves: waves,
      score: score,
      win: !!win,
      attempts: 0,
      at: Date.now()
    };
    writePending(pending);
    submitResult(pending);
  }

  function writePending(pending) {
    try {
      Net.store.set("pending", JSON.stringify(pending));
    } catch (e) {}
  }

  function readPending(sessionId) {
    try {
      var raw = Net.store.get("pending", "");
      if (!raw) return null;
      var p = JSON.parse(raw);
      if (!p || !Array.isArray(p.waves) || !p.waves.length) return null;
      if (sessionId && p.sessionId && p.sessionId !== sessionId) return null;
      return p;
    } catch (e) {
      return null;
    }
  }

  function clearPending() {
    try {
      Net.store.del("pending");
    } catch (e) {}
  }

  function resumePending() {
    var pending = readPending(state.sessionId);
    if (!pending) return false;
    if (state.me && state.me.result) {
      clearPending();
      return false;
    }
    var cfgWaves = waveConfigs();
    state.score = pending.score;
    var summary = summarizeLocal(!!pending.win, pending.waves, pending.score, cfgWaves);
    showResult(summary, null, { pending: true });
    submitResult(pending);
    return true;
  }

  function submitResult(pending) {
    if (!state.pid || !pending) return;
    if (state.submitLock) return;
    if (state.submitted && state.submitOk) return;
    state.submitLock = true;
    var payload = {
      cid: Net.cid(),
      pid: state.pid,
      token: state.token,
      waves: pending.waves,
      score: pending.score
    };
    Net.post("/api/game/result", payload).then(function (res) {
      state.submitLock = false;
      if (res && res.ok) {
        state.submitted = true;
        state.submitOk = true;
        clearPending();
        if (res.player) state.me = res.player;
        var summary = summaryFromPlayer(state.me || {});
        var prize = res.prize || (state.me && state.me.prize) || null;
        showResult(summary, prize, { pending: false });
        if (summary.win) celebrate();
        return;
      }

      if (res && (res.code === "BAD_TOKEN" || res.code === "PLAYER_NOT_FOUND")) {
        clearPending();
        toast(res.error || "身份校验失败，请重新入场", "warn");
        return;
      }

      if (res && res.code === "BAD_PHASE") {
        clearPending();
        refreshStateAfterMiss();
        return;
      }

      pending.attempts = (pending.attempts || 0) + 1;
      if (pending.attempts <= 3) {
        writePending(pending);
        setResultWaitText("提交失败，正在重试…", false);
        setTimeout(function () {
          submitResult(pending);
        }, 900 * pending.attempts);
      } else {
        writePending(pending);
        setResultWaitText("提交失败 · 刷新页面可重试", false);
        toast("成绩提交失败，请检查网络", "warn");
      }
    });
  }

  function refreshStateAfterMiss() {
    Net.get("/api/state?cid=" + encodeURIComponent(Net.cid())).then(function (res) {
      if (res && res.ok) {
        if (res.session) applySession(res.session);
        if (res.you) {
          state.me = res.you;
          if (state.me.result) showResultFromPlayer(state.me);
        }
      }
    });
  }

  function celebrate() {
    if (state.celebrated) return;
    state.celebrated = true;
    Sound.win();
    vibrate([40, 70, 40, 70, 120]);
    Fx.confetti(72);
    try {
      Fx.burst(window.innerWidth * 0.5, window.innerHeight * 0.34, 24);
    } catch (e) {}
  }

  function setResultWaitText(text, done) {
    setText(els.resultWaitText, text);
    if (els.resultWait) els.resultWait.classList.toggle("done", !!done);
  }

  function renderPrizeCard(prize) {
    var card = els.prizeCard;
    if (!card) return;
    var won = state.me && (state.me.status === "won" || (state.me.result && state.me.result.win));
    if (!prize && !won) {
      setHidden(card, true);
      return;
    }
    setHidden(card, false);
    if (!prize) {
      setText(els.prizeLabel, "正在发放奖品");
      setText(els.prizeEmoji, "🎁");
      setText(els.prizeName, "奖品发放中…");
      setText(els.prizeNote, "请稍候，主持人正在为你发放奖品");
      return;
    }
    setText(els.prizeLabel, prize.consolation ? "新春福袋 · 安慰奖" : "恭喜中奖");
    setText(els.prizeEmoji, prize.emoji || "🎁");
    setText(els.prizeName, prize.name || "神秘奖品");
    setText(
      els.prizeNote,
      prize.consolation ? "奖品池已空，福袋同样喜气 · 请到台前领取" : "请凭昵称与头像到大屏前领奖"
    );
  }

  function renderResultStats(summary) {
    var wrap = els.resultStats;
    if (!wrap) return;
    if ((summary.missed || summary.manual) && !summary.waves) {
      setHidden(wrap, true);
      return;
    }
    setHidden(wrap, false);
    var totalWaves = summary.totalWaves || summary.waves || 0;
    var totalLen = summary.totalLen || 0;
    var items = [
      { value: summary.cleared + "/" + totalWaves, label: "通过波次" },
      { value: summary.hits + "/" + totalLen, label: "正确点灯" },
      { value: Net.fmtMs(summary.ms), label: "总用时" },
      { value: String(summary.score), label: "得分" }
    ];
    wrap.innerHTML = "";
    items.forEach(function (it) {
      var box = document.createElement("div");
      box.className = "result-stat";
      var b = document.createElement("b");
      b.textContent = it.value;
      var span = document.createElement("span");
      span.textContent = it.label;
      box.appendChild(b);
      box.appendChild(span);
      wrap.appendChild(box);
    });
  }

  function updateRevealPanel() {
    var session = state.session || {};
    var reveal = session.phase === "reveal";
    setHidden(els.revealState, !reveal);
    if (!reveal) {
      setResultWaitText("成绩已提交，等待大屏开奖", false);
      setText(els.resultTip, "开奖后请留意大屏中奖名单");
      return;
    }
    var me = state.me || {};
    var won = me.status === "won" || (me.result && me.result.win);
    var prize = me.prize || null;
    setText(els.resultFlag, "本轮开奖");
    if (els.revealText) {
      els.revealText.textContent = won
        ? "你已中奖" + (prize && prize.name ? "：" + prize.name : "") + " · 请到大屏前领奖"
        : "本轮未中奖 · 下一轮好运继续";
    }
    setResultWaitText(won ? "本轮开奖 · 恭喜中奖" : "本轮开奖 · 期待下一轮", true);
    setText(els.resultTip, "主持人重置房间后，可重新扫码参加下一轮");
  }

  function showResult(summary, prize, opts) {
    opts = opts || {};
    showScreen("result");
    var phase = state.session ? state.session.phase : "";
    var isReveal = phase === "reveal";
    var win = !!summary.win;

    setText(els.resultFlag, isReveal ? "本轮开奖" : opts.pending ? "成绩提交中" : "本轮结算");
    if (win) {
      setText(els.resultTitle, isReveal ? "恭喜中奖" : "恭喜通关");
      setText(
        els.resultSub,
        isReveal ? "灯阵全亮 · 好运已到账" : "灯阵全亮 · 连击完成" + (opts.pending ? " · 核对成绩中" : "")
      );
    } else if (summary.missed) {
      setText(els.resultTitle, "本轮开奖");
      setText(els.resultSub, "本轮挑战未完成 · 下一轮再来");
    } else {
      setText(els.resultTitle, "差一点点");
      setText(els.resultSub, "灯阵熄灭了 · 下一轮再战");
    }

    if (win) {
      renderPrizeCard(prize);
      setHidden(els.loseCard, true);
    } else {
      setHidden(els.prizeCard, true);
      setHidden(els.loseCard, false);
      setText(els.loseTitle, summary.missed ? "本轮未完成" : "差一点点");
      if (summary.missed) {
        setText(els.loseText, "本轮没有完成灯阵挑战，下一轮继续加油");
      } else if (summary.strikes > 0) {
        setText(els.loseText, "失误 " + summary.strikes + " 次，灯阵熄灭在最后一步");
      } else if (summary.cleared > 0) {
        setText(els.loseText, "已通过 " + summary.cleared + " 波，离奖品只差一步");
      } else {
        setText(els.loseText, "灯阵熄灭得太快，下一轮一定行");
      }
    }

    renderResultStats(summary);
    if (win) {
      setText(els.resultBless, "灯阵全亮 · 福气已到账 · 新年行大运");
    } else if (summary.missed) {
      setText(els.resultBless, "本轮已开奖 · 下一轮重新扫码再来");
    } else {
      setText(els.resultBless, "别灰心 · 下一轮好运一定轮到你");
    }

    if (isReveal || opts.pending) {
      if (isReveal) updateRevealPanel();
      else {
        setHidden(els.revealState, true);
        setResultWaitText("成绩提交中…", false);
        setText(els.resultTip, "提交成功后等待大屏开奖");
      }
    } else {
      updateRevealPanel();
    }
  }

  function showResultFromPlayer(player) {
    if (!player) return;
    var result = player.result;
    if (!result && !(player.status === "won" || player.status === "lost")) {
      enterWait();
      return;
    }
    state.me = player;
    state.submitted = true;
    if (result) clearPending();
    var summary = summaryFromPlayer(player);
    var prize = player.prize || null;
    showResult(summary, prize, { pending: false });
    if (summary.win) celebrate();
  }

  function applyServerResult(res) {
    if (!res || !res.ok) return;
    if (res.player) state.me = res.player;
    var prize = res.prize || (state.me && state.me.prize) || null;
    var summary = summaryFromPlayer(state.me || {});
    showResult(summary, prize, { pending: false });
    if (summary.win) celebrate();
  }

  /* ================= SSE / session ================= */

  function clearReconnectTimer() {
    if (state.reconnectTimer) {
      clearTimeout(state.reconnectTimer);
      state.reconnectTimer = 0;
    }
  }

  /** 部分环境下 EventSource 遇到被阻塞/异常的流不会自动重试，这里兜底 4 秒强制重建 */
  function scheduleHardReconnect(gen) {
    clearReconnectTimer();
    state.reconnectTimer = setTimeout(function () {
      state.reconnectTimer = 0;
      if (gen !== state.streamGen || !state.pid) return;
      try {
        if (state.stream) state.stream.close();
      } catch (e) {}
      state.stream = null;
      connectStream();
    }, 4000);
  }

  function connectStream() {
    if (!state.pid || !state.token) return;
    if (state.stream) {
      try {
        state.stream.close();
      } catch (e) {}
      state.stream = null;
    }
    clearReconnectTimer();
    var gen = (state.streamGen = state.streamGen + 1);
    var stream = Net.stream("player", { pid: state.pid, token: state.token });
    state.stream = stream;

    stream.on("_open", function () {
      if (gen !== state.streamGen) return;
      var wasDisconnected = state.reconnectNeeded;
      state.reconnectNeeded = false;
      clearReconnectTimer();
      hideNetBanner();
      if (wasDisconnected) resyncAfterReconnect();
    });
    stream.on("_error", function () {
      if (gen !== state.streamGen) return;
      state.reconnectNeeded = true;
      showNetBanner("网络波动，重连中…");
      scheduleHardReconnect(gen);
    });
    stream.on("hello", function (msg) {
      if (gen !== state.streamGen) return;
      hideNetBanner();
      clearReconnectTimer();
      if (!msg) return;
      if (msg.serverTime) syncTime(msg.serverTime);
      if (msg.you) state.me = msg.you;
      if (msg.session) applySession(msg.session);
    });
    stream.on("session", function (msg) {
      if (msg && msg.session) applySession(msg.session);
    });
    stream.on("game", function (msg) {
      if (msg && msg.game) onGame(msg.game);
    });
    stream.on("you", function (msg) {
      if (msg && msg.player) handleYou(msg.player);
    });
    stream.on("award", function (msg) {
      handleAward(msg);
    });
    stream.on("kicked", function (msg) {
      onKicked(msg);
    });
    stream.on("toast", function (msg) {
      if (msg && msg.text) toast(msg.text, msg.kind);
    });
    stream.on("error", function (msg) {
      if (msg && msg.message) toast(msg.message, "warn");
    });
  }

  function applySession(session) {
    if (!session) return;
    syncTime(session.serverTime);
    var prevPhase = state.session ? state.session.phase : "";
    var prevSid = state.sessionId;
    var prevRoom = state.roomCode;

    if (state.pid) {
      var sid = session.sessionId || "";
      var roomCode = session.roomCode || "";
      // 主持人 reset：房间号变化（lobby 阶段 reset 时 sessionId 均为空，必须靠 roomCode 判断）
      if (prevRoom && roomCode && roomCode !== prevRoom) {
        state.roomCode = roomCode;
        onNewRound(session);
        return;
      }
      // 兜底：非 lobby 阶段的 sessionId 变化
      if (prevSid && sid !== prevSid) {
        onNewRound(session);
        return;
      }
      state.sessionId = sid;
      state.roomCode = roomCode || prevRoom || "";
    }

    state.session = session;
    updateSessionUI();
    updateRevealPanelIfNeeded();

    if (prevPhase !== session.phase) {
      if (session.phase === "playing") {
        if (state.pid && !state.game && (state.screen === "wait" || state.screen === "count")) {
          scheduleGameFallback();
        }
      } else if (session.phase === "reveal") {
        onReveal(session);
      }
    }
  }

  function updateSessionUI() {
    var session = state.session;
    if (!session) return;
    if (state.screen === "wait") renderWait();
    else if (state.screen === "join") {
      renderJoinPool(session);
      updateJoinPhaseHint(session);
    } else if (state.screen === "game" || state.screen === "count") {
      // 游戏内只关心 phase 变化，由 onReveal 处理
    }
  }

  function updateRevealPanelIfNeeded() {
    if (state.screen === "result" && state.session && state.session.phase === "reveal") {
      updateRevealPanel();
    }
  }

  function onReveal(session) {
    if (!session || session.phase !== "reveal") return;
    if (state.playing || state.counting) abortPlay();
    var me = state.me || {};
    if (state.screen === "result") {
      updateRevealPanel();
      return;
    }
    if (me.result || me.status === "won" || me.status === "lost") {
      showResultFromPlayer(me);
      return;
    }
    if (state.pid) {
      showResult(
        {
          win: false,
          missed: true,
          manual: false,
          waves: 0,
          totalWaves: waveConfigs().length,
          cleared: 0,
          hits: 0,
          strikes: 0,
          ms: 0,
          score: 0,
          totalLen: totalLenOf(waveConfigs())
        },
        null,
        { pending: false }
      );
    }
  }

  function onNewRound(session) {
    abortPlay();
    clearIdentity();
    state.session = session || null;
    state.sessionId = (session && session.sessionId) || "";
    state.roomCode = (session && session.roomCode) || "";
    if (session && session.roomCode) {
      Net.store.set("code", session.roomCode);
      if (els.roomCode) els.roomCode.value = session.roomCode;
    }
    showJoin();
    renderJoinPool(session);
    // 服务端 reset() 会广播 toast（含新房间号），此处不重复提示
  }

  function handleYou(player) {
    if (!player) return;
    state.me = player;
    if (player.prize && state.screen === "result") renderPrizeCard(player.prize);
    if (player.result && (player.status === "won" || player.status === "lost")) {
      if (state.screen === "game" || state.screen === "count") {
        abortPlay();
        showResultFromPlayer(player);
      } else if (state.screen === "wait") {
        showResultFromPlayer(player);
      } else if (state.screen === "result") {
        if (state.session && state.session.phase === "reveal") updateRevealPanel();
      }
    }
  }

  function handleAward(msg) {
    if (!msg) return;
    var mine = state.pid && msg.pid === state.pid;
    if (!mine) return;
    var prize = msg.prize || (msg.winner && msg.winner.prize) || null;
    if (prize) {
      if (state.me) state.me.prize = prize;
      if (state.screen === "result") renderPrizeCard(prize);
      toast("🎁 恭喜中奖：" + (prize.name || "神秘奖品"), "success");
      celebrate();
    }
  }

  function onKicked(msg) {
    abortPlay();
    if (state.stream) {
      try {
        state.stream.close();
      } catch (e) {}
      state.stream = null;
    }
    clearIdentity();
    showJoin();
    toast((msg && msg.reason) || "你已被主持人移出房间", "warn");
  }

  function resyncAfterReconnect() {
    if (!state.pid) return;
    Net.post("/api/rejoin", { cid: Net.cid(), pid: state.pid, token: state.token }).then(function (res) {
      if (!res || !res.ok) {
        if (res && res.code === "NETWORK") {
          showNetBanner("网络波动，重连中…");
          return;
        }
        abortPlay();
        clearIdentity();
        showJoin();
        toast("与主机的连接已重置，请重新入场", "warn");
        return;
      }
      if (res.player) state.me = res.player;
      if (res.session) {
        state.session = res.session;
        state.sessionId = res.session.sessionId || "";
        state.roomCode = res.session.roomCode || state.roomCode;
      }
      if (res.game) state.game = normalizeGame(res.game);
      if (state.screen === "wait") {
        if (state.session && state.session.phase === "playing") {
          if (!state.game) state.game = readPersistedGame(state.sessionId) || deriveGameFromSession(state.session);
          if (state.game) beginGame({ replay: false });
          else scheduleGameFallback();
        } else {
          renderWait();
        }
      } else if (state.screen === "result" || state.screen === "game" || state.screen === "count") {
        updateRevealPanelIfNeeded();
      }
    });
  }

  /* ================= 身份 / 恢复 ================= */

  function clearIdentity() {
    state.pid = null;
    state.token = null;
    state.me = null;
    state.sessionId = "";
    state.roomCode = "";
    state.submitted = false;
    state.submitOk = false;
    state.submitLock = false;
    state.celebrated = false;
    state.game = null;
    clearReconnectTimer();
    state.reconnectNeeded = false;
    Net.store.del("pid");
    Net.store.del("token");
    Net.store.del("pending");
    Net.store.del("game");
    if (state.stream) {
      try {
        state.stream.close();
      } catch (e) {}
      state.stream = null;
    }
  }

  function tryRejoin(attempt) {
    attempt = attempt || 1;
    var pid = Net.store.get("pid", "");
    var token = Net.store.get("token", "");
    if (!pid || !token) return Promise.resolve(false);
    state.pid = pid;
    state.token = token;

    return Net.post("/api/rejoin", { cid: Net.cid(), pid: pid, token: token }).then(function (res) {
      if (res && res.ok) {
        state.me = res.player || null;
        state.session = res.session || null;
        state.sessionId = res.session ? res.session.sessionId || "" : "";
        state.roomCode = res.session ? res.session.roomCode || "" : "";
        if (res.session) syncTime(res.session.serverTime);
        if (res.game) {
          state.game = normalizeGame(res.game);
          persistGame(state.game);
        }
        connectStream();
        routeAfterIdentity();
        return true;
      }
      if (res && res.code === "NETWORK" && attempt < 3) {
        showNetBanner("网络波动，重连中…");
        return sleep(1200).then(function () {
          return tryRejoin(attempt + 1);
        });
      }
      if (res && res.code === "NETWORK") {
        // 网络问题：保留身份，回到加入页并提示
        showJoin();
        toast("网络连接失败，请确认与主机在同一 Wi-Fi", "warn");
        return false;
      }
      clearIdentity();
      showJoin();
      toast("身份已失效，请重新扫码入场", "warn");
      return false;
    });
  }

  function routeAfterIdentity() {
    var session = state.session || {};
    var me = state.me || {};
    if (me.result || me.status === "won" || me.status === "lost") {
      showResultFromPlayer(me);
      return;
    }
    if (session.phase === "playing") {
      if (resumePending()) return;
      if (state.counting || state.playing) return;
      if (!state.game) {
        state.game = readPersistedGame(state.sessionId) || deriveGameFromSession(session);
      }
      if (state.game) {
        beginGame({ replay: true });
      } else {
        enterWait();
        scheduleGameFallback();
      }
      return;
    }
    if (session.phase === "reveal") {
      showResultFromPlayer(me);
      return;
    }
    enterWait();
  }

  /* ================= 启动 ================= */

  function boot() {
    cache();
    Fx.init();

    // 首次用户手势后解锁音频（移动端策略）
    document.addEventListener(
      "pointerdown",
      function once() {
        Sound.unlock();
        document.removeEventListener("pointerdown", once);
      },
      { passive: true }
    );

    state.avatar = (function () {
      var saved = Net.store.get("avatar", "");
      return AVATARS.indexOf(saved) >= 0 ? saved : AVATARS[0];
    })();
    renderAvatars();
    bindJoinEvents();

    var urlCode = getUrlCode();
    var savedCode = Net.store.get("code", "");
    var savedName = Net.store.get("name", "");
    if (els.roomCode) {
      if (urlCode) els.roomCode.value = urlCode;
      else if (savedCode) els.roomCode.value = savedCode;
    }
    if (els.nickname && savedName) els.nickname.value = savedName;
    updateNameCount();

    // 加入页阶段提示 / 奖品池预览（公开状态）
    Net.get("/api/state?cid=" + encodeURIComponent(Net.cid())).then(function (res) {
      if (res && res.ok && res.session) {
        state.session = res.session;
        syncTime(res.session.serverTime);
        if (state.screen === "join") {
          renderJoinPool(res.session);
          updateJoinPhaseHint(res.session);
        }
      } else if (state.screen === "join") {
        setHtml(els.joinPoolList, '<span class="muted">奖品池加载失败</span>');
      }
    });

    tryRejoin().then(function (ok) {
      if (ok) return;
      if (state.screen === "boot") showJoin();
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }
})();
