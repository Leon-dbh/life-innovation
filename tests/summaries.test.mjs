/**
 * 梗概（记忆第二层）的触发规则。
 *
 * 生产库里 summaries 曾经是 0：旧逻辑用「总条数 % 12」触发，而调用点在她的回复入库之前，
 * 总数永远是奇数——这个测试盯的就是「按新原话条数触发」和「水位用 id，不靠时间戳」。
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { MemoryStore } from '../lib/store.js'
import { maybeSummarize } from '../lib/summaries.js'
import { summarizeStructured } from '../lib/extract.js'

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jingjing-sum-'))
const store = new MemoryStore(path.join(dir, 'sum.sqlite'))
const base = new Date(2026, 10, 6, 9, 0, 0).getTime()

for (let i = 0; i < 6; i += 1) store.addRaw(base + i, 's1', i % 2 ? 'her' : 'user', `第${i}句`)
assert.equal(maybeSummarize({ store, sessionId: 's1', ts: base + 100 }), null, '不足 12 条新原话不写梗概')

for (let i = 6; i < 12; i += 1) store.addRaw(base + i, 's1', i % 2 ? 'her' : 'user', `第${i}句`)
const first = maybeSummarize({ store, sessionId: 's1', ts: base + 200 })
assert.ok(first, '满 12 条新原话应生成梗概')
assert.equal(first.rows, 4, '最近 8 条留给记忆包，一次只压 12-8=4 条')
assert.match(first.text, /第0句/)
assert.ok(!first.text.includes('第11句'), '最近的话不进梗概')
assert.deepEqual(first.sourceRefs, ['raw:1', 'raw:2', 'raw:3', 'raw:4'], '梗概保留可回读的原话 ref')
const stored = store.recentSummaries(1)[0]
assert.deepEqual(stored.sourceRefs, first.sourceRefs)
assert.equal(store.summaryById(stored.id).text, first.text)

// 结构化梗概：先保决定/未完成/情绪，工具汇报和超长回复不进梗概。
const structured = summarizeStructured([
  { id: 1, ts: base, role: 'user', text: '我决定明天开始早起' },
  { id: 2, ts: base + 1, role: 'her', text: '周末要不要去看展？' },
  { id: 3, ts: base + 2, role: 'user', text: '今天有点累' },
  { id: 4, ts: base + 3, role: 'her', text: '工具返回：https://example.com/very/long/path' },
  { id: 5, ts: base + 4, role: 'user', text: '今天吃了面' },
], 240)
assert.match(structured, /决定：.*早起/)
assert.match(structured, /没放下：.*看展/)
assert.match(structured, /情绪：.*累/)
assert.ok(!structured.includes('http'), '工具汇报不进梗概')
assert.ok(structured.length <= 240, '梗概不超过预算')

// 水位推进后，没有新原话就不该重复压同一批。
assert.equal(maybeSummarize({ store, sessionId: 's1', ts: base + 300 }), null)

// 同一毫秒的 12 条（时间戳完全相同）：按 id 水位也要能触发且不漏。
const sameTs = base + 500
for (let i = 0; i < 12; i += 1) store.addRaw(sameTs, 's1', 'user', `同刻第${i}句`)
const second = maybeSummarize({ store, sessionId: 's1', ts: sameTs + 1 })
assert.ok(second, '同一毫秒的原话也要能触发梗概')
assert.equal(store.recentSummaries(5).length, 2)
assert.ok(store.lastSummaryWatermark().rawId >= second.toRawId)

// 合并/导入来的旧梗概没有 to_raw_id：水位要按 to_ts 回退反推，不能从头再压一遍。
const legacyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jingjing-sum-legacy-'))
const legacy = new MemoryStore(path.join(legacyDir, 'legacy.sqlite'))
for (let i = 0; i < 5; i += 1) legacy.addRaw(base + i, 's1', 'user', `旧第${i}句`)
legacy.addSummary(base + 10, 's1', '旧梗概', base, base + 4)
legacy.addRaw(base + 50, 's1', 'user', '新的一句')
const legacyWatermark = legacy.lastSummaryWatermark()
assert.equal(legacyWatermark.rawId, 5, '没有 to_raw_id 时按 to_ts 找到最后一条原话')
assert.equal(maybeSummarize({ store: legacy, sessionId: 's1', ts: base + 60 }), null, '不足 12 条不重复压')
legacy.close()
fs.rmSync(legacyDir, { recursive: true, force: true })

store.close()
fs.rmSync(dir, { recursive: true, force: true })
console.log('OK: summaries（按新原话触发 / 水位用 id / 旧梗概回退推算）')
