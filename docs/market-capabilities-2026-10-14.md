# Hyperliquid 行情能力与接口边界（2026-10-14）

行情区沿用 DSH 的主题和原生会话，只参考 Hyperliquid 的市场选择、行情头、图表与盘口交互。浏览器只访问本插件 `hyper/*` RPC；宿主再读取交易所数据。

| 市场 | 行情目录 | 选择后行情 | Agent 指标/画线 | 签名交易 |
|---|---|---|---|---|
| 核心永续 | `metaAndAssetCtxs` | WS/REST 盘口、成交、K 线 | 已接入 | 已接入现有限额与 dsh-web3 流程 |
| HIP-3 永续 | `allPerpMetas` 元数据 + `allDexsAssetCtxs` WebSocket 上下文 + `perpCategories` 分类；WS 不可用时选中币种按 DEX 读取上下文 | 盘口、K 线、标记价、成交额、资金费、未平仓量；无流动性时可为空 | K 线可用时可分析/标注 | **只读** |
| 现货 | `spotMetaAndAssetCtxs` | 盘口与 K 线；部分原始币名为 `@index` | K 线可用时可分析/标注 | **只读** |
| Outcome | testnet `outcomeMeta` 中的 Yes/No 市场已接入目录 | 选择后读取盘口推算中间价；无活跃盘口时可能为空 | K 线可用时可分析/标注 | **只读** |

市场选择器的 Strict 只列出当前支持核心永续交易的市场；All 还可查看只读现货、HIP-3 和 Outcome。Crypto、TradFi、Pre-IPO 来自官方 `perpCategories` 的 HIP-3 标签：TradFi 聚合 stocks、stock、equities、equity、commodities、indices、fx、rates、preipo；未标注的市场不会被猜测分类。Pre-IPO 不是官网 Pre-launch 的同义词。`热门`按已取得的 24h 成交额排序，不伪造交易所没有提供的“热门”标签。自选存在浏览器本地。元数据目录缓存 60 秒，选择器打开时每 5 秒从宿主读取最新 WS 上下文；宿主只维护一条全 DEX 上下文订阅，不遍历所有 DEX 发 REST。WS 不可用时，选中 HIP-3 币种才请求所属 DEX 的上下文。

选中市场在选择器关闭后仍每 5 秒刷新一次独立行情。核心永续复用最多 10 秒的元数据缓存，展示和票据报价优先采用新鲜的 WS 中间价；HIP-3 优先用全 DEX WS 上下文，失效时只请求所属 DEX；现货上下文缓存 15 秒；Outcome 优先复用 WS 盘口推算中间价。客户端保留交易所数据的观测时间，非核心市场超过 25 秒未更新或读取失败时显示过期提示，票据暂停提交。

选择器支持搜索、列排序、分段滚动加载、上下键/Enter 选择与 ⌘/Ctrl+S 自选。现货上下文按官方 `spotMetaAndAssetCtxs` 响应的 `universe` 顺序映射，`@index` 市场在界面显示代币交易对名称但保留原始市场名用于行情请求。盘口档位使用交易所 `l2Book` 的 `nSigFigs`（2/3/4/5）和 5 位时的 `mantissa`（2/5），由交易所聚合后返回最多 20 档，而非浏览器拿原始前 20 档重算；原始盘口仍供价差及风险检查。累计深度条不会阻挡点击价格，聚合价原样送入票据。图表支持放大查看、视图复位、Esc 返回，以及 SMA20、EMA20/50、布林带、RSI14、MACD 和成交量的独立开关；手动缩放与平移不会被实时 K 线更新重置。

技术指标由真实 K 线计算：SMA20、EMA20/50、RSI14、MACD、布林带、ATR14、量比和邻近摆动高低点。Agent 指标仅使用交易所 `T` 已收盘的 K 线，返回最新收盘时间和排除的形成中 K 线数量；图表仍显示实时末根 K 线。它们是历史派生值，不是预言价格或下单许可。`hyper_chart` 标注按 DSH 会话、币种、周期落盘；图上的线不会自动触发订单。

## 官方数据模型与后续工作

- [Info endpoint](https://hyperliquid.gitbook.io/Hyperliquid-docs/for-developers/api/info-endpoint) 给出盘口与 K 线查询方式及 14 个官方周期；界面已覆盖这些周期。
- [Perpetuals info](https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/info-endpoint/perpetuals) 提供 `allPerpMetas`、`perpCategories` 和按 DEX 的上下文；[WebSocket subscriptions](https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/websocket/subscriptions) 提供 `allDexsAssetCtxs`。当前只用其只读数据。HIP-3 交易需另行接入 DEX 资产 ID、抵押资产、账户状态及风控。
- [Spot info](https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/info-endpoint/spot) 提供 `spotMetaAndAssetCtxs`、现货余额与 testnet-only `outcomeMeta`。现货交易需接入现货资产 ID 与余额，不应复用永续账户可用额。
- [Asset IDs](https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/asset-ids) 对核心永续、HIP-3、现货与 Outcome 使用不同编码。当前交易路径仅处理核心永续索引，因此 UI 和 paper/live 下单都阻止其他市场。

仍需单独完成：Outcome 的账户模型与签名交易、现货/HIP-3 的账户模型和签名交易、官网 Pre-launch 筛选条件的可靠接口，以及更丰富的图表绘图工具。不得通过名称猜测类别或将只读市场显示成可交易。
