import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { selfFromData, buildSelf } from '../lib/self.js'
import { buildPack } from '../lib/pack.js'
import { MemoryStore } from '../lib/store.js'

const now = Date.parse('2026-11-13T23:30:00+08:00')
const date = '2026-11-13'
const at = (hour, minute = 0) => Date.parse(`${date}T00:00:00+08:00`) + hour * 3600000 + minute * 60000

const self = selfFromData({
  date,
  now,
  talkCount: 3,
  blocks: [
    { id: 7, activity: '写日记', startedAt: at(22, 40), endedAt: at(23, 20), idle: false },
    { id: 8, activity: '空档', startedAt: at(21), endedAt: at(22), idle: true },
    { id: 9, activity: '早就结束的事', startedAt: at(18), endedAt: at(19), idle: false },
  ],
  actions: [
    { id: 3, status: 'ok', tool: 'book_next', summary: '读了《柳林风声》一段', meta: null },
    { id: 4, status: 'error', tool: 'web_search', summary: '失败了', meta: null },
  ],
  dream: { id: 2, text: '梦见一扇没有关上的门。' },
  book: { id: 1, title: '柳林风声', offset: 50, total: 200 },
})

assert.deepEqual(self.items.map((i) => i.kind), ['now', 'did', 'talk', 'dream', 'book'])
assert.equal(self.items[0].ref, 'life:7')
assert.equal(self.items[1].ref, 'act:3')
assert.equal(self.items[2].ref, 'day:2026-11-13')
assert.equal(self.items[3].ref, 'dream:2')
assert.equal(self.items[4].ref, 'book:1')
assert.match(self.lines.join('\n'), /此刻：写日记（life:7）/)
assert.match(self.lines.join('\n'), /最近你做了：读了《柳林风声》一段（act:3）/)
assert.match(self.lines.join('\n'), /今天和他说过 3 段话（day:2026-11-13）/)
assert.match(self.lines.join('\n'), /不是真事.*（dream:2）/)
assert.match(self.lines.join('\n'), /读到 25%（book:1）/)
assert.doesNotMatch(self.lines.join('\n'), /空档|早就结束|失败了/)

const empty = selfFromData({ date, now })
assert.equal(empty.lines.length, 0)
assert.equal(empty.text, '')

const fakeStore = {
  lifeForDate: () => [{ id: 7, activity: '写日记', startedAt: at(22, 40), endedAt: at(23, 20), idle: false }],
  actionsBetween: () => [{ id: 3, status: 'ok', tool: 'book_next', summary: '读了一段', meta: null }],
  dreamForDate: (d) => (d === date ? { id: 2, text: '梦见旧书。' } : null),
  bookState: () => ({ id: 1, title: '柳林风声', offset: 50, total: 200 }),
  rawBetween: () => [{ id: 1 }, { id: 2 }],
}
const built = buildSelf({ store: fakeStore, now })
assert.equal(built.items[0].ref, 'life:7')
assert.equal(built.items[1].ref, 'act:3')
assert.match(built.lines.join('\n'), /今天和他说过 2 段话/)

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'jingjing-self-test-'))
const store = new MemoryStore(path.join(tmp, 'life-innovation.sqlite'))
store.addRaw(at(23, 10), 's1', 'user', '我回来啦。')
const fpBeforeLife = store.fingerprint(now)
store.replaceLifeBlocks(date, [
  { activity: '写日记', startedAt: at(22, 40), endedAt: at(23, 20), evidence: ['raw:1'] },
])
assert.notEqual(store.fingerprint(now), fpBeforeLife, '生活线更新后记忆包要重建')
const fpBeforeDream = store.fingerprint(now)
store.addDream({ date, ts: at(23, 15), text: '梦见窗台上有一盏灯。', evidence: ['raw:1'] })
assert.notEqual(store.fingerprint(now), fpBeforeDream, '新梦也要改变指纹')
store.addAction({
  ts: at(23, 10), sessionId: 's1', kind: 'system', tool: 'write_diary',
  summary: '把今天记成日记', callId: 'diary:test', status: 'ok',
})
const pack = buildPack({ store, now, maxChars: 4000 })
assert.match(pack, /你正在过的日子/)
assert.match(pack, /此刻：写日记（life:1）/)
store.close()
fs.rmSync(tmp, { recursive: true, force: true })

console.log('OK: 自我叙事（来源、ref、顺序、空态、pack 注入）')
