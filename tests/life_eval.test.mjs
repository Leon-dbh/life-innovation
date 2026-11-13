import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { MemoryStore } from '../lib/store.js'
import { evaluateLife } from '../tools/life_eval.mjs'

const now = Date.parse('2026-11-14T10:00:00+08:00')
const day = Date.parse('2026-11-13T00:00:00+08:00')
const at = (h, m = 0) => day + h * 3600000 + m * 60000
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jingjing-eval-'))
const store = new MemoryStore(path.join(dir, 'eval.sqlite'))

store.addRaw(at(9), 's1', 'user', '我住在杭州，周末去西湖。')
store.addRaw(at(9, 1), 's1', 'assistant', '作为一个AI，我可以帮您规划路线。')
store.addRaw(at(9, 2), 's1', 'assistant', '记得穿舒服的鞋。')
store.addAction({
  ts: at(10), sessionId: 's1', kind: 'tool', tool: 'book_next',
  summary: '读了一段书', callId: 'eval:book', status: 'ok',
})
store.replaceLifeBlocks('2026-11-13', [
  { activity: '和他说说话', startedAt: at(9), endedAt: at(9, 2), evidence: ['raw:1'] },
  { activity: '读了一段书', startedAt: at(10), endedAt: at(10), evidence: ['act:1'] },
])
store.addAssertion({ ts: at(11), subject: '他', predicate: '工作', value: '老师', source: 'raw:1' })
store.addAssertion({ ts: at(12), subject: '他', predicate: '工作', value: '程序员', source: 'raw:1' })
store.addSelfSnapshot({ date: '2026-11-13', ts: at(23), text: '收起来的那一天：西湖。', evidence: ['raw:1'] })
store.addAction({
  ts: at(23, 30), sessionId: '', kind: 'system', tool: 'close_day',
  summary: '把 2026-11-13 收起来', callId: 'close_day:2026-11-13', status: 'ok',
})

const report = evaluateLife({
  store,
  now,
  queries: [
    { query: '西湖', expect: '西湖' },
    { query: '杭州', expect: '杭州' },
    { query: '不存在', expect: '没有' },
  ],
})
assert.equal(report.metrics.recallAt3, 0.667)
assert.equal(report.metrics.repairRate, 1)
assert.equal(report.metrics.assistantToneRate, 1 / 2)
assert.ok(report.metrics.continuity7d > 0)
assert.ok(report.metrics.snapshotCoverage > 0)
assert.ok(report.metrics.lifeEvidenceCoverage > 0)
assert.ok(report.metrics.token > 0)
assert.ok(report.metrics.p95RecallMs >= 0)
assert.equal(report.failures.length, 1)
store.close()
fs.rmSync(dir, { recursive: true, force: true })
console.log('OK: 生活体评测（连续性/巩固/证据/修复/助手腔/recall/token/p95）')
