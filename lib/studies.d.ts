export interface IndicatorSettings {
  rsi: { period: number; lower: number; upper: number }
  macd: { fast: number; slow: number; signal: number }
  bollinger: { period: number; multiplier: number }
  stochastic: { period: number; smoothK: number; smoothD: number; lower: number; upper: number }
  adx: { period: number; smoothing: number }
}
export type StudyKey = 'sma20' | 'sma60' | 'ema20' | 'ema50' | 'basis' | 'upper' | 'lower' | 'rsi14' | 'macd' | 'signal' | 'histogram' | 'atr14' | 'vwap' | 'stochK' | 'stochD' | 'adx' | 'plusDI' | 'minusDI' | 'obv'
export declare const INDICATOR_IDS: string[]
export declare const DEFAULT_INDICATOR_SETTINGS: IndicatorSettings
export declare function normalizeIndicatorSettings(input?: unknown): IndicatorSettings
export declare function computeStudies(candles: readonly {t: number; o: number; h: number; l: number; c: number; v: number}[], input?: IndicatorSettings): Record<StudyKey, Array<{ time: number; value: number }>>
export declare function studyDefinitions(input?: IndicatorSettings): Array<[string, StudyKey, string]>
