#!/usr/bin/env node
/** 改了抽取规则之后，把历史原话重新过一遍，补上漏掉的要点（幂等）。 */
import fs from 'node:fs'
import { MemoryStore } from '../lib/store.js'
import { extractAssertions } from '../lib/extract.js'
import { resolvePaths } from '../lib/paths.js'

const explicit = process.argv[2] ? { dbPath: process.argv[2] } : {}
const file = resolvePaths(explicit).dbPath
if (!fs.existsSync(file)) {
  console.error(`找不到记忆库：${file}（不替你新建空库）`)
  process.exit(2)
}
const store = new MemoryStore(file)

// 直接按「subject+predicate+value 且 valid_to IS NULL」查，不再用 liveAssertions(…,100)
// 的截断列表——活断言超过 100 条时旧写法会误判成“没有”，重复插入。
const findLiveSame = store.db.prepare(`SELECT id FROM assertions
  WHERE subject = ? AND predicate = ? AND value = ? AND valid_to IS NULL ORDER BY id DESC LIMIT 1`)
const findLivePredicate = store.db.prepare(`SELECT id, valid_from FROM assertions
  WHERE subject = ? AND predicate = ? AND valid_to IS NULL ORDER BY id DESC LIMIT 1`)

let added = 0
// 全量重放：活库 + 90 天前归档的原话都算，别让历史事实因为搬家而漏补。
for (const row of store.allRaw()) {
  if (row.role !== 'user') continue
  // 用原话时间，而不是「现在」：否则补出来的「明天/今晚」会以今天为基准。
  for (const item of extractAssertions(row.text, row.ts)) {
    // 已经有同 subject+predicate+value 的活断言：说明上次已经补过，跳过。
    if (findLiveSame.get('他', item.predicate, item.value)) continue
    // 旧逻辑直接用历史 row.ts 取代当前活断言，会写出 valid_to < valid_from 的负区间。
    // 取代时间取「原话时间」与「当前 valid_from」中较晚的那个。
    const prev = findLivePredicate.get('他', item.predicate)
    const at = prev ? Math.max(Math.trunc(row.ts), Number(prev.valid_from) || 0) : row.ts
    store.addAssertion({ ts: at, subject: '他', predicate: item.predicate, value: item.value, source: row.text, dueAt: item.dueAt ?? null })
    if (!item.predicate.startsWith('计划:')) {
      store.setProfile('他', item.predicate, item.value, row.text.slice(0, 120), at)
    }
    added += 1
  }
}
console.log(`backfill done, added ${added}`)
store.close()
