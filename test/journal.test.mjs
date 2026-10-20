import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { HyperStore } from '../lib/store.js'
import { HyperRemote } from '../lib/remote.js'
import { buildToolDefinitions } from '../lib/tools.js'
import { journalDigest, journalPromptLines, strategyStats } from '../lib/journal.js'

const dir = mkdtempSync(join(tmpdir(), 'dhl-journal-'))
const remote = Object.create(HyperRemote.prototype)
remote.cfg = { tradingMode: 'paper', network: 'mainnet' }
remote.store = new HyperStore(dir)
const journal = buildToolDefinitions(remote).find((tool) => tool.name === 'hyper_journal')
const run = (args) => journal.execute(args, { agent: { id: 's1' } })

assert.match((await run({})).text, /档案：空/)
await run({ action: 'profile', fields: { 风险偏好: '单笔最多亏 1% 权益', 打扰偏好: '只在需要决策时提醒' } })
await run({ action: 'profile', fields: { 打扰偏好: null } })
assert.deepEqual((await run({})).profile, { 风险偏好: '单笔最多亏 1% 权益' }, 'profile fields merge and null removes')

const created = (await run({ action: 'strategy', name: '楔形破位回踩', thesis: '上升楔形跌破后回踩下轨失败，空头延续到 POC/VAL', markets: 'xyz:XYZ100', timeframe: '4h', status: 'testing' })).strategy
assert.equal(created.version, 1)
await assert.rejects(run({ action: 'strategy', id: created.id, entry: '4h 收盘回踩不过下轨' }), /why/, 'a revision must say why')
const revised = (await run({ action: 'strategy', id: created.id, entry: '4h 收盘回踩不过下轨', why: '前 3 笔追空回撤大，改为等回踩' })).strategy
assert.equal(revised.version, 2); assert.equal(revised.changes.at(-1).why, '前 3 笔追空回撤大，改为等回踩')

await assert.rejects(run({ action: 'log', type: 'trade', text: '没有 R' }), /resultR/)
await run({ action: 'log', type: 'trade', strategyId: created.id, coin: 'xyz:XYZ100', resultR: 2.4, text: '回踩做空，TP1 POC' })
await run({ action: 'log', type: 'trade', strategyId: created.id, coin: 'xyz:XYZ100', resultR: -1, text: '假跌破止损' })
remote.cfg.tradingMode = 'live'
await run({ action: 'log', type: 'trade', strategyId: created.id, coin: 'xyz:XYZ100', resultR: 1.2, text: 'live 第一笔' })
await run({ action: 'log', type: 'lesson', text: '周五美股收盘前不在 XYZ100 开新仓' })
const stats = strategyStats(remote.store.journal())[created.id]
assert.deepEqual(Object.keys(stats).sort(), ['live/mainnet', 'paper/mainnet'], 'paper and live are scored separately')
assert.equal(stats['paper/mainnet'].trades, 2); assert.equal(stats['paper/mainnet'].expectancyR, 0.7)

const lines = journalPromptLines(remote.store.journal()).join('\n')
assert.ok(lines.includes('风险偏好=单笔最多亏 1% 权益') && lines.includes('楔形破位回踩') && lines.includes('期望0.70R') && lines.includes('周五美股收盘前'), lines)
const read = await run({ action: 'read' })
assert.ok(read.text.includes('胜率50%') && read.text.includes('最近记录'), read.text)
assert.equal(JSON.stringify(read), JSON.stringify(JSON.parse(JSON.stringify(read))), 'tool output is plain JSON')
const version3 = (await run({ action: 'strategy', id: created.id, entry: '等二次回踩', why: '避免首轮假突破' })).strategy
assert.equal(version3.version, 3)
assert.deepEqual(strategyStats(remote.store.journal())[created.id], {}, 'a new revision starts with no samples')
const oldTrade = await run({ action: 'log', type: 'trade', strategyId: created.id, strategyVersion: 2, resultR: 3, text: '修订前开仓的交易平仓' })
assert.equal(oldTrade.entry.strategyVersion, 2)
await run({ action: 'log', type: 'trade', strategyId: created.id, resultR: -1, text: '第三版第一笔' })
const versioned = journalDigest(remote.store.journal()).strategies[0]
assert.equal(versioned.stats['live/mainnet'].expectancyR, -1)
assert.equal(versioned.statsByVersion['2']['live/mainnet'].trades, 2)
assert.equal(versioned.statsByVersion['2']['paper/mainnet'].expectancyR, 0.7)
await assert.rejects(run({ action: 'log', type: 'trade', strategyId: created.id, strategyVersion: 4, resultR: 1, text: '未来版本' }), /strategyVersion/)
const legacy = remote.store.journal()
legacy.entries.push({ type: 'trade', strategyId: created.id, mode: 'live', network: 'mainnet', resultR: 50 })
const legacyDigest = journalDigest(legacy).strategies[0]
assert.equal(legacyDigest.stats['live/mainnet'].trades, 1)
assert.equal(legacyDigest.statsByVersion.unknown['live/mainnet'].expectancyR, 50, 'unversioned history is retained separately')
await run({ action: 'removeStrategy', id: created.id })
assert.equal(remote.store.journal().strategies.length, 0)
console.log('交易员日志：档案、策略版本与修订原因、按 paper/live 分开统计、系统提示摘要通过')
