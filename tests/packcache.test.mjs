import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { MemoryStore } from '../lib/store.js'
import { createPackCache } from '../lib/packCache.js'

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jj-cache-'))
const store = new MemoryStore(path.join(dir, 't.sqlite'))
const cache = createPackCache({ store, maxChars: 1200 })
const now = new Date(2026, 10, 5, 20, 0, 0).getTime()

store.addRaw(now - 60000, 's1', 'user', '我叫林晚，住在杭州')
store.addAssertion({ ts: now - 60000, subject: '他', predicate: '名字', value: '林晚', source: 'x' })
store.setProfile('他', '名字', '林晚', 'x', now - 60000)

const first = cache.get(now)
assert.match(first, /他叫林晚/)
assert.equal(cache.stats().builds, 1)

const second = cache.get(now + 1000)
assert.equal(second, first, '指纹不变时应整段复用')
assert.equal(cache.stats().builds, 1, '不应重复构建')

store.addAssertion({ ts: now + 2000, subject: '他', predicate: '住在', value: '杭州', source: 'x' })
store.setProfile('他', '住在', '杭州', 'x', now + 2000)
const third = cache.get(now + 3000)
assert.notEqual(third, first, '有新的 live 断言后要重建')
assert.equal(cache.stats().builds, 2)

store.addAction({ ts: now + 4000, sessionId: 's1', kind: 'file', tool: 'write_diary', summary: '写今天的日记', callId: 'd:1', status: 'ok' })
cache.get(now + 5000)
assert.equal(cache.stats().builds, 3, '有新动作后要重建')

// 跨天：即使库没变，日期标签变了，也要重建
cache.get(now + 86400000)
assert.equal(cache.stats().builds, 4, '跨天要重建')

store.close()
fs.rmSync(dir, { recursive: true, force: true })
console.log('OK: pack cache rebuilds only when memory changes')
