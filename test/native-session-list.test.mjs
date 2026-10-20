import assert from 'node:assert/strict'
import { build } from 'esbuild'
const built = await build({ entryPoints: ['src/client/native-session-list.ts'], bundle: true, write: false, platform: 'node', format: 'esm' })
const { readNativeSessionList } = await import('data:text/javascript;base64,' + Buffer.from(built.outputFiles[0].text).toString('base64'))
let snapshot = { phase: 'pending', byId: {} }
const currentHost = { getSnapshot: () => snapshot }
assert.equal(readNativeSessionList(currentHost).phase, 'pending')
snapshot = { phase: 'ready', byId: { session: { displayTitle: '交易会话' } } }
assert.equal(readNativeSessionList(currentHost).byId.session.displayTitle, '交易会话')
assert.equal(readNativeSessionList(currentHost).phase, 'ready')
assert.deepEqual(readNativeSessionList({ get: () => snapshot }), snapshot)
assert.deepEqual(readNativeSessionList({ getSnapshot: () => snapshot, get: () => { throw Error('legacy getter must not override the current API') } }), snapshot)
assert.equal(readNativeSessionList(undefined), null)
console.log('DSH 新旧会话快照接口与 pending → ready 恢复通过')
