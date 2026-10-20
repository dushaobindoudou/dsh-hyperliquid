/** Move a fixed amount of mock USDC from this project's testnet Spot wallet to Perps.
 * Requires an explicit approval at the dsh-web3 signing gate; never retries a broadcast.
 */
import assert from 'node:assert/strict'
import { homedir } from 'node:os'
import { resolve } from 'node:path'
import { createInterface } from 'node:readline/promises'
import { WalletVault } from 'dsh-web3-core'
import { WalletService } from '../node_modules/dsh-web3/lib/service.js'
import { createSecretStore } from '../node_modules/dsh-web3/lib/keychain.js'
import { splitSignature } from '../lib/signing.js'
import { HyperliquidClient } from '../lib/hl.js'

const amount = '100'
const expectedAddress = '0xF5D7710aC1bBDc51fB32Dfa67fC5D0f22CD9636C'
const vaultPath = resolve(homedir(), '.dsh-hyperliquid-test-web3')
const vault = await WalletVault.open({ directory: vaultPath, autoLockMs: 900_000 })
const wallet = new WalletService(vault, {
  vaultPath, autoLockMs: 900_000, passphraseMode: 'auto', env: {},
  credentials: undefined, keychain: createSecretStore('auto', vaultPath),
  rpcOverrides: {}, tokens: {}, allowModelSecretReveal: false,
})
const account = wallet.listAccounts().find((a) => a.label === 'hyperliquid-testnet')
assert.equal(account?.address?.toLowerCase(), expectedAddress.toLowerCase(), 'test wallet address changed')
const client = new HyperliquidClient({ network: 'testnet' })
const rl = createInterface({ input: process.stdin, output: process.stdout })

const balances = async () => {
  const [spot, perp] = await Promise.all([
    client.spotClearinghouseState(expectedAddress), client.clearinghouseState(expectedAddress),
  ])
  return {
    spotUsdc: Number(spot?.balances?.find((b) => b.coin === 'USDC')?.total ?? 0),
    perpEquity: Number(perp?.marginSummary?.accountValue ?? 0),
    positions: perp?.assetPositions?.length ?? 0,
  }
}

try {
  const before = await balances()
  assert.ok(before.spotUsdc >= Number(amount), 'Spot USDC below transfer amount')
  assert.equal(before.positions, 0, 'existing position: stop for manual review')
  console.log(JSON.stringify({ phase: 'before', network: 'testnet', address: expectedAddress, amount, ...before }))

  const nonce = Date.now()
  const action = {
    type: 'usdClassTransfer', signatureChainId: '0x66eee',
    hyperliquidChain: 'Testnet', amount, toPerp: true, nonce,
  }
  const domain = {
    name: 'HyperliquidSignTransaction', version: '1', chainId: 421614,
    verifyingContract: '0x0000000000000000000000000000000000000000',
  }
  const types = {
    'HyperliquidTransaction:UsdClassTransfer': [
      { name: 'hyperliquidChain', type: 'string' },
      { name: 'amount', type: 'string' },
      { name: 'toPerp', type: 'bool' },
      { name: 'nonce', type: 'uint64' },
    ],
  }
  await wallet.unlock()
  const approval = {
    request: async ({ reason }) => {
      console.log(`\nDSH-WEB3 APPROVAL REQUIRED\n${reason}\n`)
      const answer = await rl.question('Type APPROVE for this one signature, anything else to reject: ')
      return answer.trim() === 'APPROVE' ? 'allowed-once' : 'denied'
    },
  }
  const signed = await wallet.signTypedData(
    { account: account.id, domain, types, value: action, purpose: `Move ${amount} mock USDC from Hyperliquid testnet Spot to Perps` },
    approval,
    { toolName: 'dsh-hyperliquid-testnet-funding', agent: { id: 'testnet-acceptance' }, callId: `fund-${nonce}` },
  )
  assert.equal(signed?.status, 'signed', `wallet rejected signature: ${signed?.status}`)
  assert.equal(signed.address.toLowerCase(), expectedAddress.toLowerCase())
  const body = { action, nonce, signature: splitSignature(signed.signature) }
  const response = await fetch('https://api.hyperliquid-testnet.xyz/exchange', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  })
  const result = await response.json()
  console.log(JSON.stringify({ phase: 'exchange', httpStatus: response.status, result }))
  assert.equal(response.ok, true, 'exchange HTTP rejection')
  assert.equal(result?.status, 'ok', 'exchange action rejection')
  const after = await balances()
  console.log(JSON.stringify({ phase: 'after', ...after }))
  assert.ok(before.spotUsdc - after.spotUsdc >= Number(amount) - 1e-6, 'Spot balance did not decrease')
  assert.ok(after.perpEquity - before.perpEquity >= Number(amount) - 1e-6, 'Perps equity did not increase')
} finally {
  rl.close()
  wallet.lock()
  client.close()
}
