# Hyperliquid funded testnet acceptance — 2026-10-14

Dedicated dsh-web3 account: `0xF5D7710aC1bBDc51fB32Dfa67fC5D0f22CD9636C`.
All actions targeted `https://api.hyperliquid-testnet.xyz`; no mainnet exchange action was submitted.

## Preparation

- Initial Hyperliquid Spot USDC: 500.0; Perps account value: 0.0.
- User approved moving 100 mock USDC from Spot to Perps.
- `usdClassTransfer` returned `status: ok`; independent balance query showed Spot 400.0 and Perps 100.0.
- `npm test` and `npm run acceptance:online` passed before funded execution.

## Exchange acceptance

The funded script used the project `HyperRemote` order, cancel, guard, and dsh-web3 signing paths. The user delegated decisions for the remaining testnet steps. Each host action and wallet signature was individually reviewed at the approval gate. BTC leverage was set to 1x.

| Check | Exchange evidence |
| --- | --- |
| GTC buy 0.001 BTC at 66,653.0 rested, then canceled | oid `62660280924`; cloid `0x0c8c7ca9365b4c07a5e06bc3c4dfe936`; later `orderStatus: canceled` |
| IOC buy 0.001 BTC filled | cloid `0x8b09ff43a0f84444b949ee12c1f2fe92`; later `orderStatus: filled` |
| Reduce-only sell 0.001 BTC filled | cloid `0x36213d5e974445a8b1dff419cc090080`; later `orderStatus: filled` |

Independent final `/info` queries returned no open orders and no positions. Two BTC fills were recorded. Perps account value was 99.898032 mock USDC, a decrease of 0.101968 during the round trip, including reported fees of 0.037478 and 0.03749 mock USDC. Spot USDC remained 400.0.

This validates the real testnet exchange path through the local acceptance harness. It does not validate the browser desk's live UI interaction or a production mainnet trade.
