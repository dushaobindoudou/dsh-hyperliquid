export type DrawingKind = 'level' | 'hray' | 'vline' | 'text' | 'trend' | 'ray' | 'extended' | 'fib' | 'rect' | 'measure' | 'channel' | 'long' | 'short' | 'fibext' | 'fibchannel' | 'fibtime' | 'gannfan' | 'pitchfork' | 'regression' | 'vprofile' | 'arrow' | 'callout' | 'circle' | 'triangle' | 'brush' | 'crossline' | 'pricelabel' | 'infoline' | 'trendangle' | 'pricerange' | 'daterange' | 'elliott' | 'elliottabc' | 'xabcd' | 'abcd' | 'headshoulders' | 'gannbox' | 'gannsquare' | 'schiff' | 'modschiff' | 'icon' | 'flatchannel' | 'disjoint' | 'fibfan' | 'fibcircles' | 'fibarcs' | 'fibwedge' | 'fibtrendtime' | 'cypher' | 'threedrives' | 'tripattern' | 'elliotttri' | 'elliottwxy' | 'elliottwxyxz' | 'cycles' | 'sine' | 'ellipse' | 'rotrect' | 'arc' | 'curve' | 'note' | 'pricenote' | 'signpost' | 'avwap' | 'avprofile' | 'forecast' | 'highlighter' | 'path' | 'polyline' | 'pin' | 'fibspiral' | 'barspattern' | 'projection' | 'ghostfeed' | 'anchoredtext' | 'table' | 'gannfixed' | 'insidepitchfork'
export type LineStyleName = 'solid' | 'dashed' | 'dotted'
export interface DrawingStyle { visibleIntervals?: string[]; fontSize?: number; bold?: boolean; italic?: boolean; extendLeft?: boolean; extendRight?: boolean; screenX?: number; screenY?: number; fillOpacity?: number; levels?: number[]; rows?: number; valueArea?: number; color?: string; lineWidth?: number; lineStyle?: LineStyleName; locked?: boolean; hidden?: boolean; shared?: boolean; alert?: boolean }
export declare const DRAWING_POINTS: Record<DrawingKind, number>
export declare const DRAWING_KINDS: DrawingKind[]
export declare const DRAWING_CLICKS: Record<DrawingKind, number>
export declare const LINE_STYLES: LineStyleName[]
export declare function drawingStyle(request: unknown): DrawingStyle
export declare const FIB_LEVELS: number[]
export declare function drawingGeometry(kind: string, request: unknown, now?: number): Record<string, unknown>
export declare const BRUSH_MIN: number
export declare const BRUSH_MAX: number
export declare const TEXT_KINDS: DrawingKind[]
export declare const FIB_EXT_LEVELS: number[]
export declare const FIB_TIME_SERIES: number[]
export declare const GANN_RATIOS: Array<[number, number]>
export declare const ICON_NAMES: string[]
export declare const GANN_BOX_LEVELS: number[]
export declare const STICKERS: Record<'trading' | 'faces' | 'symbols', string[]>
export declare function isIconLabel(label: unknown): boolean
export declare const ALERT_KINDS: DrawingKind[]
export declare function linePriceAt(mark: unknown, time: number): number | null
export declare function isSingleEmoji(value: unknown): boolean
export interface VolumeProfileRow { low: number; high: number; up: number; down: number }
export declare function volumeProfile(bars: Array<{ open: number; high: number; low: number; close: number; volume: number }>, options?: { rows?: number; valueArea?: number }): { rows: VolumeProfileRow[]; total: number; poc: number; pocIndex: number; vah: number; val: number; valueLow: number; valueHigh: number } | null
export declare const PROFILE_ROWS_MIN: number
export declare const PROFILE_ROWS_MAX: number
export declare const FIB_LEVEL_KINDS: DrawingKind[]
export declare const INTERVALS: string[]
export declare const FONT_KINDS: DrawingKind[]
export declare const FILL_KINDS: DrawingKind[]
export declare const FREEHAND_KINDS: DrawingKind[]
export declare const MULTI_KINDS: DrawingKind[]
export declare const PATH_MAX: number
export declare const SCREEN_KINDS: DrawingKind[]
