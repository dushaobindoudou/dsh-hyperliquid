# 多周期、指标配置与复盘证据

范围按用户选择收敛为三项：复盘可信度、多周期研究、常用指标设置。其余 TradingView 平台功能不作为待办。

## 入口与行为

- 图表「单图 / 双图研究 / 四图研究」：同一会话标的，不同周期；副图可独立选择 14 种周期。时间视窗按 UTC epoch 联动，光标定位到对应周期包含该时间的 K 线；可分别关闭联动。布局、周期、联动开关和各周期视区按会话保存。
- 主图编辑画线，其他研究图同步显示该会话标注。每图的点位引用都携带自己的周期、原始 OHLCV 和当前参数计算值。副图只读画线，避免误改。
- 「指标 → 参数与模板」配置 RSI 长度及阈值、MACD 快慢和信号长度、BOLL 长度和标准差倍数、Stochastic 参数及阈值、ADX/DMI 参数。模板包括已启用指标、全部参数、自定义均线；宿主保存，可跨会话载入、更新和删除。
- 「数据窗口」显示光标对应的原始 OHLCV、当前启用指标和自定义均线值。未完成预热的指标留空，不填零。配置及开关按会话保存。
- 「交易复盘」按 7 / 30 / 90 天、当前标的或全部标的读取成交、委托和资金费。展开逐笔记录查看 oid、交易 ID、原始原因、费用、执行偏差及缺口；可定位图表、导出含原始证据与核对结果的 JSON，或交给 AI 复盘。
- 「交易设置 → 交易限额 → 模拟成交成本」：默认手续费 4.5 bps、不利滑点 5 bps，可配置 0–100 bps；是模拟假设，不是账户实际费率。费用实际扣现金，保证金预检包含费用和滑点损失。仅作用于新成交，逐笔保存当时配置与参考中间价。

## 复盘口径

交易窗口统计不等于账户收益率，也不等于一笔完整开平仓。订单按 `coin + oid` 匹配，成交优先按 `coin + tid` 去重；模拟成交使用本地唯一 oid。保留原始决策原因，未记录的原因标为缺失，不事后补写为原始依据。

核心 USDC 永续：已实现毛盈亏使用成交的 closedPnl，扣费净额减去该窗口所有成交手续费（含开仓手续费）。资金费按现金流正负计入，仅在完整取得窗口资金费时显示含资金费净额。手续费 fee 已含 builderFee，不能重复扣除；不同 feeToken 分开汇总。HIP-3、现货和 Outcome 不并入核心永续的 USDC 净额。平仓成交笔数不是完整往返交易数。

缺失 fee、closedPnl 或资金费数据时净额显示未知；历史达到保留上限时显示覆盖缺口。实盘受交易所最近 2000 笔成交 / 历史委托限制；资金费分页使用包含末时间戳的边界并去重，最多 12 页，遇到无法推进、无效记录、请求错误或上限则标为不完整。历史订单没有窗口内成交可能是撤单、未成交、窗口外成交或截断，不据此认定执行失败。状态未知的本地下单需按 cloid 查询 orderStatus。

模拟账本保留最多 5000 笔成交与委托；旧版本仅保留 200 笔，达到这一数量后保守提示历史可能截断。旧记录未知费用不追溯补算。不模拟盘口深度、资金费和强平。钱包统计也明确仅覆盖保留成交。

## 指标口径与 AI 一致性

`lib/studies.js` 是图表、数据窗口、点位引用和 AI 配置指标的共同计算入口。RSI 使用 Wilder 平滑；本次纠正旧图表后续涨跌项未除以周期的错误。MACD 用 SMA 初始化的 EMA；BOLL 使用总体标准差；Stochastic 使用区间最高 / 最低计算原始 %K，再对 %K / %D 做 SMA；ADX 使用 TR、方向运动和 DX 的 Wilder 平滑；OBV 从已加载首根的零基准累积有符号成交量。

OBV 绝对值随历史窗口变化；EMA、RSI、ADX 等有递归初始化，对比不同加载窗口时可能存在预热差异。图表含形成中末根，AI `hyper_market indicators` 排除未收盘 K 线，只能在相同参数、相同历史窗口、相同已收盘时点比较。高周期光标匹配到的柱子在低周期当时可能尚未收盘；联动用于研究，不是隔离未来数据的回放器。

`hyper_context.workspace` 返回参数和研究布局；`hyper_market indicators.configured` 返回实际参数、各指标值和已收盘时点，兼容字段 RSI/MACD/BOLL 也按配置更新；`hyper_account review` 返回与界面相同的证据和核对结果。策略框架继续使用其明确写出的固定默认条件，不能把自定义参数当作已验证策略。

## 验证

- `npm test`：新增指标手工金值、RSI 与既有后端对照、资金费分页边界、重复成交、builder fee、不完整费用、数量差异、模拟成本扣账、模板及会话配置恢复、AI 参数一致性。
- `npm run typecheck` / `npm run build`。
- `npm run smoke:research`：临时真实 DSH 宿主，四图/双图、光标和时间联动、拖动不引用、参数与模板、数据窗口、点位参数、复盘导出与刷新恢复。
- `npm run smoke:drawing`：原绘图、图表基础交互及新增研究流程的组合回归。

本轮已通过 `npm test`、`npm run typecheck`、`npm run build`、`npm run smoke:chart` 和 `npm run smoke:research`。浏览器验收覆盖模拟费用设置保存、四图/双图、光标与时间联动、拖动不引用、参数化点位引用、90 天复盘证据导出、刷新恢复及模板跨会话应用。图表基础回归覆盖画线坐标、图表类型、日期导航、导出和放大视图。

## 口径依据

- [Hyperliquid Info endpoint](https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/info-endpoint)：成交 ID、费用字段、返回上限。
- [Hyperliquid perpetuals info](https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/info-endpoint/perpetuals)：userFunding 时间窗和现金流字段。
- [TradingView Stochastic](https://www.tradingview.com/support/solutions/43000502332-stochastic-stoch/)：%K / %D 定义。
- [TradingView ADX](https://www.tradingview.com/support/solutions/43000589099-average-directional-index-adx/) 与 [OBV](https://www.tradingview.com/support/solutions/43000502593-on-balance-volume-obv/)：指标含义与计算口径。
