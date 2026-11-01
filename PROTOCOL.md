# 新春年会抽奖系统 · 协作协议 v1

> 本文件是唯一接口契约。所有页面（大屏 / 手机端 / 后台）必须严格按本协议实现。
> 与代码冲突时以本文件为准，改动协议必须先告知 Lead。

## 0. 总览

单进程 Node.js 服务（零第三方依赖，二维码除外），主机运行后即为主服务器。

| 页面 | 路径 | 用途 |
| --- | --- | --- |
| 大屏 | `/` | 投影/大屏展示：房间号、二维码、玩家、进度、开奖 |
| 手机端 | `/play` | 玩家扫码进入，输入房间号 + 昵称，玩「灯阵·连击」 |
| 后台 | `/admin` | 主持人后台：奖品增删改、人数上限、难度、开始/重置/开奖、名单导出 |

- 默认端口 `8080`，可用环境变量 `PORT` 覆盖；数据目录 `DATA_DIR`（默认 `./data`）。
- 局域网地址由服务端自动探测，通过 `session.joinUrl` 下发。
- **禁止任何外网资源**（字体/图片/CDN/接口）。全部程序化绘制，离线可用。
- 库存与名单落盘 `data/state.json`，重启不丢。

## 1. 房间与生命周期

```
lobby ──start()──> playing(倒计时 3s) ──全部完成/主持人揭晓──> reveal ──reset()──> lobby
```

- 房间号：6 位数字，`lobby` 阶段可加入；`reset()` 时更换房间号并清空本轮玩家。
- `playing` 阶段中途加入 → 拒绝（错误码 `GAME_STARTED`）。
- `reveal` 后玩家页面保留本轮结果；`reset()` 后回到加入页。
- 全员提交结果后 2.5s 自动进入 `reveal`；另有 120s 超时兜底自动揭晓。

玩家状态 `status`：`joined` | `playing` | `won` | `lost`。

## 2. 难度配置（服务端 `lib/difficulty.js` 为唯一数据源）

依次为 `easy / normal / hard / extreme / prize`，参数均可现场调整（当前默认值见下）。

```jsonc
[
  { "key": "easy",   "label": "简单", "waveCount": 2, "maxStrikes": 3,
    "desc": "入门档：3+4 盏灯、闪灯 560/520ms，最多可失误 3 次",
    "estimatedPass": "约 70%",
    "waves": [ { "len": 3, "showMs": 560, "gapMs": 340, "inputMs": 4600 },
               { "len": 4, "showMs": 520, "gapMs": 330, "inputMs": 5800 } ] },

  { "key": "normal", "label": "标准", "waveCount": 2, "maxStrikes": 2,
    "desc": "标准档：4+5 盏灯、复现时限充裕，最多可失误 2 次",
    "estimatedPass": "约 55%",
    "waves": [ { "len": 4, "showMs": 480, "gapMs": 320, "inputMs": 15000 },
               { "len": 5, "showMs": 440, "gapMs": 310, "inputMs": 15000 } ] },

  { "key": "hard",   "label": "困难", "waveCount": 3, "maxStrikes": 1,
    "desc": "困难档：5+6+6 三波连击，最多可失误 1 次",
    "estimatedPass": "约 30%",
    "waves": [ { "len": 5, "showMs": 440, "gapMs": 300, "inputMs": 15000 },
               { "len": 6, "showMs": 400, "gapMs": 290, "inputMs": 15500 },
               { "len": 6, "showMs": 380, "gapMs": 280, "inputMs": 15000 } ] },

  { "key": "extreme","label": "极致", "waveCount": 3, "maxStrikes": 0,
    "desc": "极致档：6+7+7 贴脸闪现，零容错，错一盏即出局",
    "estimatedPass": "约 8%",
    "waves": [ { "len": 6, "showMs": 380, "gapMs": 280, "inputMs": 15000 },
               { "len": 7, "showMs": 340, "gapMs": 270, "inputMs": 15000 },
               { "len": 7, "showMs": 320, "gapMs": 260, "inputMs": 15000 } ] },

  { "key": "prize",  "label": "获奖", "waveCount": 1, "guaranteed": true, "maxStrikes": 99,
    "desc": "全员福气：3 盏灯轻松完成，必得奖品（按库存发放）",
    "estimatedPass": "必得奖",
    "waves": [ { "len": 3, "showMs": 900, "gapMs": 320, "inputMs": 15000 } ] }
]
```

- `maxStrikes`：允许失误次数，`0` = 错一次即本波失败；获奖档为 `99`。
- 客户端展示难度时统一从 `session.difficulty` 取 `{key,label,desc,color,estimatedPass,maxStrikes}`。
- `estimatedPass` 由服务端下发（用于后台展示，标注「预估」）。

## 3. 数据模型

### 3.1 服务端配置 `config`
```jsonc
{
  "maxPlayers": 30,                // 1..200，加入时校验
  "difficulty": "easy",            // 5 档之一
  "awardRule": "lowFirst",         // lowFirst | highFirst | random
  "pin": "8888",                   // 后台密码
  "title": "龙腾新春 · 年会抽奖",
  "subtitle": "扫码入场 · 灯阵夺魁 · 好运连连"
}
```

### 3.2 奖品 `prize`
```jsonc
{ "id": "p_xxx", "name": "智能手表", "emoji": "⌚", "quantity": 3,
  "awarded": 0, "remaining": 3, "note": "", "order": 2 }
```
`remaining = max(0, quantity - awarded)`。库存发完视为不可领。全空时发放「新春福袋」安慰奖（`consolation: true`）。

### 3.3 中奖记录 `winner`
```jsonc
{ "pid": "pl_xxx", "name": "张三", "avatar": "🐲",
  "prize": { "id": "p_xxx", "name": "智能手表", "emoji": "⌚", "consolation": false },
  "at": 1762000000000, "difficulty": "easy" }
```

### 3.4 玩家 `player`（服务端内存，向客户端下发时去掉 token）
```jsonc
{ "pid": "pl_x", "name": "张三", "avatar": "🐲",
  "status": "joined", "ready": false, "wave": 0, "score": 0,
  "result": { "win": true, "waves": 2, "cleared": 2, "hits": 7, "strikes": 0, "ms": 18234 },
  "prize": { "id": "p_x", "name": "智能手表", "emoji": "⌚", "consolation": false } }
```

### 3.5 会话快照 `session`（`session` 事件 / `GET /api/state` 的 `session` 字段）
```jsonc
{
  "phase": "lobby",            // lobby | playing | reveal
  "roomCode": "482913",
  "joinUrl": "http://192.168.1.8:8080/play",
  "hostUrl": "http://192.168.1.8:8080/",
  "serverTime": 1762000000000,
  "sessionId": "s_ab12cd",
  "startAt": null,             // playing 阶段：正式开玩的时间戳（含 3.2s 倒计时）
  "revealAt": null,
  "config": { "maxPlayers": 30, "difficulty": "easy", "awardRule": "lowFirst",
              "title": "龙腾新春 · 年会抽奖", "subtitle": "扫码入场 · 灯阵夺魁 · 好运连连" },
  "difficulty": { "key": "easy", "label": "简单", "desc": "入门档：3+4 盏灯…", "color": "#7fd1a4",
                  "estimatedPass": "约 70%", "guaranteed": false, "maxStrikes": 3,
                  "waves": [ { "len": 3, "showMs": 560, "gapMs": 340, "inputMs": 4600 } ] },
  "prizes": [ { "id": "p_x", "name": "智能手表", "emoji": "⌚", "quantity": 3,
                "awarded": 0, "remaining": 3, "note": "", "order": 2 } ],
  "winners": [ /* winner[]，本轮累计（reset 保留，clear 清空） */ ],
  "players": [ /* player[]（去掉 token） */ ],
  "stats": { "joined": 12, "playing": 5, "wins": 2, "losses": 3,
             "totalPrizes": 41, "awardedPrizes": 2 }
}
```

## 4. HTTP API

统一 `application/json; charset=utf-8`。失败返回 `HTTP 4xx/5xx` + `{ "ok": false, "error": "中文提示", "code": "ERR_CODE" }`。
成功一律 `{ "ok": true, ... }`。

### 4.1 公共
| 方法 | 路径 | 入参 | 出参 |
| --- | --- | --- | --- |
| GET | `/api/health` | – | `{ok, phase, players, uptime}` |
| GET | `/api/state?cid=` | – | `{ok, session, you?}`（`you` 为当前 cid 绑定的玩家） |
| GET | `/api/stream?cid=&role=` | `role=host\|player\|admin`；player 可带 `pid&token` | SSE 流（见 §5） |
| POST | `/api/join` | `{cid, code, name, avatar}` | `{ok, player:{pid,token,name,avatar}, session}` |
| POST | `/api/rejoin` | `{cid, pid, token}` | `{ok, player, session}` |
| POST | `/api/ready` | `{cid, pid, token, ready}` | `{ok}` |
| POST | `/api/game/result` | `{cid, pid, token, waves:[{cleared,hits,strikes,ms}], score}` | `{ok, win, prize, player}` |
| GET | `/api/qr.svg?text=` | URL 文本 | SVG 二维码 |
| GET | `/api/export/winners.csv` | 需后台 cookie | CSV 附件（UTF-8 BOM） |

加入校验：`code` 必须等于当前房间号；`name` 1–12 字符（去空白）；`avatar` 为头像 emoji 之一；
人数 ≥ `maxPlayers` → `ROOM_FULL`；`phase !== 'lobby'` → `GAME_STARTED`。

### 4.2 后台（除 login 外均需 cookie `adm`）
| 方法 | 路径 | 入参 | 说明 |
| --- | --- | --- | --- |
| POST | `/api/admin/login` | `{pin}` | 成功 set-cookie；失败 401 `BAD_PIN` |
| POST | `/api/admin/logout` | – | 清 cookie |
| GET | `/api/admin/data` | – | `{ok, config, prizes, players, winners, session, pinSet}` |
| POST | `/api/admin/action` | `{type, ...}` | 见下表 |

`/api/admin/action` 的 `type`：
| type | 参数 | 说明 |
| --- | --- | --- |
| `config.set` | `{maxPlayers?, difficulty?, awardRule?, pin?, title?, subtitle?}` | 校验：人数 1–200，难度合法，awardRule 合法，pin 4–8 位数字；pin 变更后当前会话保持登录 |
| `prize.add` | `{name, emoji, quantity, note?}` | 追加到末尾；name 1–20 字，quantity 0–999 |
| `prize.update` | `{id, name?, emoji?, quantity?, note?}` | 改数量时 `awarded` 不受影响，`quantity < awarded` 允许但 `remaining=0` |
| `prize.remove` | `{id}` | 已发放记录保留（winner 里存的是快照） |
| `prize.reseed` | – | 恢复示例奖品并把 `awarded` 归零 |
| `winner.clear` | – | 清空中奖名单（不影响库存） |
| `session.start` | – | `lobby → playing`（需至少 1 名玩家） |
| `session.reveal` | – | `playing → reveal`（可提前开奖） |
| `session.reset` | – | 回 `lobby`，换房间号，清空玩家与本轮状态 |
| `player.kick` | `{pid}` | 踢出玩家（其页面收到 `kicked` 事件） |
| `player.award` | `{pid}` | 主持人手动发奖（立即发一个库存奖品） |

所有后台写操作成功后广播最新 `session`。

## 5. SSE 事件

`event: message`，`data: <json>`，每 15s 发送 `: ping` 注释保活。事件对象必带 `t`。
同一浏览器的多个页面共用 `cid`，服务端按 `cid + role` 区分连接，大屏与后台可同时在线互不踢线。

| `t` | 载荷 | 接收方 | 说明 |
| --- | --- | --- | --- |
| `hello` | `{t, serverTime, role, session}` | 全部 | 连接建立/重连时首帧 |
| `session` | `{t, session}` | 全部 | 任意状态变化（服务端 60ms 合并） |
| `game` | `{t, game}` | 全部 | 开赛：`{sessionId, startAt, difficulty, waves, maxStrikes, minMs}` |
| `you` | `{t, player}` | 对应玩家 | 本人状态/结果/奖品变化 |
| `award` | `{t, pid, name, avatar, prize, winner}` | 全部 | 出奖瞬间（大屏动画、手机弹窗） |
| `kicked` | `{t, reason}` | 对应玩家 | 被踢出 |
| `toast` | `{t, text, kind}` | 全部 | `kind: info\|success\|warn`，仅提示 |
| `error` | `{t, message}` | 对应连接 | 非致命错误 |

`game` 事件示例：
```jsonc
{ "t": "game", "game": {
  "sessionId": "s_ab12cd", "startAt": 1762000003200, "seed": 123456789,
  "difficulty": "easy", "maxStrikes": 3, "minMs": 5430,
  "waves": [ { "len": 3, "showMs": 560, "gapMs": 340, "inputMs": 4600 } ] } }
```

## 6. 玩法「灯阵·连击」与判定

**8 盏灯**围成一圈（编号 0–7，从正上方顺时针）。每波：
1. **记忆**：按 `waves[i].len` 随机生成序列（允许非相邻/重复），依次点亮，每盏亮 `showMs`，间隔 `gapMs`。
2. **复现**：序列熄灭后开始 `inputMs` 倒计时，玩家按原顺序点灯。点错 = 失误；失误数 > `maxStrikes` 或超时 = 本波失败。
3. 通过进入下一波；失败则整局结束。全部波通过 = 中奖。

客户端生成序列用 `mulberry32(seed + waveIndex)`，`seed` 来自 `game` 事件（服务端随机）。
判定：`hits` 为正确点数，`cleared` 为是否通过，`ms` 为该波耗时。提交时服务端校验：
- `waves.length` 与配置一致，每项 `hits ≤ len`；
- 若 `cleared`，必须 `hits === len && strikes ≤ maxStrikes`；
- `ms ≥ len*showMs + (len-1)*gapMs - 250`（防瞬时作弊，不满足则该波判负）；
- `hits / strikes / ms` 非整数或越界 → 直接 `400 BAD_INPUT`（不做 clamp，避免伪造通关）；
- 重复提交只接受第一次。

结果页（手机端）：中奖展示奖品卡 + 祝福语；未中奖展示「差一点点」+ 本轮最好成绩；然后等待大屏开奖（`reveal` 后展示全场中奖名单入口或留白动画）。

## 7. `public/js/net.js`（Lead 维护，禁止修改）

```js
Net.cid();                                  // 本标签页稳定 clientId（localStorage）
Net.stream('host'|'player'|'admin', extra); // → { on(t, fn), close(), es }
Net.post(path, body);                       // → Promise<{ok, ...}>
Net.get(path);                              // → Promise<{ok, ...}>
Net.store.get(k, def) / .set(k, v) / .del(k)
Net.escape(s);                              // HTML 转义，渲染用户名必用
Net.fmtMs(ms);                              // 1234 → "1.2s"
```
`on()` 支持 `'*'` 监听全部事件。`stream('player')` 需额外传 `{pid, token}`。

## 8. `public/js/art.js`（art-engine 负责实现，本接口冻结）

```js
Art.createScene(canvas, opts) → scene
// opts: { quality?: 'high'|'low', density?: number, phase?: 'lobby'|'playing'|'reveal' }
scene.start() / scene.stop() / scene.resize() / scene.destroy()
scene.setPhase('lobby'|'playing'|'reveal')   // 改变氛围/粒子强度
scene.setEnergy(0..1)                        // 环境光与粒子强度
scene.burst(x, y, { count?, colors?, power? })  // CSS 像素坐标下的烟花
scene.celebrate(n)                           // 随机位置连放 n 朵烟花

Art.lanternIcon(canvas, { color?, glow? })    // 把一个灯笼图标绘制进给定 canvas
Art.mountCanvas(canvas)                       // → { ctx, w, h, dpr, onResize(fn) }
Art.THEME = { red:'#c8102e', gold:'#f2c14e', jade:'#4fd1a5', ink:'#150709', paper:'#fff6e6' }
```

要求：DPR 自适应；`resize()` 幂等；`prefers-reduced-motion` 时降低粒子；隐藏标签页暂停 rAF；
2.5D 表现（透视地面/多层视差/体积光）全部程序化绘制，禁止外部图片。
大屏页面结构：`<canvas id="bg">` 全屏铺底，DOM 层叠加玩家/图标/文字，`burst(x,y)` 用 DOM 元素中心坐标。

## 9. `public/css/theme.css`（Lead 维护，可追加，不可改已有变量含义）

CSS 变量：`--red-900/800/700/600/500`、`--gold-400/500/600`、`--jade-500`、`--ink`、`--paper`、
`--radius-*`、`--shadow-*`、`--font-display`、`--font-body`、`--ease-*`。
通用类：`.page` `.panel` `.card` `.btn`（`.btn--gold` `.btn--red` `.btn--ghost` `.btn--sm` `.btn--lg` `.btn--block`）、
`.badge` `.chip` `.input` `.field` `.label` `.row` `.col` `.stack` `.center` `.muted` `.gold-text`
`.divider` `.scroll` `.code-chip` `.qr-frame` `.fade-in` `.pop-in` `.float` `.glow`。
各页面自建 `host.css / player.css / admin.css` 做布局，不得覆盖其它页面选择器。

## 10. 文件所有权（禁止越界写入）

| 负责人 | 文件 |
| --- | --- |
| Lead | `server.js`、`lib/*`、`package.json`、`PROTOCOL.md`、`README.md`、`public/js/net.js`、`public/css/theme.css`、`data/*`、启动脚本 |
| art-engine | `public/js/art.js` |
| host-screen | `public/index.html`、`public/css/host.css`、`public/js/host.js` |
| player-client | `public/play.html`、`public/css/player.css`、`public/js/player.js` |
| admin-panel | `public/admin.html`、`public/css/admin.css`、`public/js/admin.js` |
| qa | `tools/*`（测试脚本）、`docs/QA.md` |

调试端口分配（避免互抢）：Lead `8080`、host-screen `8711`、player-client `8712`、admin-panel `8713`、qa `8790`。
命令：`$env:PORT=8711; node server.js`。测试完请关闭自己启动的服务进程。

## 11. 视觉与体验要求

- 主题：中国红 + 鎏金 + 夜宴氛围；**2.5D**：透视地面、层叠视差、体积光、灯笼立体投影，禁止纯扁平贴图感。
- 大屏 16:9 优先，1280–1920 宽度自适应；手机端 360–430 宽优先，竖屏，安全区适配（底部按钮避开 iPhone 横条）。
- 中文字体栈：`--font-display` 楷体/宋体，`--font-body` 苹方/微软雅黑。
- 关键反馈：加入、开赛倒计时、点灯对错、中奖、开奖都必须有动画/微交互，不能只有文字变化。
- 所有用户输入渲染前必须 `Net.escape()` 或 `textContent`。
- 无网络时不能白屏（纯本地资源）。

## 12. 验收清单（QA 按此验收）

1. 启动 `node server.js`，打印大屏/手机端/后台地址与房间号。
2. 手机端输错房间号 → 明确报错；正确房间号 + 昵称 → 进入等待页，大屏实时出现该玩家。
3. 后台加奖品 / 改数量 / 删除奖品 / 改人数 / 切难度 → 大屏与手机端同步。
4. 开始游戏 → 手机端 3-2-1 倒计时 → 灯阵可玩；大屏显示进度。
5. 通关 → 手机端立即显示奖品，大屏出现 `award` 动画与中奖名单，库存 -1。
6. 全部完成 → 自动 `reveal`，大屏开奖；后台可提前揭晓、可重置（换房间号）。
7. 人数满 / 游戏已开始 时加入 → 正确拒绝。
8. 刷新手机页可恢复身份；后台刷新保持登录。
9. 断网/离线：页面无外链请求；数据重启后保留。
10. 375×812 与 1920×1080 两种尺寸无重叠/溢出，主要按钮可点。
