# 策略记录与复盘

策略可处于 `idea`、`testing`、`active`、`paused`、`retired`。每个策略记录 `thesis`、`entry`、`exit`、`invalidation`、`sizing`、`markets`、`timeframe`，让入场和作废条件可核对。不同会话的策略与战绩分开统计，共享规则也不合并成交份额；修订使用 `hyper_journal strategy id=… why=…`，说明根据哪些交易改变了哪条规则，版本自动递增。不要把不同版本、paper/live 或 testnet/mainnet 混作一份战绩。

交易前用 `hyper_journal log type=plan` 记录策略 id、入场、止损、目标和计划 1R 金额。平仓后用 `hyper_account fills` 或 `review` 核对实际成交、手续费、资金费，再记 `type=trade`、入场时的 `strategyVersion`、`resultR` 与 `pnlUsd`。`resultR = 实际盈亏 ÷ 计划 1R`。没有原始计划不能事后编造依据；偏差或可复用教训另记 `type=lesson`。

用户问交易表现、首次需要体检或周期复盘时，用 `hyper_account action=analyze` / `review`，结合 `hyper_journal read` 报告样本量、期望、回撤和执行偏差。样本少时只给描述，不下稳定习惯或有效性结论。`review` 的成交与委托可能截断、资金费可能缺失；手续费已含 builderFee，不能重复扣。窗口净额不是账户收益率，平仓数不是完整往返数。

历史回放可用 `hyper_market candles` 翻页；计入成本，区分样本内外。回放只能支持进入验证阶段，不能证明将来盈利。升级、暂停与风险纪律的数值门槛全部读当前档案和策略条目，不在 skill 中另设默认值。

复盘执行质量时，除了胜率和 R，再逐笔看四件事，并把结论写成 `lesson`：①离场后多久重新入场、方向是否与大周期一致（止损后几分钟内同向重进是最常见的漏洞）；②手续费占毛利的比例和往返次数，是否有“平掉再按同样大小重开”的调整往返；③每笔持仓期间是否始终有覆盖全量的止损单，若有缺口记下时长和原因；④浮盈期间止损是否按规则上移（用 `protect`），还是浮盈全部回吐后才被原止损带走。资金费单列，测试网资金费可能极端，不能当作策略收益。
