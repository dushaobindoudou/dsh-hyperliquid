export type MaKind = 'sma' | 'ema' | 'smma' | 'wma'
export type MaSource = 'close' | 'open' | 'high' | 'low' | 'hl2' | 'hlc3' | 'ohlc4'
export interface MaLine {
  id: string
  kind: MaKind
  period: number
  source: MaSource
  smoothing: { kind: MaKind; period: number } | null
  color?: string
}
export interface MaCandle { o: number; h: number; l: number; c: number }
export declare const MA_KINDS: MaKind[]
export declare const MA_SOURCES: MaSource[]
export declare const MA_MAX_LINES: number
export declare const MA_MAX_PERIOD: number
export declare function normalizeMaLine(input: unknown): MaLine
export declare function normalizeMaLines(list: unknown): MaLine[]
export declare function maLabel(line: MaLine): string
export declare function movingAverage(values: Array<number | null>, kind: MaKind, period: number): Array<number | null>
export declare function maSeries(candles: MaCandle[], line: MaLine): { values: Array<number | null>; smoothed: Array<number | null> | null }
export declare function maLatest(candles: MaCandle[], lines: MaLine[]): Array<{ id: string; label: string; value: number | null; smoothed: number | null; line: MaLine }>
