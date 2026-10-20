# dsh-hyperliquid 审阅者简报（2026-10-14）

## 这份资料的用途

用户已确认产品目标是 **Hyperliquid 交易台**，目前处于测试阶段。审阅者负责核对现状、资产、问题证据和官方资料，并复核 DSH 的交付；本简报不是开发指令，也不授权转账、签名或交易。当前仍需确认本阶段验收到 paper 还是包含 funded testnet 的真实订单生命周期。分层验收见[交易台测试矩阵](./trading-desk-test-matrix-2026-10-14.md)。

## 已核实的现状

| 事项 | 证据与结论 | 边界 |
| --- | --- | --- |
| 宿主与插件 | 用户手动重启后的 Web 宿主于 2026-10-14 11:20:45 启动；在该进程上直接调用 `hyper/status` 成功，返回 `testnet`、`paper`、`signer=web3`、`autonomousLive=false`。 | 旧审计的 PID 68040 与“运行的是旧代码”结论已过时；仍需单独核对当前工具 schema 和界面。 |
| ACP 目录 | `dsh/remote/catalog` 不列出 `hyper`，也不列出其他部分插件远端；`hyper/status` 直接调用成功。 | 目录缺项不能作为插件未激活的证据。该目录读取 `ctx.typert.local.list()`，而此插件通过源模式的远端服务被调用。 |
| 仓库 | 宿主源码在 `index.js`、`lib/`；客户端源码在 `src/client/`，`client.js` 是构建产物；仓库当前不是 Git 工作树。 | 修改前后要用文件哈希或明确的差异记录复核，不能借助 Git diff。 |
| 基线测试 | 2026-10-14 已运行 `npm test` 与 `npm run typecheck`，均通过。 | 只能证明现有测试覆盖范围内通过，不能证明体验、实时数据和交易验收完成。 |
| 本轮 A–C 测试 | 12:14 `acceptance:online` 使用真实 testnet 行情与临时 paper 账本，6/6 通过、退出码 0；12:18 修复隔离 smoke 的首启引导处理后，`npm run smoke` 退出码 0，面板、图表、嵌入式会话和票据控件均挂载。 | smoke 没有提交会话交易意图，也没有模拟断线/恢复；常驻 Web 宿主仍是源码更新前的 11:20 进程。细节见[测试矩阵](./trading-desk-test-matrix-2026-10-14.md)。 |
| 本地 paper 账户 | `~/.dsh-hyperliquid/paper.json` 只读快照：USD 99,999.93683575、无持仓、2 笔模拟成交；`sessions.json` 有 6 个交易会话。 | 这是本地模拟账本，与 Hyperliquid 测试网或主网资金无关。 |
| 测试网账户 | 11:45 左右官方 testnet `/info` 快照：Spot USDC 500、Perps 权益 0。12:03 划转后 Spot USDC 400、Perps 权益 100。12:19 只读复核：Spot 400、Perps 权益 99.898032、持仓 0、挂单 0、成交 2。 | 这是不同时点的测试网 mock 资产。官方说明统一账户或组合保证金模式下，跨 Spot/Perps 的交易账户余额应以 Spot 余额端点为准；不能把两栏简单相加为通用“总资产”。 |
| 资金与订单脚本事件 | 11:43 首次运行 `scripts/fund-perps-testnet.mjs` 停在签名审批前。12:03:53 钱包审计记录一次 `allowed-once` 审批与完成签名；官方 testnet 账本于 12:03:54 记录 100 mock USDC 的 `accountClassTransfer`（Spot → Perps）。随后 `scripts/acceptance-funded-testnet.mjs` 运行并结束；钱包审计另有五次一次性批准。官方 `orderStatus` 对其三笔订单的结果依次为 `canceled`、`filled`、`filled`。 | 已用只读账户、订单和钱包审计交叉核对；脚本来源及用户对 funded testnet 测试范围的确认仍待核对。此次脚本结果不能代替真实 Web 会话和界面验收。 |

## 已确认的产品目标与待定测试边界

产品目标是交易台，不是单纯行情页；但测试阶段的结束条件还需确定。下面是交易台从展示到真实执行的验证层级，不能用代码审计清单代替验收目标。

| 目标 | 可观察的验收结果 | 首先要查的资产与问题 |
| --- | --- | --- |
| 行情与研究台 | 行情、K 线、盘口、资金费能持续更新；断线和过期数据显著可见；会话能理解当前币种。 | WebSocket/REST 路径、数据时效、币种覆盖、宿主与界面版本。 |
| Agent 辅助的 paper 交易台 | 用户在会话里表达意图，模拟订单、仓位、成交与风控可追溯；模拟限制清楚展示。 | 本地 paper 账本、事件链、风险规则与 UI 一致性、模拟撮合偏差。 |
| 测试网真实验收 | 指定测试账户、资金来源、动作、限额和回滚/对账方式；每次交易所结果可按 oid/cloid 对账。 | Spot/Perps 余额、API wallet 归属、签名策略、nonce、订单与成交记录。该目标需要用户给出明确的测试动作。 |
| 主网交易 | 先有明确定义的策略、权限、金额与退出条件，再验证签名、限额、账户状态和事故处理。 | 账户地址与 API wallet、资金与仓位、审批边界、限额账本、失败/超时对账。当前 `paper` 配置不等于该目标。 |

在本阶段验收边界确定前，审阅者只做只读核对与资料准备；不默认开始某个修复批次，也不把测试网脚本视为例行测试。

## 旧审计如何使用

- [2026-10-14 审计](./audit-2026-10-14.md) 的 P0-2、A-1/A-2/A-3、P-1 至 P-5 等是**候选问题**，要结合目标排序。P0-1 的旧进程证据已失效。
- 若目标是行情台，先验证“数据过期是否可见”和 K 线是否更新；若目标是 paper 交易，优先验证会话约束、模拟账本与风险规则；若目标是测试网验收，优先核对账户、签名与交易所状态。
- 每次让 DSH 执行一个明确切片：给定用户目标、当前证据、允许操作、验收结果；交付后由审阅者独立复核源码差异、测试、宿主行为和资产状态。

## 官方资料与对项目的含义

1. [API 总览](https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api)说明同一类公开 API 可指向 mainnet 或 testnet。环境必须在每份验收记录中明示。
2. [Perpetuals Info](https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/info-endpoint/perpetuals)给出 `clearinghouseState`、`metaAndAssetCtxs` 等请求；`metaAndAssetCtxs` 本身包含 meta，支持复核旧审计 P-1。该页说明统一账户或组合保证金模式下跨 Spot/Perps 的余额要看 Spot 端点。
3. [Spot Info](https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/info-endpoint/spot)给出 `spotClearinghouseState` 的余额结构。审阅资产时应标明“本地 paper”“测试网 Spot”“测试网 Perps”，不能合成一个数字。
4. [API wallet 与 nonce](https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/nonces-and-api-wallets)说明 API wallet 用于签名；查询主账户或子账户资料要传实际账户地址。若未来做多进程交易，nonce 与钱包分配也需要单独设计。
5. [Exchange endpoint](https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/exchange-endpoint)区分下单、撤单、杠杆和 Spot/Perps USDC 划转。后者是资金动作，不能被“运行测试”一词掩盖。
6. [WebSocket 订阅](https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/websocket/subscriptions)列出 `allMids`、`candle`、`userFills`、`orderUpdates` 等独立通道；[WebSocket 指南](https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/websocket)要求处理断线与恢复。实时性验收应覆盖断线、重连和过期提示。
7. [签名指南](https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/signing)建议优先对照官方 SDK，且指出错误签名可能恢复出不同签名者；本仓库已有官方向量测试，但新增动作仍需独立对拍。更细的订单、TP/SL 和品牌链接见[实现资源索引](./reviewer-resources-2026-10-14.md)。

## 审阅者下一轮输出格式

每轮只报告：**用户目标与本轮验收条件；已核实的资产快照；最高优先级问题及证据；交给 DSH 的单个任务；独立验证结果；尚缺的用户决定**。结论标明“已验证 / 推断 / 待证实”，并附时间与环境。若 DSH 的动作超出约定范围，先停止该动作、保全只读证据，再重新定界。
