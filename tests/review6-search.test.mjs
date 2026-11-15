import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { MemoryStore } from '../lib/store.js'
import { rankedRecall, termsOf } from '../lib/search.js'

const now = Date.parse('2026-11-14T10:00:00+08:00')
const dirs = []

// 造一个和基准库同内容的库：用来对照“缓存算出来的分”和“第一次直接算的分”。
function seed(seedDir) {
  dirs.push(seedDir)
  const store = new MemoryStore(path.join(seedDir, 'life.sqlite'))
  store.addRaw(now - 3 * 86400000, 's1', 'user', '杭州的雨下了一整晚')
  store.addRaw(now - 3 * 86400000 + 1000, 's1', 'her', '我也记得杭州的雨')
  store.addRaw(now - 86400000, 's1', 'user', '今天在公司加班到很晚')
  store.addRaw(now - 2 * 3600000, 's1', 'her', '早点睡，别太累')
  return store
}

const query = '杭州的雨你还记得吗？'
const terms = termsOf(query)
const expected = new Set()
const probe = seed(fs.mkdtempSync(path.join(os.tmpdir(), 'jingjing-search-probe-')))
for (const row of probe.candidateRaw(terms, 400)) {
  for (const term of terms) if (String(row.text).toLowerCase().includes(term.toLowerCase())) expected.add(term)
}
probe.close()
assert.ok(expected.size > 0 && expected.size < terms.length, '用例里要同时有命中词和未命中词')

const store = seed(fs.mkdtempSync(path.join(os.tmpdir(), 'jingjing-search-')))
let counted = []
let allCalls = 0
const originalCount = store.countRawMatches.bind(store)
const originalAll = store.countRawAll.bind(store)
store.countRawMatches = (term) => { counted.push(term); return originalCount(term) }
store.countRawAll = () => { allCalls += 1; return originalAll() }

const first = rankedRecall({ store, query, now })
assert.deepEqual(new Set(counted), expected, '只给候选行里真的出现的词算 df')
assert.equal(counted.length, expected.size, '每个命中词最多算一次')
assert.ok(first.hits.length > 0 && first.scanned > 0)

const callsAfterFirst = counted.length
const totalCallsAfterFirst = allCalls
const second = rankedRecall({ store, query, now })
assert.equal(counted.length, callsAfterFirst, '同一数据版本复用 df/totalDocs')
assert.equal(allCalls, totalCallsAfterFirst, '缓存命中时不再 countRawAll')
assert.deepEqual(second.hits.map((h) => [h.id, h.score]), first.hits.map((h) => [h.id, h.score]))

// 数据一变（新增原话），指纹变化，缓存必须失效并重新算。
const fresh = store.addRaw(now, 's1', 'user', '杭州又下雨了，你记得带伞吗')
const third = rankedRecall({ store, query, now })
assert.ok(counted.length > callsAfterFirst, '新增原话后要重新算 df')
assert.ok(third.hits.some((h) => h.id === fresh), '新命中原话能进召回')

// 与完全没有缓存的同内容库对照：命中顺序与分数一致。
const control = seed(fs.mkdtempSync(path.join(os.tmpdir(), 'jingjing-search-control-')))
control.addRaw(now, 's1', 'user', '杭州又下雨了，你记得带伞吗')
const uncached = rankedRecall({ store: control, query, now })
assert.deepEqual(
  third.hits.map((h) => [h.id, h.score]),
  uncached.hits.map((h) => [h.id, h.score]),
  '缓存不能改变排序/分数',
)

store.close()
control.close()
for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true })
console.log('OK: 召回 df/totalDocs 缓存只算命中词，失效与打分正确')
