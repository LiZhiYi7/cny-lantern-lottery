"use strict";

/**
 * 新春年会抽奖系统 · 主服务器
 * 主机运行此文件即成为局域网主服务器：大屏 / 手机端 / 后台 三端同源。
 *
 *   node server.js                # 默认 8080
 *   PORT=9000 node server.js      # 指定端口
 *   DATA_DIR=./data node server.js
 */

const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const { AppError, lanIps, csvCell } = require("./lib/util");
const { Store } = require("./lib/store");
const { Hub } = require("./lib/hub");
const { Room, publicPlayer } = require("./lib/room");

let QRCode = null;
try {
  QRCode = require("qrcode");
} catch (e) {
  console.warn("[server] 未找到 qrcode 依赖，二维码接口不可用（执行 npm install 可恢复）");
}

const PORT = Number(process.env.PORT || 8080);
const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(__dirname, "data"));
const PUBLIC_DIR = path.join(__dirname, "public");
const ADMIN_TTL = 12 * 60 * 60 * 1000;
const BODY_LIMIT = 128 * 1024;

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".txt": "text/plain; charset=utf-8",
  ".md": "text/markdown; charset=utf-8"
};

const store = new Store(DATA_DIR);
const hub = new Hub();
let server = null;

function urls() {
  const ip = process.env.HOST_IP || lanIps()[0] || "127.0.0.1";
  const port = server && server.address() ? server.address().port : PORT;
  return { joinUrl: "http://" + ip + ":" + port + "/play", hostUrl: "http://" + ip + ":" + port + "/" };
}

const room = new Room({ store, hub, urls });

const adminTokens = new Map(); // token -> expiresAt
const pinFailures = new Map(); // ip -> {count, until}
const qrCache = new Map();

/* ---------------------------------------------------------------- 工具 */

function sendJson(res, status, body, headers) {
  const text = JSON.stringify(body);
  const h = Object.assign(
    {
      "Content-Type": "application/json; charset=utf-8",
      "Content-Length": Buffer.byteLength(text),
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff"
    },
    headers || {}
  );
  res.writeHead(status, h);
  res.end(text);
}

function sendText(res, status, text, headers) {
  const buf = Buffer.from(text, "utf8");
  const h = Object.assign(
    {
      "Content-Type": "text/plain; charset=utf-8",
      "Content-Length": buf.length,
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff"
    },
    headers || {}
  );
  res.writeHead(status, h);
  res.end(buf);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    let tooLarge = false;
    const chunks = [];
    req.on("data", (chunk) => {
      if (tooLarge) return; // 继续 drain，保证能把 413 正常写回客户端
      size += chunk.length;
      if (size > BODY_LIMIT) {
        tooLarge = true;
        chunks.length = 0;
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (tooLarge) return reject(new AppError("BODY_TOO_LARGE", "请求数据过大", 413));
      const text = Buffer.concat(chunks).toString("utf8").trim();
      if (!text) return resolve({});
      try {
        const data = JSON.parse(text);
        if (!data || typeof data !== "object" || Array.isArray(data)) {
          return reject(new AppError("BAD_JSON", "请求格式错误"));
        }
        resolve(data);
      } catch (e) {
        reject(new AppError("BAD_JSON", "请求格式错误"));
      }
    });
    req.on("error", reject);
  });
}

function parseCookies(req) {
  const out = {};
  const raw = req.headers.cookie || "";
  raw.split(";").forEach((pair) => {
    const idx = pair.indexOf("=");
    if (idx < 0) return;
    const k = pair.slice(0, idx).trim();
    const v = pair.slice(idx + 1).trim();
    if (k) out[k] = decodeURIComponent(v);
  });
  return out;
}

function isAdmin(req) {
  const token = parseCookies(req).adm;
  if (!token) return false;
  const exp = adminTokens.get(token);
  if (!exp) return false;
  if (exp < Date.now()) {
    adminTokens.delete(token);
    return false;
  }
  return true;
}

function clientIp(req) {
  return req.socket.remoteAddress || "unknown";
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => {
    return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
  });
}

/* ---------------------------------------------------------------- SSE */

function handleStream(req, res, url) {
  const q = url.searchParams;
  const role = String(q.get("role") || "host");
  if (["host", "player", "admin"].indexOf(role) < 0) {
    return sendJson(res, 400, { ok: false, error: "role 参数不合法", code: "BAD_INPUT" });
  }
  if (role === "admin" && !isAdmin(req)) {
    return sendJson(res, 401, { ok: false, error: "请先登录后台", code: "UNAUTHORIZED" });
  }
  const cid = String(q.get("cid") || "").slice(0, 80);
  if (!cid) return sendJson(res, 400, { ok: false, error: "缺少 cid", code: "BAD_INPUT" });

  let player = null;
  if (role === "player") {
    const pid = String(q.get("pid") || "");
    const token = String(q.get("token") || "");
    if (pid && token) player = room.attachPlayer(cid, pid, token);
  }

  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    "X-Accel-Buffering": "no",
    Connection: "keep-alive",
    "X-Content-Type-Options": "nosniff"
  });
  if (res.flushHeaders) res.flushHeaders();
  res.write(": connected\n\n");

  hub.add(cid, role, res, { pid: player ? player.pid : null });
  hub.send(cid, {
    t: "hello",
    serverTime: Date.now(),
    role,
    session: room.snapshot(),
    you: player ? publicPlayer(player) : null
  }, role);
  // 游戏中重连：补发开赛配置（含 seed），保证刷新后灯阵序列一致
  if (room.phase === "playing" && room.game) {
    hub.send(cid, { t: "game", game: room.game }, role);
  }

  req.on("close", () => hub.remove(cid, role, res));
}

/* ---------------------------------------------------------------- 静态资源 */

function resolveStatic(pathname) {
  let rel = pathname;
  if (rel === "/") rel = "/index.html";
  else if (rel === "/play" || rel === "/play/") rel = "/play.html";
  else if (rel === "/admin" || rel === "/admin/") rel = "/admin.html";
  if (rel.endsWith("/")) return null;
  const abs = path.resolve(PUBLIC_DIR, "." + rel);
  if (abs !== PUBLIC_DIR && !abs.startsWith(PUBLIC_DIR + path.sep)) return null;
  return abs;
}

function notFoundPage() {
  return (
    "<!doctype html><html lang=\"zh-CN\"><head><meta charset=\"utf-8\"><title>404 · 新春抽奖</title>" +
    "<meta name=\"viewport\" content=\"width=device-width,initial-scale=1\">" +
    "<style>body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;" +
    "background:radial-gradient(120% 90% at 50% 0%,#4a0d12,#130708);color:#fbeedd;" +
    "font-family:'PingFang SC','Microsoft YaHei',sans-serif;text-align:center}" +
    "h1{font-size:72px;margin:0;color:#e9b949;font-family:KaiTi,serif}a{color:#f2c14e}</style></head>" +
    "<body><div><h1>404</h1><p>这里没有灯笼，去大屏看看吧</p>" +
    "<p><a href=\"/\">大屏</a> · <a href=\"/play\">手机端</a> · <a href=\"/admin\">后台</a></p></div></body></html>"
  );
}

function serveStatic(req, res, pathname) {
  if (pathname === "/favicon.ico") {
    res.writeHead(204);
    return res.end();
  }
  const abs = resolveStatic(pathname);
  if (!abs) return sendHtml(res, 404, notFoundPage());
  fs.readFile(abs, (err, buf) => {
    if (err) {
      if (err.code === "ENOENT" || err.code === "EISDIR") return sendHtml(res, 404, notFoundPage());
      return sendHtml(res, 500, notFoundPage());
    }
    const ext = path.extname(abs).toLowerCase();
    const type = MIME[ext] || "application/octet-stream";
    res.writeHead(200, {
      "Content-Type": type,
      "Content-Length": buf.length,
      "Cache-Control": "no-cache",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
      "Content-Security-Policy":
        "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; " +
        "script-src 'self' 'unsafe-inline'; connect-src 'self'; font-src 'self' data:; " +
        "media-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'self'"
    });
    res.end(buf);
  });
}

function sendHtml(res, status, html) {
  res.writeHead(status, {
    "Content-Type": "text/html; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff"
  });
  res.end(html);
}

/* ---------------------------------------------------------------- API */

async function handleApi(req, res, url) {
  const pathname = url.pathname;
  const method = req.method || "GET";

  /* ---- 公共 ---- */
  if (pathname === "/api/health" && method === "GET") {
    return sendJson(res, 200, {
      ok: true,
      phase: room.phase,
      players: room.players.size,
      uptime: Math.round(process.uptime()),
      version: "1.0.0"
    });
  }

  if (pathname === "/api/state" && method === "GET") {
    const cid = String(url.searchParams.get("cid") || "");
    const p = room.findByCid(cid);
    return sendJson(res, 200, {
      ok: true,
      session: room.snapshot(),
      you: p ? publicPlayer(p) : null
    });
  }

  if (pathname === "/api/stream" && method === "GET") {
    return handleStream(req, res, url);
  }

  if (pathname === "/api/join" && method === "POST") {
    const body = await readBody(req);
    const player = room.join(body);
    return sendJson(res, 200, {
      ok: true,
      player: Object.assign(publicPlayer(player), { token: player.token }),
      session: room.snapshot()
    });
  }

  if (pathname === "/api/rejoin" && method === "POST") {
    const body = await readBody(req);
    const player = room.rejoin(body);
    return sendJson(res, 200, {
      ok: true,
      player: Object.assign(publicPlayer(player), { token: player.token }),
      session: room.snapshot(),
      game: room.phase === "playing" ? room.game : null
    });
  }

  if (pathname === "/api/ready" && method === "POST") {
    const body = await readBody(req);
    const player = room.setReady(body);
    return sendJson(res, 200, { ok: true, player: publicPlayer(player) });
  }

  if (pathname === "/api/game/result" && method === "POST") {
    const body = await readBody(req);
    const out = room.submitResult(body);
    return sendJson(res, 200, Object.assign({ ok: true }, out));
  }

  if (pathname === "/api/qr.svg" && method === "GET") {
    if (!QRCode) {
      return sendJson(res, 503, { ok: false, error: "二维码依赖未安装", code: "QR_UNAVAILABLE" });
    }
    const text = String(url.searchParams.get("text") || "").slice(0, 400);
    if (!text) return sendJson(res, 400, { ok: false, error: "缺少 text 参数", code: "BAD_INPUT" });
    let svg = qrCache.get(text);
    if (!svg) {
      svg = await QRCode.toString(text, {
        type: "svg",
        margin: 1,
        width: 320,
        errorCorrectionLevel: "M",
        color: { dark: "#1a0506", light: "#fff6e6" }
      });
      qrCache.set(text, svg);
      if (qrCache.size > 60) qrCache.delete(qrCache.keys().next().value);
    }
    res.writeHead(200, {
      "Content-Type": "image/svg+xml; charset=utf-8",
      "Content-Length": Buffer.byteLength(svg),
      "Cache-Control": "public, max-age=3600",
      "X-Content-Type-Options": "nosniff"
    });
    return res.end(svg);
  }

  /* ---- 后台 ---- */
  if (pathname === "/api/admin/login" && method === "POST") {
    const ip = clientIp(req);
    const fail = pinFailures.get(ip);
    if (fail && fail.until > Date.now()) {
      throw new AppError("TOO_MANY_ATTEMPTS", "尝试次数过多，请 30 秒后再试", 429);
    }
    const body = await readBody(req);
    const pin = String(body.pin || "");
    if (pin !== store.config.pin) {
      const cur = pinFailures.get(ip) || { count: 0, until: 0 };
      cur.count += 1;
      if (cur.count >= 8) {
        cur.until = Date.now() + 30000;
        cur.count = 0;
      }
      pinFailures.set(ip, cur);
      throw new AppError("BAD_PIN", "后台密码不正确", 401);
    }
    pinFailures.delete(ip);
    const token = crypto.randomBytes(18).toString("hex");
    adminTokens.set(token, Date.now() + ADMIN_TTL);
    return sendJson(
      res,
      200,
      { ok: true },
      {
        "Set-Cookie":
          "adm=" + token + "; Path=/; HttpOnly; SameSite=Lax; Max-Age=" + Math.floor(ADMIN_TTL / 1000)
      }
    );
  }

  if (pathname === "/api/admin/logout" && method === "POST") {
    const token = parseCookies(req).adm;
    if (token) adminTokens.delete(token);
    return sendJson(res, 200, { ok: true }, { "Set-Cookie": "adm=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0" });
  }

  if (pathname === "/api/admin/data" && method === "GET") {
    if (!isAdmin(req)) throw new AppError("UNAUTHORIZED", "请先登录后台", 401);
    const ips = lanIps();
    return sendJson(res, 200, {
      ok: true,
      ...room.adminData(),
      serverInfo: { ips, port: server.address() ? server.address().port : PORT, urls: urls() },
      lastError: store.lastError
    });
  }

  if (pathname === "/api/admin/action" && method === "POST") {
    if (!isAdmin(req)) throw new AppError("UNAUTHORIZED", "登录已失效，请重新登录", 401);
    const body = await readBody(req);
    const type = String(body.type || "");
    switch (type) {
      case "config.set":
        room.setConfig(body);
        break;
      case "prize.add":
        room.addPrize(body);
        break;
      case "prize.update":
        room.updatePrize(body);
        break;
      case "prize.remove":
        room.removePrize(body.id);
        break;
      case "prize.reseed":
        room.reseedPrizes();
        break;
      case "winner.clear":
        room.clearWinners();
        break;
      case "session.start":
        room.start();
        break;
      case "session.reveal":
        room.reveal();
        break;
      case "session.reset":
        room.reset();
        break;
      case "player.kick":
        room.kick(body.pid);
        break;
      case "player.award":
        room.awardPlayer(body.pid);
        break;
      default:
        throw new AppError("UNKNOWN_ACTION", "未知操作：" + type);
    }
    return sendJson(res, 200, { ok: true, data: room.adminData() });
  }

  if (pathname === "/api/export/winners.csv" && method === "GET") {
    if (!isAdmin(req)) throw new AppError("UNAUTHORIZED", "请先登录后台", 401);
    const rows = [
      ["序号", "奖品", "中奖人", "头像", "难度", "时间"]
    ];
    store.winners.forEach((w, i) => {
      rows.push([
        String(i + 1),
        (w.prize.emoji || "") + " " + (w.prize.name || ""),
        w.name,
        w.avatar,
        w.difficulty,
        new Date(w.at).toLocaleString("zh-CN", { hour12: false })
      ]);
    });
    const csv = "\uFEFF" + rows.map((r) => r.map(csvCell).join(",")).join("\r\n");
    const stamp = new Date().toISOString().slice(0, 16).replace(/[-:T]/g, "");
    return sendText(res, 200, csv, {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": 'attachment; filename="winners-' + stamp + '.csv"',
      "Cache-Control": "no-store"
    });
  }

  const KNOWN_METHODS = {
    "/api/health": "GET",
    "/api/state": "GET",
    "/api/stream": "GET",
    "/api/join": "POST",
    "/api/rejoin": "POST",
    "/api/ready": "POST",
    "/api/game/result": "POST",
    "/api/qr.svg": "GET",
    "/api/admin/login": "POST",
    "/api/admin/logout": "POST",
    "/api/admin/data": "GET",
    "/api/admin/action": "POST",
    "/api/export/winners.csv": "GET"
  };
  if (KNOWN_METHODS[pathname]) {
    return sendJson(res, 405, { ok: false, error: "请求方法不支持", code: "METHOD_NOT_ALLOWED" });
  }
  throw new AppError("NOT_FOUND", "接口不存在", 404);
}

/* ---------------------------------------------------------------- 请求入口 */

async function handleRequest(req, res) {
  let url;
  try {
    url = new URL(req.url, "http://" + (req.headers.host || "localhost"));
  } catch (e) {
    return sendJson(res, 400, { ok: false, error: "请求地址不合法", code: "BAD_URL" });
  }
  let pathname;
  try {
    pathname = decodeURIComponent(url.pathname);
  } catch (e) {
    return sendJson(res, 400, { ok: false, error: "请求地址不合法", code: "BAD_URL" });
  }

  if (pathname.indexOf("/api/") === 0) {
    try {
      await handleApi(req, res, url);
    } catch (err) {
      if (res.headersSent) {
        try {
          res.end();
        } catch (e) {}
        return;
      }
      if (err instanceof AppError) {
        return sendJson(res, err.status, { ok: false, error: err.message, code: err.code });
      }
      console.error("[server] 未处理异常", err);
      return sendJson(res, 500, { ok: false, error: "服务器内部错误", code: "INTERNAL" });
    }
    return;
  }

  return serveStatic(req, res, pathname);
}

/* ---------------------------------------------------------------- 启动 */

server = http.createServer((req, res) => {
  handleRequest(req, res).catch((err) => {
    console.error("[server] 请求处理失败", err);
    if (!res.headersSent) sendJson(res, 500, { ok: false, error: "服务器内部错误", code: "INTERNAL" });
    else {
      try {
        res.end();
      } catch (e) {}
    }
  });
});

server.headersTimeout = 60000;
server.requestTimeout = 300000;

server.on("error", (err) => {
  if (err.code === "EADDRINUSE") {
    console.error("\n[启动失败] 端口 " + PORT + " 已被占用。");
    console.error("请关闭占用程序，或换端口：$env:PORT=8081; node server.js\n");
  } else {
    console.error("[启动失败]", err.message);
  }
  process.exit(1);
});

server.listen(PORT, "0.0.0.0", () => {
  const u = urls();
  const ip = lanIps()[0] || "127.0.0.1";
  const port = server.address().port;
  const lines = [
    "",
    "  🏮  新春年会抽奖系统 已启动",
    "  ──────────────────────────────────────────────",
    "  大屏（投影本机） :  http://" + ip + ":" + port + "/",
    "  手机端（扫码）   :  http://" + ip + ":" + port + "/play",
    "  后台管理         :  http://" + ip + ":" + port + "/admin",
    "  房间号           :  " + room.roomCode + "   （手机端输入此 6 位数字加入）",
    "  后台密码         :  " + store.config.pin + "   （可在后台修改）",
    "  ──────────────────────────────────────────────",
    "  局域网其他设备请连同一 Wi-Fi；页面打不开时检查 Windows 防火墙。",
    "  数据实时保存于 " + DATA_DIR,
    "  按 Ctrl+C 退出",
    ""
  ];
  console.log(lines.join("\n"));
  if (u.joinUrl && ip === "127.0.0.1") {
    console.log("  ⚠ 未探测到局域网 IP，其他设备可能无法加入。\n");
  }
});

/* ---------------------------------------------------------------- 退出 */

function shutdown(signal) {
  console.log("\n[server] 收到 " + signal + "，正在保存并退出…");
  store.save();
  hub.closeAll();
  try {
    server.close(() => process.exit(0));
  } catch (e) {
    process.exit(0);
  }
  setTimeout(() => process.exit(0), 1500).unref();
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

process.on("uncaughtException", (err) => {
  console.error("[server] uncaughtException", err);
});
process.on("unhandledRejection", (err) => {
  console.error("[server] unhandledRejection", err);
});
