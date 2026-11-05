import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { MemoryStore } from '../lib/store.js'
import { mergeDatabase } from '../lib/merge.js'
import { rankedRecall } from '../lib/search.js'
import { tick, dateKey, startOfDay } from '../lib/life.js'

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jingjing-review-'))
const db = (name) => path.join(dir, name)
const DAY = 86400000
const now = Date.now()

// 1) 干净库（从未创建过 outbox 表）也能合并：merge 不能假设 Outbox 一定跑过。
{
  const targetPath = db('clean-target.sqlite')
  const sourcePath = db('clean-source.sqlite')
  const t = new MemoryStore(targetPath)
  t.addRaw(1000, 's', 'user', '目标库里的一句话')
  t.close()
  const s = new MemoryStore(sourcePath)
  s.addRaw(2000, 's', 'user', '来源库里的一句话')
  s.close()
  const report = mergeDatabase({ targetPath, sourcePath })
  assert.equal(report.raw_turns.added, 1)
  const out = new MemoryStore(targetPath)
  assert.equal(out.countRaw(), 2)
  out.close()
}

// 2) 召回大小写：正文里的 Alice 用 alice 也能搜到。
{
  const store = new MemoryStore(db('case.sqlite'))
  const id = store.addRaw(now - 1000, 's', 'user', '我的同事 Alice 今天带了蛋糕')
  const found = rankedRecall({ store, query: 'alice', limit: 5, now })
  assert.equal(found.hits[0]?.id, id, '小写查询要能命中正文里大写的 Alice')
  store.close()
}

// 3) tick 幂等：同一天已经写成 ok 之后，31 分钟后的 tick 不能再重写。
{
  const store = new MemoryStore(db('tick.sqlite'))
  const base = startOfDay(now) + 10 * 3600 * 1000 // 当地 10:00
  store.addRaw(base - 30 * 60 * 1000, 's', 'user', '今天聊了两句')
  const first = tick({ store, now: base, quietMs: 20 * 60 * 1000, dir: db('diary') })
  assert.ok(first, '第一次 tick 应该写日记')
  const again = tick({ store, now: base + 31 * 60 * 1000, quietMs: 20 * 60 * 1000, dir: db('diary') })
  assert.equal(again, null, '已经写过的那天不能再写第二遍')
  assert.equal(store.actionByCallId(`diary:${dateKey(base)}`).status, 'ok')
  store.close()
}

// 4) 回收站：删原话时要把生活块证据和梗概水位一起清掉。
{
  const store = new MemoryStore(db('recycle.sqlite'))
  const id = store.addRaw(now - 5000, 's', 'user', '被回收的一句话')
  store.addSummary(now - 4000, 's', '一条梗概', now - 5000, now - 5000, id)
  store.replaceLifeBlocks('2026-11-06', [
    { activity: '和他说说话', startedAt: now - 5000, endedAt: now - 5000, evidence: [`raw:${id}`] },
  ], now)
  assert.ok(store.recycleRaw(id))
  const block = store.lifeForDate('2026-11-06')[0]
  assert.deepEqual(block.evidence, [], '生活块证据里不能留着已删除的 raw 编号')
  const summary = store.recentSummaries(1)[0]
  // 水位不是外键：原话被回收后不能把水位清零，否则下一次摘要把旧原话再压一遍。
  assert.equal(summary.toRawId, id, '梗概水位保持在被回收的那条原话上，不回退')
  store.close()
}

// 5) 从回收站恢复的原话，7 天内不能再被归档规则搬走。
{
  const store = new MemoryStore(db('restore.sqlite'))
  const old = now - 200 * DAY
  const id = store.addRaw(old, 's', 'user', '很久以前的一句')
  store.addSummary(old + 1000, 's', '梗概', old, old, id)
  store.archiveRawBefore(now - 90 * DAY)
  store.recycleRaw(id)
  const recycleId = store.recycleRows(1)[0].id
  store.recycleRestore(recycleId, now)
  store.archiveRawBefore(now - 90 * DAY)
  assert.ok(store.rawById(id), '刚恢复的原话不能被立刻再归档')
  store.close()
}

console.log('OK: review fixes（干净库 merge / 大小写召回 / tick 幂等 / 回收清理 / 恢复不立刻归档）')
