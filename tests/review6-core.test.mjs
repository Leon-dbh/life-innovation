/**
 * 0.6.2 复审 P1/P2/P3 的核心回归：动作口径、对话口径、多日补梦、>7 天补账、
 * 归档对话、自我快照渲染、归档动作时间戳。
 *
 * 全部用固定本地日期，不依赖真实时钟；每个用例独立临时库。
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { MemoryStore } from '../lib/store.js'
import { buildTimeline } from '../lib/timeline.js'
import { selfFromData, buildSelf } from '../lib/self.js'
import { consolidateDay } from '../lib/consolidate.js'
import { closeDayIfDue, tickRhythm } from '../lib/rhythm.js'
import { dateKey, startOfDay } from '../lib/life.js'

function ts(date, hour = 10, minute = 0, second = 0) {
  const [y, m, d] = String(date).split('-').map(Number)
  return new Date(y, m - 1, d, hour, minute, second).getTime()
}

function tempStore(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  const store = new MemoryStore(path.join(dir, 'life-innovation.sqlite'))
  return {
    dir,
    store,
    cleanup() {
      store.close()
      fs.rmSync(dir, { recursive: true, force: true })
    },
  }
}

function addDayRaw(store, date, text = '今天有点累，随便说两句。') {
  store.addRaw(ts(date, 10), 's1', 'user', text)
}

function addOkAction(store, date, callId) {
  store.addAction({
    ts: ts(date, 10, 5), sessionId: 's1', kind: 'tool', tool: 'web_search',
    summary: '查了点东西', callId, status: 'ok',
  })
}

// P1-1：timeline 的 actions 只算 status='ok'，总量另设 actionsTotal；巩固文案用 ok 数。
{
  const { store, cleanup } = tempStore('jingjing-review6-actions-')
  try {
    const date = '2026-11-14'
    const now = ts(date, 23, 30)
    addDayRaw(store, date)
    addOkAction(store, date, 'r6:a1')
    store.addAction({ ts: ts(date, 10, 6), sessionId: 's1', kind: 'tool', tool: 'web_search', summary: '没查成', callId: 'r6:a2', status: 'error' })
    store.addAction({ ts: ts(date, 10, 7), sessionId: 's1', kind: 'tool', tool: 'write_diary', summary: '还在写', callId: 'r6:a3', status: 'called' })
    store.replaceLifeBlocks(date, [
      { activity: '和他说说话', startedAt: ts(date, 10), endedAt: ts(date, 10, 10), evidence: ['raw:1'] },
    ])

    const timeline = buildTimeline({ store, date, now })
    assert.equal(timeline.counts.actions, 1, '成功动作只有 1 件')
    assert.equal(timeline.counts.actionsTotal, 3, '动作总量另算')
    const made = consolidateDay({ store, date, now })
    assert.ok(made && made.created)
    assert.match(made.snapshot.text, /做成了 1 件/)
    assert.doesNotMatch(made.snapshot.text, /做成了 3 件/)
  } finally {
    cleanup()
  }
}

// P1-2：talk 只算 role='user'，总量另设 talkTotal；自我叙事用用户话数。
{
  const { store, cleanup } = tempStore('jingjing-review6-talk-')
  try {
    const date = '2026-11-14'
    const now = ts(date, 22)
    store.addRaw(ts(date, 9), 's1', 'user', '今天去西湖走走。')
    store.addRaw(ts(date, 9, 1), 's1', 'assistant', '好啊，我记得你上次也提过。')
    store.addRaw(ts(date, 9, 2), 's1', 'user', '这次想去远一点。')
    store.replaceLifeBlocks(date, [
      { activity: '和他说说话', startedAt: ts(date, 9), endedAt: ts(date, 9, 30), evidence: ['raw:1', 'raw:2', 'raw:3'] },
    ])

    const timeline = buildTimeline({ store, date, now })
    assert.equal(timeline.counts.talk, 2, '两句他说的')
    assert.equal(timeline.counts.talkTotal, 3, '对话总量另算')
    assert.equal(timeline.events.filter((e) => e.kind === 'talk').length, 3)

    const self = buildSelf({ store, now })
    assert.equal(self.talkCount, 2)
    assert.equal(self.talkTotal, 3)
    assert.match(self.lines.join('\n'), /今天和他说过 2 段话/)
  } finally {
    cleanup()
  }
}

// P2-5：停机 3 天回来，先补完所有欠的梦，再巩固；每天的快照里都有当天的梦。
{
  const { store, dir, cleanup } = tempStore('jingjing-review6-dreams-')
  try {
    const today = '2026-11-14'
    const now = ts(today, 9, 30)
    const days = ['2026-11-11', '2026-11-12', '2026-11-13']
    for (const day of days) {
      addDayRaw(store, day, `${day} 说了一句足够长的原话，能当梦的引子。`)
      addOkAction(store, day, `dream:${day}`)
    }

    const result = tickRhythm({ store, now, dir })
    assert.equal(result.closed.closed.length, 3, '三个没关的日子一次补完')
    assert.equal(result.dreams.length, 3, '三个梦都补上')
    assert.equal(result.snapshots.length, 3, '三天的巩固都做了')
    for (const day of days) {
      assert.equal(store.isDayClosed(day), true)
      assert.ok(store.dreamForDate(day), `${day} 有梦`)
      const snap = store.selfSnapshotForDate(day)
      assert.ok(snap, `${day} 有快照`)
      assert.match(snap.text, /夜里梦见/, `${day} 的快照里带着当天的梦`)
    }
  } finally {
    cleanup()
  }
}

// P2-6：停机超过 7 天，从最后一个已关闭日之后逐日补齐，梦境与巩固也跟上。
{
  const { store, dir, cleanup } = tempStore('jingjing-review6-gap-')
  try {
    const today = '2026-11-12'
    const now = ts(today, 9)
    const anchor = '2026-11-01'
    store.addAction({
      ts: ts(anchor, 23), sessionId: '', kind: 'system', tool: 'close_day',
      summary: `把 ${anchor} 收起来`, callId: `close_day:${anchor}`, status: 'ok',
    })
    const days = []
    for (let d = 2; d <= 11; d += 1) {
      const day = `2026-11-${String(d).padStart(2, '0')}`
      days.push(day)
      addDayRaw(store, day, `${day} 说了一句足够长的原话，说明这一天真的发生过。`)
      addOkAction(store, day, `gap:${day}`)
    }

    const result = tickRhythm({ store, now, dir })
    assert.equal(result.closed.closed.length, 10, '10 天空档一次补齐')
    assert.equal(result.dreams.length, 10)
    // 10 天补账 + 早先已关闭但还没巩固的锚点日，一共 11 条快照。
    assert.equal(result.snapshots.length, 11)
    assert.ok(store.selfSnapshotForDate(anchor), '锚点日也补上巩固')
    for (const day of days) {
      assert.equal(store.isDayClosed(day), true, `${day} 已关闭`)
      assert.ok(store.dreamForDate(day), `${day} 的梦没丢`)
      assert.ok(store.selfSnapshotForDate(day), `${day} 的巩固没丢`)
    }
  } finally {
    cleanup()
  }
}

// P3-3：raw_turns 归档后，时间线仍要读 raw_archive。
{
  const { store, cleanup } = tempStore('jingjing-review6-archive-')
  try {
    const date = '2026-11-14'
    const now = ts(date, 23)
    store.addRaw(ts(date, 9), 's1', 'user', '归档之后也应该被看见。')
    store.addRaw(ts(date, 9, 1), 's1', 'assistant', '我记得这句话。')
    assert.equal(store.archiveRawBefore(ts(date, 12)), 2, '两条原话都进了归档')
    assert.equal(store.countRaw(), 0, 'raw_turns 已空')

    const timeline = buildTimeline({ store, date, now })
    assert.equal(timeline.events.filter((e) => e.kind === 'talk').length, 2, '归档对话仍出现在时间线')
    assert.equal(timeline.counts.talk, 1)
    assert.equal(timeline.counts.talkTotal, 2)
  } finally {
    cleanup()
  }
}

// P3-5：自我叙事保留快照日期行，去掉每行前面的横杠，不再渲染成「：- 00:01」。
{
  const self = selfFromData({
    date: '2026-11-13',
    snapshot: {
      id: 9,
      text: '2026-11-13 收起来的时候，她记得这一天真的发生过：\n- 00:01 写日记（life:1）\n- 和他说过 3 段话',
    },
  })
  const item = self.items.find((i) => i.kind === 'snapshot')
  assert.ok(item)
  assert.match(item.text, /2026-11-13/, '日期行还在')
  assert.doesNotMatch(item.text, /：-/)
  assert.doesNotMatch(item.text, /- 00:01/, '横杠不进入叙事')
}

// P3-6：close_day 的 ts 落在被关闭那一天，不跑到第二天的时间线里。
{
  const { store, dir, cleanup } = tempStore('jingjing-review6-close-')
  try {
    const date = '2026-11-14'
    const now = ts('2026-11-15', 9)
    addDayRaw(store, date)
    addOkAction(store, date, 'close:test')
    const result = closeDayIfDue({ store, now, dir })
    assert.equal(result.closed.length, 1)
    const row = store.db.prepare('SELECT id, ts FROM actions WHERE call_id = ?').get(`close_day:${date}`)
    assert.ok(row, 'close_day 动作已落库')
    assert.equal(Number(row.ts), ts(date, 23, 59, 59) + 999, '落在当天最后一刻')
    assert.equal(dateKey(Number(row.ts)), date, '日期仍属于被关闭的那天')

    const dayTimeline = buildTimeline({ store, date, now })
    assert.ok(dayTimeline.events.some((e) => e.kind === 'action' && /收起来/.test(e.text)), '出现在当天时间线')
    const nextTimeline = buildTimeline({ store, date: '2026-11-15', now })
    assert.equal(nextTimeline.events.some((e) => /收起来/.test(e.text)), false, '不污染第二天')
    assert.equal(startOfDay(now) > Number(row.ts), true)
  } finally {
    cleanup()
  }
}

console.log('OK: 0.6.2 复审回归（动作/对话口径、多日补梦、>7天补账、归档对话、快照渲染、close_day 时间戳）')
