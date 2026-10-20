# 交易台测试验收矩阵（2026-10-14）

## 目标与判定方式

用户已确认目标是 **Hyperliquid 交易台**，当前处于测试阶段。交易台的核心路径是：用户在界面看见及时的行情与账户状态 → 在当前 DSH 会话表达交易意图 → agent 使用 `hyper_*` 工具 → 宿主校验并执行 paper 或经批准的测试网动作 → 界面与账户/订单记录同步。任何一段失败，都不能仅凭“页面打开”或“单测通过”判定验收完成。

每项结果标记 **通过 / 失败 / 未验证**，附测试时间、网络、交易模式、宿主进程或构建标识、操作前后只读快照、脱敏的工具与界面证据。旧截图和旧进程的结论不可复用。

## 分层验收

| 层级 | 必须看到的结果 | 当前证据 | 待补证据 |
| --- | --- | --- | --- |
| A. 运行与界面 | 当前宿主能调用 `hyper/status`；交易台侧栏、三栏、K 线和嵌入式 DSH 会话可见；宿主代码与 `client.js` 对应。 | 当前宿主 `hyper/status` 调用成功，工具列表可见 6 个 `hyper_*`；修复首启引导后，隔离 `npm run smoke` 已通过面板、图表和会话挂载。 | 常驻宿主启动早于源码更新；用户手动重启后需复测其界面与版本一致性。 |
| B. 行情实时性 | 切币/周期后焦点一致；盘口、成交、K 线持续更新；断线、超时或重连时显示数据过期，恢复后清除。 | 当前源码已有 `isMarketStale`、过期横幅、票据暂停与 status 轮询；隔离 UI smoke 证明图表可挂载。官方 WebSocket 文档要求断线重连和补缺。 | 在当前构建上记录正常、断线、恢复三个时刻的界面和数据时间戳；源码存在不等于运行时通过。 |
| C. paper 交易闭环 | 票据只把意图交给当前会话；agent 工具产生模拟订单、成交和仓位；减仓、限额、拒绝原因、账户权益在会话与界面一致。 | `npm test` 与 `npm run typecheck` 已通过；12:14 `acceptance:online` 在真实 testnet 行情与隔离 paper 账本上 6/6 通过，不调用 `/exchange`。 | 在真实 Web 会话中走一遍意图→工具→账本→界面；检查浏览器直呼 `placeOrder` 的旁路（旧审计 A-2）。 |
| D. funded testnet 订单闭环 | 测试账户起始余额/持仓/挂单/成交明确；每个签名动作有人工可读的目标与一次性批准；订单回执按 oid/cloid 与 `orderStatus`、`userFills` 对账；结束时资产、仓位和挂单被复核。 | 12:03 有 100 mock USDC 从 Spot 转入 Perps；12:05–12:06 的验收脚本产生三笔 BTC 订单。官方 `orderStatus` 逐笔对账为：挂单 `canceled`、开仓 `filled`、平仓 `filled`；12:05:58 只读快照为 Spot 400、Perps 权益 99.898032、持仓 0、挂单 0、成交 2。钱包审计显示五次 `allowed-once` 签名批准；脚本进程已结束。 | 已观察到订单生命周期和账户回平，但还缺脚本完整报告与真实 Web 会话/界面证据；用户是否把 funded testnet 纳入本阶段验收仍待确认。 |
| E. 主网 | 交易策略、账户、权限、限额、异常对账和退出条件均由用户明确给定并验收。 | 当前宿主配置为 `network=testnet`、`tradingMode=paper`。 | 本阶段不据测试网通过结果推断主网可用。 |

## 现有命令的作用与边界

| 命令 / 脚本 | 实际行为 | 审阅用途 |
| --- | --- | --- |
| `npm test`、`npm run typecheck`、`npm run build` | 离线测试与构建；不构成真实交易台端到端验收。 | 每次源码改动后的基础回归。 |
| `npm run smoke` | 构建、打包并在隔离 DSH profile 中打开交易台，运行 Playwright 冒烟。 | 验证新包可装载及核心 UI；不会自动证明当前常驻宿主已更新。 |
| `npm run acceptance:online` | 读取真实行情，在临时目录进行 paper 交易；脚本声明不调用 `/exchange`。 | 行情与模拟撮合联动测试；应核对网络响应和每项结果。 |
| `npm run acceptance:exchange-testnet` | 真实解锁钱包、签名并向 testnet `/exchange` 发送杠杆、IOC 订单和撤单请求；仅从 Perps 状态检查权益、持仓、挂单和成交是否为零，未检查 Spot 余额。 | **不可当作普通离线测试**。当前账户 Spot 已有 mock USDC；“未注资”注释与检查条件并不等价。 |
| `scripts/fund-perps-testnet.mjs` | 经人工签名批准后，把 100 mock USDC 从测试网 Spot 转到 Perps。 | 资金动作；12:03 的官方账本已记录该划转。再次运行须先核对现有余额与意图。 |
| `scripts/acceptance-funded-testnet.mjs` | 在 Perps 权益至少 100 时尝试杠杆、挂单/撤单、市价开仓与减仓平仓，逐次询问 `APPROVE`。 | 12:05–12:06 已运行一次并留下订单/钱包审计证据；不能纳入自动基础测试。脚本失败时只记录剩余状态，没有自动保证平仓；起始检查只看 BTC 仓位，未拒绝其他币的持仓。 |

## 下一张交给 DSH 的任务单应包含

1. **验收层级**：先明确本轮只覆盖 A–C，还是包含 D。当前尚无用户对 D 的明确答复。
2. **单个用户旅程**：例如“在 BTC 交易台新建会话，提交一笔 paper 买入意图，在账户面板看到持仓，再由会话减仓”。只给一个闭环，不把整个旧审计批次打包下发。
3. **观察点**：开始与结束的网络/模式/余额/持仓、所用工具、订单或模拟成交 ID、界面截图及错误文案。记录要脱敏。
4. **失败处理**：在 paper 阶段可重置隔离账本；测试网阶段若订单结果未知，先用官方 `orderStatus` 按 oid/cloid 对账，核对仓位与挂单，再决定下一动作。不要盲目重试。
5. **审阅者复核**：依据工具调用、界面、账本和官方 API 四类证据核对；标注推断和待证实项。仅在证据支持时再给 DSH 开修复任务。

## 官方依据

- [Hyperliquid API 环境](https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api)：同类 API 在 mainnet 与 testnet 使用不同地址。
- [Spot 余额](https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/info-endpoint/spot)与[Perps 账户](https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/info-endpoint/perpetuals)：两种状态独立查询；统一账户/组合保证金模式下 Spot 余额端点是跨账户余额的来源。
- [WebSocket 与恢复](https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/websocket)、[订阅类型](https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/websocket/subscriptions)：断线重连和快照补缺；订单更新、成交和用户事件分别订阅。
- [订单状态查询](https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/info-endpoint#query-order-status-by-oid-or-cloid)：支持 oid/cloid，对未知回执和超时做对账。
- [Exchange endpoint](https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/exchange-endpoint)：下单、撤单、杠杆修改和 Spot/Perps USDC 划转是不同动作。
- [API wallet 与 nonce](https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/nonces-and-api-wallets)：签名钱包与查询账户地址有不同角色。

本矩阵记录的是**审阅标准和现有证据**，不触发任何交易。余额与进程状态会变化，实际执行前重新取只读快照。

## 12:10–12:19 本轮只读与隔离测试记录

| 检查 | 结果 | 证据及边界 |
| --- | --- | --- |
| 当前 Web 宿主 `hyper/status` | **通过** | 12:10 在 11:20:45 启动的进程上直接调用成功；配置为 `testnet`、`paper`、`signer=web3`、`autonomousLive=false`。这只证明宿主远端可调用。 |
| 当前 Web 宿主 agent 工具面 | **通过** | 12:08 宿主工具列表包含 6 个 `hyper_*`，包括决策、订单与账户对账的 schema。工具存在不等于真实 Web 会话已走完交易闭环。 |
| 宿主与盘上源码一致性 | **失败** | 宿主在 11:20:45 启动，源码在 12:07–12:10 有并行更新，隔离 smoke 于 12:11 重建 `client.js`；运行中宿主没有由此自动换成新源码。用户手动重启后需重新取证。 |
| 新包隔离 profile UI smoke | **失败** | 插件安装、Web 启动和客户端激活通过；Playwright 点击 Hyperliquid 侧栏时被 DSH 首次启动的“添加一个 API Key”引导弹窗遮挡。交易台面板、K 线和嵌入式会话仍未取得界面证据。 |
| 修复后的新包隔离 profile UI smoke | **通过** | 12:18 只改 `scripts/dsh-client-smoke.mjs`，在临时 profile 中按文案识别首启引导并点击“稍后配置”；重跑退出码 0。交易台面板、7 个图表 canvas、嵌入式会话与 composer、票据控件和返回会话均通过，未见 fatal page error。`client.js` 12:18 重建后哈希与 12:11 一致。 |
| `acceptance:online` | **通过** | 12:14 使用真实 testnet 行情与临时 paper 账本，退出码 0，6 项通过、0 项失败；包括行情/盘口、K 线/成交、会话上下文、模拟开平仓与拒绝路径。脚本不调用 `/exchange`，也不能代替真实 Web 会话验收。 |
| 行情断线/恢复、真实 Web 会话的 paper 订单闭环 | **未验证** | 隔离 UI smoke 已证明面板与会话挂载，但未模拟断线/恢复，也未发送交易意图并对照工具、账本和界面。常驻宿主仍是源码更新前的进程。 |
| 12:19 测试网资产复核 | **只读对账** | 官方 testnet `/info`：Spot USDC 400.0、Perps accountValue 99.898032、持仓 0、挂单 0、成交 2。与 funded 脚本结束后的快照一致；这是测试网 mock 资产。 |

本轮发现源码与 `client.js` 在当前 Web 进程启动后更新；`npm run smoke` 又重新构建了 `client.js`。隔离 smoke 与 `acceptance:online` 只能说明各自运行时的源码/包，不能证明 11:20 启动的常驻宿主已经加载这些改动。首启引导造成的 smoke 阻塞已修复。下一项是对当前源码做行情正常/断线/恢复的 UI 验证，并在用户手动重启常驻宿主后走一次真实 Web 会话的 paper 意图→工具→账本→界面闭环。
