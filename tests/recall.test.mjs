import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { MemoryStore } from '../lib/store.js'
import { rankedRecall, termsOf } from '../lib/search.js'

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jingjing-recall-'))
const store = new MemoryStore(path.join(dir, 'life.sqlite'))
const now = Date.now()
const DAY = 86400000

try {
  // 一条很久以前的稀有旧事。
  const oldId = store.addRaw(now - 90 * DAY, 's', 'user', '他说起青铜器，眼睛亮了一下')
  // 之后塞满只含高频词「杭州」的近期闲聊；旧事会被挤出“最近 400 条”。
  store.db.exec('BEGIN')
  for (let i = 0; i < 430; i += 1) {
    store.addRaw(now - i * 1000, 's', 'user', `今天杭州的天气一般，第 ${i} 次闲聊`)
  }
  store.db.exec('COMMIT')

  const terms = termsOf('杭州 青铜器')
  assert.ok(terms.includes('杭州'))
  assert.ok(terms.includes('青铜'))

  const candidates = store.candidateRaw(terms, 400)
  assert.ok(candidates.some((r) => r.id === oldId), '按词取候选不能被最近 400 条埋掉')

  const out = rankedRecall({ store, query: '杭州 青铜器', limit: 3, now })
  assert.ok(out.hits.some((h) => h.id === oldId), '稀有旧事应进入召回前 3')
  assert.match(out.hits.find((h) => h.id === oldId).text, /青铜器/)
} finally {
  store.close()
  fs.rmSync(dir, { recursive: true, force: true })
}

console.log('OK: 召回候选按词覆盖，稀有旧事不被近期高频词挤出')
