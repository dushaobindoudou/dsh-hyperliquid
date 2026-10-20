import type { Candle } from './types'
import { computeStudies, type IndicatorSettings } from '../../lib/studies.js'
export type IndicatorId = 'sma20' | 'sma60' | 'ema20' | 'ema50' | 'bollinger20' | 'rsi14' | 'macd' | 'volume' | 'atr14' | 'vwap' | 'stochastic' | 'adx' | 'obv'
export type ChartPoint = { time: number; value: number }
export function chartIndicators(candles: Candle[], settings?: IndicatorSettings) { return computeStudies(candles, settings) }
