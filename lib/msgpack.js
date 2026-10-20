/**
 * dsh-hyperliquid — canonical msgpack encoder.
 *
 * Hyperliquid's L1 action hash is keccak256(msgpack(action) ‖ nonce ‖ flags).
 * The hash input is never sent on the wire (the POST body is JSON), but it
 * must match the server's canonical encoding byte-for-byte, so this encoder
 * mirrors python-msgpack `packb` defaults:
 *   - nil/bool/int (fixint … uint64/int64)
 *   - float64 (0xcb) for non-integer numbers
 *   - str as fixstr/str8/16/32 (UTF-8) — order px/sz travel as strings
 *   - bin as bin8/16/32
 *   - array fixarray/array16/32, map fixmap/map16/32 (insertion order;
 *     the SDK builds actions with a fixed field order — keep it)
 * @module lib/msgpack.js
 */

export function packb(value) {
  const out = []
  writeValue(out, value)
  return Uint8Array.from(out)
}

function writeValue(out, value) {
  if (value === null || value === undefined) return out.push(0xc0)
  if (typeof value === 'boolean') return out.push(value ? 0xc3 : 0xc2)
  if (typeof value === 'number') return writeNumber(out, value)
  if (typeof value === 'string') return writeString(out, value)
  if (typeof value === 'bigint') return writeBigInt(out, value)
  if (value instanceof Uint8Array) return writeBin(out, value)
  if (Array.isArray(value)) return writeArray(out, value)
  if (typeof value === 'object') return writeMap(out, value)
  throw new TypeError(`msgpack: unsupported type ${typeof value}`)
}

function pushBytes(out, bytes) {
  for (const b of bytes) out.push(b)
}

function writeNumber(out, n) {
  if (!Number.isFinite(n)) throw new TypeError(`msgpack: non-finite number ${n}`)
  if (Number.isInteger(n)) {
    if (n >= 0) {
      if (n <= 0x7f) return out.push(n)
      if (n <= 0xff) return out.push(0xcc, n)
      if (n <= 0xffff) return out.push(0xcd, n >> 8, n & 0xff)
      if (n <= 0xffffffff) return out.push(0xce, (n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff)
      return writeBigInt(out, BigInt(n))
    }
    if (n >= -32) return out.push(0xe0 | (n + 32))
    if (n >= -128) return out.push(0xd0, n & 0xff)
    if (n >= -32768) return out.push(0xd1, (n >> 8) & 0xff, n & 0xff)
    if (n >= -2147483648) {
      const v = n < 0 ? n + 0x1_0000_0000 : n
      return out.push(0xd2, (v >>> 24) & 0xff, (v >>> 16) & 0xff, (v >>> 8) & 0xff, v & 0xff)
    }
    return writeBigInt(out, BigInt(n))
  }
  return writeF64(out, n)
}

function writeBigInt(out, n) {
  if (n >= 0n) {
    if (n <= 0xffff_ffff_ffff_ffffn) {
      const hex = n.toString(16).padStart(16, '0')
      out.push(0xcf, ...hexToBytes(hex))
      return
    }
    throw new TypeError('msgpack: uint64 overflow')
  }
  if (n >= -0x8000_0000_0000_0000n) {
    const hex = (n + 0x1_0000_0000_0000_0000n).toString(16).padStart(16, '0')
    out.push(0xd3, ...hexToBytes(hex))
    return
  }
  throw new TypeError('msgpack: int64 overflow')
}

function writeF64(out, n) {
  const buf = new DataView(new ArrayBuffer(8))
  buf.setFloat64(0, n, false)
  out.push(0xcb)
  for (let i = 0; i < 8; i += 1) out.push(buf.getUint8(i))
}

function writeString(out, s) {
  const bytes = new TextEncoder().encode(s)
  if (bytes.length <= 31) out.push(0xa0 | bytes.length)
  else if (bytes.length <= 0xff) out.push(0xd9, bytes.length)
  else if (bytes.length <= 0xffff) out.push(0xda, bytes.length >> 8, bytes.length & 0xff)
  else out.push(0xdb, (bytes.length >>> 24) & 0xff, (bytes.length >>> 16) & 0xff, (bytes.length >>> 8) & 0xff, bytes.length & 0xff)
  pushBytes(out, bytes)
}

function writeBin(out, bytes) {
  if (bytes.length <= 0xff) out.push(0xc4, bytes.length)
  else if (bytes.length <= 0xffff) out.push(0xc5, bytes.length >> 8, bytes.length & 0xff)
  else out.push(0xc6, (bytes.length >>> 24) & 0xff, (bytes.length >>> 16) & 0xff, (bytes.length >>> 8) & 0xff, bytes.length & 0xff)
  pushBytes(out, bytes)
}

function writeArray(out, arr) {
  if (arr.length <= 15) out.push(0x90 | arr.length)
  else if (arr.length <= 0xffff) out.push(0xdc, arr.length >> 8, arr.length & 0xff)
  else out.push(0xdd, (arr.length >>> 24) & 0xff, (arr.length >>> 16) & 0xff, (arr.length >>> 8) & 0xff, arr.length & 0xff)
  for (const v of arr) writeValue(out, v)
}

function writeMap(out, obj) {
  const entries = Object.entries(obj)
  if (entries.length <= 15) out.push(0x80 | entries.length)
  else if (entries.length <= 0xffff) out.push(0xde, entries.length >> 8, entries.length & 0xff)
  else out.push(0xdf, (entries.length >>> 24) & 0xff, (entries.length >>> 16) & 0xff, (entries.length >>> 8) & 0xff, entries.length & 0xff)
  for (const [k, v] of entries) {
    writeString(out, k)
    writeValue(out, v)
  }
}

function hexToBytes(hex) {
  const out = []
  for (let i = 0; i < hex.length; i += 2) out.push(parseInt(hex.slice(i, i + 2), 16))
  return out
}
