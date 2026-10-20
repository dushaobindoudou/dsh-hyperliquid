/** Known legacy/display names that are not valid Hyperliquid API coin names. */
export function canonicalMarketCoin(value) {
  const coin = String(value ?? '').trim()
  return coin === 'xyz:100' || coin === 'XYZ100' ? 'xyz:XYZ100' : coin
}
