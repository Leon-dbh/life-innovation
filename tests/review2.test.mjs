/**
 * 第二轮复审的回归：WAL 备份、归档后 tick、开机补归档、同日指纹、
 * 跨午夜 phase、merge 新表/归档重复、keep_until、回收证据、安静读书节流。
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { MemoryStore } from '../lib/store.js'
import { snapshotDatabase } from '../lib/backup.js'
import { dateKey, tick, addDays, startOfDay } from '../lib/life.js'
import { syncPhase, closeDayIfDue } from '../lib/rhythm.js'
import { buildPack } from '../lib/pack.js'
import { mergeDatabase } from '../lib/merge.js'
import { createHands } from '../lib/hands.js'

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'jingjing-review2-'))
const db = (name) => path.join(tmp, `${name}.sqlite`)
const diary = path.join(tmp, 'diary')
const at = (h, m = 0, day = 5) => new Date(2026, 10, day, h, m, 0, 0).getTime()
let passed = 0

// 1) WAL 里未 checkpoint 的数据也能进快照（copyFileSync 会得到空库）。
{
  const file = db('wal')
  const store = new MemoryStore(file)
  store.addRaw(at(10), 's', 'user', '快照之前写进去的话')
  const snap = path.join(tmp, 'wal-snapshot.sqlite')
  snapshotDatabase(file, snap)
  const copy = new MemoryStore(snap)
  assert.equal(copy.stats().raw, 1, '快照必须包含 WAL 里的已提交事务')
  copy.close()
  store.close()
  passed += 1
}

// 2) 归档之后 tick 不能重写日记，更不能把「空档」写成动作。
{
  const file = db('closed-tick')
  const store = new MemoryStore(file)
  store.addRaw(at(21, 30), 's', 'user', '在吗')
  const closed = closeDayIfDue({ store, now: at(0, 10, 6), dir: diary })
  assert.ok(closed && closed.closed[0].date === '2026-11-05')
  const filePath = path.join(diary, '2026-11-05.md')
  const before = fs.readFileSync(filePath, 'utf8')
  assert.ok(!before.includes('空档（证据'), '归档日记不能把空档写成动作')
  const again = tick({ store, now: at(0, 40, 6), dir: diary })
  assert.equal(again, null, '已归档的日子不能再被 tick 写')
  assert.equal(fs.readFileSync(filePath, 'utf8'), before, '日记文件不能被重写')
  store.close()
  passed += 1
}

// 3) 22:00 关机、次日 09:00 启动：前一天仍要补归档。
{
  const file = db('catchup')
  const store = new MemoryStore(file)
  store.addRaw(at(22), 's', 'user', '今天累坏了')
  store.addAction({ ts: at(22, 10), sessionId: 's', kind: 'file', tool: 'read_file', summary: '看了点东西', status: 'ok' })
  const closed = closeDayIfDue({ store, now: at(9, 0, 6), dir: diary })
  assert.ok(closed && closed.closed[0].date === '2026-11-05', '09:00 启动要补归档昨天')
  assert.ok(store.isDayClosed('2026-11-05'))
  assert.ok(fs.existsSync(path.join(diary, '2026-11-05.md')))
  store.close()
  passed += 1
}

// 4) 空日子不在 23:30 提前归档，留给跨天路径。
{
  const store = new MemoryStore(db('empty'))
  const closed = closeDayIfDue({ store, now: at(23, 30), dir: diary })
  assert.equal(closed, null, '没有真实动作的日子不该被归档')
  assert.equal(store.isDayClosed('2026-11-05'), false)
  store.close()
  passed += 1
}

// 5) 同一天新增原话也要改变指纹（记忆包不能停在当天第一句）。
{
  const store = new MemoryStore(db('fingerprint'))
  store.addRaw(at(10), 's', 'user', '第一句')
  const fp1 = store.fingerprint(at(10, 1))
  store.addRaw(at(10, 2), 's', 'user', '第二句')
  const fp2 = store.fingerprint(at(10, 3))
  assert.notEqual(fp1, fp2, '同日新原话必须改变指纹')
  assert.match(buildPack({ store, now: at(10, 3) }), /第二句/)
  store.close()
  passed += 1
}

// 6) 跨午夜的 night 要切成新的一天，第二天 8 点前也能看到 phase。
{
  const store = new MemoryStore(db('midnight'))
  const night = syncPhase({ store, now: at(23, 30) })
  assert.equal(night.phase.phase, 'night')
  const next = syncPhase({ store, now: at(0, 30, 6) })
  assert.equal(next.phase.phase, 'night')
  assert.equal(next.phase.date, '2026-11-06')
  assert.ok(store.phasesForDate('2026-11-06').length > 0)
  const prev = store.phasesForDate('2026-11-05')
  assert.ok(prev.every((p) => p.endedAt), '前一天的 phase 应该已经结束')
  store.close()
  passed += 1
}

// 7) merge 要搬 life_phases / dreams / books，且目标已归档的同句不重复插。
{
  const target = db('merge-target')
  const source = db('merge-source')
  const t = new MemoryStore(target)
  const s = new MemoryStore(source)
  t.addRaw(1000, 't', 'user', '同一句')
  t.addAssertion({ ts: 1000, subject: '他', predicate: '住在', value: '杭州', source: 'raw:1' })
  t.setProfile('他', '住在', '杭州', 'raw:1', 1000)
  t.close()

  const old = s.addRaw(500, 's', 'user', '很早的一句')
  s.addSummary(600, 's', '旧梗概', 500, 500, old)
  s.archiveRawBefore(800)
  s.addAssertion({ ts: 2000, subject: '他', predicate: '住在', value: '上海', source: `raw:${old}` })
  s.setProfile('他', '住在', '上海', `raw:${old}`, 2000)
  s.appendPhase({ date: '2026-11-05', phase: 'quiet', startedAt: 900, reason: '没人说话', evidence: [] })
  s.addDream({ date: '2026-11-05', ts: 950, text: '梦见一把伞。', evidence: [`raw:${old}`] })
  s.addBook({ title: '测试书', url: 'https://www.gutenberg.org/x.txt', path: 'x.txt', total: 100, now: 960 })
  s.close()

  const report = mergeDatabase({ targetPath: target, sourcePath: source })
  assert.equal(report.life_phases.added, 1)
  assert.equal(report.dreams.added, 1)
  assert.equal(report.books.added, 1)
  assert.equal(report.assertions.demoted, 1, '来源更新的说法要降级目标旧说法')
  const m = new MemoryStore(target)
  assert.equal(m.liveAssertions().find((a) => a.predicate === '住在').value, '上海')
  assert.equal(m.stats().raw, 2, '归档同句不能再插一条活原话')
  assert.equal(m.stats().archived, 0, '来源归档原话搬回活库，避免两表同 id 引用歧义')
  assert.match(m.dreamsForDate('2026-11-05')[0].evidence[0], /^raw:\d+$/)
  m.close()
  passed += 1
}

// 8) 恢复的原话 7 天内不再被归档（keep_until 与「现在」比，不与 90 天 cutoff 比）。
{
  const store = new MemoryStore(db('keep'))
  const id = store.addRaw(Date.now() - 200 * 86400000, 's', 'user', '很久以前的话')
  store.addSummary(Date.now() - 190 * 86400000, 's', '旧梗概', Date.now() - 200 * 86400000, Date.now() - 200 * 86400000, id)
  store.archiveRawBefore(Date.now() - 180 * 86400000)
  store.recycleRaw(id)
  const restored = store.recycleRestore(store.recycleRows(1)[0].id, Date.now())
  assert.equal(store.archiveRawBefore(Date.now() + 1000), 0, '7 天保护期内不能再次归档')
  assert.ok(restored.id > 0)
  store.close()
  passed += 1
}

// 9) 回收原话时，life_phases / dreams 的证据也要清掉。
{
  const store = new MemoryStore(db('recycle-evidence'))
  const id = store.addRaw(1000, 's', 'user', '会被回收的一句话')
  store.appendPhase({ date: '2026-11-05', phase: 'quiet', startedAt: 1000, reason: 'x', evidence: [`raw:${id}`] })
  store.addDream({ date: '2026-11-05', ts: 1100, text: '梦见一句话。', evidence: [`raw:${id}`] })
  assert.ok(store.recycleRaw(id))
  assert.deepEqual(store.phasesForDate('2026-11-05')[0].evidence, [])
  assert.deepEqual(store.dreamsForDate('2026-11-05')[0].evidence, [])
  store.close()
  passed += 1
}

// 10) 安静读书同一 3 小时桶只读一次，书签不能偷偷往前跑。
{
  const home = path.join(tmp, 'hands')
  for (const sub of ['diary', 'notes', 'books']) fs.mkdirSync(path.join(home, sub), { recursive: true })
  const store = new MemoryStore(path.join(home, 'hands.sqlite'))
  const text = '*** START OF THE PROJECT GUTENBERG EBOOK 测试 ***\n' + '风从窗缝里进来。'.repeat(400)
  const hands = createHands({
    home, store,
    fetchImpl: async (url) => ({ ok: true, status: 200, url, arrayBuffer: async () => Buffer.from(text) }),
    notifier: async () => ({ ok: true }),
  })
  const book = await hands.bookNext()
  const offsetOf = () => Number(store.db.prepare('SELECT offset FROM books WHERE id = 1').get()?.offset || 0)
  const offset = offsetOf()
  const quietAt = at(14)
  const first = await hands.quietAction(quietAt)
  assert.ok(first, '安静时应该读一段')
  const afterFirst = offsetOf()
  assert.ok(afterFirst > offset)
  const second = await hands.quietAction(quietAt + 1000)
  assert.equal(second, null, '同一个 3 小时桶不能再读')
  assert.equal(offsetOf(), afterFirst, '被节流时书签不能前进')
  assert.equal(store.countActionsSince('book_next', quietAt - 3600000), 1)
  store.close()
  passed += 1
}

console.log(`OK: review2（${passed} 组回归：WAL / 归档 / 补归档 / 空日 / 指纹 / 跨午夜 / merge / keep_until / 回收证据 / 读书节流）`)
fs.rmSync(tmp, { recursive: true, force: true })
