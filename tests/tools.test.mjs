import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { MemoryStore } from '../lib/store.js'
import { registerMemoryTools } from '../lib/tools.js'

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jingjing-tools-'))
const dbPath = path.join(dir, 'tools.sqlite')
const store = new MemoryStore(dbPath)
const now = Date.now()

const long = '这是一段很长的原话，'.repeat(40)
for (let i = 1; i <= 10; i += 1) {
  store.addRaw(now - (10 - i) * 60000, 's1', i % 2 ? 'user' : 'assistant', i === 5 ? long : `第 ${i} 句话：我们去过西湖，聊了工作`)
}
store.addAction({ ts: now, sessionId: 's1', kind: 'file', tool: 'write_diary', summary: '把今天记成日记', callId: 'diary:x', status: 'ok' })

const registry = new Map()
const ctx = { tools: { register: (def) => { registry.set(def.name, def); return () => registry.delete(def.name) } } }
const dispose = registerMemoryTools({ ctx, store })
assert.deepEqual([...registry.keys()].sort(), ['memory_find', 'memory_read'])

const find = registry.get('memory_find')
const out = await find.execute({ query: '西湖', limit: 20 })
assert.equal(out.hits.length, 8, 'memory_find 最多 8 条')
assert.ok(out.hits.every((h) => h.text.length <= 200), '每条 <= 200 字')
assert.ok(out.hits.every((h) => /^raw:\d+$/.test(h.ref)))

const read = registry.get('memory_read')
const big = out.hits.find((h) => h.text.endsWith('…')) || out.hits[0]
const full = await read.execute({ ref: big.ref })
assert.ok(full.text.length <= 2001, 'memory_read 最多 2000 字')
assert.equal(full.ref, big.ref)

const act = await read.execute({ ref: 'act:1' })
assert.match(act.text, /日记/)
assert.match(act.who, /动作/)

const bad = await read.execute({ ref: 'nope' })
assert.match(bad.text, /看不懂/)

dispose()
assert.equal(registry.size, 0)
store.close()
fs.rmSync(dir, { recursive: true, force: true })
console.log('OK: memory_find / memory_read')
