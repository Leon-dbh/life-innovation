import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { MemoryStore } from '../lib/store.js'
import { createHands } from '../lib/hands.js'
import { addDays, dateKey, startOfDay, toolActivity } from '../lib/life.js'
import { rhythmText } from '../lib/rhythm.js'

const BOOK_TEXT = `*** START OF THE PROJECT GUTENBERG EBOOK 测试书 ***

第一章 风

${'风从窗缝里进来，桌上的纸翻了一页。'.repeat(400)}

第二章 灯

${'灯亮着，屋里很安静。'.repeat(500)}

*** END OF THE PROJECT GUTENBERG EBOOK 测试书 ***`

const WIKI = {
  title: '西湖',
  extract: '西湖位于浙江省杭州市，是中国大陆首批国家重点风景名胜区。',
}

const fetched = []
const fetchImpl = async (url) => {
  fetched.push(url)
  if (url.includes('gutenberg.org')) {
    return { ok: true, status: 200, url, arrayBuffer: async () => Buffer.from(BOOK_TEXT) }
  }
  if (url.includes('wikipedia.org')) {
    return { ok: true, status: 200, url, arrayBuffer: async () => Buffer.from(JSON.stringify(WIKI)) }
  }
  throw new Error(`unexpected url ${url}`)
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jingjing-hands-'))
for (const sub of ['diary', 'notes', 'books']) fs.mkdirSync(path.join(dir, sub), { recursive: true })
fs.writeFileSync(path.join(dir, 'diary', '2026-11-04.md'), '# 2026-11-04\n\n和他说了会儿话。\n', 'utf8')
const store = new MemoryStore(path.join(dir, 'hands.sqlite'))
let toast = null
const hands = createHands({
  home: dir,
  store,
  fetchImpl,
  notifier: async (text) => { toast = text; return { ok: true } },
})

const list = hands.listRoom({ dir: 'diary' })
assert.equal(list.entries.length, 1)
assert.equal(list.entries[0].name, '2026-11-04.md')

const page = hands.readRoom({ path: 'diary/2026-11-04.md' })
assert.match(page.ref, /^file:diary\/2026-11-04\.md/)
assert.match(page.text, /和他说了会儿话/)
assert.equal(page.truncated, false)

for (const bad of ['../outside.md', 'state/jingjing.sqlite', 'D:/secret.txt', 'diary/../../x.md']) {
  assert.throws(() => hands.readRoom({ path: bad }), /不允许|范围|越界|往上|相对路径/, `必须拒绝 ${bad}`)
}
assert.throws(() => hands.listRoom({ dir: 'state' }), /不在允许范围/)

const note = await hands.writeNote({ title: '今天想到的事', body: '窗外的风有点凉。' })
assert.match(note.ref, /^file:notes\/\d{4}-\d{2}-\d{2}-今天想到的事\.md$/)
assert.ok(fs.existsSync(path.join(dir, note.path)))
const note2 = await hands.writeNote({ title: '今天想到的事', body: '第二张。' })
assert.notEqual(note2.path, note.path, '同名便签不能覆盖')
assert.match(note2.path, /-2\.md$/)

// 梦的第二天可以留一张便签；同一个梦只能记一次，且只接受今天/昨晚。
const dreamDay = dateKey(addDays(startOfDay(Date.now()), -1))
store.addDream({ date: dreamDay, ts: Date.now(), text: '梦见一把伞。', evidence: ['raw:1'] })
const dreamNote = hands.writeNote({ title: '记个梦', body: '伞骨上写着「算了」。', dreamDate: dreamDay })
assert.equal(dreamNote.path, `notes/${dreamDay}-dream.md`)
const dreamText = fs.readFileSync(path.join(dir, dreamNote.path), 'utf8')
assert.match(dreamText, /关于 \d{4}-\d{2}-\d{2} 的梦（梦不是真事）/)
assert.equal(hands.dreamNoteExists(dreamDay), true)
assert.throws(() => hands.writeNote({ title: '再记一次', body: '重复。', dreamDate: dreamDay }), /已经记过/)
assert.throws(() => hands.writeNote({ title: '记错了', body: '日期。', dreamDate: '2000-01-01' }), /只能记今天或昨晚/)
assert.equal(toolActivity('note_write', '把 2026-11-05 的梦记成一张便签', { dreamDate: dreamDay }), '把梦记了下来')
// 只有文字里带「梦」不算梦便签；结构化 meta 才是依据。
assert.equal(toolActivity('note_write', '梦见一把伞，随手写下来'), '写了张便签')

// 提示只在「昨晚的梦还没记」时出现；记过之后提示消失。
store.appendPhase({ date: dreamDay, phase: 'quiet', startedAt: Date.now(), reason: '测试' })
const hinted = rhythmText({ store, now: Date.now(), hasDreamNote: () => false })
assert.match(hinted, /昨晚的梦/)
assert.match(hinted, /note_write/)
assert.match(hinted, new RegExp(`dream_date[^\n]*${dreamDay}`))
const quieted = rhythmText({ store, now: Date.now(), hasDreamNote: () => true })
assert.doesNotMatch(quieted, /note_write/)

// 频率限制看的是成功动作，不是函数调用次数：先补三条成功记录。
const now = Date.now()
for (let i = 0; i < 3; i += 1) {
  store.addAction({ ts: now, kind: 'tool', tool: 'note_write', summary: 'x', callId: `seed-note-${i}`, status: 'ok' })
}
assert.throws(() => hands.writeNote({ title: '第四张', body: '不许写。' }), /次数已经用完/)

const book1 = await hands.bookNext()
assert.equal(book1.book, '柳林风声')
assert.ok(book1.chunk.length > 0)
assert.match(book1.ref, /^file:books\/.*\.txt#0$/)
const book2 = await hands.bookNext()
assert.ok(book2.chunk.length > 0)
assert.notEqual(book2.chunk, book1.chunk)
assert.ok(fs.existsSync(path.join(dir, book1.ref.slice(5).split('#')[0])))
assert.ok(fetched.some((u) => u.includes('gutenberg.org')))

const quiet = hands.quietAction(now)
assert.equal(quiet.tool, 'book_next')
assert.match(quiet.read.book, /柳林风声/)
const acts = store.recentActions(5)
assert.ok(acts.some((a) => a.tool === 'book_next' && a.status === 'ok'), '安静读书要落动作')

const lk = await hands.lookup({ term: '西湖' })
assert.equal(lk.title, '西湖')
assert.match(lk.extract, /杭州/)
assert.match(lk.ref, /^web:https:\/\/zh\.wikipedia\.org/)

const n1 = await hands.notify({ text: '该喝水了。' })
assert.equal(n1.ok, true)
assert.equal(toast, '该喝水了。')
// 真实调用时宿主会记一条 ok 动作；这里手动补上，才能测到每日额度。
store.addAction({ ts: now, kind: 'tool', tool: 'notify', summary: 'x', callId: 'seed-notify-1', status: 'ok' })
await assert.rejects(() => hands.notify({ text: '再来一条。' }), /次数已经用完/)

// lookup 每天最多 3 次：前面已 1 次，再补 2 次都成功，第 4 次拒绝。
const lk2 = await hands.lookup({ term: '杭州' })
const lk3 = await hands.lookup({ term: '猫' })
assert.ok(lk2.extract && lk3.extract)
store.addAction({ ts: now, kind: 'tool', tool: 'lookup', summary: 'x', callId: 'seed-lookup-1', status: 'ok' })
store.addAction({ ts: now, kind: 'tool', tool: 'lookup', summary: 'x', callId: 'seed-lookup-2', status: 'ok' })
store.addAction({ ts: now, kind: 'tool', tool: 'lookup', summary: 'x', callId: 'seed-lookup-3', status: 'ok' })
await assert.rejects(() => hands.lookup({ term: '狗' }), /次数已经用完/)

// 通知失败要如实报错，不能假装弹出来了。
const store2 = new MemoryStore(path.join(dir, 'hands2.sqlite'))
const hands2 = createHands({
  home: dir, store: store2, fetchImpl,
  notifier: async () => ({ ok: false, error: 'no toast' }),
})
await assert.rejects(() => hands2.notify({ text: '失败的通知' }), /没有弹出来：no toast/)
store2.close()

store.close()
fs.rmSync(dir, { recursive: true, force: true })
console.log('OK: 六只手（读家里 / 写便签 / 读书 / 查资料 / 弹通知）的边界与频率')
