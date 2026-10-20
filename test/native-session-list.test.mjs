import assert from 'node:assert/strict'
import { build } from 'esbuild'
const built = await build({ entryPoints: ['src/client/native-session-list.ts'], bundle: true, write: false, platform: 'node', format: 'esm' })
const { readNativeSessionList, untitledDeskSessions } = await import('data:text/javascript;base64,' + Buffer.from(built.outputFiles[0].text).toString('base64'))
let snapshot = { phase: 'pending', byId: {} }
const currentHost = { getSnapshot: () => snapshot }
assert.equal(readNativeSessionList(currentHost).phase, 'pending')
snapshot = { phase: 'ready', byId: { session: { displayTitle: '交易会话' } } }
assert.equal(readNativeSessionList(currentHost).byId.session.displayTitle, '交易会话')
assert.equal(readNativeSessionList(currentHost).phase, 'ready')
assert.deepEqual(readNativeSessionList({ get: () => snapshot }), snapshot)
assert.deepEqual(readNativeSessionList({ getSnapshot: () => snapshot, get: () => { throw Error('legacy getter must not override the current API') } }), snapshot)
assert.equal(readNativeSessionList(undefined), null)
// DSH 显示标题回退到 cwd 目录名（家目录名就是账户名），所以只给"没有持久标题"的
// 交易会话说重命名，避免覆盖用户自己起的名字。
assert.deepEqual(untitledDeskSessions({ a: { title: '我的策略' }, b: {}, c: undefined }, ['a', 'b', 'c', 'd']), ['b'], 'only catalogued desk rows without a durable title are named')
assert.deepEqual(untitledDeskSessions(undefined, ['a']), [], 'missing catalog never names anything')
console.log('DSH 新旧会话快照接口与 pending → ready 恢复通过')
