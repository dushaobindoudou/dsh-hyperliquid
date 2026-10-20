/**
 * dsh-hyperliquid — EIP-712 L1 action signing.
 *
 * Replicates hyperliquid-python-sdk v0.24.0 signing.py (verified against the
 * research doc §4, which line-read the SDK source):
 *
 *   actionHash  = keccak256(msgpack(action) ‖ nonce(8B BE)
 *                            ‖ [0x00]                       (no vault)
 *                            | [0x01 ‖ vault20(lowercase)]  (vault routing)
 *                            ‖ [0x00 ‖ expiresAfter(8B BE)] (opt-in expiry))
 *   phantom     = { source: 'a' (mainnet) | 'b' (testnet), connectionId: actionHash }
 *   digest      = keccak256(0x1901 ‖ domainSeparator ‖ structHash)
 *   domain      = EIP712Domain(name "Exchange", version "1", chainId 1337,
 *                             verifyingContract 0x000…000)
 *   primaryType = Agent { source: string, connectionId: bytes32 }
 *
 * Curve math comes from @noble/curves + @noble/hashes, imported dynamically so
 * the bundle stays dependency-free; without them live trading degrades to a
 * clear error while paper trading and market data keep working.
 *
 * Wire contract notes (research §4.4): px/sz travel as decimal STRINGS with
 * trailing zeros stripped (float_to_wire); addresses lowercase; msgpack field
 * order matters.
 *
 * ✅ VALIDATED 2026-10-12 against the installed official SDK
 * (hyperliquid-python-sdk, eth_account 0.13.7): three vectors — mainnet order,
 * testnet cancel with vault, updateLeverage — reproduce identical r/s/v.
 * The one real trap this uncovered: inside the EIP-712 domain separator the
 * `verifyingContract` address encodes as a LEFT-PADDED 32-byte value, while
 * the actionHash vault pre-image keeps the raw 20 bytes.
 * @module lib/signing.js
 */

import { packb } from './msgpack.js'

/** Hyperliquid hashes MessagePack with protocol field order, not caller key order. */
export function canonicalAction(action) {
  if (!action || typeof action !== 'object' || Array.isArray(action)) throw new Error('exchange action 必须为对象')
  const fields = (value, names, label) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} 必须为对象`)
    for (const key of Object.keys(value)) if (!names.includes(key)) throw new Error(`${label} 包含未知字段 ${key}`)
    for (const key of names) if (!(key in value)) throw new Error(`${label} 缺少字段 ${key}`)
    return Object.fromEntries(names.map((key) => [key, value[key]]))
  }
  switch (action.type) {
    case 'order': {
      const top = fields(action, ['type', 'orders', 'grouping'], 'order action')
      if (!Array.isArray(top.orders) || top.orders.length === 0) throw new Error('order action 需要 orders')
      return { type: 'order', orders: top.orders.map((order) => {
        const names = ['a', 'b', 'p', 's', 'r', 't', ...(order && 'c' in order ? ['c'] : [])]
        return fields(order, names, 'order')
      }), grouping: top.grouping }
    }
    case 'cancel': {
      const top = fields(action, ['type', 'cancels'], 'cancel action')
      if (!Array.isArray(top.cancels) || top.cancels.length === 0) throw new Error('cancel action 需要 cancels')
      return { type: 'cancel', cancels: top.cancels.map((cancel) => fields(cancel, ['a', 'o'], 'cancel')) }
    }
    case 'updateLeverage':
      return fields(action, ['type', 'asset', 'isCross', 'leverage'], 'updateLeverage action')
    default:
      throw new Error(`不支持的 exchange action: ${String(action.type)}`)
  }
}

const NULL_ADDRESS = new Uint8Array(32) // EIP-712 encodes address members left-padded to 32 bytes

let cryptoCache = null
/** Load @noble stacks once; memoised. */
async function loadCrypto() {
  if (cryptoCache) return cryptoCache
  let nobleHashes
  let nobleCurves
  try {
    nobleHashes = await import('@noble/hashes/sha3')
    nobleCurves = await import('@noble/curves/secp256k1')
  } catch (err) {
    throw new Error(
      'live 下单需要 @noble/curves 与 @noble/hashes（未安装）。' +
      '请在插件运行环境安装这两个依赖，或继续使用 paper 模式。原始错误: ' + String(err?.message ?? err),
    )
  }
  // @noble/hashes ≥1.8 renames keccak256 → keccak_256; accept both spellings.
  const keccak256 = nobleHashes.keccak256 ?? nobleHashes.keccak_256
  const { secp256k1 } = nobleCurves
  cryptoCache = {
    keccak256,
    sign: (digest, priv) => secp256k1.sign(digest, priv, { prehash: false }),
    hexToBytes: (hex) => {
      const clean = hex.startsWith('0x') ? hex.slice(2) : hex
      const out = new Uint8Array(clean.length / 2)
      for (let i = 0; i < out.length; i += 1) out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16)
      return out
    },
    bytesToHex: (bytes) => Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join(''),
    hashText: (text) => keccak256(new TextEncoder().encode(text)),
  }
  return cryptoCache
}

function concat(...arrays) {
  const total = arrays.reduce((n, a) => n + a.length, 0)
  const out = new Uint8Array(total)
  let at = 0
  for (const a of arrays) { out.set(a, at); at += a.length }
  return out
}

function u256be(value) {
  const hex = BigInt.asUintN(256, BigInt(value)).toString(16).padStart(64, '0')
  return cryptoCache.hexToBytes(hex)
}

function addressBytes(address) {
  const clean = address.startsWith('0x') ? address.slice(2) : address
  if (!/^[0-9a-fA-F]{40}$/.test(clean)) throw new Error(`bad address: ${address}`)
  return cryptoCache.hexToBytes(clean)
}

/** keccak256(msgpack(action) ‖ nonce ‖ vaultFlag ‖ [expiresAfter]) — exported for diagnostics. */
export async function actionHash(action, vaultAddress, nonce, expiresAfter) {
  const c = await loadCrypto()
  const parts = [packb(canonicalAction(action)), u256be(nonce).slice(24)] // low 8 bytes, big-endian
  if (vaultAddress) {
    parts.push(new Uint8Array([0x01]), addressBytes(vaultAddress)) // addressBytes yields lowercase bytes
  } else {
    parts.push(new Uint8Array([0x00]))
  }
  if (Number.isFinite(expiresAfter)) {
    parts.push(new Uint8Array([0x00]), u256be(Math.floor(expiresAfter)).slice(24))
  }
  return c.keccak256(concat(...parts))
}

/**
 * Sign one L1 action. @returns {{r: string, s: string, v: number}}
 * r/s are 0x-prefixed 32-byte hex; v is 27|28 (eth_sign style, no EIP-155).
 */
export async function signL1Action(privateKey, action, vaultAddress, nonce, isMainnet = true) {
  const c = await loadCrypto()
  const hash = await actionHash(action, vaultAddress, nonce)

  const domainTypehash = c.hashText('EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)')
  const agentTypehash = c.hashText('Agent(string source,bytes32 connectionId)')
  const domainName = c.hashText('Exchange')
  const domainVersion = c.hashText('1')

  const domainSeparator = c.keccak256(concat(domainTypehash, domainName, domainVersion, u256be(1337), NULL_ADDRESS))
  const sourceHash = c.hashText(isMainnet ? 'a' : 'b')
  const structHash = c.keccak256(concat(agentTypehash, sourceHash, hash))
  const digest = c.keccak256(concat(new Uint8Array([0x19, 0x01]), domainSeparator, structHash))

  const priv = c.hexToBytes(privateKey)
  if (priv.length !== 32) throw new Error('钱包私钥格式错误（需要 32 字节 hex）')
  const sig = c.sign(digest, priv)
  const recovery = typeof sig.recovery === 'number' ? sig.recovery : sig.v - 27
  const rHex = c.bytesToHex(typeof sig.r === 'bigint' ? u256be(sig.r) : sig.r).padStart(64, '0').slice(-64)
  const sHex = c.bytesToHex(typeof sig.s === 'bigint' ? u256be(sig.s) : sig.s).padStart(64, '0').slice(-64)
  return { r: '0x' + rHex, s: '0x' + sHex, v: 27 + recovery }
}

/**
 * Build the L1 action as a STANDARD EIP-712 typed-data payload — the shape
 * dsh-web3's `ctx.wallet.signTypedData` (and any ethers-style signer) accepts.
 * Digest path equivalence is guaranteed by the same actionHash + domain
 * constants used by signL1Action; test/signing-web3.test.mjs cross-validates
 * that ethers signs this payload to the exact r/s/v of the official vectors.
 * @returns {{domain, types, value}} ethers-compatible typed data
 */
export async function buildL1TypedData(action, nonce, { vaultAddress = null, isMainnet = true } = {}) {
  const c = await loadCrypto()
  const hash = await actionHash(action, vaultAddress, nonce)
  const connectionId = '0x' + c.bytesToHex(hash)
  return {
    domain: {
      name: 'Exchange',
      version: '1',
      chainId: 1337,
      verifyingContract: '0x0000000000000000000000000000000000000000',
    },
    types: {
      Agent: [
        { name: 'source', type: 'string' },
        { name: 'connectionId', type: 'bytes32' },
      ],
    },
    value: { source: isMainnet ? 'a' : 'b', connectionId },
  }
}

/**
 * Split a 65-byte hex signature (0x + 130 chars, ethers style) into the
 * Hyperliquid wire form: r/s as 0x-prefixed 32-byte hex, v as 27|28.
 */
export function splitSignature(hex) {
  const clean = String(hex ?? '').replace(/^0x/, '')
  if (clean.length !== 130) throw new Error(`签名长度异常（期望 65 字节 hex）：${clean.length} 字符`)
  const r = clean.slice(0, 64)
  const s = clean.slice(64, 128)
  const vHex = clean.slice(128, 130)
  const vNum = parseInt(vHex, 16)
  const v = vNum >= 27 ? vNum : vNum + 27
  return { r: '0x' + r, s: '0x' + s, v }
}

/** Derive the EVM address (0x…) for a private key — used for account reads. */
export async function addressFromPrivateKey(privateKey) {
  const c = await loadCrypto()
  const priv = c.hexToBytes(privateKey)
  if (priv.length !== 32) throw new Error('钱包私钥格式错误（需要 32 字节 hex）')
  const { secp256k1 } = await import('@noble/curves/secp256k1')
  const pub = secp256k1.getPublicKey(priv, false) // uncompressed: 0x04 ‖ X ‖ Y
  const hash = c.keccak256(pub.slice(1))
  return '0x' + c.bytesToHex(hash.slice(-20))
}

// ── user-signed actions (EIP-712 "HyperliquidSignTransaction" domain) ──
// Field lists and order follow the official Python SDK (utils/signing.py); the main wallet signs them.
export const SEND_ASSET_TYPES = [
  { name: 'hyperliquidChain', type: 'string' },
  { name: 'destination', type: 'string' },
  { name: 'sourceDex', type: 'string' },
  { name: 'destinationDex', type: 'string' },
  { name: 'token', type: 'string' },
  { name: 'amount', type: 'string' },
  { name: 'fromSubAccount', type: 'string' },
  { name: 'nonce', type: 'uint64' },
]
/** The SDK signs user actions on chain 0x66eee; hyperliquidChain inside the message prevents replay across networks. */
export const USER_SIGNATURE_CHAIN_ID = '0x66eee'

/**
 * A `sendAsset` action (move collateral between perp dexes / spot) and its EIP-712 payload.
 * @returns {{ action, typed: { domain, types, value } }}
 */
export function buildSendAsset({ destination, sourceDex, destinationDex, token, amount, nonce, isMainnet = true }) {
  const action = { type: 'sendAsset', signatureChainId: USER_SIGNATURE_CHAIN_ID, hyperliquidChain: isMainnet ? 'Mainnet' : 'Testnet',
    destination, sourceDex, destinationDex, token, amount, fromSubAccount: '', nonce }
  const value = Object.fromEntries(SEND_ASSET_TYPES.map(({ name }) => [name, action[name]]))
  return {
    action,
    typed: {
      domain: { name: 'HyperliquidSignTransaction', version: '1', chainId: parseInt(USER_SIGNATURE_CHAIN_ID, 16), verifyingContract: '0x0000000000000000000000000000000000000000' },
      types: { 'HyperliquidTransaction:SendAsset': SEND_ASSET_TYPES },
      value,
    },
  }
}

/** `usdClassTransfer` fields, as the official SDK signs them. */
export const USD_CLASS_TRANSFER_TYPES = [
  { name: 'hyperliquidChain', type: 'string' },
  { name: 'amount', type: 'string' },
  { name: 'toPerp', type: 'bool' },
  { name: 'nonce', type: 'uint64' },
]

/**
 * A `usdClassTransfer` action (USDC between the spot balance and the core perp account) and its EIP-712 payload.
 * @returns {{ action, typed: { domain, types, value } }}
 */
export function buildUsdClassTransfer({ amount, toPerp, nonce, isMainnet = true }) {
  const action = { type: 'usdClassTransfer', signatureChainId: USER_SIGNATURE_CHAIN_ID, hyperliquidChain: isMainnet ? 'Mainnet' : 'Testnet', amount, toPerp: Boolean(toPerp), nonce }
  const value = Object.fromEntries(USD_CLASS_TRANSFER_TYPES.map(({ name }) => [name, action[name]]))
  return {
    action,
    typed: {
      domain: { name: 'HyperliquidSignTransaction', version: '1', chainId: parseInt(USER_SIGNATURE_CHAIN_ID, 16), verifyingContract: '0x0000000000000000000000000000000000000000' },
      types: { 'HyperliquidTransaction:UsdClassTransfer': USD_CLASS_TRANSFER_TYPES },
      value,
    },
  }
}

/** EIP-712 digest + secp256k1 signature for a single-struct payload of string / uint / bool / address fields. */
export async function signTypedDataLocal(privateKey, { domain, types, value }) {
  const c = await loadCrypto()
  const [primary, fields] = Object.entries(types)[0]
  const encode = (type, item) => {
    if (type === 'string') return c.hashText(String(item))
    if (type === 'bool') return u256be(item ? 1 : 0)
    if (type === 'address') { const out = new Uint8Array(32); out.set(addressBytes(item), 12); return out }
    if (/^uint\d+$/.test(type)) return u256be(item)
    throw new Error(`unsupported EIP-712 field type ${type}`)
  }
  const typeHash = c.hashText(`${primary}(${fields.map((f) => `${f.type} ${f.name}`).join(',')})`)
  const structHash = c.keccak256(concat(typeHash, ...fields.map((f) => encode(f.type, value[f.name]))))
  const domainHash = c.keccak256(concat(c.hashText('EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)'),
    c.hashText(domain.name), c.hashText(domain.version), u256be(domain.chainId), encode('address', domain.verifyingContract)))
  const digest = c.keccak256(concat(new Uint8Array([0x19, 0x01]), domainHash, structHash))
  const priv = c.hexToBytes(privateKey)
  if (priv.length !== 32) throw new Error('钱包私钥格式错误（需要 32 字节 hex）')
  const sig = c.sign(digest, priv)
  const recovery = typeof sig.recovery === 'number' ? sig.recovery : sig.v - 27
  const rHex = c.bytesToHex(typeof sig.r === 'bigint' ? u256be(sig.r) : sig.r).padStart(64, '0').slice(-64)
  const sHex = c.bytesToHex(typeof sig.s === 'bigint' ? u256be(sig.s) : sig.s).padStart(64, '0').slice(-64)
  return { r: '0x' + rHex, s: '0x' + sHex, v: 27 + recovery }
}
