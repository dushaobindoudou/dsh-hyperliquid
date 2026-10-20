// sendAsset is a user-signed EIP-712 action. Our in-plugin signer must produce exactly what a standard
// ethers / wallet signer produces for the same payload (the dsh-web3 path signs that payload directly).
import assert from 'node:assert/strict'
import { Wallet, Signature, verifyTypedData } from 'ethers'
import { buildSendAsset, signTypedDataLocal, splitSignature } from '../lib/signing.js'

const key = '0x0123456789012345678901234567890123456789012345678901234567890123'
const wallet = new Wallet(key)
for (const isMainnet of [true, false]) {
  const { action, typed } = buildSendAsset({ destination: wallet.address, sourceDex: '', destinationDex: 'xyz', token: 'USDC:0x6d1e7cde53ba9467b783cb7c530ce054', amount: '25.5', nonce: 1792140000000, isMainnet })
  assert.equal(action.hyperliquidChain, isMainnet ? 'Mainnet' : 'Testnet')
  assert.deepEqual(Object.keys(typed.value), ['hyperliquidChain', 'destination', 'sourceDex', 'destinationDex', 'token', 'amount', 'fromSubAccount', 'nonce'], 'SDK field order')
  const ours = await signTypedDataLocal(key, typed)
  const theirs = splitSignature(await wallet.signTypedData(typed.domain, typed.types, typed.value))
  assert.deepEqual(ours, theirs, 'local EIP-712 signature equals the ethers signature')
  assert.equal(verifyTypedData(typed.domain, typed.types, typed.value, Signature.from(ours)), wallet.address, 'it recovers the signing wallet')
}
console.log('sendAsset 用户签名：字段顺序与 SDK 一致，本地签名与 ethers 逐字节一致（主网/测试网）')
