/**
 * 节律（M3.5）测试：状态只由时钟和真实事件推导，归档只一次，梦永远是非事实层。
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { MemoryStore } from '../lib/store.js'
import { dateKey } from '../lib/life.js'
import {
  syncPhase, reconcileOnStart, closeDayIfDue, maybeDream, maybeQuietAction, tickRhythm,
} from '../lib/rhythm.js'
import { dayView, renderDays } from '../lib/view.js'

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'jingjing-rhythm-'))
const diary = path.join(tmp, 'diary')
const db = (name) => path.join(tmp, `${name}.sqlite`)

function at(h, m = 0, day = 5) {
  return new Date(2026, 10, day, h, m, 0, 0).getTime()
}

function open(name) {
  return new MemoryStore(db(name))
}

// 1) 醒着 → 安静：同一条状态不重复写；有人说话就切回醒着
{
  const store = open('phase')
  const t = at(21, 0)
  store.addRaw(t - 60000, 's1', 'user', '在吗')
  store.addRaw(t - 30000, 's1', 'her', '在。')
  assert.equal(syncPhase({ store, now: t }).phase.phase, 'awake')
  assert.equal(syncPhase({ store, now: t + 11 * 60000 }).phase.phase, 'quiet')
  const before = store.phasesForDate(dateKey(t)).length
  syncPhase({ store, now: t + 12 * 60000 })
  assert.equal(store.phasesForDate(dateKey(t)).length, before, '状态没变不应该新增行')
  store.addRaw(t + 13 * 60000, 's1', 'user', '还在吗')
  assert.equal(syncPhase({ store, now: t + 13 * 60000 }).phase.phase, 'awake')
  store.close()
}

// 2) 夜里：23 点后进入 night
{
  const store = open('night')
  const t = at(23, 10)
  assert.equal(syncPhase({ store, now: t }).phase.phase, 'night')
  store.close()
}

// 3) 归档：安静够久才收，只收一次；收完这一天冻结
{
  const store = open('close')
  const t = at(18, 0)
  store.addRaw(t, 's2', 'user', '晚上好')
  store.addAction({ ts: t + 5 * 60000, sessionId: 's2', kind: 'file', tool: 'write_diary', summary: '写了日记', status: 'ok' })
  const c1 = closeDayIfDue({ store, now: at(23, 40), dir: diary })
  assert.ok(c1 && c1.date === dateKey(t), '应该归档 2026-11-05')
  assert.equal(c1.count, 2, '两件真实的事：说话 + 写日记')
  assert.ok(store.isDayClosed(dateKey(t)))
  assert.ok(fs.existsSync(path.join(diary, `${dateKey(t)}.md`)))
  assert.equal(closeDayIfDue({ store, now: at(23, 45), dir: diary }), null, '同一天只归档一次')
  assert.equal(syncPhase({ store, now: at(23, 46) }).phase.phase, 'closed')
  const frozen = store.lifeForDate(dateKey(t)).length
  store.addRaw(at(23, 50), 's2', 'user', '还没睡')
  syncPhase({ store, now: at(23, 50) })
  assert.equal(store.lifeForDate(dateKey(t)).length, frozen, '归档后不能再改写当天日子')
  store.close()
}

// 4) 重启对账：关机期间记 offline，不补写活动
{
  const store = open('offline')
  const start = at(10, 0)
  store.appendPhase({ date: dateKey(start), phase: 'awake', startedAt: start, reason: '测试', evidence: [] })
  store.addRaw(at(10, 5), 's3', 'user', '早')
  reconcileOnStart({ store, now: at(12, 0) })
  const phases = store.phasesForDate(dateKey(start))
  const offline = phases.find((p) => p.phase === 'offline')
  assert.ok(offline, '应该留下 offline 段')
  assert.equal(offline.startedAt, at(10, 5), 'offline 从最后一次真实事件起算')
  assert.equal(offline.endedAt, at(12, 0))
  assert.equal(store.currentPhase().phase, 'quiet')
  store.close()
}

// 5) 梦：必须归档后才有，只做一次，标 non_factual，证据指向真实原话
{
  const store = open('dream')
  const t = at(18, 30)
  store.addRaw(t, 's4', 'user', '我今天在便利店门口等末班车，雨很大。')
  store.addAction({ ts: t + 60000, sessionId: 's4', kind: 'file', tool: 'write_diary', summary: '写了日记', status: 'ok' })
  closeDayIfDue({ store, now: at(23, 40), dir: diary })
  const d1 = maybeDream({ store, now: at(23, 41) })
  assert.ok(d1 && d1.text, '应该生成梦')
  assert.ok(d1.evidence[0].startsWith('raw:'), '梦要有真实证据')
  const saved = store.dreamForDate(dateKey(t))
  assert.equal(saved.nonFactual, true)
  assert.equal(maybeDream({ store, now: at(23, 42) }), null, '同一晚只做一个梦')
  const blocks = store.lifeForDate(dateKey(t))
  assert.ok(!blocks.some((b) => b.activity.includes('梦')), '梦不能进生活块')
  store.close()
}

// 6) 安静时翻旧记忆：落一条真实 ok 动作，每个 3 小时桶最多一次
{
  const store = open('quiet')
  const t = at(18, 0)
  store.addRaw(t, 's5', 'user', '我喜欢摄影，周末常去拍照。')
  store.addAssertion({ ts: t, subject: '他', predicate: '喜欢', value: '摄影', source: '我喜欢摄影' })
  syncPhase({ store, now: at(21, 0) })
  assert.equal(store.currentPhase().phase, 'quiet')
  const a1 = maybeQuietAction({ store, now: at(21, 30) })
  assert.ok(a1 && a1.hits >= 1, '应该真的查到原话')
  const act = store.recentActions(1)[0]
  assert.equal(act.tool, 'memory_find')
  assert.equal(act.status, 'ok')
  assert.equal(maybeQuietAction({ store, now: at(21, 40) }), null, '同一个桶不重复')
  store.close()
}

// 7) 只读视图：相位、生活块、动作、梦都在，且带证据
{
  const store = open('view')
  const t = at(18, 0)
  store.addRaw(t, 's6', 'user', '今天有点累。')
  store.addAction({ ts: t + 60000, sessionId: 's6', kind: 'file', tool: 'write_diary', summary: '写了日记', status: 'ok' })
  closeDayIfDue({ store, now: at(23, 40), dir: diary })
  maybeDream({ store, now: at(23, 41) })
  const view = dayView({ store, now: at(23, 50), days: 1 })
  assert.equal(view.days.length, 1)
  assert.ok(view.days[0].closed)
  assert.ok(view.days[0].blocks.length >= 2)
  assert.ok(view.days[0].actions.some((a) => a.ref.startsWith('act:')))
  assert.equal(view.days[0].dreams.length, 1)
  const md = renderDays({ store, now: at(23, 50), days: 1 })
  assert.ok(md.includes('这一天真的做过的事'))
  assert.ok(md.includes('梦（不是真事）'))
  store.close()
}

// 8) tickRhythm 一次跑通：归档 + 状态 + 梦
{
  const store = open('tick')
  const t = at(18, 0)
  store.addRaw(t, 's7', 'user', '晚上吃什么好呢？')
  const r = tickRhythm({ store, now: at(23, 40), dir: diary })
  assert.equal(r.closed.date, dateKey(t))
  assert.equal(r.phase.phase, 'closed')
  assert.ok(r.dream)
  store.close()
}

fs.rmSync(tmp, { recursive: true, force: true })
console.log('OK: 节律（醒着/安静/夜里/归档/离线）+ 梦（非事实层）+ 只读视图')
