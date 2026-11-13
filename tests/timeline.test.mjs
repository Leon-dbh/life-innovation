import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { MemoryStore } from '../lib/store.js'
import { buildTimeline, renderTimelineText } from '../lib/timeline.js'

const date = '2026-11-14'
const day = new Date(2026, 10, 14).getTime()
const at = (hour, minute = 0) => day + hour * 3600000 + minute * 60000
const now = at(23, 30)

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'jingjing-timeline-'))
const store = new MemoryStore(path.join(tmp, 'life-innovation.sqlite'))

store.addRaw(at(9, 5), 's1', 'user', '今天去西湖走走。')
store.addRaw(at(9, 6), 's1', 'assistant', '好啊，我记得你上次也提过。')
store.addAction({
  ts: at(10, 15), sessionId: 's1', kind: 'tool', tool: 'web_search',
  summary: '查了西湖的天气', callId: 'timeline:search', status: 'ok',
})
store.addAction({
  ts: at(10, 20), sessionId: 's1', kind: 'tool', tool: 'book_next',
  summary: '', callId: 'timeline:book', status: 'ok',
})
store.replaceLifeBlocks(date, [
  { activity: '和他说说话', startedAt: at(9, 5), endedAt: at(9, 6), evidence: ['raw:1', 'raw:2'] },
  { activity: '上网查了点东西', startedAt: at(10, 15), endedAt: at(10, 15), evidence: ['act:1'] },
])
store.appendPhase({ date, phase: 'awake', startedAt: at(8, 0), reason: '他刚跟你说过话', evidence: [] })
store.endPhase(1, at(12, 0))
store.appendPhase({ date: '2026-11-13', phase: 'night', startedAt: day - 3600000, reason: '夜深了', evidence: [] })
store.endPhase(2, at(7, 0))
store.addDream({ date, ts: at(7, 30), text: '梦见西湖边有一盏灯。', evidence: ['raw:1'] })
store.addBook({ title: '柳林风声', url: 'book:test', path: '/tmp/x.txt', total: 200, now: at(11, 0) })
store.setBookProgress(1, 40, 200, at(11, 30))

const timeline = buildTimeline({ store, date, now })
assert.equal(timeline.date, date)
assert.equal(timeline.chapters.length, 2)
assert.equal(timeline.phases.length, 2)
assert.equal(timeline.phases[0].ref, 'phase:2')
assert.equal(timeline.phases[0].from, day)
assert.equal(timeline.counts.talk, 2)
assert.equal(timeline.counts.actions, 2)
assert.equal(timeline.counts.dreams, 1)
assert.equal(timeline.counts.books, 1)
assert.equal(timeline.events[0].kind, 'dream')
assert.match(timeline.events.map((e) => e.ref).join(','), /raw:1.*raw:2.*act:1.*act:2.*book:1/)
assert.match(timeline.chapters[0].activity, /和他说说话/)
assert.match(timeline.text, /章节：/)
assert.match(timeline.text, /发生的事：/)
assert.match(timeline.text, /上网查了点东西/)
assert.match(timeline.text, /梦/)
assert.match(renderTimelineText({ date, chapters: timeline.chapters, phases: timeline.phases, events: timeline.events }), /柳林风声/)

const empty = buildTimeline({ store, date: '2026-11-01', now })
assert.equal(empty.events.length, 0)
assert.equal(empty.chapters.length, 0)
assert.match(empty.text, /没有留下可查的记录/)
assert.equal(buildTimeline({ store, date, now: at(8, 0) }).events.some((e) => e.ref === 'raw:2'), false)
store.close()
fs.rmSync(tmp, { recursive: true, force: true })

console.log('OK: 生活时间线（对话/动作/梦/书/章节/状态/空日）')
