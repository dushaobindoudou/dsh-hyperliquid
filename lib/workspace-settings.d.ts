export interface ResearchSettings { layout: 'single' | 'dual' | 'quad'; intervals: import('../src/client/types').Interval[]; syncTime: boolean; syncCursor: boolean }
export declare function normalizeResearch(input?: unknown): ResearchSettings
export declare function normalizePaperCosts(input?: unknown): { feeBps: number; slippageBps: number }
