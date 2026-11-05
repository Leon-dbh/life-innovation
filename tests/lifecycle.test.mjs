import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { MemoryStore } from '../lib/store.js'
import { buildPack } from '../lib/pack.js'
import { createPackCache } from '../lib/packCache.js'
import { vitalityOf, halfLifeDays, EMOTION_HALF_LIFE_DAYS, HALF_LIFE_DAYS } from '../lib/lifecycle.js'
import { rankedRecall } from '../lib/search.js'

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jingjing-lifecycle-'))
const store = new MemoryStore(path.join(dir, 'life.sqlite'))
const now = Date.now()
const DAY = 86400000

// ---- 生命力 ----
assert.ok(vitalityOf(now, now) > 0.99)
assert.ok(Math.abs(vitalityOf(now - HALF_LIFE_DAYS * DAY, now, '普通') - 0.5) < 1e-9, '30 天半衰')
assert.ok(Math.abs(vitalityOf(now - EMOTION_HALF_LIFE_DAYS * DAY, now, '那天我很难过') - 0.5) < 1e-9, '情绪句 7 天半衰')
assert.equal(halfLifeDays('普通'), HALF_LIFE_DAYS)
assert.equal(halfLifeDays('我很难过'), EMOTION_HALF_LIFE_DAYS)

// ---- 归档：id 不变，证据仍可读 / 可搜 ----
const oldId = store.addRaw(now - 100 * DAY, 's0', 'user', '很久以前我说过一只叫年糕的仓鼠')
for (let i = 0; i < 5; i += 1) store.addRaw(now - i * 1000, 's1', 'user', `最近第 ${i} 句闲聊`)
assert.equal(store.rawById(oldId).archived, false)
const moved = store.archiveRawBefore(now - 90 * DAY)
assert.equal(moved, 1)
assert.equal(store.rawById(oldId).archived, true, '归档后仍按 id 读得到')
assert.equal(store.stats().raw, 5)
assert.equal(store.stats().archived, 1)
const found = rankedRecall({ store, query: '年糕', limit: 3, now })
assert.equal(found.hits[0].id, oldId, '归档的旧原话仍能被召回')

// ---- 回收站：从召回里拿走，但保留 payload ----
assert.ok(store.recycleRaw(oldId))
assert.equal(store.recycleCount(), 1)
assert.equal(store.rawById(oldId), null)
assert.equal(rankedRecall({ store, query: '年糕', limit: 3, now }).hits.length, 0)

// ---- 重复说法不再改指纹；梗概/画像更新要改指纹 ----
store.addAssertion({ ts: now - 1000, subject: '他', predicate: '名字', value: '林晚', source: '我叫林晚' })
const fp1 = store.fingerprint(now)
const same = store.addAssertion({ ts: now, subject: '他', predicate: '名字', value: '林晚', source: '我叫林晚' })
assert.equal(same.unchanged, true)
assert.equal(store.fingerprint(now), fp1, '同一说法重复出现不重建记忆包')
store.addAssertion({ ts: now, subject: '他', predicate: '名字', value: '小晚', source: '叫我小晚' })
assert.notEqual(store.fingerprint(now), fp1, '新说法改变指纹')
const fp2 = store.fingerprint(now)
store.addSummary(now, 's1', '他最近在准备复查', now - 2000, now)
assert.notEqual(store.fingerprint(now), fp2, '新梗概改变指纹')

// ---- 注入按行截断，不切半行 ----
const text = buildPack({ store, now, maxChars: 260 })
assert.ok(text.length <= 260)
const lines = text.split('\n')
for (const line of lines.slice(1)) {
  assert.ok(!line.endsWith('（'), `行不应停在半个括号：${line}`)
  assert.ok(!line.endsWith('（证据'), `行不应停在半个词：${line}`)
}
assert.match(text, /^你记得的事/)

// ---- 缓存命中/重建会记可观测事件 ----
const cache = createPackCache({ store, maxChars: 800 })
const a = cache.get(now)
const b = cache.get(now)
assert.equal(a, b)
assert.equal(cache.stats().builds, 1)

store.close()
fs.rmSync(dir, { recursive: true, force: true })
console.log('OK: lifecycle（半衰期 / 归档 / 回收站 / 指纹 / 按行截断）')
