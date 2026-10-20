# 账户与 HIP-3

先读 `hyper_context.accountMode`、`hyper_account action=state` 和目标市场的保证金资产。Standard 账户下，现货 USDC、主永续 USDC、各 HIP-3 交易所的 USDC 是不同余额；统一账户或组合保证金模式下，现货 USDC 可用作永续保证金，通常不需要这些内部划转。

Standard 账户保证金不足时，用 `hyper_account action=transfer` 的 `from` / `to`（`spot`、`perp` 或 HIP-3 交易所名）划入本次交易需要的 USDC 加合理缓冲。现货↔HIP-3、HIP-3↔HIP-3 由插件经主永续两步执行；第二步失败时先核对资金是否停在主永续，不直接重复整笔划转。半托管的批准、全托管直接执行由当前托管状态决定。不要让用户去网页手动完成插件已支持的划转。

HIP-3 只交易以 USDC 为保证金且工具报告 `tradable=true` 的市场。Standard 账户下开仓前要确认对应交易所有足量 USDC，例如 `from=perp to=xyz`；统一账户或组合保证金模式按工具返回的可交易额度判断。部分 HIP-3 市场只允许逐仓，最大杠杆以市场数据为准。切换交易所或币种后重新读取抵押额、仓位、价格和限制，不沿用主永续账户的数字。
