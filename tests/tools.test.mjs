import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { MemoryStore } from '../lib/store.js'
import { registerMemoryTools } from '../lib/tools.js'
import { createHands } from '../lib/hands.js'

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jingjing-tools-'))
const dbPath = path.join(dir, 'tools.sqlite')
const store = new MemoryStore(dbPath)
const now = Date.now()

const long = '这是一段很长的原话，'.repeat(40)
for (let i = 1; i <= 10; i += 1) {
  store.addRaw(now - (10 - i) * 60000, 's1', i % 2 ? 'user' : 'assistant', i === 5 ? long : `第 ${i} 句话：我们去过西湖，聊了工作`)
}
// 旧但高相关：一年前说过一次「失去味觉」，最近十句都在闲聊西湖。
store.addRaw(now - 365 * 86400000, 's0', 'user', '去年生病的时候失去了味觉，吃什么都没味道')
store.addAction({ ts: now, sessionId: 's1', kind: 'file', tool: 'write_diary', summary: '把今天记成日记', callId: 'diary:x', status: 'ok' })
store.addAssertion({ ts: now - 86400000, subject: '他', predicate: '工作', value: '老师', source: 'raw:1' })
store.addAssertion({ ts: now, subject: '他', predicate: '工作', value: '程序员', source: 'raw:2' })

const registry = new Map()
const ctx = { tools: { register: (def) => { registry.set(def.name, def); return () => registry.delete(def.name) } } }
const observe = { snapshot: () => ({ packs: [{ chars: 520, cache: 'build', sections: [] }], recalls: [] }) }
const hands = createHands({ home: dir, store, notifier: async () => ({ ok: true }) })
const dispose = registerMemoryTools({ ctx, store, observe, hands })
assert.deepEqual([...registry.keys()].sort(), ['book_import', 'book_next', 'book_open', 'book_search', 'life_days', 'life_status', 'lookup', 'memory_explain', 'memory_find', 'memory_forget', 'memory_read', 'memory_restore', 'memory_timeline', 'note_write', 'notify', 'plugin_search', 'room_list', 'room_read', 'web_read', 'web_search'])

const room = registry.get('room_list')
const roomOut = await room.execute({ dir: 'diary' })
assert.equal(roomOut.dir, 'diary')
assert.ok(Array.isArray(roomOut.entries))
const noteOut = await registry.get('note_write').execute({ title: '工具注册', body: '手接上了。' })
assert.match(noteOut.ref, /^file:notes\//)

const find = registry.get('memory_find')
const out = await find.execute({ query: '西湖', limit: 20 })
assert.equal(out.hits.length, 8, 'memory_find 最多 8 条')
assert.ok(out.hits.every((h) => h.text.length <= 200), '每条 <= 200 字')
assert.ok(out.hits.every((h) => /^raw:\d+$/.test(h.ref)))
assert.ok(out.recall.terms.length > 0, '召回带词面')
assert.ok(out.hits.every((h) => typeof h.score === 'number' && h.why.length > 0), '每条带分数与理由')

// 稀有词 + 旧事：词面强的旧原话要排在新闲聊前面，而不是被时间倒序埋掉。
const rare = await find.execute({ query: '味觉', limit: 3 })
assert.match(rare.hits[0].text, /味觉/, '稀有词命中应排第一')
assert.ok(rare.hits[0].score > 0)

const explain = registry.get('memory_explain')
const explained = await explain.execute({ query: '西湖' })
assert.ok(explained.hits.length > 0, 'memory_explain 能按 query 找到原话')
assert.ok(explained.hits.every((h) => h.kind === 'raw' && h.source === '原话'))
assert.ok(explained.hits.every((h) => typeof h.injection === 'string'))
const byRef = await explain.execute({ ref: explained.hits[0].ref })
assert.equal(byRef.hits[0].ref, explained.hits[0].ref)
assert.equal(byRef.hits[0].injected, explained.hits[0].injected)
const conflict = await explain.execute({ query: '工作' })
assert.equal(conflict.conflicts.length, 1)
assert.equal(conflict.conflicts[0].current, '程序员')
assert.equal(conflict.conflicts[0].previous[0].value, '老师')
const archivedFact = await explain.execute({ ref: conflict.conflicts[0].current_ref })
assert.equal(archivedFact.hits[0].injected, false, '事实档案不冒充“已进记忆包”')
assert.match(archivedFact.hits[0].injection, /事实档案/)
const emptyExplain = await explain.execute({})
assert.match(emptyExplain.note, /query 或 ref/)

const timeline = registry.get('memory_timeline')
const day = await timeline.execute({})
assert.match(day.date, /^\d{4}-\d{2}-\d{2}$/)
assert.ok(Array.isArray(day.chapters))
assert.ok(Array.isArray(day.phases))
assert.ok(Array.isArray(day.events))
assert.ok(day.events.some((e) => /^raw:/.test(e.ref)), '时间线包含原话事件')
assert.equal(typeof day.counts.talk, 'number')

const read = registry.get('memory_read')
const big = out.hits.find((h) => h.text.endsWith('…')) || out.hits[0]
const full = await read.execute({ ref: big.ref })
assert.ok(full.text.length <= 2000, 'memory_read 最多 2000 字（含省略号）')
assert.equal(full.ref, big.ref)

const act = await read.execute({ ref: 'act:1' })
assert.match(act.text, /日记/)
assert.match(act.who, /动作/)

const bad = await read.execute({ ref: 'nope' })
assert.match(bad.text, /看不懂/)

const days = registry.get('life_days')
const dv = await days.execute({ days: 1 })
assert.equal(dv.days.length, 1, '只读视图给最近一天')
assert.match(dv.days[0].date, /^\d{4}-\d{2}-\d{2}$/)
assert.ok(Array.isArray(dv.days[0].blocks))
assert.ok(dv.days[0].actions.some((a) => a.tool === 'write_diary'))

// 显式遗忘：默认 dry-run，不确认不动库；确认后进回收站；可按编号找回。
const forget = registry.get('memory_forget')
const dry = await forget.execute({ ref: 'raw:1', reason: '测试整理' })
assert.equal(dry.dry_run, true)
assert.equal(dry.ref, 'raw:1')
assert.match(dry.confirm_hint, /raw:1/)
assert.equal(store.recycleCount(), 0, '预演不写回收站')
await assert.rejects(() => forget.execute({ ref: 'raw:1', confirm: 'raw:2' }), /确认值必须是/)
assert.equal(store.recycleCount(), 0, '确认值不对不能动库')
const gone = await forget.execute({ ref: 'raw:1', confirm: 'raw:1', reason: '测试整理' })
assert.equal(gone.dry_run, false)
assert.ok(gone.recycle_id > 0)
assert.equal(store.recycleCount(), 1)
assert.equal(store.rawAnyById(1), null)
const restore = registry.get('memory_restore')
const back = await restore.execute({ recycle_id: gone.recycle_id, reason: '测试找回' })
assert.equal(back.restored, true)
assert.equal(back.ref, 'raw:1')
assert.equal(store.recycleCount(), 0)
assert.ok(store.rawAnyById(1))
assert.equal(store.memoryAudit(3)[0].action, 'restore')
assert.equal(store.memoryAudit(3)[1].action, 'forget')

const status = registry.get('life_status')
const st = await status.execute({})
assert.equal(st.stats.raw, 11)
assert.equal(st.stats.recycle, 0)
assert.equal(st.lastPack.chars, 520)
assert.equal(st.stats.actions, 1)

dispose()
assert.equal(registry.size, 0)
store.close()
fs.rmSync(dir, { recursive: true, force: true })
console.log('OK: memory_find / memory_read / life_status / life_days（召回按相关度而非时间）')
