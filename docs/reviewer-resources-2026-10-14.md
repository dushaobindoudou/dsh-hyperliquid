# dsh-hyperliquid 官方资源索引（2026-10-14）

供实现 agent 使用。背景与本地缺口见 [审计报告](./audit-2026-10-14.md)；品牌资产的已核验路径见 [品牌与交易页研究](./research-hyperliquid-logo-and-trade-ui.md)。以下协议事实均以 Hyperliquid 官方文档或官方 Python SDK 为准；实施前重读链接中的现行定义。

## 订单与 TP/SL

- [订单类型](https://hyperliquid.gitbook.io/hyperliquid-docs/trading/order-types)：限价的 GTC、ALO、IOC；Reduce Only；Stop/Take 的 Market/Limit 语义。不要仅凭交易页文案推断 API 类型。
- [TP/SL 专页](https://hyperliquid.gitbook.io/hyperliquid-docs/trading/take-profit-and-stop-loss-orders-tp-sl)：**标记价格**触发；市价 TP/SL 的官方滑点容忍度为 10%；限价 TP/SL 触发后仍可能挂在盘口。仓位关联的 TP/SL 默认跟随全仓位，指定数量后变为固定数量；父订单关联的子单在父单未完全成交时处于未触发状态，取消未成交父单会取消子单。为票据实现保护单时要明确选哪种语义。
- [Exchange endpoint：Place an order](https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/exchange-endpoint#place-an-order)：`order.orders[]` 中 `t.trigger = {isMarket, triggerPx, tpsl: "tp"|"sl"}`；`r` 是 reduceOnly；`grouping` 允许 `na`、`normalTpsl`、`positionTpsl`；`c` 可放 128 位十六进制 cloid。批量父单与保护单的具体回执及取消联动，先在 testnet 验证，再开放 UI。官方[错误表](https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/error-responses)明确列出非 reduce-only TP/SL 的整批预校验拒绝，以及 `BadTriggerPx`。
- [官方 Python SDK 签名测试](https://github.com/hyperliquid-dex/hyperliquid-python-sdk/blob/master/tests/signing_test.py)含 trigger order 向量；扩展本仓库 `lib/signing.js` 时用它对拍。现有 `canonicalAction` 仅支持 `order`、`cancel`、`updateLeverage` 三类 action；`order` 已有 `grouping` 字段，但 trigger 内容及 grouping 值缺少专项校验/对拍。新增 `modify`、`cancelByCloid`、逐仓保证金动作时需扩充签名白名单和向量测试。

## 交易动作与对账

- [Exchange endpoint](https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/exchange-endpoint)：`POST /exchange` 的 `order`、`cancel`（asset+oid）、`cancelByCloid`、`modify`、`batchModify`、`updateLeverage`、`updateIsolatedMargin` 均在此页。`updateLeverage` 传 `asset`、`isCross`、整数 `leverage`；`updateIsolatedMargin.ntli` 用 6 位小数表示 USDC 增减，另有 `topUpIsolatedOnlyMargin` 按目标杠杆调整。不要把“切换全仓/逐仓杠杆”和“追加/减少逐仓保证金”合成一个动作。
- 同页 `modify` 可按 oid 或 cloid 指定旧单，并提交完整新订单；当前文档增加可选 `a`（always_place）：`a=true` 即使旧单取消失败也放新单；省略/false 时新单必须是非 trigger 且符合 ALO 或不可立即成交的 GTC 约束。为保护单编辑设计失败语义时必须处理这一差异。[官方 SDK 基础下单示例](https://github.com/hyperliquid-dex/hyperliquid-python-sdk/blob/master/examples/basic_order.py)演示下单回执、按 oid 查询、撤单。
- [Info endpoint：orderStatus](https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/info-endpoint#query-order-status-by-oid-or-cloid)供超时/未知回执对账，支持 oid/cloid；状态表含 `filled`、`canceled`、`triggered`、`siblingFilledCanceled` 等。查询账户用主账户或子账户的**实际地址**，不能用 agent wallet 地址。[资产 ID](https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/asset-ids)和[价格/数量精度](https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/tick-and-lot-size)用于任何新下单/改单预检，尤其 builder perp 和 testnet ID 不可硬编码。

## 实时行情与订单状态

- [WebSocket 入口与断线恢复](https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/websocket)：mainnet `wss://api.hyperliquid.xyz/ws`，testnet `wss://api.hyperliquid-testnet.xyz/ws`；官方要求处理服务端断连并重连，缺失数据由重连快照或对应 Info 查询补齐。
- [订阅协议与字段](https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/websocket/subscriptions)：`candle {coin, interval}`（`t/T/s/i/o/c/h/l/v/n`）、`l2Book {coin}`（每侧 `px/sz/n`）、`trades {coin}`、`orderUpdates {user}`（`order/status/statusTimestamp`）、`userFills {user}` 和 `userEvents {user}` 是不同通道。`userFills` 首帧可带 `isSnapshot: true`；取消订阅须传与订阅完全相同的对象。[官方 SDK 订阅示例](https://github.com/hyperliquid-dex/hyperliquid-python-sdk/blob/master/examples/basic_ws.py)覆盖这些通道。
- 对应审计 P-4/P-5：本仓库 `lib/hl.js` 已有 candle 通道但 `lib/remote.js` 未消费；接入时按 `coin:interval` 管理订阅、断线重建和每条失败订阅的重试。`orderUpdates` 用于订单状态，成交与资金变化仍看 `userFills`/`userEvents`，不要仅从订单更新推算成交。冷启动的 REST 备份见 [Info endpoint：candleSnapshot/l2Book/recentTrades](https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/info-endpoint)。
- [限流](https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/rate-limits-and-user-limits)：REST 是按 IP 聚合权重限制；`l2Book`、`allMids`、`orderStatus` 权重 2，其余多数 Info 查询权重 20，`recentTrades` 等另按返回条数计。优先复用宿主 WS 快照，对 REST 回退限频。

## 官方品牌素材

- [Hyperliquid Brand kit](https://hyperliquid.gitbook.io/hyperliquid-docs/brand-kit)提供 SVG/PNG logo、横幅和 Hypurr。现有 `icon.svg` 与 `src/client/components/brand-mark.tsx` 已使用官方 SVG 路径；继续从 kit 原文件取素材，遵守现有[品牌研究](./research-hyperliquid-logo-and-trade-ui.md)记录的留白、颜色、变形限制。若要更新素材，先比对官方 kit 与仓库资源，不必重新描摹 logo。
