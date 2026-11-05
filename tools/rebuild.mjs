#!/usr/bin/env node
/**
 * 从原话重建要点与画像（抽取规则改了以后用；按时间顺序重放 user 原话）。
 *
 * 安全前提：
 * - 先 VACUUM INTO 备份（会带上 WAL 里已提交但还没 checkpoint 的数据）；
 * - 先把 raw_turns + raw_archive 全量读出来，再删旧断言/画像；
 * - 删除与重放包在 BEGIN IMMEDIATE … COMMIT 里，任何一步失败都 ROLLBACK。
 * 默认重放全部历史；--limit N 只重放最近 N 条原话。
 *
 * 用法：node tools/rebuild.mjs [--db <memory.sqlite>] [--limit N]
 */
import path from 'node:path'
import { MemoryStore } from '../lib/store.js'
import { extractAssertions } from '../lib/extract.js'

function parseArgs(argv) {
  const out = { db: null, limit: null, help: false }
  const positional = []
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i]
    if (a === '--db') out.db = argv[++i]
    else if (a === '--limit') out.limit = argv[++i]
    else if (a === '-h' || a === '--help') out.help = true
    else if (a.startsWith('--')) throw new Error(`不认识的参数：${a}`)
    else positional.push(a)
  }
  if (!out.db && positional.length) out.db = positional[0]
  if (positional.length > 1) throw new Error(`多余的参数：${positional.slice(1).join(' ')}`)
  return out
}

const args = parseArgs(process.argv.slice(2))
if (args.help) {
  console.log('用法：node tools/rebuild.mjs [--db <memory.sqlite>] [--limit N]')
  process.exit(0)
}

let limit = null
if (args.limit !== null && args.limit !== undefined) {
  const n = Number(args.limit)
  if (!Number.isInteger(n) || n < 1) {
    console.error(`--limit 需要正整数，收到：${args.limit}`)
    process.exit(2)
  }
  limit = n
}

const file = path.resolve(String(args.db || 'D:/jingjing-home/state/jingjing.sqlite'))
const store = new MemoryStore(file)

// 1) 备份：VACUUM INTO 是事务性快照，WAL 里已提交的数据也会进去。
const stamp = new Date().toISOString().replace(/[:.]/g, '-')
const backup = `${file}.before-rebuild-${stamp}`
store.db.exec(`VACUUM INTO '${backup.replaceAll("'", "''")}'`)
console.log(`已备份现有记忆库：${backup}`)

// 2) 先读全量再删：raw_turns 和 raw_archive 都要，按时间、id 排（同 id 时活跃的在前）。
let rows = store.db.prepare(`SELECT id, ts, role, text, 0 AS archived FROM raw_turns
  UNION ALL SELECT id, ts, role, text, 1 AS archived FROM raw_archive
  ORDER BY ts ASC, id ASC, archived ASC`).all().map((r) => ({
  id: Number(r.id), ts: Number(r.ts), role: String(r.role), text: String(r.text),
}))
if (limit !== null && rows.length > limit) rows = rows.slice(-limit)

// 3) 事务里删旧 + 全量重放；失败回滚，旧断言/画像原样还在。
let facts = 0
store.db.exec('BEGIN IMMEDIATE')
try {
  store.db.exec('DELETE FROM assertions')
  store.db.exec('DELETE FROM profiles')
  for (const row of rows) {
    if (row.role !== 'user') continue
    // 用原话时间推算「明天/今晚」，和当时 live 抽取（index.js: extractAssertions(text, ts)）一致。
    for (const item of extractAssertions(row.text, row.ts)) {
      store.addAssertion({
        ts: row.ts, subject: '他', predicate: item.predicate, value: item.value,
        source: row.text, dueAt: item.dueAt ?? null,
      })
      if (!item.predicate.startsWith('计划:')) {
        store.setProfile('他', item.predicate, item.value, row.text.slice(0, 120), row.ts)
      }
      facts += 1
    }
  }
  store.db.exec('COMMIT')
  console.log(`rebuild done, ${facts} facts（重放 ${rows.length} 条原话${limit === null ? '，全量' : `，limit=${limit}`}）`)
} catch (err) {
  try { store.db.exec('ROLLBACK') } catch { /* 事务可能已经自己回滚了 */ }
  console.error(`rebuild 失败，已回滚：${err.message}`)
  process.exitCode = 1
} finally {
  store.close()
}
