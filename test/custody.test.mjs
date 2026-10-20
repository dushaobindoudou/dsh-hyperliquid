// 全托管 / 半托管: who may change limits, whether live actions need approval, and USDC transfers to HIP-3 dexes.
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Signature, Wallet, verifyTypedData } from 'ethers'
import { HyperRemote } from '../lib/remote.js'
import { HyperStore } from '../lib/store.js'
import { TradingGuard } from '../lib/trading-guard.js'
import { buildToolDefinitions } from '../lib/tools.js'
import { buildSendAsset, buildUsdClassTransfer } from '../lib/signing.js'
import { Context } from '@deepseek-ai/cordis'

const dir = mkdtempSync(join(tmpdir(), 'dhl-custody-'))
const key = '0x0123456789012345678901234567890123456789012345678901234567890123'
const wallet = new Wallet(key)
const remote = Object.create(HyperRemote.prototype)
remote.cfg = { tradingMode: 'live', network: 'mainnet', signer: 'local', privateKey: key, custody: 'assisted', dataDir: dir,
  allowedCoins: ['BTC'], maxOrderUsd: 100, maxDailyUsd: 500, maxPositionUsd: 500, maxLeverage: 5 }
remote.store = new HyperStore(dir)
remote.guard = new TradingGuard(dir, remote.cfg)
remote.paperGuard = new TradingGuard(dir, remote.cfg, { budgetName: 'paper-budget.json' })
remote.resolveAddress = async () => wallet.address
const posted = []
let approvals = 0
remote.authorizeToolAction = async () => { approvals += 1 }
remote.client = {
  nextNonce: () => 1792140000000,
  async info(type, extra = {}) {
    if (type === 'perpDexs') return [null, { name: 'xyz' }, { name: 'flx' }, { name: 'abc' }]
    if (type === 'meta') return { collateralToken: extra.dex === 'xyz' || extra.dex === 'abc' ? 0 : 360, universe: [] }
    if (type === 'spotMeta') return { tokens: [{ name: 'USDC', index: 0, tokenId: '0x6d1e7cde53ba9467b783cb7c530ce054' }] }
    if (type === 'clearinghouseState') return { withdrawable: '40', assetPositions: [] }
    throw new Error(type)
  },
  async clearinghouseState() { return { withdrawable: '300', assetPositions: [] } },
  async spotClearinghouseState() { return { balances: [{ coin: 'USDC', token: 0, total: '250', hold: '20' }] } },
  async userAbstraction() { return remote.testAccountMode ?? 'default' },
  async exchangeUserSigned(action, signature, nonce) {
    if (remote.failNextSendAsset && action.type === 'sendAsset') { remote.failNextSendAsset = false; return { status: 'err', response: 'Insufficient balance' } }
    if (remote.timeoutNextSendAsset && action.type === 'sendAsset') { remote.timeoutNextSendAsset = false; throw new Error('request timed out') }
    posted.push({ action, signature, nonce }); return { status: 'ok', response: { type: 'default' } }
  },
}
const account = buildToolDefinitions(remote).find((tool) => tool.name === 'hyper_account')
const exec = { agent: { id: 's1' } }

// 半托管: limits belong to the trader; the agent is told where to change them
await assert.rejects(account.execute({ action: 'limits', addCoins: ['xyz:XYZ100'] }, exec), /半托管.*设置 → 交易限额与签名规则.*全托管/)
// a transfer still works, but only with the trader's approval
const viaApproval = await account.execute({ action: 'transfer', dex: 'xyz', amount: 50 }, exec)
assert.equal(approvals, 1, 'assisted transfer asks for approval'); assert.match(viaApproval.text, /主永续账户 → xyz/)
const sent = posted.at(-1)
assert.deepEqual({ ...sent.action, signatureChainId: undefined }, { ...buildSendAsset({ destination: wallet.address, sourceDex: '', destinationDex: 'xyz', token: 'USDC:0x6d1e7cde53ba9467b783cb7c530ce054', amount: '50', nonce: 1792140000000, isMainnet: true }).action, signatureChainId: undefined })
const { typed } = buildSendAsset({ ...sent.action, isMainnet: true })
assert.equal(verifyTypedData(typed.domain, typed.types, typed.value, Signature.from(sent.signature)), wallet.address, 'the transfer is signed by the trading wallet')

// the desk switch: live managed needs an explicit acknowledgement
await assert.rejects(remote.setCustody({ mode: 'managed' }), /确认/)
await remote.setCustody({ mode: 'managed', acknowledge: true })
assert.equal(remote.store.custody(), 'managed', 'the choice persists')

// 全托管: the agent adjusts limits itself, and transfers go straight through
const limits = await account.execute({ action: 'limits', addCoins: ['xyz:100'], maxOrderUsd: 250 }, exec)
assert.deepEqual(limits.after.allowedCoins, ['BTC', 'xyz:XYZ100']); assert.equal(limits.after.maxOrderUsd, 250)
assert.equal(remote.cfg.maxOrderUsd, 250, 'the guard uses the new limit'); assert.equal(remote.store.getRiskSettings().maxOrderUsd, 250, 'and it is saved')
// all markets via the agent, and back to a list
const toAll = await account.execute({ action: 'limits', addCoins: ['*'] }, exec)
assert.deepEqual(toAll.after.allowedCoins, ['*'])
await assert.rejects(account.execute({ action: 'limits', removeCoins: ['SOL'] }, exec), /当前允许全部币对/)
const toList = await account.execute({ action: 'limits', removeCoins: ['*'], addCoins: ['BTC', 'xyz:100'] }, exec)
assert.deepEqual(toList.after.allowedCoins, ['BTC', 'xyz:XYZ100'])
assert.ok(remote.store.eventsSince(0).events.some((ev) => ev.kind === 'risk.changed' && ev.data?.by === 'agent'), 'the desk is told the agent changed limits')
await account.execute({ action: 'transfer', dex: 'xyz', amount: 30, direction: 'out' }, exec)
assert.equal(approvals, 1, 'managed transfer does not ask again')
assert.equal(posted.at(-1).action.sourceDex, 'xyz'); assert.equal(posted.at(-1).action.destinationDex, '')

// guard rails that hold in both modes
await assert.rejects(account.execute({ action: 'transfer', dex: 'xyz', amount: 45, direction: 'out' }, exec), /可划转 40\.00/)
await assert.rejects(account.execute({ action: 'transfer', dex: 'flx', amount: 10 }, exec), /不使用 USDC/)
await assert.rejects(account.execute({ action: 'transfer', dex: 'xyz', amount: 900 }, exec), /仓位上限/)
// spot ↔ perp: usdClassTransfer, signed by the trading wallet, both directions
const toPerp = await account.execute({ action: 'transfer', from: 'spot', to: 'perp', amount: 200 }, exec)
assert.match(toPerp.text, /现货账户 → 主永续账户/)
const spotSent = posted.at(-1)
assert.deepEqual(spotSent.action, buildUsdClassTransfer({ amount: '200', toPerp: true, nonce: 1792140000000, isMainnet: true }).action)
const spotTyped = buildUsdClassTransfer({ amount: '200', toPerp: true, nonce: 1792140000000, isMainnet: true }).typed
assert.deepEqual(Object.keys(spotTyped.types), ['HyperliquidTransaction:UsdClassTransfer'])
assert.equal(verifyTypedData(spotTyped.domain, spotTyped.types, spotTyped.value, Signature.from(spotSent.signature)), wallet.address, 'spot → perp is signed by the trading wallet')
await account.execute({ action: 'transfer', from: 'perp', to: 'spot', amount: 50 }, exec)
assert.equal(posted.at(-1).action.type, 'usdClassTransfer'); assert.equal(posted.at(-1).action.toPerp, false)
await assert.rejects(account.execute({ action: 'transfer', from: 'spot', to: 'perp', amount: 240 }, exec), /现货账户可划转 230\.00/)
// spot → HIP-3 and HIP-3 → HIP-3 go through perp: two signed legs, one approval
let approvalsBefore = approvals, postedBefore = posted.length
const twoLeg = await account.execute({ action: 'transfer', from: 'spot', to: 'xyz', amount: 10 }, exec)
assert.match(twoLeg.text, /现货账户 → 主永续账户 → xyz（两步）/)
assert.deepEqual(posted.slice(postedBefore).map((row) => [row.action.type, row.action.toPerp ?? row.action.destinationDex]), [['usdClassTransfer', true], ['sendAsset', 'xyz']])
assert.equal(approvals - approvalsBefore, remote.isManaged() ? 0 : 1, 'one approval for both legs')
postedBefore = posted.length
await account.execute({ action: 'transfer', from: 'xyz', to: 'abc', amount: 10 }, exec)
assert.deepEqual(posted.slice(postedBefore).map((row) => [row.action.sourceDex, row.action.destinationDex]), [['xyz', ''], ['', 'abc']])
// a failed second leg says where the money is
remote.failNextSendAsset = true
await assert.rejects(account.execute({ action: 'transfer', from: 'spot', to: 'xyz', amount: 10 }, exec), /第一步已完成（10 USDC 已到主永续账户）.*第二步.*未完成.*资金在主永续账户/)
// a second leg that timed out may have gone through: the agent is told to reconcile, not retry
remote.timeoutNextSendAsset = true
await assert.rejects(account.execute({ action: 'transfer', from: 'spot', to: 'xyz', amount: 10 }, exec), /已提交但未收到确认.*结果未知.*不要直接重试/)
// cancelled between the legs: the error still says where the money is
const between = new AbortController()
const originalSign = remote.signUserTyped
// (the first leg is confirmed; the cancel lands while the second is being signed)
remote.signUserTyped = async function (...args) { if (args[1].includes('（2/2）')) between.abort(); return originalSign.apply(this, args) }
postedBefore = posted.length
await assert.rejects(account.execute({ action: 'transfer', from: 'spot', to: 'xyz', amount: 10 }, { ...exec, signal: between.signal }), /第一步已完成（10 USDC 已到主永续账户）.*资金在主永续账户/)
assert.deepEqual(posted.slice(postedBefore).map((row) => row.action.type), ['usdClassTransfer'], 'only the first leg reached the exchange')
// a wallet switch between the legs: same message, second leg not submitted
remote.signUserTyped = async function (...args) { if (args[1].includes('（2/2）')) remote.walletEpoch = (remote.walletEpoch ?? 0) + 1; return originalSign.apply(this, args) }
postedBefore = posted.length
await assert.rejects(account.execute({ action: 'transfer', from: 'spot', to: 'xyz', amount: 10 }, exec), /第一步已完成.*钱包已切换.*资金在主永续账户/)
assert.deepEqual(posted.slice(postedBefore).map((row) => row.action.type), ['usdClassTransfer'])
remote.signUserTyped = originalSign
// failed second legs are in the event log
assert.ok(remote.store.eventsSince(0).events.some((ev) => ev.kind === 'live.transfer' && ev.data?.failed && ev.data?.unknown === true), 'an unconfirmed second leg is logged as unknown')
assert.ok(remote.store.eventsSince(0).events.some((ev) => ev.kind === 'live.transfer' && ev.data?.failed && ev.data?.unknown === false), 'a refused second leg is logged')
// perp must have the money free before the second leg
const originalPerp = remote.client.clearinghouseState
remote.client.clearinghouseState = async () => ({ withdrawable: '3', assetPositions: [] })
postedBefore = posted.length
await assert.rejects(account.execute({ action: 'transfer', from: 'spot', to: 'xyz', amount: 10 }, exec), /第一步已完成.*主永续账户可划转 3\.00 USDC，不足 10/)
assert.deepEqual(posted.slice(postedBefore).map((row) => row.action.type), ['usdClassTransfer'], 'the second leg is not submitted')
remote.client.clearinghouseState = originalPerp
// a non-USDC dex on either side is refused before anything is signed
postedBefore = posted.length
await assert.rejects(account.execute({ action: 'transfer', from: 'spot', to: 'flx', amount: 10 }, exec), /flx 不使用 USDC/)
assert.equal(posted.length, postedBefore)
await assert.rejects(account.execute({ action: 'transfer', from: 'perp', to: 'perp', amount: 10 }, exec), /不能相同/)
// perp → HIP-3 with the new parameters is the same sendAsset as dex + direction
await account.execute({ action: 'transfer', from: 'perp', to: 'xyz', amount: 20 }, exec)
assert.equal(posted.at(-1).action.type, 'sendAsset'); assert.equal(posted.at(-1).action.destinationDex, 'xyz')
// unified accounts already use spot USDC as margin
remote.testAccountMode = 'unifiedAccount'; remote.accountModeCache = null
await assert.rejects(account.execute({ action: 'transfer', from: 'spot', to: 'perp', amount: 10 }, exec), /无需划转/)
remote.testAccountMode = 'default'; remote.accountModeCache = null
// No transfer is signed when the account mode cannot be read, nor between two HIP-3 dexes
const sentBefore = posted.length
remote.testAccountMode = 'boom'; remote.accountModeCache = null
await assert.rejects(account.execute({ action: 'transfer', from: 'spot', to: 'perp', amount: 10 }, exec), /未知账户模式/)
remote.testAccountMode = 'default'; remote.accountModeCache = null
await assert.rejects(account.execute({ action: 'transfer', from: 'xyz', to: 'flx', amount: 10 }, exec), /flx 不使用 USDC/)
assert.equal(posted.length, sentBefore, 'nothing was submitted')
// testnet signs for the Testnet chain
remote.cfg.network = 'testnet'
await account.execute({ action: 'transfer', from: 'spot', to: 'perp', amount: 5 }, exec)
assert.equal(posted.at(-1).action.hyperliquidChain, 'Testnet')
remote.cfg.network = 'mainnet'

remote.cfg.tradingMode = 'paper'
await assert.rejects(account.execute({ action: 'transfer', dex: 'xyz', amount: 10 }, exec), /paper/)
await remote.setCustody({ mode: 'assisted' })
remote.cfg.tradingMode = 'live'
await assert.rejects(remote.transferCollateral({ dex: 'xyz', amount: 0.0000001 }, exec), /6 位小数/)
const originalAddress = remote.resolveAddress
remote.resolveAddress = async () => '0x0000000000000000000000000000000000000001'
const identityPosts = posted.length
await assert.rejects(remote.transferCollateral({ dex: 'xyz', amount: 10 }, exec), /主钱包签名.*不一致/)
remote.resolveAddress = originalAddress
remote.cfg.signer = 'web3'
remote.web3Address = async () => wallet.address
remote.walletService = () => ({ signTypedData: async () => ({ status: 'signed', address: '0x0000000000000000000000000000000000000001', signature: await wallet.signTypedData(typed.domain, typed.types, typed.value) }) })
remote.approvalGateway = () => null
await assert.rejects(remote.transferCollateral({ dex: 'xyz', amount: 10 }, exec), /返回的签名地址.*不一致/)
assert.equal(posted.length, identityPosts, 'identity mismatches never reach the exchange')
const walletAbort = new AbortController()
remote.walletService = () => ({ signTypedData: async (args) => {
  const signature = await wallet.signTypedData(args.domain, args.types, args.value)
  walletAbort.abort()
  return { status: 'signed', address: wallet.address, signature }
} })
await assert.rejects(remote.transferCollateral({ dex: 'xyz', amount: 10 }, { ...exec, signal: walletAbort.signal }), { name: 'AbortError' })
assert.equal(posted.length, identityPosts, 'cancellation after wallet signing never submits the signature')
remote.cfg.signer = 'local'

// Exercise the real constructor wrapper while approval is pending: a transfer
// must hold the same environment lock as an order, including rejection cleanup.
const locked = new HyperRemote(new Context(), { dataDir: mkdtempSync(join(tmpdir(), 'dhl-transfer-lock-')), network: 'testnet', tradingMode: 'live', privateKey: key })
locked.client.close()
locked.client = remote.client
locked.resolveAddress = remote.resolveAddress
let releaseApproval, enteredApproval
const entered = new Promise((resolve) => { enteredApproval = resolve })
locked.authorizeToolAction = () => { enteredApproval(); return new Promise((resolve) => { releaseApproval = resolve }) }
try {
  const transfer = locked.transferCollateral({ dex: 'xyz', amount: 10 }, exec)
  await entered
  assert.equal(locked.activeTradeOps, 1, 'pending transfer holds the environment lock')
  await assert.rejects(locked.switchNetwork({ network: 'mainnet', acknowledgeMainnet: true }), /交易操作仍在进行/)
  await assert.rejects(locked.switchTradingMode({ mode: 'paper' }), /交易操作仍在进行/)
  await assert.rejects(locked.updateRiskSettings({ limits: { allowedCoins: ['BTC'], maxOrderUsd: 100, maxDailyUsd: 500, maxPositionUsd: 500, maxLeverage: 2 } }), /交易操作仍在进行/)
  await assert.rejects(locked.resetRiskSettings(), /交易操作仍在进行/)
  await assert.rejects(locked.setCustody({ mode: 'managed', acknowledge: true }), /交易操作仍在进行/)
  releaseApproval()
  await transfer
  assert.equal(posted.at(-1).action.hyperliquidChain, 'Testnet')
  assert.equal(locked.activeTradeOps, 0)
  locked.authorizeToolAction = async () => { throw new Error('approval rejected') }
  await assert.rejects(locked.transferCollateral({ dex: 'xyz', amount: 10 }, exec), /approval rejected/)
  assert.equal(locked.activeTradeOps, 0, 'rejection releases the environment lock')
  const abort = new AbortController()
  locked.authorizeToolAction = async () => { abort.abort() }
  const before = posted.length
  await assert.rejects(locked.transferCollateral({ dex: 'xyz', amount: 10 }, { ...exec, signal: abort.signal }), { name: 'AbortError' })
  assert.equal(posted.length, before, 'cancelled transfer never reaches the exchange')
} finally {
  releaseApproval?.()
  clearInterval(locked.sweepTimer)
  clearInterval(locked.alertTimer)
}
console.log('托管模式：半托管限额只由用户改、划转需批准；全托管 agent 可调限额与直接划转；sendAsset 由交易钱包签名')
