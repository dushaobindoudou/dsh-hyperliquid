# 盯盘失效诊断（2026-10-20）

> 问题：为什么这套交易台「不会自己盯盘操作」。
> 证据：`~/.dsh-hyperliquid/`（journal / live-orders / live-decisions / sessions / turn-origin）、
> `~/.dsh/logs/startup-*.log`、`~/.dsh/sessions/**/session.v4.jsonl.zstd`（DSH 原生会话日志）、
> 代码（`index.js`、`lib/strategy-monitor.js`、`lib/wake.js`、`lib/turn-origin.js`、`lib/prompt.js`）、
> Hyperliquid 测试网账户 `0xF5D7…9636C` 的只读快照。

---

## 一、结论

**心跳是在跑的，但每一轮都打在了一个「哑」会话上。**

DSH 的会话日志给出了决定性证据：ETH 会话 `8f569b1b` 在 15:30、15:45、16:00 各收到一次
`[交易台市场检查]` 唤醒，然后 turn 在 **22–1140 毫秒内以 `blocked` 结束，连一次 `step/start` 和
`request/header` 都没有** —— 也就是说一次模型请求都没发出，唤醒文本随即被从 inbox 移除。
同一个时间点，BTC 会话 `8e50a65c` 的唤醒正常跑完（16:00:09 → 16:02:54 completed）。

原因：`8f569b1b` 是用户 10-19 17:26 要求归档的那个 ETH 会话。DSH 对归档会话有一道
`agent/pre-step` 闸门（其 API 文档原文：「the durable archive set is what a provider's `agent/pre-step`
gate reads, so **every wake the stops induce is already blocked**」），所以这个会话收到的每一次
唤醒都被静默吞掉 —— 不报错、不通知、不留痕。

于是形成最坏的一种失败形态：**系统看起来在盯盘（每 15 分钟都有一个 turn），实际上什么都没发生，
而且外部完全看不出区别。**

叠加在这条主线上的还有四个结构性问题：

| # | 问题 | 后果 |
|---|---|---|
| 1 | 唤醒投递到「该币最新创建的会话」，不校验它是否可执行 | 归档会话 / 无前端会话 → 唤醒全部作废（本条） |
| 2 | `deliver()` 发出消息就返回 `true`，从不确认 turn 是否真的跑了 | 失败被当成成功，进入 60s 冷却，永不重试 |
| 3 | 唯一心跳是 15m 收盘，保护依赖交易所触发单，而触发单只在测试网有 | 主网 = 零自动保护；bar 之间最长 15 分钟盲区 |
| 4 | 风控（日亏 2R / 连亏减半 / 不裸扛）写在提示词里，不在代码里 | 靠模型自觉，日志证明没拦住 |

---

## 二、证据

### 2.1 决定性证据：blocked 的唤醒回合

ETH 会话 `8f569b1b`（DSH 原生 session 日志）：

```
17:27:17.762 step/start   {turn:13, step:2}
17:27:17.780 request/header {provider:vol, model:glm-5-3-flash}   ← 真正跑过的回合
17:28:04.859 turn/end     {turn:13, reason:{kind:completed}}

21:51:31.788 session/end-seed
21:51:31.819 turn/start   {turn:14}      ← 价格提醒「ETH 下穿 2404」
21:51:31.841 turn/end     {turn:14, reason:{kind:blocked}}        ← 22ms，无模型请求

15:30:10.361 session/end-seed
15:30:10.624 turn/start   {turn:15}      ← [交易台市场检查] ETH 07:15 bar
15:30:10.927 turn/end     {turn:15, reason:{kind:blocked}}

15:45:07.278 turn/start   {turn:16}      ← 07:30 bar
15:45:08.416 turn/end     {turn:16, reason:{kind:blocked}}

16:00:09.059 turn/start   {turn:17}      ← 07:45 bar
16:00:09.128 turn/end     {turn:17, reason:{kind:blocked}}
```

对照 BTC 会话 `8e50a65c`（同一个心跳、同一时刻）：

```
16:00:09 WAKE> [交易台市场检查] BTC 15m 已收盘 0x7:45Z ...
16:00:09 turn/start {turn:11}
16:02:54 turn/end   {turn:11, reason:{kind:completed}}   ← 正常执行，约 2m45s
```

每条 blocked 的唤醒消息还伴随一条 `agent/inbox/spliced {removedCount:1, inserted:[]}` ——
**消息被删除**，所以既没有进入对话历史，也没有任何地方能看到「这条提醒被丢了」。

这意味着 README 里承诺的「价格提醒会唤醒 agent」「15m 收盘唤醒会话」在归档会话上**全部失效**，
而且失效得完全无声。

### 2.2 为什么唤醒会打到归档会话

`lib/strategy-monitor.js:31-34`：

```js
const sessions = remote.store.listSessions()          // store.js:188 按 createdAt 倒序
for (const [coin, strategyIds] of byCoin) {
  const session = sessions.find((row) => row.coin === coin)
```

`864821e5`（Fib 区间轮动）仍是 `status: "testing"`、`markets: "ETH"`，所以监控器每根 15m bar
都会给「ETH 里最新创建的那个会话」发一条事件 —— 而那个会话正是 10-19 17:26 被归档的 `8f569b1b`。
会话是否归档，监控器完全不知道，也不检查。

同一个 bug 在 BTC 上是另一种表现：BTC 有 6 个会话、2 个 `testing` 策略
（`9b6aed6b` 在 `738ad86e`、`beae6f90` 在 `8e50a65c`），监控器只叫醒 `createdAt` 最新的
`8e50a65c`。`738ad86e` 的 15:28 有 `session/end-seed` 之后再没收到过任何唤醒 ——
**`9b6aed6b` 实际上已经没有人管了**，但它仍是 `testing`，仍被当作「候选策略」塞进每一条唤醒文本里。

### 2.3 投递成功是假象

`index.js:119-128`：

```js
deliver: async (sessionId, message, { signal }) => {
  const resolved = await ctx.get('sessionController')?.resolveAgent?.(sessionId)
  if (… typeof resolved.agent?.followup !== 'function') return false
  remote.store.setAlertOrigin(sessionId, true)
  resolved.agent.followup({ … })          // 只是入队
  await ctx.get('sessions')?.flush?.(resolved.agent.session)
  return true                             // ← 立刻宣称成功
}
```

`followup` 只负责入队，真正的执行被 pre-step 闸门拒绝时这里收不到任何信号。
`deliver` 返回 true → `wake.js:40` 记 `lastAt` → 进入 `cooldownMs`（bar 轮 60s、提醒轮 5 分钟），
**没有任何重试，也没有任何日志**。这就是为什么「看起来一切正常」。

### 2.4 心跳缺口（10-20 白天）

| 时间(CST) | 事件 | 来源 | 说明 |
|---|---|---|---|
| 07:28 | 宿主重启 | `restart-dsh-web3.log` | 伴生告警：profile 与全局 dsh 重复加载 14 个包 |
| 09:39 | 「执行仍被阻：网络在 mainnet 且权益 0」 | journal `71432609` | 重启后桌面回 mainnet，钱在 testnet |
| 10:09 | **TP1 减半被护栏拦住** | journal `0a564d05` | 自动轮资金操作被 `turn-origin` 拒 |
| 10:26 | 「10 分钟定时轮与 goal 轮重复，**已删定时轮**」 | journal `c3138564` | 唯一心跳被删，且当时原生监控开关是 false |
| 11:08 | SL 81,590 触发（-2.65） | journal `e6e246c6` | 早退线提醒无效，等 SL 兜底 |
| 14:14 | 缠论会话**撤销了另一个策略的 3 张挂单** | journal `dee03d0e` | 两个框架抢同一账户 |
| 15:12 | 用户下令「完全自主」 | journal `c6ab2532` | |
| 15:23 | 定位到 `turn-origin` 拦自动轮，改 `agentAutoTradeTestnet=true` | journal `decaf527` | |
| 15:31 | 首个原生 `market-bar` 唤醒（BTC，正常执行） | journal `e3e6a1be` | 但 ETH 的三次全部 blocked |
| 16:04 | 用户：「我没看到你的订单？确定进场了？」 | session `8e50a65c` turn 12 | 人对系统的信任已经开始掉 |

### 2.5 当前真实账户（16:05 只读快照）

```
accountValue 93.15   withdrawable 76.92
POS BTC 0.002  entry 81120.0  uPnL +0.082  lev 10x  liq 35024
ORD BTC SL 80704 Stop Market reduceOnly (oid 63194918434)
ORD BTC TP 82263 Take Profit Market reduceOnly (oid 63194918433)
```

持仓有保护 —— 但这是**测试网**才成立的保护。同一套流程搬到主网，这两张单根本挂不出来
（`normalTpsl` 未对主网开放），而 `prompt.js:68` 的处理只是「提醒用户自己去挂」。

---

## 三、根因

### A. 唤醒投递不做「可执行性」校验（最致命）

监控器只回答了「哪个币有策略」，没有回答「哪个会话能执行」。会话可归档、可被前端关闭、
可被替换成新会话，这三件事监控器都不知道。DSH 的阻塞是**静默且快速**的（22ms），
恰好和「agent 很快决定观望」在外部不可区分。

### B. 投递结果不确认

`followup` 成功 ≠ turn 成功。现在没有任何 `turn/end` 观察、没有 `blocked` 检测、
没有失败重路由、没有失败日志。`wake.js` 的护栏全部围绕「不要打扰太频繁」设计，
没有一条围绕「确保送达并执行」设计。

### C. 分辨率与风险不匹配

- `strategy-monitor.js:21` 把 `nextPollAt` 推到下一根 bar 边界 → 真实分辨率 **15 分钟**。
- `FRESH_MS = 2 分钟`（`:5`）→ 宿主睡眠 / 长 turn / REST 抖动超过 2 分钟，这根 bar 永久丢弃，无补发。
- `previous == null`（`:43`）→ 重启后第一根 bar 只做播种，不触发。
- 保护只能靠交易所触发单，而触发单只在测试网 → **主网是裸奔**。
- 主网的 bar 轮被 `:19` 的 `network !== 'testnet'` 直接挡掉 → 主网连「看一眼」都没有。

### D. 唤醒对象与执行权没有收敛

`864821e5`（ETH）与 `9b6aed6b`（BTC）都还是 `testing`，但都已经没有可执行的会话；
`9b6aed6b` 与 `beae6f90` 同为 BTC `testing`，同账户同币，允许同时开仓 —— 14:14 互相撤单是必然结果。
`markets` 与 `session.coin` 不一致时也不报错（15:23 只能手动改 `markets` 去迁就监控器）。

### E. 风控是提示词，不是代码

`prompt.js:81` 连亏 3 笔只是「建议暂停」；日亏 2R 只存在于 journal profile 的文本里。
硬闸只有交易限额（单笔 25,000 / 日 50,000 / 杠杆 20），**等于没有日亏闸**。
今天从 99.9 亏到 93.02（≈1.38R），全靠 agent 自己记账才发现。

### F. `turn-origin` 把人工插话也判成自动轮

`turn-origin.js:36`：

```js
} else if (source?.kind === 'user' && !turns.get(session)?.automatic) {
```

本回合一旦被标记 `automatic`，用户在同一回合插话也不清除标记、不清 `turn-origin.json`
的持久记录（journal `decaf527` 已记录该现象）→ 人明明在线，`hyper_decide` 仍被拒。

### G. 没有运行日志

`store.recordEvent` 只写内存 500 条环形缓冲（`store.js:323-328`），重启清零。
「这一轮为什么没动手」只能翻 agent 手写的 journal 笔记。今天能查出 blocked，是靠我去解压
DSH 的 zstd 会话日志 —— 这件事不该由人来做。

---

## 四、怎么改

原则：**把「盯盘」拆成两层 —— 保护层交给宿主代码（秒级、确定性、不烧 token），
决策层才交给 agent（15m、需要判断）。** 现在两层混成了一层，所以既慢、又贵、又不可靠。

### P0-1 投递必须确认，失败必须重路由（先做这个，收益最大）

1. `deliver()` 改为「发出 + 等待该 turn 结束」，用 `ctx.on('session/event')` 观察
   对应 session 的 `turn/start` / `turn/end`：
   - `completed` / `max-tokens` → 返回 true（正常）
   - `blocked` / `error` / `aborted` → 返回 false，并记一条 `wake.failed{reason}`
2. `deliver` 返回 false 时**不推进 `lastAt`**（`wake.js:40`），并立即尝试下一个候选会话：
   ```js
   candidates = [strategySession, …同币其它会话, …该币最新活跃会话]
   ```
3. 全候选都失败 → 写入 run-log，并把事件降级为「交易台界面内通知」（至少不静默）。
4. **监控器加入「会话可执行性」检查**：跳过已归档会话（DSH 有归档集合，宿主侧可读）；
   优先选「最近有 journal 写入 / 有持仓 / 有挂单」的会话，而不是 `createdAt` 最新。
5. `status=testing` 但会话不可执行 / 无仓无单无 plan → **不唤醒**，只记一行 `wake.skipped`。

这一项做完，ETH 那种「每 15 分钟空转一次」会立刻暴露成日志里的一条 `wake.failed`，
而不是继续假装在盯盘。

### P0-2 新增 `lib/watchdog.js`：确定性风控心跳（30s，不经 LLM）

```
每 30s：
  account = 直查 clearinghouseState + frontendOpenOrders（宿主已有 client）
  plans   = journal 里的 active 计划（需补结构化字段，见 P0-3）
  actions = evaluate({account, plans, limits, now})     ← 纯函数，可单测
  for a of actions:
     a.safe（reduceOnly / cancel / 补保护单）→ 直接执行 + 审计
     a.judgement（开仓/加仓/换向）           → 交 P0-1 的 waker 唤醒归属会话
```

| 规则 | 条件 | 动作 |
|---|---|---|
| R1 裸仓 | 持仓 sz 未被 reduceOnly 触发单覆盖 ≥99% | 测试网：自动补 SL；主网：尝试挂独立 trigger reduceOnly |
| R2 穿越未成交 | mid 穿 SL，或穿「早退线」 | reduceOnly 市价离场 |
| R3 到价减半 | mid 穿 TP1 且仓位 > 计划剩余 | reduceOnly 减半 |
| R4 时间止损 | 持仓 > plan.maxHoldMs | reduceOnly 离场 |
| R5 日亏闸 | 当日已实现 ≤ -2R | 撤所有非保护挂单 + 网关级冻结开仓 |
| R6 距强平 | (liq-mid)/mid < 15% | 告警 + 建议减仓 |

R1–R5 都只减仓/撤单，天然安全，不该等 LLM，也不该占一次审批。
R5 的「冻结开仓」必须在 `hyper_order` 网关处直接拒绝，不能写进提示词。

### P0-3 策略 ↔ 会话绑定，收敛执行权

1. `hyper_journal` 写策略时自动落 `sessionId`（当前会话）+ `primary`。
2. 监控器用 `strategy.sessionId` 找会话，回退到「最近活跃会话」，不再用 `createdAt`。
3. 同币同网络只允许一个 `primary` 策略可开仓，其余 `observer`（只能减仓/撤单）。
4. `markets` 与 `session.coin` 不一致 → **拒绝注册并报错**。

### P1-1 补齐漏掉的 bar，不丢事件

- 每币记 `lastBarAt`，发现跳根 → 补发最近一根，文本标注「跳过 N 根，只做保护性判断」。
- `FRESH_MS` 2min → 20min；bar 唤醒的 `staleMs`（`index.js:118`）2min → 20min。
- agent 忙时事件排队不丢，文本必须带 bar 时间戳。
- 顺手修 `strategy-monitor.js:36` 的 `return []`（网络切换时不该放弃本轮剩余币）。

### P1-2 重启对账

`apply()` 后 20 秒跑一次 `reconcile()`：持仓 / 挂单 / journal plan 三方对账，不一致就投递
`[交易台对账]`。今天 07:28 重启、09:39 才发现「在 mainnet 且权益 0」，这类问题应 30 秒内自曝。

### P1-3 主网也要有保护（仍不许自动开仓）

- 放开「主网单条 trigger reduceOnly 保护单」（不走 `normalTpsl`）。
- `prompt.js:68` 改成「先自动补挂，补挂失败才提示用户」。
- 红线不变：主网自动轮只减仓/撤单/补保护，不开仓、不改限额、不划转。

### P2-1 持久化运行日志

`~/.dsh-hyperliquid/run-log.jsonl`（7 天轮转）：`wake.sent / wake.failed{reason} / wake.skipped /
bar-skip / decide / order / guard-block{reason} / watchdog{rule,action} / reconcile`。
新增 `hyper_journal action=diagnose` 或 `hyper_account action=diagnose` 读它。
再把 `store.events` 落盘一份，重启不清零。

### P2-2 修 `turn-origin` 的人工插话判定

```js
} else if (source?.kind === 'user') {     // 人类消息无条件视为授权
```

并允许人工消息覆盖同一回合的 `automatic` 标记、同时清 `turn-origin.json`。

---

## 五、不建议做

- **不要把心跳改成 1 分钟唤醒 LLM**：成本线性涨 15 倍，1m K 线没有信息量，判断质量反而降。
  正解是 P0-2 的代码 watchdog + 现有 15m 决策点。
- **不要为了「更自动」放开主网自动开仓**：现有红线（主网只减不加）是对的，缺的是「减」的确定性执行。
- **不要急着加第三个策略框架**：4 个策略里 2 个抢同一个 BTC 账户，先收敛执行权。

---

## 六、落地顺序

| 顺序 | 内容 | 验收标准 |
|---|---|---|
| 1 | P2-2 修人工插话（3 行） | 自动轮中用户插话后 `hyper_decide` 立即放行 |
| 2 | P0-1 投递确认 + 重路由 + 归档会话跳过 | 把唤醒指向归档会话时，run-log 出现 `wake.failed{blocked}` 并自动改投可用会话 |
| 3 | P0-3 策略↔会话绑定 + primary | 两个 BTC 策略不再互相撤单；`9b6aed6b` 能被自己的会话评估 |
| 4 | P0-2 watchdog + R1/R2/R5 | 制造裸仓 30s 内自动补挂；日亏 2R 后 `hyper_order` 被网关拒绝 |
| 5 | P1-2 重启对账 | 重启后 30s 内主动报告持仓/挂单/plan 差异 |
| 6 | P1-1 漏 bar 补齐 + P1-3 主网保护单 | 宿主 sleep 10 分钟后恢复能补发一次并标注跳过 |
| 7 | P2-1 run-log | 「今天为什么没动手」一条命令查出来 |

前 4 项都有现成测试脚手架（`npm test` 的 signing / store / markers 三组）。
第 4 项动钱，建议先只开「只减仓 / 撤单 / 补保护」三个安全动作跑一天，再开需要判断的规则。
