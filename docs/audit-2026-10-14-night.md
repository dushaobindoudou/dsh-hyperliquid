# 审计：对标 Hyperliquid 原生交易系统的差距清单（2026-10-14 晚，对账版）

> 基准：当前磁盘代码 + 官方文档（WS Subscriptions / Exchange Endpoint）。
> 与前两份审计的关系：`audit-2026-10-14.md`（上午）与 `audit-2026-10-14-evening.md` 中的多项 P0 **已在当前代码修复**，本清单只保留**当前仍成立**的差距，已逐条用代码复核。

## 0. 已修、勿再列为缺口（复核结论）

- `index.js:38` Config 已导出，schema 校验生效（有回归测试）。
- 持仓风险字段（ROE/清算价/保证金/累计资金费）已在 `bottom-table.tsx:63-72` 展示。
- **paper 已接入 TradingGuard**：`remote.js:839-844` 独立 `paperGuard`（paper-budget.json）做 validate/reserve/release；`remote.js:850` 返回值带 `simulation` 字段声明模拟简化。
- 账户抽象（userAbstraction/unified/portfolio）有 `account-data.test.mjs` 覆盖。
- 上午六项小修（markets 去冗余 / safeMids / 重试单定时器 / 事件前缀匹配 / decision 落盘 / marker 收敛）均已落地。

---

## 1. 架构差距

| # | 差距 | 现状 | 官方能力 |
|---|------|------|----------|
| A1 | **用户事件通道未接** | `hl.js` 已实现 `userFills`/`userEvents`/`orderUpdates` 订阅能力但从未订阅；账户数据全靠浏览器 3s 轮询 `account()`（clearinghouseState 2 + frontendOpenOrders 20 权重 × 20 次/分 ≈ 440 权重/分） | `orderUpdates`/`userFills`/`userFundings`/`clearinghouseState` 全部可 WS 推送；接入后账户延迟从秒级轮询 → 推送级，且权重近乎归零 |
| A2 | **订单簿无增量** | 上游 l2Book 每帧全量覆盖快照，浏览器 0.9s 全量拉 | 官方有 `bbo` 轻量通道；l2Book 支持nSigFigs/mantissa 参数化；做高频需要本地 diff 层 |
| A3 | 事件环仅内存 | `store.js` 事件环重启即丢，靠 3s 轮询兜底 | —（自定标准） |
| A4 | `candles()` 无缓存 | 切币/切周期每次全量 REST（~23-26 权重） | markets/catalog/detail 已有三级缓存，唯独它没有 |
| A5 | `frontendOpenOrders().catch(()=>[])` | 限流后 UI 显示「无挂单」而实际有 | 应显式失败并保留上一次数据 + stale 标记 |

## 2. 性能差距（实测/行号级）

| # | 问题 | 位置 | 影响 |
|---|------|------|------|
| P1 | `eventsSeq` **无条件 patch**（每 0.9s 造新对象） | `data.ts:212`，patch 在 `if (events.length>0)` 之外 | `useStore` 无 selector + 全库零 React.memo ⇒ 0.9s 全部 6 个订阅组件重渲染。**一行修复：seq 变更才 patch** |
| P2 | 图表每帧全量 `setData` | `candle-chart.tsx:178-184`，7 series × 140 点 ≈ 980 点/帧 | 应首帧 setData + 之后 `series.update(lastBar)`；`chart-indicators.ts:46-48` 布林带 O(n²)；MAX_CANDLES=140 而宿主给 288+ 根 |
| P3 | `hyperCall` 无超时 | `src/client/remote.ts:44`，`pendingSnapshots` 同样无超时 | 一次挂起 RPC 让该币行情**永久冻结**且顶栏显示正常 |
| P4 | Intl options 每次分配 / MutationObserver 监听 `documentElement.style` | `format.ts:12-16`、`candle-chart.tsx:143` | 微开销 + 宿主动画即触发标注线重建 |
| P5 | 全库无 throttle/debounce | grep 零命中 | 频率控制仅靠轮询间隔与 in-flight 去重 |

## 3. UI 交互差距（vs Hyperliquid 官方前端）

**最大差异 = 下单模型**（需用户决策）：官方是「确定性下单 + 即时回执」；当前票据把指令拼成自然语言发给 agent 走对话往返，无 pending/无成交回执。`live.order.*` 事件宿主已产生、UI 未消费。两条路：
① 补回执链路（pending → filled/cancelled 状态机，保留 agent-native 不变量）；
② 加直通下单路径（会动摇「所有下单经会话」的核心设计）。

| # | 缺失 | 备注 |
|---|------|------|
| U1 | 下单回执状态链 | 事件已就绪，差 UI 消费 |
| U2 | 图上持仓成本线 | entry 只在表格显示；官方图表画 entry/清算价线 |
| U3 | ALO（post-only）UI 未暴露 | 后端已支持（tif 白名单含 Alo） |
| U4 | Cancel All / 一键平仓 | 只有单笔撤单、单笔 reduceOnly 平仓 |
| U5 | B/S 切方向、Enter 提交等交易快捷键 | 只有 `/` 市场选择器与 picker 导航 |
| U6 | 零 ErrorBoundary | 任一面板抛错 → 整桌白屏 |
| U7 | fills 无分页；无 funding 结算记录 tab | |

已有且**超出官方**：市场选择器（搜索+分类+排序+自选+完整键盘导航）、K 线指标体系（SMA/EMA/BOLL/RSI/MACD 多窗格）、agent 图表标注、`document.hidden` 暂停轮询、行情过期阻断下单、盘口点击填单。

## 4. 系统能力差距（vs 官方 Exchange Endpoint）

| # | 能力 | 官方 | 当前 |
|---|------|------|------|
| S1 | fast cancel（`f:true`） | 撤单最快路径，参数级成本 | 无 |
| S2 | 批量撤单 / cancelByCloid / 批量改单 / modify | 原生批量 action | 无；canonicalAction 白名单仅 order/cancel/updateLeverage |
| S3 | 独立触发单 | trigger（isMarket: false = stop limit） | 仅 normalTpsl 分组保护单，且 mainnet 未开闸（testnet 已验收） |
| S4 | positionTpsl（仓位级 TP/SL） | 官方 grouping 第三种 | 无 |
| S5 | 裸 IOC 限价 | 三种 TIF 齐全 | market 内部用 Ioc，但对外 tif 白名单仅 Gtc/Alo |
| S6 | 自动对账循环 | orderStatus 29 个状态值 | 无扫描；`submitting/unknown` 是永久孤儿，靠 agent 手动查；状态仅透传原始字符串 |
| S7 | TWAP / trailing stop / scheduleCancel（dead man's switch） | 官方均有 | 无（前审曾建议不做 TWAP；若目标是「原生一致」需重新评估） |
| S8 | 可观测性 | — | 零 logger/metrics；`hl.js` throws 计数是死字段；expiresAfter 是签名桩，产品路径不可用 |
| S9 | iceberg | **官方也没有** | 不算差距，勿列 |

## 5. 测试缺口

- live+mainnet 全路径零测试（TPSL 分组 testnet-only，杠杆显示类 bug 曾因此存活）。
- 浏览器真实交互零测试：client-integration 用 React stub 不执行 effect → 轮询、票据提交、盘口点击填单均未测；playwright 冒烟只验证面板出现。
- `hl.js` unsubscribe/sweep 状态机、REST 限流行为无测试。

## 6. 建议优先级

- **P0（小改大收益）**：① `data.ts:212` seq 条件 patch（一行）+ `useStore` selector；② 图表首帧 setData + `series.update`；③ `hyperCall` 超时 + ErrorBoundary；④ A5 显式失败。
- **P1（体验一致关键）**：⑤ 下单回执状态链（消费 `live.order.*`）；⑥ 用户 WS 通道接入（orderUpdates/userFills → 实时账户，替代 3s 轮询）；⑦ fast cancel + Cancel All/一键平仓 + ALO UI。
- **P2**：⑧ modify/批量撤单；⑨ positionTpsl + mainnet TPSL 开闸；⑩ 图上成本线；⑪ candles 缓存；⑫ live/mainnet 测试补齐。
- **P3**：TWAP、trailing stop、scheduleCancel、增量簿、metrics、orderStatus 语义翻译。
