# 行情取证与画线

`hyper_market action=indicators` 的可用指标以工具返回和 `INDICATOR_IDS` 为准：`volume`、`sma20`、`sma60`、`ema20`、`ema50`、`bollinger20`、`rsi14`、`macd`、`atr14`、`vwap`、`stochastic`、`adx`、`obv`。指标设置遵循会话的 `indicatorSettings`。先看 `ready`、已收盘 K 线数量、`observedAt`；数据过期或样本不足时不拿指标作开仓依据。布林带触轨本身不是反转信号。

复原用户截图时，用 `candles` 找到对应高低点的 epoch 毫秒时间和价格，再给 `hyper_chart` 的 `points`。固定范围成交量分布用 `vprofile` 的两个时间锚点；锚定 VWAP 用 `avwap`。具体画线种类、点数和参数以 `hyper_chart` 工具说明为准，已有画线优先 `update`。

交易股指、股票、商品类 HIP-3 市场，或计划临近 CPI、FOMC、非农、财报时，核对事件日程，再把时点和可能的流动性影响写入风险说明；不要凭记忆写日期。
