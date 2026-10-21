import assert from 'node:assert/strict'
import { build } from 'esbuild'
const built = await build({ entryPoints: ['src/client/native-session-list.ts'], bundle: true, write: false, platform: 'node', format: 'esm' })
const { readNativeSessionList, placeholderDeskSessions } = await import('data:text/javascript;base64,' + Buffer.from(built.outputFiles[0].text).toString('base64'))
let snapshot = { phase: 'pending', byId: {} }
const currentHost = { getSnapshot: () => snapshot }
assert.equal(readNativeSessionList(currentHost).phase, 'pending')
snapshot = { phase: 'ready', byId: { session: { displayTitle: '交易会话' } } }
assert.equal(readNativeSessionList(currentHost).byId.session.displayTitle, '交易会话')
assert.equal(readNativeSessionList(currentHost).phase, 'ready')
assert.deepEqual(readNativeSessionList({ get: () => snapshot }), snapshot)
assert.deepEqual(readNativeSessionList({ getSnapshot: () => snapshot, get: () => { throw Error('legacy getter must not override the current API') } }), snapshot)
assert.equal(readNativeSessionList(undefined), null)
// 旧版本给交易会话写入的「未命名」被 DSH 当作用户命名而锁定，不再自动起名；只交还这个占位标题，
// 用户自己起的名字和无标题的会话都不动。
assert.deepEqual(placeholderDeskSessions({ a: { title: '我的策略' }, b: { title: '未命名' }, c: { title: 'Untitled' }, d: {}, e: { title: '未命名' } }, ['a', 'b', 'c', 'd', 'x']), ['b', 'c'], 'only desk rows still holding the placeholder are released')
assert.deepEqual(placeholderDeskSessions(undefined, ['a']), [], 'missing catalog releases nothing')
console.log('DSH 新旧会话快照接口与 pending → ready 恢复通过')
