/*!
 * art.js · 新春年会抽奖系统 —— 2.5D 中国春节夜景渲染引擎（纯 Canvas2D，零外链资源）
 * 接口见 PROTOCOL.md §8，签名冻结；大屏(1920×1080)与手机端复用。
 *
 *   const scene = Art.createScene(document.getElementById('bg'),
 *     { quality: 'high', density: 1, phase: 'lobby' });   // quality: 'high' | 'low'
 *   scene.start();  scene.setPhase('playing');  scene.setEnergy(0.8);  // 内部约 1s 平滑过渡
 *   scene.burst(x, y, { count: 90, power: 1.2 });   // x,y 为 CSS 像素（DOM 元素中心）
 *   scene.celebrate(6);  scene.resize();  scene.destroy();   // resize 幂等、destroy 解绑监听
 *   Art.lanternIcon(canvasEl, { color: Art.THEME.red, glow: true });   // 画灯笼图标
 *   Art.THEME = { red, gold, jade, ink, paper }
 *  性能：DPR 封顶 2；静态背景按 min(DPR,1.5) 烘焙离屏画布；隐藏标签页暂停 rAF；
 *  prefers-reduced-motion 降级；粒子走对象池、颜色透明度预烘焙为字符串阶梯。
 */
(function (global) {
  'use strict';

  // ===== 0. 主题与常量 =====
  const THEME = Object.freeze({ red: '#c8102e', gold: '#f2c14e', jade: '#4fd1a5', ink: '#150709', paper: '#fff6e6' });
  const TAU = Math.PI * 2;
  const PAD = 64; // 视差层左右安全边距（CSS px），避免平移露边
  const FW_STEPS = 10;
  const FW_COLORS = ['#ffd76a', '#ffa04a', '#ff5f52', '#ffe9b8', '#8ff0c8', '#fff6e6'];
  // 阶段氛围：breath=灯笼呼吸 glow=光晕 rays=体积光 particle=粒子倍率 burst=烟花规模
  const PHASE = {
    lobby: { breath: 0.30, glow: 0.80, rays: 0.55, particle: 0.80, burst: 0.75, fwMin: 9000, fwMax: 17000, fwPower: 0.85 },
    playing: { breath: 0.85, glow: 1.00, rays: 0.80, particle: 1.00, burst: 1.00, fwMin: 4200, fwMax: 8000, fwPower: 1.05 },
    reveal: { breath: 1.00, glow: 1.35, rays: 1.15, particle: 1.45, burst: 1.45, fwMin: 1100, fwMax: 2400, fwPower: 1.35 }
  };

  // ===== 1. 工具 =====
  const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
  const lerp = (a, b, t) => a + (b - a) * t;
  const rnd = (a, b) => a + Math.random() * (b - a);
  function mulberry32(seed) { // 固定种子随机数：背景可复现，resize 不突变
    let a = seed >>> 0;
    return function () {
      a = (a + 0x6d2b79f5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  function hexToRgb(hex) {
    let s = String(hex || '').trim().replace('#', '');
    if (s.length === 3) s = s[0] + s[0] + s[1] + s[1] + s[2] + s[2];
    if (!/^[0-9a-fA-F]{6}$/.test(s)) return [242, 193, 78];
    const n = parseInt(s, 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }
  function makeLadder(hex, steps) { // 透明度阶梯：避免每帧拼 rgba 字符串
    const rgb = hexToRgb(hex), out = new Array(steps);
    for (let i = 0; i < steps; i++) out[i] = 'rgba(' + rgb[0] + ',' + rgb[1] + ',' + rgb[2] + ',' + (i / (steps - 1)).toFixed(3) + ')';
    return out;
  }
  function makeCanvas(w, h, scale) { // w/h 为 CSS 逻辑尺寸，scale 为内部超采样
    const cv = document.createElement('canvas');
    cv.width = Math.max(1, Math.round(w * scale));
    cv.height = Math.max(1, Math.round(h * scale));
    const ctx = cv.getContext('2d');
    if (scale !== 1) ctx.setTransform(scale, 0, 0, scale, 0, 0);
    return { cv: cv, ctx: ctx, w: w, h: h };
  }
  function rr(g, x, y, w, h, r) { // 圆角矩形路径
    g.beginPath();
    g.moveTo(x + r, y);
    g.arcTo(x + w, y, x + w, y + h, r);
    g.arcTo(x + w, y + h, x, y + h, r);
    g.arcTo(x, y + h, x, y, r);
    g.arcTo(x, y, x + w, y, r);
    g.closePath();
  }
  const reduceQ = (function () {
    try { return global.matchMedia ? global.matchMedia('(prefers-reduced-motion: reduce)') : null; } catch (e) { return null; }
  })();
  function prefersReduce() { return !!(reduceQ && reduceQ.matches); }

  // ===== 2. Art.mountCanvas：DPR 自适应 + resize 幂等 =====
  function mountCanvas(canvas) {
    if (!canvas || typeof canvas.getContext !== 'function') {
      const noop = function () {};
      return { ctx: null, w: 0, h: 0, dpr: 1, onResize: function () { return noop; }, _sync: noop, _dispose: noop };
    }
    const st = { canvas: canvas, ctx: canvas.getContext('2d'), w: 0, h: 0, dpr: 1, subs: [], bound: false, observer: null, disposed: false };
    function sync() {
      if (st.disposed) return;
      const c = st.canvas;
      // 先清掉自己钉过的内联尺寸，再按 CSS 布局测量，避免「窗口由大变小」时
      // 内联 px 把盒子钉死、ResizeObserver 不触发导致画布永远不缩（投影/全屏切换场景）。
      if (c.style.width) c.style.width = '';
      if (c.style.height) c.style.height = '';
      const rect = c.getBoundingClientRect();
      let cw = rect.width, ch = rect.height;
      if (!(cw > 1) || !(ch > 1)) { cw = global.innerWidth || 2; ch = global.innerHeight || 2; }
      // 无 CSS 尺寸时把盒子钉住，避免「设 width 属性→盒子变大→再设」死循环
      if (c.width > 1 && c.height > 1 && Math.abs(rect.width - c.width) < 1.5 && Math.abs(rect.height - c.height) < 1.5) {
        c.style.width = cw + 'px';
        c.style.height = ch + 'px';
      }
      const dpr = Math.min(2, global.devicePixelRatio || 1); // DPR 封顶 2
      const pw = Math.max(1, Math.round(cw * dpr)), ph = Math.max(1, Math.round(ch * dpr));
      st.w = cw; st.h = ch; st.dpr = dpr;
      if (c.width !== pw || c.height !== ph) { c.width = pw; c.height = ph; }
      if (st.ctx) st.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      for (let i = 0; i < st.subs.length; i++) { try { st.subs[i](cw, ch); } catch (e) { /* 单个订阅者异常不影响其它 */ } }
    }
    function bind() {
      if (st.bound || st.disposed) return;
      st.bound = true;
      global.addEventListener('resize', sync, { passive: true });
      global.addEventListener('orientationchange', sync, { passive: true });
      if (typeof global.ResizeObserver === 'function') { st.observer = new global.ResizeObserver(sync); st.observer.observe(canvas); }
    }
    bind();
    sync();
    return {
      get ctx() { return st.ctx; },
      get w() { return st.w; },
      get h() { return st.h; },
      get dpr() { return st.dpr; },
      onResize: function (fn) { // 返回解绑函数；多次调用不重复绑定 window 监听
        const noop = function () {};
        if (typeof fn !== 'function') return noop;
        st.subs.push(fn);
        return function () { const i = st.subs.indexOf(fn); if (i >= 0) st.subs.splice(i, 1); };
      },
      _sync: sync,
      _dispose: function () {
        if (st.disposed) return;
        st.disposed = true;
        st.subs.length = 0;
        if (st.bound) { global.removeEventListener('resize', sync); global.removeEventListener('orientationchange', sync); }
        if (st.observer) { st.observer.disconnect(); st.observer = null; }
      }
    };
  }

  // ===== 3. 精灵烘焙（灯笼 / 光斑 / 云 / 光束 / 暗角） =====
  const LANT_W = 136, LANT_H = 152; // 灯笼标准坐标系：灯身中心(68,58)，吊点(68,0)
  function paintLantern(g, color, withGlow) {
    const rgb = hexToRgb(color), rs = rgb.join(','), cx = 68, cy = 58;
    if (withGlow !== false) { // 外发光
      const halo = g.createRadialGradient(cx, cy, 4, cx, cy, 62);
      halo.addColorStop(0, 'rgba(' + rs + ',0.55)'); halo.addColorStop(0.34, 'rgba(' + rs + ',0.20)');
      halo.addColorStop(0.72, 'rgba(' + rs + ',0.05)'); halo.addColorStop(1, 'rgba(' + rs + ',0)');
      g.fillStyle = halo;
      g.beginPath(); g.arc(cx, cy, 62, 0, TAU); g.fill();
    }
    g.strokeStyle = 'rgba(233,185,73,0.8)'; g.lineWidth = 1.4;
    g.beginPath(); g.moveTo(cx, 0); g.lineTo(cx, 12); g.stroke(); // 提绳
    g.fillStyle = '#e9b949'; rr(g, cx - 11, 12, 22, 6, 3); g.fill(); // 上盖
    const body = g.createRadialGradient(60, 46, 3, cx, cy, 40); // 球体渐变灯身
    body.addColorStop(0, '#fff1dd');
    body.addColorStop(0.18, 'rgb(' + Math.min(255, rgb[0] + 95) + ',' + Math.min(255, rgb[1] + 75) + ',' + Math.min(255, rgb[2] + 45) + ')');
    body.addColorStop(0.62, color);
    body.addColorStop(1, 'rgb(' + Math.round(rgb[0] * 0.42) + ',' + Math.round(rgb[1] * 0.30) + ',' + Math.round(rgb[2] * 0.32) + ')');
    g.fillStyle = body;
    g.beginPath(); g.ellipse(cx, cy, 30, 33, 0, 0, TAU); g.fill();
    g.strokeStyle = 'rgba(255,214,140,0.26)'; g.lineWidth = 1; // 经线棱
    const ribs = [26, 19, 11, 4];
    for (let i = 0; i < ribs.length; i++) { g.beginPath(); g.ellipse(cx, cy, ribs[i], 33, 0, 0, TAU); g.stroke(); }
    g.strokeStyle = 'rgba(233,185,73,0.75)'; g.lineWidth = 2; // 上下金箍
    g.beginPath(); g.ellipse(cx, cy - 29, 25, 6, 0, 0, TAU); g.stroke();
    g.beginPath(); g.ellipse(cx, cy + 29, 25, 6, 0, 0, TAU); g.stroke();
    g.fillStyle = 'rgba(255,236,200,0.20)'; // 立体高光
    g.beginPath(); g.ellipse(cx - 11, cy - 13, 8, 15, -0.25, 0, TAU); g.fill();
    g.save(); // 「福」字
    g.fillStyle = 'rgba(255,222,150,0.92)'; g.textAlign = 'center'; g.textBaseline = 'middle';
    g.font = 'bold 27px "STKaiti","KaiTi","Kaiti SC","STSong",serif';
    g.fillText('福', cx, cy + 2);
    g.restore();
    g.fillStyle = '#e9b949'; rr(g, cx - 10, 89, 20, 6, 3); g.fill(); // 下盖
    g.strokeStyle = 'rgba(233,185,73,0.85)'; g.lineWidth = 1.6;
    g.beginPath(); g.moveTo(cx, 95); g.lineTo(cx, 105); g.stroke();
    g.strokeStyle = 'rgba(200,40,40,0.85)'; g.lineWidth = 1.4; // 流苏
    g.beginPath(); g.moveTo(cx, 105); g.lineTo(cx - 4, 124); g.moveTo(cx, 105); g.lineTo(cx, 127); g.moveTo(cx, 105); g.lineTo(cx + 4, 124); g.stroke();
    g.fillStyle = '#ffe6b3'; g.beginPath(); g.arc(cx, 94, 3, 0, TAU); g.fill();
  }
  function bakeLanternSprite(color) {
    const L = makeCanvas(LANT_W, LANT_H, 2);
    paintLantern(L.ctx, color);
    return L.cv;
  }
  function bakeGlow(hex, core) { // 柔和径向光斑（灯笼光晕/地面光池/烟花闪光通用）
    const N = 128, L = makeCanvas(N, N, 1), g = L.ctx, rs = hexToRgb(hex).join(',');
    const grd = g.createRadialGradient(N / 2, N / 2, 0, N / 2, N / 2, N / 2);
    grd.addColorStop(0, 'rgba(' + rs + ',' + core + ')');
    grd.addColorStop(0.22, 'rgba(' + rs + ',' + (core * 0.42) + ')');
    grd.addColorStop(0.55, 'rgba(' + rs + ',' + (core * 0.12) + ')');
    grd.addColorStop(1, 'rgba(' + rs + ',0)');
    g.fillStyle = grd; g.fillRect(0, 0, N, N);
    return L.cv;
  }
  function bakeCloud(seed) { // 云带精灵：柔和暗红团块 + 极淡月光云边
    const rng = mulberry32(seed), L = makeCanvas(512, 180, 1), g = L.ctx;
    for (let i = 0; i < 18; i++) {
      const cx = 40 + rng() * 432, cy = 42 + rng() * 96, r = 38 + rng() * 92;
      const grd = g.createRadialGradient(cx, cy, 0, cx, cy, r);
      grd.addColorStop(0, 'rgba(52,16,24,0.55)'); grd.addColorStop(0.55, 'rgba(40,12,20,0.26)');
      grd.addColorStop(1, 'rgba(30,10,15,0)');
      g.fillStyle = grd; g.beginPath(); g.arc(cx, cy, r, 0, TAU); g.fill();
    }
    for (let i = 0; i < 7; i++) {
      const cx = 90 + rng() * 340, cy = 30 + rng() * 50, r = 26 + rng() * 46;
      const grd = g.createRadialGradient(cx, cy, 0, cx, cy, r);
      grd.addColorStop(0, 'rgba(255,196,150,0.06)'); grd.addColorStop(1, 'rgba(255,196,150,0)');
      g.fillStyle = grd; g.beginPath(); g.arc(cx, cy, r, 0, TAU); g.fill();
    }
    return L.cv;
  }
  function bakeShaft() { // 体积光束：竖向渐变 + 横向柔化
    const L = makeCanvas(160, 520, 1), g = L.ctx;
    const lg = g.createLinearGradient(0, 0, 0, 520);
    lg.addColorStop(0, 'rgba(255,232,190,0.50)'); lg.addColorStop(0.4, 'rgba(255,210,155,0.20)');
    lg.addColorStop(1, 'rgba(255,196,140,0)');
    g.fillStyle = lg; g.fillRect(0, 0, 160, 520);
    g.globalCompositeOperation = 'destination-in'; const hg = g.createLinearGradient(0, 0, 160, 0);
    hg.addColorStop(0, 'rgba(0,0,0,0)'); hg.addColorStop(0.42, 'rgba(0,0,0,1)');
    hg.addColorStop(0.58, 'rgba(0,0,0,1)'); hg.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = hg; g.fillRect(0, 0, 160, 520);
    return L.cv;
  }
  function bakeVignette(w, h) { // 前景暗角（半分辨率足够，柔和上采样）
    const L = makeCanvas(w, h, 0.5), g = L.ctx;
    const rg = g.createRadialGradient(w * 0.5, h * 0.52, Math.min(w, h) * 0.16, w * 0.5, h * 0.52, Math.hypot(w, h) * 0.62);
    rg.addColorStop(0, 'rgba(0,0,0,0)'); rg.addColorStop(0.55, 'rgba(3,1,5,0.10)');
    rg.addColorStop(0.82, 'rgba(3,1,5,0.40)'); rg.addColorStop(1, 'rgba(2,1,4,0.72)');
    g.fillStyle = rg; g.fillRect(0, 0, w, h);
    const tg = g.createLinearGradient(0, 0, 0, h * 0.26); tg.addColorStop(0, 'rgba(2,1,4,0.52)'); tg.addColorStop(1, 'rgba(2,1,4,0)');
    g.fillStyle = tg; g.fillRect(0, 0, w, h * 0.26);
    const bg = g.createLinearGradient(0, h, 0, h * 0.72); bg.addColorStop(0, 'rgba(2,1,4,0.46)'); bg.addColorStop(1, 'rgba(2,1,4,0)');
    g.fillStyle = bg; g.fillRect(0, h * 0.72, w, h * 0.28);
    return L;
  }

  // ===== 4. 背景烘焙 =====
  function bakeSky(w, h, cs, horizon) { // 夜空渐变 + 巨大月晕 + 月盘 + 稀疏星点
    const L = makeCanvas(w, h, cs), g = L.ctx;
    const grad = g.createLinearGradient(0, 0, 0, h);
    grad.addColorStop(0, '#050206'); grad.addColorStop(0.16, '#120409'); grad.addColorStop(0.34, '#2b0810');
    grad.addColorStop(0.50, '#4a0f17'); grad.addColorStop(0.60, '#6b191d'); grad.addColorStop(0.68, '#3d0d14');
    grad.addColorStop(0.82, '#1a060b'); grad.addColorStop(1, '#080307');
    g.fillStyle = grad; g.fillRect(0, 0, w, h);
    const wide = w > h * 1.2, mx = w * (wide ? 0.775 : 0.70), my = h * (wide ? 0.20 : 0.155);
    const halo = g.createRadialGradient(mx, my, 0, mx, my, Math.max(w, h) * 0.52);
    halo.addColorStop(0, 'rgba(255,246,220,0.34)'); halo.addColorStop(0.10, 'rgba(255,232,180,0.20)');
    halo.addColorStop(0.28, 'rgba(255,206,150,0.09)'); halo.addColorStop(0.58, 'rgba(255,180,120,0.03)');
    halo.addColorStop(1, 'rgba(255,170,110,0)');
    g.fillStyle = halo; g.fillRect(0, 0, w, h);
    const mr = Math.min(w, h) * 0.055;
    const disc = g.createRadialGradient(mx - mr * 0.22, my - mr * 0.28, mr * 0.08, mx, my, mr);
    disc.addColorStop(0, '#fffdf4'); disc.addColorStop(0.5, '#ffefc8');
    disc.addColorStop(0.86, 'rgba(255,226,170,0.42)'); disc.addColorStop(1, 'rgba(255,220,160,0)');
    g.fillStyle = disc;
    g.beginPath(); g.arc(mx, my, mr, 0, TAU); g.fill();
    const rng = mulberry32(20260130), starN = Math.round(clamp((w * h) / (1600 * 900), 0.5, 2) * 150);
    for (let i = 0; i < starN; i++) { // 稀疏星点，越近地平线越少
      const x = rng() * w, y = rng() * horizon * 0.92, a = 0.18 + rng() * 0.62, r = 0.4 + rng() * (rng() > 0.9 ? 1.8 : 0.9);
      g.fillStyle = 'rgba(226,236,255,' + a.toFixed(3) + ')';
      g.beginPath(); g.arc(x, y, r, 0, TAU); g.fill();
      if (a > 0.72 && r > 1) { // 亮星十字星芒
        g.fillStyle = 'rgba(226,236,255,' + (a * 0.5).toFixed(3) + ')';
        g.fillRect(x - r * 3.4, y - 0.4, r * 6.8, 0.8); g.fillRect(x - 0.4, y - r * 3.4, 0.8, r * 6.8);
      }
    }
    const haze = g.createLinearGradient(0, horizon - h * 0.16, 0, horizon + h * 0.02);
    haze.addColorStop(0, 'rgba(255,150,95,0)'); haze.addColorStop(1, 'rgba(255,160,105,0.10)');
    g.fillStyle = haze; g.fillRect(0, horizon - h * 0.16, w, h * 0.18);
    return L;
  }
  function bakeRidge(w, h, pad, horizon, cs, o) { // 山脊剪影：多层视差 + 雪线 + 雾化
    const cw = w + pad * 2, L = makeCanvas(cw, h, cs), g = L.ctx;
    const rng = mulberry32(o.seed), p1 = rng() * TAU, p2 = rng() * TAU, p3 = rng() * TAU;
    const amp = o.amp * h, base = horizon - o.base * h, step = Math.max(8, Math.round(10 / cs));
    const pts = [];
    for (let x = 0; x <= cw; x += step) {
      pts.push(x, base - amp * 0.34 - amp * 0.30 * Math.sin(x * 0.0019 + p1) - amp * 0.22 * Math.sin(x * 0.0046 + p2) - amp * 0.13 * Math.sin(x * 0.0113 + p3));
    }
    g.beginPath(); g.moveTo(0, h + 2);
    for (let i = 0; i < pts.length; i += 2) g.lineTo(pts[i], pts[i + 1]);
    g.lineTo(cw, h + 2); g.closePath();
    const grd = g.createLinearGradient(0, base - amp * 1.8, 0, horizon + h * 0.06);
    grd.addColorStop(0, o.cTop); grd.addColorStop(0.55, o.cMid); grd.addColorStop(1, o.cBot);
    g.fillStyle = grd; g.fill();
    g.beginPath(); g.moveTo(pts[0], pts[1]); // 山脊雪线（冷色微光）
    for (let i = 2; i < pts.length; i += 2) g.lineTo(pts[i], pts[i + 1]);
    g.strokeStyle = o.rim; g.lineWidth = Math.max(0.9, cs * 1.2); g.stroke();
    const fog = g.createLinearGradient(0, base - amp * 1.1, 0, horizon + h * 0.03); // 雾化只染剪影
    fog.addColorStop(0, 'rgba(0,0,0,0)');
    fog.addColorStop(0.7, o.fog);
    fog.addColorStop(1, o.fogEnd);
    g.globalCompositeOperation = 'source-atop'; g.fillStyle = fog; g.fillRect(0, 0, cw, h);
    g.globalCompositeOperation = 'source-over';
    return { cv: L.cv, w: cw, h: h };
  }
  function bakeGround(w, h, hz, pad, cs) { // 透视地砖/雪地纹理：静态烘焙，逐帧只做视差平移
    const cw = w + pad * 2, L = makeCanvas(cw, h, cs), g = L.ctx, off = pad;
    const vpx = off + w * 0.5, rows = 22, cols = 15;
    g.save();
    g.beginPath(); g.rect(0, hz, cw, h - hz); g.clip();
    const gr = g.createRadialGradient(vpx, h * 1.16, 0, vpx, h * 1.16, w * 0.72); // 中央灯光在雪地上的柔和反光
    gr.addColorStop(0, 'rgba(255,170,110,0.16)'); gr.addColorStop(0.45, 'rgba(220,96,64,0.06)'); gr.addColorStop(1, 'rgba(180,56,50,0)');
    g.fillStyle = gr; g.fillRect(0, hz, cw, h - hz);
    g.beginPath(); // 横向地砖线：近疏远密（幂次透视）
    for (let i = 1; i <= rows; i++) { const y = hz + (h - hz) * Math.pow(i / rows, 2.6); g.moveTo(0, y); g.lineTo(cw, y); }
    g.strokeStyle = 'rgba(198,216,248,0.11)'; g.lineWidth = 1; g.stroke();
    g.beginPath(); // 纵向消失线
    for (let i = 0; i <= cols; i++) { const bx = vpx - w * 1.3 + w * 2.6 * (i / cols); g.moveTo(bx, h + 80); g.lineTo(vpx + (bx - vpx) * 0.02, hz + 1); }
    g.strokeStyle = 'rgba(198,216,248,0.075)'; g.stroke();
    const rng = mulberry32(0x9a17); // 雪堆起伏：冷白柔和椭球
    for (let i = 0; i < 70; i++) {
      const x = rng() * cw, yy = hz + Math.pow(rng(), 0.6) * (h - hz), rx = (26 + rng() * 120) * (0.4 + (yy - hz) / (h - hz));
      const gr = g.createRadialGradient(x, yy, 0, x, yy, rx);
      gr.addColorStop(0, 'rgba(206,224,255,' + (0.05 + rng() * 0.05).toFixed(3) + ')');
      gr.addColorStop(1, 'rgba(206,224,255,0)');
      g.save(); g.translate(x, yy); g.scale(1, 0.12 + rng() * 0.1); g.translate(-x, -yy);
      g.fillStyle = gr; g.beginPath(); g.arc(x, yy, rx, 0, TAU); g.fill(); g.restore();
    }
    g.restore();
    return { cv: L.cv, w: cw, h: h };
  }
  function drawHouse(g, cx, baseY, unit) { // 中式屋舍：墙体 + 起翘飞檐 + 雪檐 + 窗灯
    const ww = 82 * unit, wallH = 26 * unit, roofH = 22 * unit, eaveY = baseY - wallH;
    g.fillStyle = '#08030a'; g.fillRect(cx - ww * 0.5, eaveY - 1, ww, wallH + 2);
    g.beginPath(); g.moveTo(cx - ww * 0.66, eaveY - unit * 4); // 左檐角上翘
    g.quadraticCurveTo(cx - ww * 0.48, eaveY + unit * 6, cx - ww * 0.30, eaveY - roofH);
    g.lineTo(cx + ww * 0.30, eaveY - roofH); g.quadraticCurveTo(cx + ww * 0.48, eaveY + unit * 6, cx + ww * 0.66, eaveY - unit * 4);
    g.closePath();
    g.fillStyle = '#060205'; g.fill();
    g.strokeStyle = 'rgba(196,216,255,0.22)'; g.lineWidth = 1.2; g.stroke();
    g.fillStyle = '#060205'; g.fillRect(cx - ww * 0.05, eaveY - roofH - unit * 3, ww * 0.1, unit * 3); // 屋脊宝顶
    g.fillStyle = 'rgba(255,186,104,0.72)';
    for (let i = 0; i < 2; i++) g.fillRect(cx - ww * 0.24 + i * ww * 0.30, eaveY + wallH * 0.26, ww * 0.13, wallH * 0.42);
  }
  function drawPagoda(g, cx, baseY, unit, tiers) { // 中式宝塔：多层塔身 + 飞檐 + 塔刹
    g.fillStyle = '#0a0407'; g.fillRect(cx - 52 * unit, baseY - 13 * unit, 104 * unit, 15 * unit);
    let y = baseY - 13 * unit, tw = 108 * unit;
    for (let i = 0; i < tiers; i++) {
      const wallW = tw * 0.62, wallH = 25 * unit * (1 - i * 0.09), roofH = 17 * unit;
      g.fillStyle = i % 2 ? '#0d0509' : '#090306'; g.fillRect(cx - wallW * 0.5, y - wallH, wallW, wallH);
      g.fillStyle = 'rgba(255,190,110,0.78)';
      const winW = Math.max(2, wallW * 0.18); g.fillRect(cx - winW * 0.5, y - wallH * 0.72, winW, wallH * 0.42);
      y -= wallH;
      g.beginPath(); g.moveTo(cx - tw * 0.52, y - unit * 5);
      g.quadraticCurveTo(cx - tw * 0.34, y + unit * 4, cx - tw * 0.11, y - roofH);
      g.lineTo(cx + tw * 0.11, y - roofH); g.quadraticCurveTo(cx + tw * 0.34, y + unit * 4, cx + tw * 0.52, y - unit * 5);
      g.closePath();
      g.fillStyle = '#070305'; g.fill();
      g.strokeStyle = 'rgba(242,193,78,0.20)'; g.lineWidth = 1.1; g.stroke();
      g.strokeStyle = 'rgba(196,216,255,0.16)'; g.stroke();
      y -= roofH;
      tw *= 0.78;
    }
    const topY = y - unit * 3; // 塔刹
    g.strokeStyle = 'rgba(242,193,78,0.6)'; g.lineWidth = Math.max(1, 1.6 * unit);
    g.beginPath(); g.moveTo(cx, topY); g.lineTo(cx, topY - 24 * unit); g.stroke();
    g.fillStyle = 'rgba(242,193,78,0.7)';
    for (let k = 0; k < 3; k++) { g.beginPath(); g.ellipse(cx, topY - (7 + k * 7) * unit, (6 - k) * unit, 2.2 * unit, 0, 0, TAU); g.fill(); }
    const bg = g.createRadialGradient(cx, topY - 26 * unit, 0, cx, topY - 26 * unit, 13 * unit);
    bg.addColorStop(0, 'rgba(255,236,180,0.85)'); bg.addColorStop(0.4, 'rgba(255,200,120,0.30)');
    bg.addColorStop(1, 'rgba(255,190,110,0)');
    g.fillStyle = bg; g.beginPath(); g.arc(cx, topY - 26 * unit, 13 * unit, 0, TAU); g.fill();
  }
  function drawGate(g, cx, baseY, unit) { // 牌坊：双柱 + 横匾 + 飞檐
    const ww = 168 * unit, hh = 50 * unit, pw = Math.max(3, 8 * unit);
    g.fillStyle = '#0a0407';
    g.fillRect(cx - ww * 0.44, baseY - hh, pw, hh);
    g.fillRect(cx + ww * 0.44 - pw, baseY - hh, pw, hh);
    g.fillRect(cx - ww * 0.5, baseY - hh - 13 * unit, ww, 13 * unit);
    g.beginPath();
    g.moveTo(cx - ww * 0.56, baseY - hh - 12 * unit);
    g.quadraticCurveTo(cx - ww * 0.36, baseY - hh - 30 * unit, cx - ww * 0.10, baseY - hh - 36 * unit);
    g.lineTo(cx + ww * 0.10, baseY - hh - 36 * unit);
    g.quadraticCurveTo(cx + ww * 0.36, baseY - hh - 30 * unit, cx + ww * 0.56, baseY - hh - 12 * unit);
    g.closePath();
    g.fillStyle = '#070305'; g.fill();
    g.strokeStyle = 'rgba(196,216,255,0.18)'; g.lineWidth = 1.2; g.stroke();
    g.save();
    g.fillStyle = 'rgba(242,193,78,0.72)';
    g.font = 'bold ' + Math.max(8, Math.round(15 * unit)) + 'px "STKaiti","KaiTi","Kaiti SC",serif';
    g.textAlign = 'center'; g.textBaseline = 'middle';
    g.fillText('新春', cx, baseY - hh + 12 * unit);
    g.restore();
    g.fillStyle = 'rgba(255,190,110,0.5)'; // 匾下灯挂钩
    g.fillRect(cx - ww * 0.30, baseY - hh - 3 * unit, 2, 5 * unit); g.fillRect(cx + ww * 0.30, baseY - hh - 3 * unit, 2, 5 * unit);
  }
  function bakeVillage(w, h, horizon, pad, cs, quality) { // 中景村落 + 宝塔 + 灯笼串定义
    const cw = w + pad * 2, L = makeCanvas(cw, h, cs), g = L.ctx;
    const unit = clamp(h / 1000, 0.55, 1.6), off = pad, rng = mulberry32(0x51f15e);
    const strings = [], lanterns = [], high = quality === 'high';
    const gx = off + w * 0.74, gy = horizon - h * 0.09; // 村落后方暖光
    const rg = g.createRadialGradient(gx, gy, 0, gx, gy, w * 0.46);
    rg.addColorStop(0, 'rgba(255,150,80,0.20)'); rg.addColorStop(0.35, 'rgba(235,95,60,0.10)');
    rg.addColorStop(1, 'rgba(200,60,40,0)');
    g.fillStyle = rg; g.fillRect(off, 0, w, h);
    if (high) drawPagoda(g, off + w * 0.19, horizon + unit * 2, unit * 0.42, 3); // 极远小塔
    drawPagoda(g, off + w * 0.775, horizon + unit * 4, unit, high ? 4 : 3); // 主宝塔
    const houses = high
      ? [[0.105, 1.15], [0.185, 0.95], [0.265, 1.25], [0.345, 0.88], [0.545, 0.92], [0.625, 1.12], [0.695, 0.85], [0.925, 1.0]]
      : [[0.13, 1.1], [0.30, 1.2], [0.58, 1.0], [0.68, 1.1], [0.92, 0.95]];
    for (let i = 0; i < houses.length; i++) drawHouse(g, off + w * houses[i][0], horizon + unit * 2 + (i % 3) * unit * 2.5, unit * houses[i][1]);
    drawGate(g, off + w * 0.455, horizon + unit * 2, unit);
    function addString(sx0, sy0, sx1, sy1, count, sag) { // 吊绳 + 沿绳灯笼
      const id = strings.length;
      strings.push({ x0: sx0, y0: sy0, x1: sx1, y1: sy1, sag: sag });
      const n = Math.max(3, Math.round(count * (high ? 1 : 0.6)));
      for (let i = 1; i <= n; i++) {
        const u = i / (n + 1);
        lanterns.push({ str: id, u: u, r: unit * (12 + rng() * 3.5), warm: rng() > 0.62, ph: rng() * TAU, sp: 1.1 + rng() * 1.2, sx: 0, sy: 0, sway: 0, flick: 1 });
      }
    }
    addString(off + w * 0.115, horizon - h * 0.205, off + w * 0.455, horizon - h * 0.245, 7, h * 0.032); // 左侧长串
    addString(off + w * 0.575, horizon - h * 0.255, off + w * 0.955, horizon - h * 0.175, 8, h * 0.035); // 右侧纵深串
    addString(off + w * 0.395, horizon - h * 0.135, off + w * 0.525, horizon - h * 0.150, 4, h * 0.018); // 门楼前短串
    return { layer: L, cssW: cw, cssH: h, strings: strings, lanterns: lanterns };
  }

  // ===== 5. Art.createScene =====
  function createScene(canvas, opts) {
    opts = opts || {};
    const mount = mountCanvas(canvas), ctx = mount.ctx;
    const quality = opts.quality === 'low' ? 'low' : 'high';
    const density = clamp(typeof opts.density === 'number' ? opts.density : 1, 0.2, 2.5);
    const normPhase = function (p) { return p === 'playing' || p === 'reveal' ? p : 'lobby'; };
    const cache = {};
    const S = {
      w: 0, h: 0, dpr: 1, quality: quality, density: density, portrait: false, horizon: 0,
      cache: cache, destroyed: false, started: false, raf: 0, last: 0, t: 0, camX: 0, camY: 0,
      phase: normPhase(opts.phase), energy: 0.5,
      energyTarget: opts.phase === 'reveal' ? 0.9 : opts.phase === 'playing' ? 0.62 : 0.45, energyLocked: false,
      env: { breath: 0.4, glow: 0.9, rays: 0.6, particle: 0.9, burst: 0.9 }, reduce: prefersReduce(),
      snow: [], snowCap: 0, snowCount: 0, embers: [], emberCap: 0, emberCount: 0,
      fw: [], fwCursor: 0, bursts: [], fwPalette: [], fwBuckets: [],
      celeQueue: [], nextAuto: 2.5, fgLanterns: [], areaF: 1
    };

    // ---- 尺寸与背景烘焙 ----
    function rebuild() {
      if (!ctx || S.destroyed) return;
      S.w = Math.max(2, mount.w); S.h = Math.max(2, mount.h); S.dpr = mount.dpr;
      const w = S.w, h = S.h, hz = S.horizon = Math.round(S.h * (S.h > S.w * 1.05 ? 0.57 : 0.605));
      S.portrait = S.h > S.w * 1.05;
      const cs = Math.min(S.dpr, S.quality === 'high' ? 1.5 : 1.1); // 背景超采样倍率
      cache.sky = bakeSky(w, h, cs, hz);
      cache.cloudA = bakeCloud(1337); cache.cloudB = bakeCloud(90210);
      cache.ridgeFar = bakeRidge(w, h, PAD, hz, cs, { seed: 11, amp: 0.085, base: 0.105, cTop: '#7b3548', cMid: '#4e1b28', cBot: '#2a0d16', rim: 'rgba(255,196,158,0.30)', fog: 'rgba(150,62,62,0.16)', fogEnd: 'rgba(172,76,70,0.26)' });
      cache.ridgeMid = bakeRidge(w, h, PAD, hz, cs, { seed: 29, amp: 0.090, base: 0.055, cTop: '#4a1a27', cMid: '#2a0d16', cBot: '#17070c', rim: 'rgba(255,180,140,0.22)', fog: 'rgba(120,46,50,0.14)', fogEnd: 'rgba(130,52,52,0.22)' });
      cache.ridgeNear = bakeRidge(w, h, PAD, hz, cs, { seed: 77, amp: 0.055, base: 0.012, cTop: '#240c14', cMid: '#15060a', cBot: '#0a0306', rim: 'rgba(230,170,140,0.16)', fog: 'rgba(90,35,40,0.10)', fogEnd: 'rgba(90,35,40,0.18)' });
      const vill = bakeVillage(w, h, hz, PAD, cs, S.quality);
      cache.village = vill.layer; cache.villageW = vill.cssW; cache.villageH = vill.cssH;
      cache.strings = vill.strings; cache.lanterns = vill.lanterns;
      cache.vignette = bakeVignette(w, h);
      cache.glowWarm = bakeGlow('#ff9a4d', 0.95); cache.glowCool = bakeGlow('#bcd4ff', 0.75);
      cache.glowWhite = bakeGlow('#fff6e6', 0.95);
      cache.shaft = bakeShaft();
      cache.lanternSprite = bakeLanternSprite(THEME.red); cache.lanternSpriteWarm = bakeLanternSprite('#e8622a');
      // 地面/地平线渐变（主 ctx 创建一次，逐帧复用，零分配）
      const gg = ctx.createLinearGradient(0, hz, 0, h);
      gg.addColorStop(0, '#3a1c26'); gg.addColorStop(0.12, '#26141f'); gg.addColorStop(0.42, '#181021');
      gg.addColorStop(0.75, '#0f0b18'); gg.addColorStop(1, '#08060e');
      const haz = ctx.createLinearGradient(0, hz - 72, 0, hz + 78);
      haz.addColorStop(0, 'rgba(255,140,90,0)'); haz.addColorStop(0.45, 'rgba(255,150,100,0.06)');
      haz.addColorStop(0.62, 'rgba(255,160,110,0.10)'); haz.addColorStop(1, 'rgba(255,150,100,0)');
      const mis = ctx.createLinearGradient(0, hz - 46, 0, hz + 26); // 地平线薄雾：柔化山脚与地面接缝
      mis.addColorStop(0, 'rgba(255,150,110,0)'); mis.addColorStop(0.5, 'rgba(255,156,112,0.22)'); mis.addColorStop(1, 'rgba(255,150,110,0)');
      cache.grad = { ground: gg, haze: haz, mist: mis };
      cache.ground = bakeGround(w, h, hz, PAD, cs);
      cache.cloudBands = [
        { img: cache.cloudA, y: h * 0.09, w: w * 0.74, h: h * 0.21, x0: -w * 0.2, sp: 4.6, a: 0.55 },
        { img: cache.cloudB, y: h * 0.19, w: w * 0.56, h: h * 0.17, x0: w * 0.4, sp: -3.2, a: 0.42 },
        { img: cache.cloudA, y: h * 0.30, w: w * 0.92, h: h * 0.23, x0: w * 0.1, sp: 2.1, a: 0.30 }
      ];
      const areaF = S.areaF = clamp(Math.sqrt((w * h) / (1600 * 900)), 0.45, 1.9);
      const srng = mulberry32(4242), starTwN = Math.round(42 * areaF * (S.quality === 'high' ? 1 : 0.5));
      cache.twinkles = []; // 闪烁星（天空动态微光）
      for (let i = 0; i < starTwN; i++) cache.twinkles.push({ x: srng() * w, y: srng() * hz * 0.86, r: 0.5 + srng() * 1.1, ph: srng() * TAU, sp: 1.2 + srng() * 2.4, big: srng() > 0.82 });
      const speckN = cache.speckCount = Math.round(70 * areaF * (S.quality === 'high' ? 1 : 0.5));
      cache.specks = []; // 地面雪粒闪光
      for (let i = 0; i < speckN; i++) {
        const yy = hz + Math.pow(Math.random(), 0.7) * (h - hz);
        cache.specks.push({ x: Math.random() * w, y: yy, s: 1 + ((yy - hz) / (h - hz)) * 2.2, p: Math.random() * TAU });
      }
      cache.pools = [ // 地面暖光池
        { x: w * 0.5, y: hz + (h - hz) * 0.20, rx: w * 0.34, ry: (h - hz) * 0.13, a: 0.10, ph: 0 },
        { x: w * 0.22, y: hz + (h - hz) * 0.44, rx: w * 0.22, ry: (h - hz) * 0.10, a: 0.075, ph: 1.7 },
        { x: w * 0.80, y: hz + (h - hz) * 0.38, rx: w * 0.20, ry: (h - hz) * 0.09, a: 0.075, ph: 3.1 }
      ];
      cache.pathPools = []; // 灯道：由近及远的暖光斑，强化地面透视纵深
      for (let i = 0; i < 7; i++) { const t = i / 6; cache.pathPools.push({ x: w * 0.5 + (i % 2 ? 1 : -1) * w * (0.012 + 0.055 * t), y: hz + (h - hz) * Math.pow(t, 1.7), rx: w * (0.012 + 0.055 * t), a: 0.14 + 0.12 * t }); }
      cache.shafts = [ // 体积光束（从月晕方向斜切）
        { x: w * 0.62, ang: 0.32, w: w * 0.20, len: h * 1.15, ph: 0 },
        { x: w * 0.74, ang: 0.22, w: w * 0.15, len: h * 1.05, ph: 2.1 },
        { x: w * 0.50, ang: 0.44, w: w * 0.12, len: h * 1.2, ph: 4.2 }
      ];
      S.fgLanterns = []; // 前景大灯笼：半出画，只做边缘景深框，避免遮挡页面 UI
      const fr = clamp(h * 0.055, 22, 60);
      if (S.portrait) S.fgLanterns.push({ x: w * 1.02, y: -h * 0.03, r: fr * 0.95, ph: 1.2, sp: 0.7 });
      else {
        S.fgLanterns.push({ x: -w * 0.012, y: -h * 0.055, r: fr, ph: 0.4, sp: 0.8 });
        if (S.quality === 'high' && w > 640) S.fgLanterns.push({ x: w * 1.012, y: -h * 0.04, r: fr * 0.92, ph: 2.1, sp: 0.62 });
      }
      // 粒子池（只分配一次，之后复用对象）
      const qm = S.quality === 'high' ? 1 : 0.5;
      S.snowCap = Math.max(24, Math.round(185 * areaF * qm * S.density));
      S.emberCap = Math.max(10, Math.round(85 * areaF * qm * S.density));
      S.snow = new Array(S.snowCap);
      for (let i = 0; i < S.snowCap; i++) { S.snow[i] = { x: 0, y: 0, z: 0, vy: 0, drift: 0, sp: 0, ph: 0, size: 0 }; initSnow(S.snow[i], w, h, true); }
      S.embers = new Array(S.emberCap);
      for (let i = 0; i < S.emberCap; i++) { S.embers[i] = { x: 0, y: 0, vx: 0, vy: 0, life: 0, max: 1, size: 1, ph: 0 }; resetEmber(S.embers[i], w, h, hz, true); }
      const fwCap = S.quality === 'high' ? 520 : 260;
      S.fw = new Array(fwCap);
      for (let i = 0; i < fwCap; i++) S.fw[i] = { active: false, x: 0, y: 0, vx: 0, vy: 0, life: 0, max: 1, grav: 0, size: 1, ci: 0, fl: 0 };
      S.bursts = [];
      for (let i = 0; i < 10; i++) S.bursts.push({ active: false, x: 0, y: 0, age: 0, life: 1, r0: 30, col: '#ffd76a' });
      S.fwCursor = 0; S.fwPalette = []; S.fwBuckets = [];
      for (let i = 0; i < FW_COLORS.length; i++) getColorIdx(FW_COLORS[i]);
      cache.snowLadder = makeLadder('#e6f0ff', 12);
      refreshCounts();
    }

    function initSnow(p, w, h, scatter) {
      p.z = 0.2 + Math.random() * 0.8; p.x = Math.random() * w;
      p.y = scatter ? Math.random() * h : -10; p.vy = 22 + p.z * 78;
      p.drift = -6 + Math.random() * 14; p.sp = 0.6 + Math.random() * 1.6;
      p.ph = Math.random() * TAU; p.size = 0.9 + p.z * 2.4;
    }
    function resetEmber(p, w, h, hz, scatter) {
      p.x = Math.random() * w;
      p.y = scatter ? hz - h * 0.05 + Math.random() * (h - hz) * 0.95 : h * 0.92 + Math.random() * h * 0.08;
      p.vx = -8 + Math.random() * 16; p.vy = -(8 + Math.random() * 26);
      p.max = p.life = 2.5 + Math.random() * 3.5;
      p.size = 0.8 + Math.random() * 1.8; p.ph = Math.random() * TAU;
    }
    function refreshCounts() { // 粒子数量 = 池容量 × 能量 × 阶段 × reduce-motion
      const mot = S.reduce ? 0.28 : 1, pm = S.env.particle;
      S.snowCount = Math.min(S.snowCap, Math.round(S.snowCap * (0.26 + 0.74 * S.energy) * pm * mot));
      S.emberCount = Math.min(S.emberCap, Math.round(S.emberCap * (0.16 + 0.84 * S.energy) * pm * mot));
    }
    function getColorIdx(hex) { // 烟花颜色注册（支持调用方自定义颜色）
      for (let i = 0; i < S.fwPalette.length; i++) if (S.fwPalette[i].hex === hex) return i;
      S.fwPalette.push({ hex: hex, ladder: makeLadder(hex, FW_STEPS) });
      for (let s = 0; s < FW_STEPS; s++) S.fwBuckets.push([]);
      return S.fwPalette.length - 1;
    }
    function takeFw() { // 轮转取空闲粒子
      const n = S.fw.length;
      for (let i = 0; i < n; i++) { S.fwCursor = (S.fwCursor + 1) % n; if (!S.fw[S.fwCursor].active) return S.fw[S.fwCursor]; }
      return S.fw[S.fwCursor];
    }
    function takeBurst() {
      for (let i = 0; i < S.bursts.length; i++) if (!S.bursts[i].active) return S.bursts[i];
      return null;
    }

    // ---- 时间步进：平滑过渡 + 粒子物理 ----
    function step(dt) {
      S.t += dt;
      const P = PHASE[S.phase], ek = Math.min(1, dt * 1.6);
      S.energy += (S.energyTarget - S.energy) * Math.min(1, dt * 2.4); // 能量平滑
      S.env.breath += (P.breath - S.env.breath) * ek; // 阶段氛围平滑，避免跳变
      S.env.glow += (P.glow - S.env.glow) * ek; S.env.rays += (P.rays - S.env.rays) * ek;
      S.env.particle += (P.particle - S.env.particle) * ek; S.env.burst += (P.burst - S.env.burst) * ek;
      S.reduce = prefersReduce();
      const mot = S.reduce ? 0.3 : 1;
      S.camX = (Math.sin(S.t * 0.055) * 7 + Math.sin(S.t * 0.021 + 1.7) * 4.5) * mot; // 镜头缓慢漂移
      S.camY = Math.sin(S.t * 0.043 + 0.6) * 2.6 * mot;
      refreshCounts();
      const w = S.w, h = S.h, hz = S.horizon;
      for (let i = 0; i < S.snowCount; i++) { // 飘雪：不同景深不同速度
        const p = S.snow[i];
        p.y += p.vy * dt * mot;
        p.x += (p.drift + Math.sin(S.t * p.sp + p.ph) * 13) * dt * mot;
        if (p.y > h + 10) { p.y = -10; p.x = Math.random() * w; }
        else if (p.x > w + 12) p.x = -12;
        else if (p.x < -12) p.x = w + 12;
      }
      for (let i = 0; i < S.emberCount; i++) { // 金色余烬
        const p = S.embers[i];
        p.life -= dt;
        if (p.life <= 0) { resetEmber(p, w, h, hz, false); continue; }
        p.x += (p.vx + Math.sin(S.t * 1.3 + p.ph) * 8) * dt * mot;
        p.y += p.vy * dt * mot;
      }
      const drag = Math.pow(0.72, dt);
      for (let i = 0; i < S.fw.length; i++) { // 烟花粒子
        const p = S.fw[i];
        if (!p.active) continue;
        p.life -= dt;
        if (p.life <= 0) { p.active = false; continue; }
        p.vx *= drag;
        p.vy = p.vy * drag + p.grav * dt;
        p.x += p.vx * dt;
        p.y += p.vy * dt;
      }
      for (let i = 0; i < S.bursts.length; i++) {
        const b = S.bursts[i];
        if (b.active && (b.age += dt) >= b.life) b.active = false;
      }
      if (!S.reduce && S.energy > 0.04) { // 间歇性自动烟花
        if (S.t >= S.nextAuto) {
          const gap = (lerp(P.fwMin, P.fwMax, Math.random()) / 1000) * (1.35 - 0.55 * S.energy);
          S.nextAuto = S.t + Math.max(0.4, gap);
          spawnBurst((0.13 + Math.random() * 0.74) * w, (0.07 + Math.random() * 0.30) * h, { power: P.fwPower * (0.6 + Math.random() * 0.8) });
        }
      } else if (S.reduce) S.nextAuto = S.t + 2;
      for (let i = S.celeQueue.length - 1; i >= 0; i--) { // celebrate 队列
        if (S.t >= S.celeQueue[i].at) {
          const e = S.celeQueue[i];
          S.celeQueue.splice(i, 1);
          spawnBurst(e.x, e.y, e.o);
        }
      }
      computeLanterns();
    }
    function computeLanterns() { // 灯笼屏幕坐标/摆动/闪烁（地面倒影也复用）
      const lans = cache.lanterns, strs = cache.strings;
      if (!lans || !strs) return;
      const shiftX = S.camX, shiftY = S.camY * 0.5, mot = S.reduce ? 0.35 : 1;
      for (let i = 0; i < lans.length; i++) {
        const l = lans[i], s = strs[l.str], u = l.u, iu = 1 - u;
        const x0 = s.x0 + shiftX, y0 = s.y0 + shiftY, x1 = s.x1 + shiftX, y1 = s.y1 + shiftY;
        const cx = (s.x0 + s.x1) * 0.5 + shiftX, cy = (s.y0 + s.y1) * 0.5 + s.sag + shiftY;
        l.sx = iu * iu * x0 + 2 * iu * u * cx + u * u * x1; // 二次贝塞尔
        l.sy = iu * iu * y0 + 2 * iu * u * cy + u * u * y1;
        l.sway = Math.sin(S.t * l.sp + l.ph) * (0.042 + 0.03 * S.env.breath) * mot;
        l.flick = 0.82 + 0.18 * Math.sin(S.t * (1.6 + l.ph * 0.35) + l.ph);
      }
    }
    function spawnBurst(x, y, o) { // 烟花爆发（x,y 为 CSS 像素）
      if (!cache.glowWhite || S.destroyed) return;
      o = o || {};
      x = clamp(x, 0, S.w); y = clamp(y, 0, S.h);
      const power = clamp(o.power == null ? 1 : o.power, 0.3, 2.4);
      const cols = o.colors && o.colors.length ? o.colors : FW_COLORS;
      const idxs = new Array(cols.length);
      for (let i = 0; i < cols.length; i++) idxs[i] = getColorIdx(cols[i]);
      let count = Math.round((o.count != null ? o.count : S.quality === 'high' ? 80 : 38) * (0.45 + 0.9 * S.energy) * (0.7 + 0.6 * S.env.burst) * (S.reduce ? 0.4 : 1));
      count = Math.min(count, 240);
      const b = takeBurst();
      if (b) { b.active = true; b.x = x; b.y = y; b.age = 0; b.life = 0.95; b.r0 = 20 * power + 12; b.col = typeof cols[0] === 'string' ? cols[0] : '#ffd76a'; }
      for (let i = 0; i < count; i++) {
        const p = takeFw();
        if (!p) break;
        const ang = Math.random() * TAU, spd = (50 + Math.random() * 330) * power * (S.quality === 'high' ? 1 : 0.82);
        p.active = true; p.x = x; p.y = y;
        p.vx = Math.cos(ang) * spd; p.vy = Math.sin(ang) * spd - 22;
        p.grav = 66 + Math.random() * 40;
        p.max = p.life = 0.85 + Math.random() * 1.0;
        p.size = 1.2 + Math.random() * 2.3;
        p.ci = idxs[(Math.random() * idxs.length) | 0];
        p.fl = Math.random() * TAU;
      }
    }

    // ---- 逐层绘制 ----
    function drawLayer(img, dx, dy) { ctx.drawImage(img.cv, dx - PAD, dy, img.w, img.h); }
    function drawTwinkles() {
      const tw = cache.twinkles, g = ctx;
      if (!tw || !tw.length) return;
      g.globalCompositeOperation = 'lighter';
      for (let i = 0; i < tw.length; i++) {
        const s = tw[i];
        g.globalAlpha = 0.22 + 0.72 * (0.5 + 0.5 * Math.sin(S.t * s.sp + s.ph));
        g.fillStyle = s.big ? '#fff6e0' : '#dce9ff';
        g.beginPath(); g.arc(s.x, s.y, s.r, 0, TAU); g.fill();
        if (s.big) { g.fillRect(s.x - s.r * 3.2, s.y - 0.4, s.r * 6.4, 0.8); g.fillRect(s.x - 0.4, s.y - s.r * 3.2, 0.8, s.r * 6.4); }
      }
      g.globalAlpha = 1; g.globalCompositeOperation = 'source-over';
    }
    function drawClouds() {
      const bands = cache.cloudBands, g = ctx, w = S.w, mot = S.reduce ? 0.25 : 1;
      if (!bands) return;
      for (let i = 0; i < bands.length; i++) {        const b = bands[i], total = w + b.w;
        let x = (((b.x0 + S.t * b.sp * mot) % total) + total) % total - b.w;
        x += S.camX * 0.15;
        g.globalAlpha = b.a * (0.85 + 0.15 * Math.sin(S.t * 0.2 + i * 1.7));
        g.drawImage(b.img, x, b.y, b.w, b.h);
      }
      g.globalAlpha = 1;
    }
    function drawGround(camX) { // 透视地面：近大远小网格 + 光池 + 积雪反光
      const w = S.w, h = S.h, hz = S.horizon, g = ctx;
      g.fillStyle = cache.grad.ground;
      g.fillRect(0, hz, w, h - hz);
      g.globalCompositeOperation = 'lighter'; // 月光滑过雪地
      g.globalAlpha = 0.12 + 0.06 * S.env.glow;
      g.drawImage(cache.glowCool, w * 0.5 - w * 0.4, hz - (h - hz) * 1.15 * 0.32, w * 0.8, (h - hz) * 1.15);
      g.globalAlpha = 1; g.globalCompositeOperation = 'source-over';
      g.drawImage(cache.ground.cv, camX * 0.55 - PAD, 0, cache.ground.w, cache.ground.h); // 地砖层（视差）
      g.fillStyle = cache.grad.haze; g.fillRect(0, hz - 72, w, 150); // 地平线暖雾：压住远端网格形成空气透视
      g.fillStyle = cache.grad.mist; g.fillRect(0, hz - 46, w, 72); // 地平线薄雾：柔化山脚/地面接缝
      const sp = cache.specks; // 雪面闪光
      g.fillStyle = '#d8e6ff';
      for (let i = 0; i < cache.speckCount; i++) {
        const s = sp[i];
        g.globalAlpha = 0.07 + 0.2 * (0.5 + 0.5 * Math.sin(S.t * 1.7 + s.p));
        g.fillRect(s.x + camX * 0.55, s.y, s.s, s.s);
      }
      g.globalAlpha = 1;
      g.globalCompositeOperation = 'lighter'; // 暖光池
      const pools = cache.pools;
      for (let i = 0; i < pools.length; i++) {
        const p = pools[i];
        g.globalAlpha = clamp(p.a * (0.7 + 0.3 * Math.sin(S.t * 1.1 + p.ph)) * (0.7 + 0.5 * S.env.glow), 0, 0.5);
        g.drawImage(cache.glowWarm, p.x - p.rx + camX * 0.55, p.y - p.ry, p.rx * 2, p.ry * 2);
      }
      for (let i = 0; i < cache.pathPools.length; i++) { // 灯道光斑（透视纵深）
        const p = cache.pathPools[i];
        g.globalAlpha = clamp(p.a * (0.8 + 0.2 * Math.sin(S.t * 1.3 + i)) * (0.6 + 0.6 * S.env.glow), 0, 0.55);
        g.drawImage(cache.glowWarm, p.x - p.rx + camX * 0.55, p.y - p.rx * 0.45, p.rx * 2, p.rx * 0.9);
      }
      const lans = cache.lanterns; // 灯笼地面倒影
      if (lans) {
        const n = Math.min(lans.length, 9);
        for (let i = 0; i < n; i++) {
          const l = lans[i];
          if (!l.sx) continue;
          const dx = l.sx + camX * 0.4, dy = hz + (hz - l.sy) * 0.42, rx = l.r * 3.4, ry = l.r * 8.5;
          g.globalAlpha = clamp((0.07 + 0.09 * S.env.glow) * l.flick, 0, 0.24);
          g.drawImage(cache.glowWarm, dx - rx, dy - ry * 0.5, rx * 2, ry);
        }
      }
      g.globalAlpha = 1; g.globalCompositeOperation = 'source-over';
    }
    function drawVillage() { // 中景剪影 + 吊绳 + 灯笼（光晕加法 + 绕吊点摆动）
      const w = S.w, hz = S.horizon, g = ctx, sx = S.camX, sy = S.camY * 0.5;
      g.globalCompositeOperation = 'lighter';
      g.globalAlpha = clamp(0.20 + 0.16 * S.env.glow, 0, 0.6);
      g.drawImage(cache.glowWarm, w * 0.12, hz - w * 0.36, w, w * 0.7);
      g.globalAlpha = 1; g.globalCompositeOperation = 'source-over';
      g.drawImage(cache.village.cv, sx - PAD, sy, cache.villageW, cache.villageH);
      const strs = cache.strings;
      g.strokeStyle = 'rgba(8,3,5,0.9)'; g.lineWidth = 1.5;
      for (let i = 0; i < strs.length; i++) {
        const s = strs[i];
        g.beginPath(); g.moveTo(s.x0 + sx, s.y0 + sy);
        g.quadraticCurveTo((s.x0 + s.x1) * 0.5 + sx, (s.y0 + s.y1) * 0.5 + s.sag + sy, s.x1 + sx, s.y1 + sy);
        g.stroke();
      }
      const lans = cache.lanterns;
      g.globalCompositeOperation = 'lighter';
      for (let i = 0; i < lans.length; i++) {
        const l = lans[i], halo = l.r * (3.4 + 1.6 * S.env.breath);
        g.globalAlpha = clamp((0.13 + 0.17 * S.env.breath + 0.08 * S.energy) * l.flick, 0, 0.8);
        g.drawImage(cache.glowWarm, l.sx - halo, l.sy + l.r * 0.45 - halo, halo * 2, halo * 2);
      }
      g.globalAlpha = 1; g.globalCompositeOperation = 'source-over';
      const sprites = [cache.lanternSprite, cache.lanternSpriteWarm];
      for (let i = 0; i < lans.length; i++) {
        const l = lans[i], dw = l.r * 2.5, dh = l.r * 3.3;
        g.save();
        g.translate(l.sx, l.sy); g.rotate(l.sway);
        g.drawImage(sprites[l.warm ? 1 : 0], -dw / 2, -dh * 0.05, dw, dh);
        g.restore();
      }
    }
    function drawFireworks() { // 闪光/冲击环 + 按「颜色×透明度」分桶批量绘制拖尾粒子
      const g = ctx;
      g.globalCompositeOperation = 'lighter';
      for (let i = 0; i < S.bursts.length; i++) {
        const b = S.bursts[i];
        if (!b.active) continue;
        const k = clamp(b.age / b.life, 0, 1), fade = (1 - k) * (1 - k), gr = b.r0 * (1.7 + 1.5 * k);
        g.globalAlpha = clamp(fade * 0.5, 0, 0.5);
        g.drawImage(cache.glowWhite, b.x - gr, b.y - gr, gr * 2, gr * 2);
      }
      const buckets = S.fwBuckets;
      for (let i = 0; i < buckets.length; i++) buckets[i].length = 0;
      for (let i = 0; i < S.fw.length; i++) {
        const p = S.fw[i];
        if (!p.active) continue;
        const st = Math.min(FW_STEPS - 1, Math.max(0, ((p.life / p.max) * (FW_STEPS - 1)) | 0));
        buckets[p.ci * FW_STEPS + st].push(p);
      }
      g.lineCap = 'round';
      for (let ci = 0; ci < S.fwPalette.length; ci++) {
        const ladder = S.fwPalette[ci].ladder, base = ci * FW_STEPS;
        for (let st = 0; st < FW_STEPS; st++) {
          const list = buckets[base + st];
          if (!list || !list.length) continue;
          g.strokeStyle = ladder[st];
          g.lineWidth = 1 + st * 0.18;
          g.beginPath();
          for (let k = 0; k < list.length; k++) {
            const p = list[k];
            g.moveTo(p.x - p.vx * 0.045, p.y - p.vy * 0.045); // 拖尾：沿速度反方向拉一小段
            g.lineTo(p.x, p.y);
          }
          g.stroke();
        }
      }
      g.globalAlpha = 1; g.globalCompositeOperation = 'source-over';
    }
    function drawSnow() { // 飘雪：近景拉成短斜线，远景为小点
      const n = S.snowCount;
      if (!n) return;
      const g = ctx, lad = cache.snowLadder, maxI = lad.length - 1;
      for (let i = 0; i < n; i++) {
        const p = S.snow[i], ai = Math.min(maxI, (p.z * maxI) | 0);
        g.globalAlpha = 0.18 + p.z * 0.55;
        g.fillStyle = lad[ai];
        if (p.z > 0.66) {
          g.beginPath(); g.ellipse(p.x, p.y, p.size * 0.62, p.size * 1.05, 0, 0, TAU); g.fill();
          g.fillRect(p.x - p.size * 0.3, p.y - p.size * 2.6 * 0.55, p.size * 0.6, p.size * 1.3);
        } else g.fillRect(p.x, p.y, p.size, p.size);
      }
      g.globalAlpha = 1;
    }
    function drawEmbers() { // 空气中漂浮的金色余烬
      const n = S.emberCount;
      if (!n) return;
      const g = ctx;
      g.globalCompositeOperation = 'lighter';
      for (let i = 0; i < n; i++) {
        const p = S.embers[i];
        const a = Math.pow(clamp(p.life / p.max, 0, 1), 0.7) * (0.55 + 0.45 * Math.sin(S.t * 2.2 + p.ph));
        if (a <= 0.02) continue;
        g.globalAlpha = clamp(a * 0.75, 0, 0.85); g.fillStyle = '#ffcf7a';
        g.beginPath(); g.arc(p.x, p.y, p.size, 0, TAU); g.fill();
      }
      g.globalAlpha = 1; g.globalCompositeOperation = 'source-over';
    }
    function drawForeground() { // 前景大灯笼：体积感 + 沉浸边框
      const fgs = S.fgLanterns;
      if (!fgs || !fgs.length) return;
      const g = ctx, mot = S.reduce ? 0.3 : 1;
      for (let i = 0; i < fgs.length; i++) {
        const f = fgs[i], sway = Math.sin(S.t * f.sp + f.ph) * 0.035 * mot, x = f.x, y = f.y;
        g.strokeStyle = 'rgba(10,4,6,0.92)'; g.lineWidth = 3;
        g.beginPath(); g.moveTo(x, 0); g.quadraticCurveTo(x + Math.sin(sway) * 6, y * 0.5, x + Math.sin(sway) * 22, y); g.stroke();
        g.globalCompositeOperation = 'lighter';
        g.globalAlpha = clamp(0.16 + 0.16 * S.env.glow, 0, 0.7);
        const halo = f.r * 5.6;
        g.drawImage(cache.glowWarm, x - halo, y - halo + f.r * 0.7, halo * 2, halo * 2);
        g.globalAlpha = 1; g.globalCompositeOperation = 'source-over';
        const dw = f.r * 2.3, dh = f.r * 3.05;
        g.save(); g.translate(x, y); g.rotate(sway);
        g.drawImage(cache.lanternSprite, -dw / 2, -dh * 0.05, dw, dh);
        g.restore();
      }
    }
    function drawGodRays() { // 体积光斜束
      const shafts = cache.shafts, g = ctx;
      g.globalCompositeOperation = 'lighter';
      for (let i = 0; i < shafts.length; i++) {
        const s = shafts[i];
        g.globalAlpha = clamp((0.04 + 0.05 * S.env.rays) * (0.55 + 0.45 * Math.sin(S.t * 0.35 + s.ph)), 0, 0.28);
        g.save(); g.translate(s.x + S.camX * 0.2, -S.h * 0.04); g.rotate(s.ang);
        g.drawImage(cache.shaft, -s.w / 2, 0, s.w, s.len);
        g.restore();
      }
      g.globalAlpha = 1; g.globalCompositeOperation = 'source-over';
    }
    function draw() { // 整帧：远→近 9 层
      if (!cache.sky || S.destroyed) return;
      const g = ctx, w = S.w, h = S.h, hz = S.horizon;
      g.setTransform(S.dpr, 0, 0, S.dpr, 0, 0);
      g.globalAlpha = 1; g.globalCompositeOperation = 'source-over';
      g.drawImage(cache.sky.cv, 0, 0, w, h); // 1) 夜空 + 月晕 + 星
      drawTwinkles();
      drawClouds();
      drawLayer(cache.ridgeFar, S.camX * 0.26, S.camY * 0.10); // 2) 多层远山视差
      drawLayer(cache.ridgeMid, S.camX * 0.48, S.camY * 0.20);
      drawLayer(cache.ridgeNear, S.camX * 0.70, S.camY * 0.30);
      g.fillStyle = cache.grad.haze; g.fillRect(0, hz - 72, w, 150); // 3) 地平线雾
      drawGround(S.camX); // 4) 透视地面
      drawVillage(); // 5) 村落 + 灯笼
      drawFireworks(); // 6) 烟花
      drawSnow(); drawEmbers(); // 7) 飘雪 + 余烬
      drawForeground(); // 8) 前景灯笼
      drawGodRays(); // 9) 体积光 + 暗角
      g.drawImage(cache.vignette.cv, 0, 0, w, h);
      g.globalAlpha = 1; g.globalCompositeOperation = 'source-over';
    }

    // ---- rAF 循环 / 可见性 / 尺寸变化 ----
    function frame(now) {
      S.raf = 0;
      if (!S.started) return;
      let dt = (now - S.last) / 1000;
      if (!(dt > 0) || dt > 0.06) dt = 1 / 60;
      S.last = now;
      step(dt);
      draw();
      if (S.started && !S.destroyed) S.raf = global.requestAnimationFrame(frame);
    }
    function kick() {
      if (S.raf || S.destroyed) return;
      S.last = global.performance ? global.performance.now() : Date.now();
      S.raf = global.requestAnimationFrame(frame);
    }
    function onVisibility() { // 隐藏标签页暂停 rAF，可见时恢复
      if (S.destroyed) return;
      if (global.document && global.document.hidden) {
        if (S.raf) { global.cancelAnimationFrame(S.raf); S.raf = 0; }
      } else if (S.started) kick();
    }
    function renderOnce() { if (cache.sky && !S.destroyed) draw(); }

    let offResize = mount.onResize(function () { // 只重建一次，不叠加监听
      if (S.destroyed) return;
      if (mount.w === S.w && mount.h === S.h && mount.dpr === S.dpr && cache.sky) { renderOnce(); return; }
      rebuild();
      renderOnce();
    });
    if (global.document) global.document.addEventListener('visibilitychange', onVisibility);
    rebuild();
    renderOnce(); // 首帧同步绘制：调用方忘记 start() 也不会白屏

    // ---- 对外 API（签名冻结） ----
    return {
      start: function () {
        if (S.destroyed) return;
        S.started = true;
        if (global.document && global.document.hidden) return; // 隐藏中先不跑，可见时自动恢复
        kick();
      },
      stop: function () {
        S.started = false;
        if (S.raf) { global.cancelAnimationFrame(S.raf); S.raf = 0; }
      },
      resize: function () { if (!S.destroyed) mount._sync(); }, // 幂等：内部触发重建/重绘
      destroy: function () {
        if (S.destroyed) return;
        S.destroyed = true;
        S.started = false;
        if (S.raf) { global.cancelAnimationFrame(S.raf); S.raf = 0; }
        if (global.document) global.document.removeEventListener('visibilitychange', onVisibility);
        if (offResize) offResize();
        offResize = null;
        mount._dispose();
        cache.sky = null;
      },
      setPhase: function (p) { // 阶段切换：氛围参数在 step 内平滑逼近，不跳变
        if (S.destroyed) return;
        const np = normPhase(p);
        if (np === S.phase) return;
        S.phase = np;
        if (!S.energyLocked) S.energyTarget = np === 'reveal' ? 0.9 : np === 'playing' ? 0.62 : 0.45;
        S.nextAuto = Math.min(S.nextAuto, S.t + 0.5);
        if (!S.started) renderOnce();
      },
      setEnergy: function (v) {
        if (S.destroyed || typeof v !== 'number' || !isFinite(v)) return;
        S.energyLocked = true;
        S.energyTarget = clamp(v, 0, 1);
        if (!S.started) renderOnce();
      },
      burst: function (x, y, o) {
        if (S.destroyed) return;
        spawnBurst(typeof x === 'number' && isFinite(x) ? x : S.w * 0.5, typeof y === 'number' && isFinite(y) ? y : S.h * 0.28, o);
        if (!S.started) renderOnce();
      },
      celebrate: function (n) { // 随机位置连放 n 朵（错峰排队）
        if (S.destroyed) return;
        const count = clamp(Math.round(typeof n === 'number' ? n : 4) || 4, 1, 24);
        let delay = 0.05;
        for (let i = 0; i < count; i++) {
          S.celeQueue.push({
            at: S.t + delay,
            x: (0.12 + Math.random() * 0.76) * S.w,
            y: (0.08 + Math.random() * 0.34) * S.h,
            o: { power: 0.9 + Math.random() * 0.8, count: S.quality === 'high' ? 70 : 34 }
          });
          delay += 0.1 + Math.random() * 0.28;
        }
        if (!S.started) renderOnce();
      }
    };
  }

  // ===== 6. Art.lanternIcon：把灯笼图标画进调用方的 canvas =====
  function lanternIcon(canvas, opts) {
    opts = opts || {};
    if (!canvas || typeof canvas.getContext !== 'function') return;
    const dpr = Math.min(2, global.devicePixelRatio || 1);
    const cw = canvas.clientWidth || canvas.width || 64, ch = canvas.clientHeight || canvas.height || 64;
    let pw = canvas.width, ph = canvas.height;
    if (!(pw > 1) || !(ph > 1)) {
      pw = canvas.width = Math.max(1, Math.round(cw * dpr));
      ph = canvas.height = Math.max(1, Math.round(ch * dpr));
    }
    const g = canvas.getContext('2d');
    if (!g) return;
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.clearRect(0, 0, pw, ph);
    const scale = Math.min(pw / LANT_W, ph / LANT_H) * 0.94;
    g.save(); g.translate((pw - LANT_W * scale) / 2, (ph - LANT_H * scale) / 2); g.scale(scale, scale);
    paintLantern(g, opts.color || THEME.red, opts.glow !== false);
    g.restore();
  }

  // ===== 7. 导出 =====
  const Art = { THEME: THEME, mountCanvas: mountCanvas, createScene: createScene, lanternIcon: lanternIcon };
  global.Art = Art;
  if (typeof module !== 'undefined' && module.exports) module.exports = Art;
})(typeof window !== 'undefined' ? window : this);
