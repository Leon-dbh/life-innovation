import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { MemoryStore } from '../lib/store.js'
import { aggregateDay, syncDay, renderDiary, writeDiaryFile, tick, dateKey } from '../lib/life.js'
import { planDue } from '../lib/extract.js'

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jj-life-'))
const store = new MemoryStore(path.join(dir, 't.sqlite'))
const base = new Date(2026, 10, 6, 9, 0, 0).getTime()
const min = 60000

store.addRaw(base, 's1', 'user', '早上好')
store.addRaw(base + 3 * min, 's1', 'her', '早。')
store.addAction({ ts: base + 90 * min, sessionId: 's1', kind: 'file', tool: 'read_file', summary: '看了点东西', callId: 'act:1', status: 'ok' })

const now = base + 120 * min
const blocks = aggregateDay({ store, now })
assert.equal(blocks[0].activity, '和他说说话', '第一件真实动作之前不该记空档')
assert.ok(blocks.some((b) => b.activity === '空档' && b.startedAt === base + 3 * min), '两件事之间空着的时间要如实记下')
const chat = blocks.find((b) => b.activity === '和他说说话')
assert.ok(chat, '应有一块聊天')
assert.equal(chat.evidence.length, 2, '聊天块应带两条原话证据')
assert.ok(blocks.some((b) => b.activity === '看了点东西' && b.evidence[0] === 'act:1'))
assert.ok(blocks.every((b) => b.idle || b.evidence.length > 0), '所有非空档块都要有证据')

const md = renderDiary(blocks, now)
assert.match(md, /证据：raw:1/)
assert.match(md, /空档/)
assert.match(md, /2026-11-06/)

syncDay({ store, now })
assert.equal(store.lifeForDate(dateKey(now)).length, blocks.length, '写回后再读应一致')

const written = writeDiaryFile({ store, now, dir })
assert.ok(fs.existsSync(written.file))
assert.match(fs.readFileSync(written.file, 'utf8'), /和他说说话/)

const first = tick({ store, now, dir })
assert.ok(first, '安静 30 分钟且是白天，应写日记')
assert.ok(fs.existsSync(first.file))
const second = tick({ store, now: now + 5 * min, dir })
assert.equal(second, null, '30 分钟内不应重复写')

store.addAssertion({ ts: base, subject: '他', predicate: '计划:明天', value: '去医院复查', source: 'x', dueAt: base + 86400000 })
assert.equal(store.livePlans('他', 2, base + 2 * 86400000).length, 0, '过期计划不该再出现')
store.expirePlans(base + 2 * 86400000, '他')
assert.equal(store.livePlans('他', 2, base).length, 0, '过期后被退役')

assert.equal(planDue('明天', base), new Date(2026, 10, 7, 10, 0, 0).getTime())
assert.equal(planDue('后天', base), new Date(2026, 10, 8, 10, 0, 0).getTime())
assert.equal(planDue('今晚', base), new Date(2026, 10, 6, 23, 0, 0).getTime())

store.close()
fs.rmSync(dir, { recursive: true, force: true })
console.log('OK: life aggregate / evidence / idle / diary / tick / plan due')
