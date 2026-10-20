# dsh-hyperliquid 能力审计报告（2026-10-14 晚）

> **复核提示**：下文第 0–7 节是审计当时的快照，部分问题随后已修复。当前状态和新增的执行计划见[第 8 节](#8-基于当前代码的优化计划2026-10-14-复核)。原始判断与工期估算不应直接作为当前上线结论。

> 目标：做一套 dsh 原生 Hyperliquid 系统，交易区域与官方交互一致、高性能、易操作。
> 结论前置：**这不是「补几个功能」的问题，而是三处结构性错位。**
> 最难的工程（EIP-712 签名，做到官方向量逐字节对拍）已经完成；
> 但**配置链路是断的**（`Config` 没导出）、**风控在默认模式下是空转的**（paper 绕过 guard）、
> **UI 的渲染与数据流没有为「高频」设计**（0 memo、0 selector、全量 setData）。
> 测试全绿（`npm test` 实跑通过），但绿色掩盖的是「测什么都是安全的」。

---

## 0. 一句话结论

| 维度 | 现状评级 | 判断 |
|---|---|---|
| 签名与执行正确性 | 🟢 **优秀** | 字节级对拍、双路径交叉验证、marker 契约测试——这部分做得比多数同类项目好，务必保留 |
| 架构分层 | 🟡 中 | 四层职责清晰，但存在跨层读私有状态、全局单例串味、事件环不落盘 |
| 安全 | 🔴 **有真空** | paper 模式完全绕过风控却对外声明有限额；TP/SL 的 OCO 语义未告知；无清算价 |
| 性能 | 🔴 **未按高频设计** | 2.2 Hz 全量重渲染 × 6 组件、每帧 980 点 setData、REST 权重占预算 37% |
| UI 交互一致性 | 🟡 中上 | 市场选择器甚至**优于**官方；但下单模型是「写自然语言给 agent」，与官方的确定性下单根本不同 |
| 系统能力 | 🟡 窄而深 | 执行面只覆盖官方能力的一个角（无 priority fee / fast cancel / 触发单 / TWAP），但深度（paper/live 双轨、会话绑定、决策一次性）做得好 |

**如果只做三件事**：① `export const Config`（一行，堵住整条配置链路）② paper 接入 guard ③ `useStore` 加 selector + chart 改增量更新。

---

## 1. 🔴 P0 — 严重（会导致资金损失或错误决策）

### P0-1 `Config` 从未导出 —— 整条配置链路是死代码（一行修复）

`index.js:38-39`：
```js
let Config
Config = z.object({ dataDir: ..., network: ..., maxOrderUsd: ..., ... })
```

`Config` 是模块内局部变量，**没有 `export`**。cordis 的消费点是 `node_modules/@deepseek-ai/cordis/lib/index.js:1631`（`Config: plugin.Config`）与 `:957`：
```js
function resolveConfig(runtime, config) {
  if (!runtime.Config) return config;   // ← 直接返回未校验的原始 config
```

**后果**（全部已验证）：
- 13 个 `.default()` 全部不生效。插件能跑**纯属巧合**——因为 `lib/remote.js:86-104` 用 `??` 手工重复了一遍默认值。**两份定义已经在漂移**：`cordis.patch.yml:5-7` 写了 `dataDir/network/tradingMode`，与 `remote.js` 的硬编码 fallback 是两个来源。
- **类型校验完全失效**：`network: "MAINNET"`（大写）不会被拒，`remote.js:88` 的 `=== 'mainnet'` 静默回落到 testnet——**用户在 mainnet 配置下可能实际连着 testnet 下单**。`maxOrderUsd: "abc"` 变成 `NaN`，靠 `remote.js:105-107` 的 `Number.isFinite` 兜住，不是 schema 的功劳。
- `privateKey` 声明 `z.string()` 但无校验，任意 JSON 都能穿透到 `signing.js:209` 的 `parseInt` 并抛出带配置片段的错误。

**修复**：改为 `export const Config = z.object({...})`，然后删掉 `remote.js:86-104` 的重复默认值，改为消费已校验的 config。
**注意**：改完后 `cordis.patch.yml` 里的值会真正过 schema，**可能暴露历史配置问题**，需要先验证。

### P0-2 paper 模式完全绕过风控，却对外声明有限额

`remote.js:658` 的 paper 分支直接 `return`，`guard.validate` 只在 `checkLiveOrder`（live 路径，`remote.js:663`）里调用。已验证 `this.guard.*` 的全部调用点：`create`(631) / `validate`(663) / `consume`(721) / `reserve`(765) / `release`(783) —— **paper 路径一个都不经过**。

而 `status()`（`remote.js:386`）**照样把 `riskLimits` 返回给 agent 和 UI**。

⇒ **agent 拿到 `maxOrderUsd:100 / maxDailyUsd:500 / maxLeverage:2`，以为有限额保护，实际可以开任意仓位、任意数量。**

叠加 paper 撮合的四个简化（`remote.js:681-700` + `store.js:150-185`）：
| 官方真实行为 | paper 实现 |
|---|---|
| 盘口深度决定成交 | `mid × (1 ± 0.05%)` **固定滑点，假设无限流动性** |
| 维持保证金 = 初始保证金/2 | **无保证金占用** |
| mark 跌破清算价 → 强平 | **无强平，永不爆仓** |
| 每小时结算资金费 | **无资金费** |

⇒ 在 paper 上跑出的盈利策略，切 live 后大概率不成立。**SKILL.md:25 / README:10 只说了「不支持触发单」，完全没说这四条。**

**修复**：① paper 分支也跑 `guard.validate`（用 paper equity 替代 accountValue）；② paper 实现 margin tier + 保证金占用（不需要真强平，只需拒绝超额开仓）；③ 顶栏与工具返回常驻一条「模拟撮合：无保证金/无强平/固定滑点/无资金费」。

### P0-3 账户抽象模式未处理 → unified 账户上读到错误权益 → 风控基于错误数据

官方明确：**unified account 模式下 `clearinghouseState` 不是真相来源**，要用 `spotClearinghouseState`。

已验证：`userAbstraction` 在 `lib/` 下**零出现**；`spotClearinghouseState` 在 `hl.js:116,165` **已实现但 `remote.js` 从未调用**。`remote.js:490`（account）与 `:628`（checkLiveOrder）无条件用 `clearinghouseState`。

⇒ 在 unified 账户上：`marginSummary.accountValue` 可能不含 spot 余额 → `remote.js:645` 风控用错误权益做杠杆检查 → **限额基数错**。

**修复**：启动查一次 `userAbstraction`（权重 20）并缓存；unified 时合并两个端点。**这是上 mainnet 的 P0。**

### P0-4 持仓不显示清算价（官方字段白送未取）

`remote.js:470-500` 的 `assetPositions` 映射只保留 6 个字段。已用检索确认 `lib/` 与 `src/client/` 下 `liquidationPx` / `marginUsed` / `returnOnEquity` / `cumFunding` **全部零命中**。

官方 `clearinghouseState` 的每个 position **自带 `liquidationPx`**，`marginUsed`、`returnOnEquity`、`cumFunding`、`maxLeverage` 也都白送。**加 5 行映射即可**，但永续交易者最需要盯的数字当前完全看不到。

**顺带一个实测 bug**：`tools.js:235` 的 `p.leverage?.leverage ?? p.leverage` —— live 模式下 `p.leverage` 是 `{type:'cross', value:3}` 对象，`?.leverage` 取不到 → 回退到整个对象 → 输出 `lev=[object Object]x`。paper 模式存的是数字所以测试全绿，**这个 bug 被 paper 测试掩盖了**。

### P0-5 TP/SL 的 OCO 语义在文档中完全未告知

当前用 `grouping:'normalTpsl'` 提交子单（`remote.js:879-891`）。官方语义：**子单仅当父单完全成交（或部分成交后因保证金不足被撤）才挂出；手动部分撤父单会导致子 TP/SL 被完全撤销。**

已核实：`README.md`、`skills/hyperliquid-trading/SKILL.md`、`lib/tools.js:274` 的工具描述中**没有一处提到这条**。

⇒ 最可能造成实际资金损失的用户误解：用户挂 IOC 带 5% 止损，部分成交后止损子单**永远不会挂出，且不报错**（`remote.js:760` 只检查 statuses 长度）。

**修复**：在 README / SKILL.md / 工具描述三处明确；票据 UI 上用一句常驻提示。

### P0-6 无自动对账 → `submitting` / `unknown` 是永久孤儿

`remote.js:750` 先落 `submitting` 再提交。若进程在两者之间崩溃，记录**永远停在该状态**，无任何代码会去看。`account()` 读交易所、`live-orders.json` 读本地意图，**两者从不比对**。

好消息：错误信息已经主动引导 agent 去 `orderStatus` 对账（`remote.js:756`），设计意识是对的，缺的是自动化。

**修复**：启动时 + 每 N 分钟扫描非终态记录 → `orderStatus` 核对 → 收敛状态 + 告警。

---

## 2. 🟡 P1 — 架构与性能

### 2.1 渲染：0 selector、0 memo，是当前最大的性能缺口

`store.ts:75-77`：
```ts
export function useStore(): DeskState {
  return useSyncExternalStore(store.subscribe, store.get, store.get)
}
```
已检索确认：`React.memo` / `useSyncExternalStoreWithSelector` / `shallow` 在整个 `src/client/` **零命中**。6 个组件（app / desk / chat / sessions / ticket / picker）全部订阅全量 store，`store.patch` 每次造新对象并通知**全部**订阅者。

**两处最小改动就能砍掉大部分无效渲染**：
1. `data.ts` 的 eventsSeq patch **无论有无事件都执行** → 加一句 `if (res.seq !== store.get().eventsSeq)` 判断。**一行，砍掉 50% 的重渲染，投产比最高。**
2. 引入 `useStoreSlice(selector)`，给 6 个组件各配选择器。

### 2.2 Chart 每帧全量 setData —— 980 个点/帧

`candle-chart.tsx` 用 lightweight-charts（✅ 用对了），但数据 effect 每次触发对 7 个 series 各 `setData` 全量 140 点（bar/volume/sma/ema20/ema50/boll上/boll下），默认配置下 **980 点走 O(n log n) 的 setData**，而正确做法是首帧 `setData`、后续 `series.update(lastBar)`。

另：`chart-indicators.ts:46-48` 的布林带是 **O(n²)**（每位置 `slice()` 分配数组）；`MAX_CANDLES=140` 而宿主按周期给 288~360 根，**浪费 50%+ 的载荷和计算**。

### 2.3 格式化和图表动画是持续性开销

`format.ts:15` 每次 `toLocaleString` 都分配新的 options 对象，全局仅 3~4 种小数位 → **可预建 5 个 `Intl.NumberFormat` 实例复用**。此外 `desk-column.tsx:182` 与 `candle-chart.tsx:257` 每帧 `new Date().toLocaleString()`。

### 2.4 图表主题监听可能触发重建风暴

`candle-chart.tsx:143` 的 MutationObserver 监听 `documentElement` 的 `style` 属性。宿主任何写在 `<html style>` 上的动画都会触发 marks effect 重跑 → **销毁重建全部 priceLine 与趋势线**。建议改为只监听 class/主题属性。

### 2.5 REST 权重核算：live 常态占预算 37%，双标签页即击穿

官方限制：**IP 聚合 1200 权重/分钟**；`l2Book`/`allMids`/`clearinghouseState` = 2，`frontendOpenOrders` = 20，`candleSnapshot` = 20 + 每 60 根 +1。

单用户（面板常开、WS 健康）核算：
| 来源 | 权重/分钟 |
|---|---|
| `account()` × 20（3s 轮询）：`clearinghouseState`(2) + `frontendOpenOrders`(20) | **440** |
| `markets()` × 6（10s TTL） | 120 |
| `snapshot()` × 67（WS 命中） | **0** ✅ |
| **合计** | **≈560 / 1200（47%）** |

**架构决策是对的**（浏览器只轮询宿主，WS 命中让 0.9s 高频轮询零权重），但两处浪费：
- **`account()` 是唯一大头**：宿主 `hl.js:225-228` 已实现 `userFills`/`userEvents` WS 通道却从未订阅 → 改 WS 驱动可把 440 降到接近 0。
- **`frontendOpenOrders` 的 `.catch(() => [])` 是危险静默**：地址维度限流后（官方：限流后 10 秒 1 请求）会**静默返回空数组**，UI 显示「无挂单」而实际有挂单。**建议改为显式 `stale: true` 或抛错。**
- **`candles()` 无缓存**（`remote.js:453`）：切币/切周期每次全量拉，单次约 23~26 权重，多会话并发切换会叠加。宿主已有 markets/catalog/detail 三级缓存，就差 candles。

### 2.6 多会话串味

`remote.js:121` 的 `this.desk` 是全局单点，`deskState()` 可被任何客户端改写。两个面板各看不同币时**最后一个调用赢**，而系统提示词（`index.js:105`）会把「当前交易台焦点」告诉**所有** agent。`store.paper` 同理——**所有会话共享一个 paper 账户**。

**测试只覆盖了「后台 agent 不移动可见面板」，反向（多 UI 互相覆盖）无覆盖。**

### 2.7 下单路径的 TOCTOU

`checkLiveOrder`（含 guard.validate，读交易所状态）与 `guard.reserve` 之间隔着**人工审批**（可能几十秒）。两个并发下单可同时通过基于同一快照的 `maxPositionUsd` 检查。`reserve()` 本身在单进程内因全同步 I/O 而原子，但**仓位约束会破**。

另外 `guard.consume` 在 `checkLiveOrder` **之前**调用（`remote.js:721` → `:722`），网络抖动会烧掉一次性决策。方向上这是**保守的（宁可重决策，不可重复下单），对资金安全是正确的**，但 30s TTL 在抖动下形同虚设。改造成本不低（会扩大重放窗口，需配合 cloid 幂等），属 P2。

### 2.8 可观测性接近于零

`lib/` 下**零 logger 调用**（唯一一处 `index.js:75` 是启动时的 warn）。无 metrics、无请求计数、无 REST 权重追踪，`hl.js:90` 的 `throws` 字段是**从未递增的死字段**。生产故障排查会很痛苦。

### 2.9 store 的崩溃恢复策略不一致

`live-orders.json` / `live-decisions.json` 损坏 → **抛错拒绝启动**（fail-closed，正确）；但 `paper.json` 走 `#readJson` **静默回退默认值** ⇒ **paper 账户权益重置为 10 万美元**。另外所有落盘**无 schema version、无迁移**，旧文件缺字段会在 `paperFill` 里炸 `TypeError`。

### 2.10 `live-bridge.mjs` 的 CORS 与方法集

`Access-Control-Allow-Origin: '*'` + METHODS 里含真实 marker 列表没有的 `orders`。当前 paper 模式无资金风险，但**这是一个「改一行配置就变成无鉴权 live 交易 API」的隐患**。

---

## 3. UI 交互一致性（对标官方）

### 3.1 最大的结构性差异：下单模型不同

| 官方 app | 当前 |
|---|---|
| 票据 → **直接产生订单** → 立即回执 | 票据 → **拼一段中文自然语言发给 agent**（`trade-ticket.tsx:85-94`）→ agent 判断后调工具 → 回话聊天窗口 |
| 有 pending/filled/rejected 状态 | **无任何回执**，提交后票据关闭 |
| Cancel All 一键撤单 | 无；单笔撤单也要走 agent 对话往返 |
| 票据常驻右侧 | 藏在 toggle 后（`chat-column.tsx:118`） |

⇒ **这不是「缺功能」，是交互模型不同。** 官方是「确定性下单 + 即时回执」，当前是「意图转交 + 对话式执行」。如果目标是「与官方交互一致」，这是最需要决策的一项——**要么承认这是 agent-native 交易台（那要在回执链路上补齐确定性），要么补一条直通下单路径（那会动摇「所有下单都经过会话」这个核心不变量）**。

### 3.2 做得好、建议保留的（部分优于官方）

- **市场选择器**（`market-picker.tsx`）：搜索 + 相关性排序 + 7 个分类 + 5 列可排序 + 自选收藏 + 完整键盘导航。官方都没有这些。
- **K 线**（`candle-chart.tsx`）：14 个周期齐全、成交量副图、SMA/EMA/BOLL/RSI/MACD 多窗格、全屏、crosshair OHLC。**指标体系超出官方**。
- **Agent 图表标注**：支撑/阻力/趋势线画在图上——官方没有的自有功能。
- **异常处理质量**：行情过期五重判定并**阻断下单**（`app.tsx:119` + `trade-ticket.tsx:60`）；paper 不支持触发单的错误信息**给了两个明确出路**，且在四处（票据 / tools / SKILL / README）表述一致。
- **`document.hidden` 暂停轮询 + 恢复即补拉**（`data.ts:205-210`）——比多数实现都好。

### 3.3 明确缺失的官方交互

| 项 | 现状 | 位置 |
|---|---|---|
| IOC / GTC / **Post-only(ALO)** 选择 | 宿主支持 `tif`（`remote.js:715`），**UI 完全没暴露** | `trade-ticket.tsx` |
| **盘口价格闪烁动画**（HL 标志性交互） | 无 | `book-card.tsx` 全文 |
| 中间价醒目大字 | 只用于算价差%，不显示 | `book-card.tsx:49,91` |
| 25/50/75/100% 数量快捷按钮 | 只有滑杆 | `trade-ticket.tsx:113` |
| 杠杆滑杆 | `<select>` 下拉 50 项 | `trade-ticket.tsx:101` |
| TP/SL 图表拖拽 / 百分比快捷 | 纯手输数字 | `trade-ticket.tsx:119-120` |
| unfilled-only 过滤、Cancel All | 无 | `bottom-table.tsx` |
| 持仓 ROE% / 清算价 / 保证金 / 已实现盈亏 | 无（宿主也没返回，见 P0-4） | `bottom-table.tsx:52-55` |
| 快捷键（B/S 切换、Enter 下单等） | 只有 `/` 和 `Esc` | `desk-column.tsx:54-68` |

### 3.4 健壮性：零错误边界

`ErrorBoundary` / `componentDidCatch` 全仓库零命中。**任一面板抛错 → 整个 desk 白屏，持仓上下文全丢**。已识别的高危点：`candle-chart.tsx:209` 的 `r.signal!` 非空断言（若 `addPane` 抛错则后续必崩）。

另有一个**最恶劣的静默故障模式**：`data.ts` 的 `pendingSnapshots` + `remote.ts` 的 `hyperCall` **无超时** ⇒ 一次挂起的 RPC 会让该 `coin:interval` 的快照轮询**永久死亡**，行情冻结在旧数据上且**顶栏仍显示 WS 正常**。

---

## 4. 系统能力缺口（对照官方基线）

| 官方能力 | 现状 | 实现成本 |
|---|---|---|
| **Stop Market / Stop Limit** | ❌ | 🟢 低（`protectionOrders` 模板已有，约 1h） |
| **fast cancel** | ❌ | 🟢 **极低**（`signing.js` 白名单加一个字段，30min）—— 官方明确这是撤单最快方式，当前普通撤单在极端行情可能排在一堆 IOC 后面撤不掉 |
| **Trailing Stop** | ❌ | 🟡 中 |
| **批量下单** | ❌ | 🟡 中（官方 `exchange 权重 = 1 + floor(n/40)`，40 单内权重恒为 1；当前逐单 = N 倍。**但现有限额下每天最多 5 笔，优先级低**） |
| **priority fee（IOC/ALO）** | ❌ | 🟡 中。官方 **1bp ≈ 45ms 延迟**，ALO 有 400ms 竞拍窗口。对当前「人工确认的对话式交易」价值有限 |
| **HIP-3 可交易** | 只读 | 🟡 中。**基础设施已齐 60%**（asset→dex+index 映射、WS 实时 ctx、分类），差签名白名单 + 账户状态 + 风控三处 |
| **现货** | 只读 | 🔴 高。与 P0-3 强耦合，建议最后做 |
| TWAP / Scale / Chase | ❌ | Chase 官方明确「**在创建它的浏览器标签页里运行**」，与本架构（无头宿主）**根本冲突，建议不做** |
| 子账户 / vault / staking / referral | ❌ | ⚪ 与「单账户严格限额」的产品定位冲突，**建议不做**。但 `signing.js:124-128` 的 vault 签名支持是死代码，应在 README 声明不支持以免误配 |

**`orderStatus` 的 29 个状态值**中，自建系统最容易漏且最难自己复刻的：`marginCanceled`（成交时保证金不足）、`badAloPxRejected`（post-only 会立即成交）、`tickRejected`、`minTradeNtlRejected`、`perpMaxPositionRejected`、`siblingFilledCanceled`（OCO）、**`scheduledCancel`（dead man's switch）**。当前只把原始响应透传给 agent，**没有做语义翻译**——agent 需要自己解读字符串。

---

## 5. 已修（确认，避免重复劳动）

上午那份审计文档里的多条问题**在当前磁盘代码里已经修掉了**，且都补了回归测试：

| 问题 | 现状 | 证据 |
|---|---|---|
| `markets()` 每周期多发一次 REST | ✅ 只调 `metaAndAssetCtxs` | `remote.js:236-250`；`test/market-data.test.mjs:9` 断言 `metaCalls === 0` |
| paper 轮询绕过 WS 快照打 REST | ✅ `safeMids` 先查 snapshot | `remote.js:947-956` |
| WS 单定时器吞掉其他 key 的重试 | ✅ 改 `Map<key, timer>` | `hl.js:93,268-290` |
| 事件 kind 只精确匹配 `'live.order'` | ✅ 改前缀匹配 | `store.js` 发 `live.order.<status>`；`test/markers.test.mjs:56` 断言 |
| `live.decision` 不落盘 | ✅ 落盘 + 事件 | `store.js:199-209`；`test/store.test.mjs:143-149` |
| 浏览器可直呼下单方法 | ✅ marker 已收敛，交易方法不暴露 | `remote.js:959-965`；`test/markers.test.mjs:54-55` 断言 |

> 另注：`npm test` 实跑全绿。但要注意 `test/store.test.mjs` 全是 paper 用例——**live+mainnet 路径零测试**，这正是 `tools.js:235` 杠杆 bug 能活下来的原因。

---

## 6. 建议路线图

### 批次 0（半天，零风险）
1. **`export const Config`**（P0-1）—— 一行，验证 `cordis.patch.yml` 是否能过 schema
2. `data.ts` eventsSeq 加变更判断（2.1-①）—— 一行，砍 50% 重渲染
3. `format.ts` 预建 `Intl.NumberFormat`（2.3）
4. `hyperCall` 加超时（3.4）—— 消除「永久静默冻结」
5. 加 3 个 ErrorBoundary（3.4）
6. 修 `tools.js:235` 杠杆显示 bug（P0-4 附带）

### 批次 1（1-2 天，让 paper 像个合格的交易台）
7. **paper 接入 guard**（P0-2）
8. **paper 保证金模型**：margin tier + 保证金占用 + 拒绝对抗保证金的仓位
9. paper 撮合改为**吃盘口逐档计算 VWAP**（替代固定 5bp）
10. paper 风险横幅（顶栏 + 工具返回 + SKILL/README 四处一致）
11. `useStore` 加 selector + 6 个组件配置（2.1-②）
12. Chart 改增量 `update`（2.2）

### 批次 2（2-3 天，交互对齐 + live 上线前）
13. **`account()` 改 WS 驱动**（省 440 权重/分）+ `frontendOpenOrders` 静默失败改显式 stale（2.5）
14. **持仓字段补全**：透传 `liquidationPx`/`marginUsed`/`returnOnEquity`/`cumFunding`（P0-4）
15. **UI 补齐**：IOC/GTC/ALO、Cancel All、unfilled-only、ROE%/清算价列、盘口闪烁、中间价大字、数量快捷键、杠杆滑杆
16. **下单回执链路**：提交后进 pending，宿主 `live.order.*` 事件驱动显示成交/失败（3.1）
17. **自动对账循环**（P0-6）+ 撤单/杠杆/签名落盘
18. **账户抽象模式处理**（P0-3）—— **mainnet 前必做**
19. TP/SL OCO 语义三处文档化（P0-5）
20. `candles()` 加缓存 + 客户端节流对齐宿主 TTL

### 批次 3（能力对标，按需）
21. Stop Market/Limit（低垂）→ fast cancel（安全相关）→ 订单状态语义翻译表
22. priority fee / Trailing Stop / 批量下单
23. HIP-3 可交易（基础设施已齐 60%）
24. 现货（最后做，与 P0-3 耦合）

**明确建议不做**：Chase（与无头宿主架构冲突）、TWAP/Scale（与产品定位不匹配）、子账户/vault（与严格限额定位冲突）。

---

## 7. 一个观察

这个项目有个明显的反差：**最难的工程做到了字节级正确**（EIP-712 签名与官方 Python SDK 逐字节对拍、local 与 web3 双路径交叉验证、marker 契约做成静态断言测试），**最简单的工程漏了**（导出一个变量）。

后者恰好是导致「所有限额声明都是死代码」的那一个。建议从批次 0 开始——一行代码，堵住整条配置链路。

---

## 8. 基于当前代码的优化计划（2026-10-14 复核）

### 8.1 已完成、部分完成、仍待处理

| 审计项 | 当前状态 | 复核依据与边界 |
|---|---|---|
| P0-1 配置 schema 未导出 | **已修** | `index.js` 导出 `Config`；`test/account-data.test.mjs` 覆盖默认值及非法网络/金额。仍需在真实 DSH 宿主配置中验收。 |
| P0-3 账户抽象模式 | **部分完成** | `lib/remote.js` 已按 `userAbstraction` 区分 Standard 与 Unified/Portfolio，后两者读取 `spotClearinghouseState` 的 USDC，并用 `activeAssetData` 约束核心永续可交易额度；未知模式与无效响应拒绝继续。全 Portfolio 估值、跨 DEX 风险聚合及非 USDC 抵押物换算仍未完成，不能把当前 USDC 数字称为全账户权益。 |
| P0-4 持仓风险字段 | **已修基础读取与显示** | `liquidationPx`、`marginUsed`、`returnOnEquity`、`cumFunding` 已透传；杠杆文本不再输出对象。需用真实有仓账户复核不同账户模式下的字段空值与单位。 |
| P0-5 TP/SL 条件单语义 | **已修文案及回执检查** | README、交易 skill、工具描述与票据均提示 `normalTpsl` 父子单条件和部分成交风险；提交时逐项检查返回状态。实际保护是否挂出仍须以订单和持仓对账为准。 |
| P0-2 paper 风控与仿真 | **部分完成** | paper 下单已接入允许币对、单笔、每日、仓位、杠杆与保证金校验；paper 日额度独立落盘，账户展示已用/可用保证金，减仓保留退出通道。撮合仍为固定滑点，未模拟盘口深度、手续费、资金费或强平；模拟收益仍不能用于 live 策略验收。 |
| P0-6 自动对账 | **未修** | `submitting`、`unknown`、`protection-unknown` 有持久化记录，但无启动恢复和定期收敛。 |
| 2.5 账户读取与 REST 权重 | **部分完成** | 已订阅 `allDexsClearinghouseState`，新鲜且地址匹配时显示全 DEX 仓位；失效时退回所选 DEX REST。挂单仍每 3 秒调用 `frontendOpenOrders`，K 线也未缓存。读取失败已显式报错，不再把失败伪装成空挂单。不能沿用原文的固定权重节省估算。 |
| 2.1–2.4 客户端性能 | **未修** | `eventsSeq` 未变时仍 `patch`；`useStore()` 无 selector；图表每次对所有序列 `setData`；主题监听包含 `style`；数字格式化仍在热路径新建 options。 |
| 2.6–2.10 架构与恢复 | **部分完成** | 损坏的 `paper.json` 现拒绝启动，避免模拟权益静默重置；全局 `desk` 焦点、共享 paper 账户、审批期间的并发仓位竞争、观测缺失、开发 bridge 的宽 CORS 仍待处理。 |
| 3.1 / 3.4 会话回执与故障隔离 | **未修** | 票据可投递到嵌入的 DSH 原生会话，但缺少关联意图 ID 的 pending/accepted/filled/rejected 回执；RPC 无超时，面板无错误边界。 |
| 4 扩展交易能力 | **未修或只读** | 核心永续 live 下单、撤单、杠杆和 testnet TP/SL 已有；HIP-3 与现货只有行情/账户读取，不允许签名下单；触发单、批量、优先费等仍缺。原文对 fast cancel 和触发单工期的估算未经签名向量及交易所验收，不作为承诺。 |

本次复核执行了 `npm test`、`npm run typecheck`；并用公开 testnet 地址收到真实 `allDexsClearinghouseState` WS 快照。**这只验证了读取链路，未证明该地址能签名或完成真实成交**。宿主是否已加载新代码也未在本次复核中验证。

### 8.2 执行顺序与验收门槛

#### 第一阶段：交易与账户可信度（阻断 live 扩面）

1. **继续提高 paper 仿真真实性。** 基础硬限额、保证金占用、独立日额度及减仓退出通道已实现并覆盖交易行为测试；下一步用盘口深度计算可成交数量和 VWAP，建模手续费、资金费与清算或明确停止条件。所有模拟缺口继续在工具和 UI 标注。验收：薄盘口、跳价、部分成交、资金费跨小时、清算阈值、反手、并发下单和重启恢复均有行为测试；paper 结果不再依赖无限流动性假设。
2. **把订单意图变成可恢复的状态机。** 对 `decisionId`/`cloid`/交易所 `oid` 建立关联；启动时与定期扫描 `submitting`、`unknown`、`protection-unknown`，调用 `orderStatus`、挂单和成交记录收敛状态。网络超时保持“未知”并阻止同一意图直接重下；TP/SL 以真实挂单和仓位确认保护状态。撤单、杠杆修改同样持久记录。验收：在发送前、发送后未收到回执、部分成交、父单撤销等断点注入故障，重启后既不重复开仓，也不把未受保护仓位标成安全。
3. **在审批之后再次预检并串行化额度。** 当前预检与最终发送之间可经过长时间审批；发送前重读价格、账户、挂单及未决风险占用，在同一钱包/风险预算下为并发订单保留额度。一次性决策的消费点需与 cloid 幂等和异常恢复一起设计。验收：两个同时通过初检的订单不能合计突破仓位/日限额；审批期间价格或余额变化会拒绝旧意图。
4. **明确账户与抵押物单位。** 对每个 DEX 标出 collateral token、计价单位、账户模式和数据时间；跨 DEX 风险只在完成可靠换算后汇总。若覆盖不足，显示“仅所选 DEX”并阻断依赖全账户敞口的自动下单。Unified/Portfolio 不以单一 USDC 余额代替完整账户价值。验收：Standard、Unified、Portfolio、HIP-3 多 DEX 的模拟响应与真实只读数据均不发生单位混用；过期/缺失数据 fail closed。

#### 第二阶段：高频数据与原生会话体验

5. **治理轮询与渲染。** `eventsSeq` 相同不 `patch`；给组件加选择性订阅和稳定比较；图表首帧 `setData`、同一周期新 K 线用 `update`，切币/切周期才全量重置；复用数字格式器，去掉主题 `style` 监听。K 线加按币种/周期和时间边界的宿主缓存；挂单使用事件触发刷新加低频兜底，并标记数据新鲜度。验收：记录同一行情流下的渲染次数、图表全量写入次数、REST 请求与权重；多标签页测试不触发限流，断线后能自动恢复。
6. **显式显示“数据还能不能用于决策”。** 为快照、账户、挂单和 RPC 设置超时/最后成功时间/错误态；超时必须释放 `pendingSnapshots`，并可再次拉取。对会话、行情和账户面板设置错误边界，不让单个面板异常导致整个桌面白屏。验收：注入永久挂起 RPC、WS 断线、429、坏响应和组件异常，页面出现明确过期提示，恢复后自动继续；过期行情不能下单。
7. **补齐会话投递到执行的可追踪回执。** 票据生成结构化 intent ID，原生 DSH 会话在原位展示受理、agent 决策、审批、提交、交易所确认、部分成交/失败及对账结果；订单表和会话引用同一意图。右侧保持原生会话为主，手动票据作为辅助入口；不新增绕过 agent 的浏览器直下路径。验收：从盘口价格或票据发起、撤单、审批、成交、失败、恢复后均能定位到同一条会话意图。
8. **隔离会话焦点。** 按会话保存 coin/interval/图表标注和未决意图；同一用户的两个面板不能互相改写焦点。paper 资金域明确为“同一钱包共享”还是“每会话独立”，实现时在 UI 与工具中保持一致。验收：两会话同时看不同市场、切换图表和提交意图，system prompt 与各自可见市场一致。

#### 第三阶段：行情交互和交易能力扩展

9. **完善 Hyperliquid 式行情操作。** 优先做盘口中间价与价差层级、价格变化提示、深度点击填票据、K 线与订单/止盈止损标注联动、订单/持仓筛选和撤单入口；保留 DSH 主题与右侧会话主视觉。IOC/GTC/ALO、数量快捷档、杠杆控件与键盘操作都必须产生清晰的会话意图和回执。验收：键盘、鼠标、拖拽、三个区域折叠/展开及移动端宽度做交互回归，拖拽取消后不残留状态。
10. **按风险边界扩充执行类型。** 顺序为订单状态语义翻译、Stop Market/Limit、HIP-3 签名与抵押物风控、fast cancel、批量与优先费；现货在资产/余额/精度/签名边界明确后再做。每类动作先核对官方协议与签名向量，再接入 DSH Web3，最后在 testnet 跑创建、部分成交、撤单、过期、拒绝和重启对账。未经真实验收的市场继续只读，不因行情已接入而标成“可交易”。

#### 上线门槛与维护项

- **真实验收**：先确认 DSH 宿主运行的是当前代码；使用隔离且已注资的 testnet 钱包，逐项验证读行情/账户、签名、限价与市价、撤单、杠杆、TP/SL、部分成交和故障恢复。记录订单 ID、时间、交易所回执及最终状态。此前的只读 WS 测试不能代替签名交易验收。
- **可观测性与存储**：加入不记录私钥/签名内容的结构化日志、请求权重和 WS 新鲜度指标；`paper.json` 已在损坏时拒绝静默重置，后续增加 schema 版本及迁移测试。`scripts/live-bridge.mjs` 限定为本地开发用途，并收紧 Origin/方法集。
- **发布约束**：核心永续 live 在第一阶段门槛通过后再扩大自主交易范围；HIP-3/现货分别通过第三阶段的签名、风险与真实 testnet 验收后才开放。保留 `hyper_decide` 的一次性决策与宿主工具权限边界。

### 8.3 与原路线图的调整

原文“补一条浏览器直通下单路径”的备选方案与已确认的产品方向不一致：**交易先交给 DSH 原生会话决策**。因此优先建立结构化意图和确定性回执，而不是把右侧改为手动下单主面板。原文将触发单、fast cancel 估为“一小时/三十分钟”也缺少签名与交易所状态验证；以阶段三的验收门槛替代时间承诺。
