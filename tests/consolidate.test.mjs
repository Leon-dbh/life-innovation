import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { MemoryStore } from '../lib/store.js'
import { consolidateClosedDays, consolidateDay } from '../lib/consolidate.js'
import { buildSelf } from '../lib/self.js'
import { buildPack } from '../lib/pack.js'

const date = '2026-11-13'
const today = Date.parse('2026-11-14T10:00:00+08:00')
const day = Date.parse(`${date}T00:00:00+08:00`)
const at = (hour, minute = 0) => day + hour * 3600000 + minute * 60000
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'jingjing-consolidate-'))
const store = new MemoryStore(path.join(tmp, 'life-innovation.sqlite'))

store.addRaw(at(9, 0), 's1', 'user', '今天把阳台上的花修了一下。')
store.addAction({
  ts: at(10, 0), sessionId: 's1', kind: 'tool', tool: 'write_diary',
  summary: '把这一天记成日记', callId: 'diary:test', status: 'ok',
})
store.replaceLifeBlocks(date, [
  { activity: '和他说说话', startedAt: at(9, 0), endedAt: at(9, 10), evidence: ['raw:1'] },
  { activity: '写日记', startedAt: at(10, 0), endedAt: at(10, 5), evidence: ['act:1'] },
])
store.addDream({ date, ts: at(7, 30), text: '梦见阳台上有一盏灯。', evidence: ['raw:1'] })
store.addAction({
  ts: at(23, 0), sessionId: '', kind: 'system', tool: 'close_day',
  summary: `把 ${date} 收起来`, callId: `close_day:${date}`, status: 'ok',
})
const before = store.fingerprint(today)
const made = consolidateClosedDays({ store, now: today })
assert.equal(made.length, 1, '收起来的一天应该被巩固')
const snapshot = store.selfSnapshotForDate(date)
assert.ok(snapshot, '快照落盘')
assert.match(snapshot.text, new RegExp(date))
assert.match(snapshot.text, /和他说说话/)
assert.match(snapshot.text, /梦不是真事/)
assert.ok(snapshot.evidence.includes('life:1'))
assert.ok(snapshot.evidence.includes('dream:1'))
assert.notEqual(store.fingerprint(today), before, '巩固后记忆包要重建')

const again = consolidateClosedDays({ store, now: today })
assert.equal(again.length, 0, '同一天不重复巩固')
assert.equal(consolidateDay({ store, date, now: today }).created, false)

const self = buildSelf({ store, now: today })
assert.ok(self.items.some((i) => i.kind === 'snapshot' && /^self:/.test(i.ref)), '自我叙事包含收起来的一天')
const pack = buildPack({ store, now: today, maxChars: 4000 })
assert.match(pack, new RegExp(`self:${snapshot.id}`))

store.close()
fs.rmSync(tmp, { recursive: true, force: true })
console.log('OK: 睡眠巩固（只收归档日、证据、幂等、自我叙事与 pack）')
