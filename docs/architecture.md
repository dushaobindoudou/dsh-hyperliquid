# dsh-hyperliquid 系统架构

> 调研基准：dsh-bots（TS + tsc 双配置 + playwright 冒烟）、dsh-freeroute（纯 JS 宿主 + 客户端集成测试替身模式），2026-10-13。
> dsh CLI 本机可用（0.2.0-rc.2），宿主联调为实装验证，非纸上架构。

## 1. 系统全景

```
┌───────────────────────── dsh 宿主进程（Node，ESM）─────────────────────────┐
│ index.js ── cordis 插件入口（inject: []，全部服务经 ctx.get 安全读取）        │
│  ├─ HyperRemote        lib/remote.js   typert Remote 命名空间 `hyper`       │
│  │   └─ HyperliquidClient lib/hl.js    REST /info·/exchange + 上游 WS 快照   │
│  ├─ hyper_* 工具组      lib/tools.js   与 UI 共用同一批 remote 方法          │
│  ├─ hyperliquid-trading skill       DSH 原生 skills 注册表，随包提供          │
│  ├─ systemPrompt.section             动态「交易台焦点」注入每个 agent prompt │
│  └─ HyperStore         lib/store.js   会话登记 / paper 账本 / 事件环（落盘）  │
│      signL1Action       lib/signing.js  EIP-712（对拍官方 Python SDK 向量）   │
└────────────────────────────────────────────────────────────────────────────┘
        ▲ typert RPC 单连接                    ▲ 轮询 0.9s/3s + eventsSince 事件环
┌───────┴───────────── dsh web 客户端（浏览器，构建产物）─────────────────────┐
│ client.js（esbuild 产物，勿手改；源码在 src/client/）                        │
│  └─ window.__ModuleLoader__.load → { inject, apply(ctx) }                  │
│     ├─ slots: main 键位槽（三栏工作台）+ sidebar.panellist（入口图标）        │
│     ├─ 左栏：交易会话（dsh sessions 服务 retain/bind）                       │
│     ├─ 中栏：行情交易台（K 线 / 资金费 / 盘口 / 成交 / 持仓与挂单）            │
│     └─ 右栏：直接嵌入原生 dsh 会话；交易票据只负责把意图入队                 │
└────────────────────────────────────────────────────────────────────────────┘
                              │ HTTPS
                    Hyperliquid API（testnet 默认，mainnet/live 可配）
```

**核心不变量：所有下单都通过会话决策。** UI 票据只收集参数并将交易意图送入已绑定的 dsh 会话，不直接调用签名或交易所下单接口；agent 通过工具执行，宿主做账户、风险与签名检查。

## 2. 源码布局与构建链

```
src/client/            客户端唯一手工维护源码（React 19 + TSX）
  index.tsx            入口：loader.load 包装 + inject/apply（cordis 客户端插件形态）
  app.tsx              HyperMain：顶栏 + 三栏
  store.ts             外部 store + useStore（useSyncExternalStore）
  remote.ts            hyperCall 连接封装（connection.remote.hyper）
  format.ts            fmt / fmtPrice / relTime
  styles.css           dhl-* 主题样式（--dsw-alias-* token，esbuild text loader 内联）
  components/          brand-mark / sessions-column / desk-column / candle-chart
                       (lightweight-charts 封装) / book-card / trades-card
                       / bottom-table / chat-column / panel-entry
scripts/
  build-client.mjs     esbuild：src/client → client.js
  dsh-smoke.sh         真宿主冒烟（复用 dsh-bots 模式）
index.js + lib/*.js    宿主半边，纯 ESM 源码，无需构建（同 dsh-freeroute 模式）
test/                  宿主 node 测试：signing 向量 / store 撮合 / marker 静态契约
docs/architecture.md   本文档
client.js              【构建产物】由 build-client.mjs 生成，禁止手改
```

**构建规则（2026-10-13 立的规矩）：**

1. 客户端第三方依赖一律走 **npm 真源码 + 构建期打包**。禁止 base64 内联任何库——不可读、不可维护、无法对上游升级（曾因此把 TradingView 塞成 270KB base64 blob，已废弃）。
2. esbuild `external` 只放行 **shell 静态模块表**里的 id（`react`；`react-dom` / `@deepseek-ai/dsh-client-ui-primitives` 备用）。表外依赖必须打进产物。
3. 产物 = esbuild CJS 输出 + loader IIFE 包装（`factory(require)` 内提供 module/exports，require 透传 shell 模块表）——与 dsh-bots 产物形态一致。
4. `npm run build` 重新生成 `client.js`；`npm test` 跑全部 node 侧测试。

## 3. 关键设计决策

| 决策 | 理由 |
|---|---|
| 宿主单上游 WS + 浏览器 0.9s 轮询宿主 | 避免每个浏览器客户端直连交易所造成 IP 限流叠加；宿主做快照缓存与订阅 sweeper（120s 空闲回收） |
| paper/live 双模式，默认 paper | live 走 EIP-712；服务端一次性决策 ID、账户与行情重检、额度账本以及 DSH 审批或显式开启的自主模式共同控制签名 |
| agent 工具与 UI 共用 HyperRemote 方法集 | 一个操作两个调用方；UI 只是选择不渲染手动控件 |
| 动态 systemPrompt section 注入交易台焦点 | agent 无需问「你在看哪个币」——status()/systemPrompt 双向同步（UI 切币 → deskState → agent；agent bindCoin → desk.state 事件 → UI 跟随） |
| K 线用 TradingView Lightweight Charts（Apache-2.0） | 官方交易页同款库；v5 `createChart` + `addSeries(CandlestickSeries)`；npm 版本锁定在 devDependencies |
| 样式全部走 `--dsw-alias-*` 主题 token | 跟随 dsh 明暗主题，不借哈希类名，shell 重构不破视觉 |

## 4. 数据流

```
UI 切币/周期 ──hyperCall('deskState')──▶ HyperRemote.desk ──▶ status()/systemPrompt ──▶ agent
agent bindCoin ──▶ desk.state 事件 ──▶ eventsSince 轮询 ──▶ UI 跟随
UI 点盘口价 ──▶ session.prompt(queue) ──▶ agent 调 hyper_context/hyper_decide ──▶ 一次性 decisionId ──▶ hyper_order ──▶ 宿主风控/钱包签名 ──▶ paper/live
行情：上游 WS 快照（allMids/l2Book/trades/candle）──▶ snapshot() ──▶ 0.9s 轮询 ──▶ 盘口/成交/K 线末根刷新
K 线历史：REST candleSnapshot；最近一根由 WS candle 快照更新
账户：paper 读 store；live 用 tradingAddress 读 clearinghouseState/openOrders/userFills；API wallet 地址仅用于签名
```

## 5. 测试金字塔

1. **node 单测**（`npm test`）：signing 三向量对拍官方 SDK；store 十组撮合场景；marker 静态契约（防 deskState 式静默失败）。
2. **客户端集成测试**（node + 替身 globals，freeroute 模式）：加载真实构建产物，验证 slot 注册、inject 清单、组件渲染逻辑。
3. **真宿主冒烟**（`scripts/dsh-smoke.sh`）：打 tgz → 全新 DSH_HOME → `dsh plugin --profile web add` → `dsh web` → playwright 校验插件激活、无 pending plugins、面板出现。

## 6. 已知后续项（不在本轮范围）

- 已注资 testnet 账户的 `normalTpsl` 组合单验收
- 原生会话消息发送、流式回复、工具审批和附件的完整交互验收
- 阶段 D 工程化：git init / LICENSE / CHANGELOG / README.zh-CN / 1.0.0 发布
