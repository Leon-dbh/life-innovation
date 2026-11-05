#!/usr/bin/env node
/**
 * 把一份导出接回另一台机器（或同一个家换一个目录）。
 *
 * 用法：
 *   node tools/import.mjs --from <导出目录> --db D:/jingjing-home/state/jingjing.sqlite \
 *                         --data D:/jingjing-home [--force | --merge]
 *
 * 规矩：
 * - 目标库已存在时，默认拒绝（避免覆盖她现在的记忆）；先备份成 *.bak-<时间> 再换。
 * - 日记按文件名合并：已有的不覆盖；--force 才覆盖。
 * - 导入后重新点数，点数对不上就报错，不假装成功。
 */
import fs from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { mergeDatabase } from '../lib/merge.js'

function parseArgs(argv) {
  const out = {}
  for (let i = 0; i < argv.length; i += 1) {
    const k = argv[i]
    if (!k.startsWith('--')) continue
    const key = k.slice(2)
    const next = argv[i + 1]
    if (next === undefined || next.startsWith('--')) out[key] = true
    else { out[key] = next; i += 1 }
  }
  return out
}

const args = parseArgs(process.argv.slice(2))
if (!args.from || !args.db) {
  console.error('用法: node tools/import.mjs --from <导出目录> --db <memory.sqlite> --data <home> [--force | --merge]')
  process.exit(2)
}
const fromDir = path.resolve(String(args.from))
const dbPath = path.resolve(String(args.db))
const dataHome = path.resolve(String(args.data || path.dirname(path.dirname(dbPath))))

const manifestPath = path.join(fromDir, 'manifest.json')
if (!fs.existsSync(manifestPath)) {
  console.error(`这不是一份鲸鲸导出：缺少 ${manifestPath}`)
  process.exit(3)
}
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
if (manifest.format !== 'jingjing-export/1') {
  console.error(`不认识的导出版本：${manifest.format}`)
  process.exit(3)
}
const snapshot = path.join(fromDir, 'jingjing.sqlite')
if (!fs.existsSync(snapshot)) {
  console.error(`导出里没有记忆库：${snapshot}`)
  process.exit(3)
}

fs.mkdirSync(path.dirname(dbPath), { recursive: true })
if (fs.existsSync(dbPath) && args.merge) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const bak = dbPath + '.before-merge-' + stamp
  fs.copyFileSync(dbPath, bak)
  console.log('已备份现有记忆库：' + bak)
  const report = mergeDatabase({ targetPath: dbPath, sourcePath: snapshot })
  const diaryFrom = path.join(fromDir, 'diary')
  const diaryTo = path.join(dataHome, 'diary')
  let copied = 0
  let kept = 0
  if (fs.existsSync(diaryFrom)) {
    fs.mkdirSync(diaryTo, { recursive: true })
    for (const name of fs.readdirSync(diaryFrom)) {
      if (!name.endsWith('.md')) continue
      const dest = path.join(diaryTo, name)
      if (fs.existsSync(dest)) { kept += 1; continue }
      fs.copyFileSync(path.join(diaryFrom, name), dest)
      copied += 1
    }
  }
  console.log('合并完成（只增不删）：')
  for (const [table, stat] of Object.entries(report)) {
    console.log('  ' + table + ': ' + (typeof stat === 'object' ? JSON.stringify(stat) : stat))
  }
  console.log('  日记：补 ' + copied + ' 篇，保留已有 ' + kept + ' 篇')
  process.exit(0)
}
if (fs.existsSync(dbPath)) {
  if (!args.force) {
    console.error(`目标记忆库已存在：${dbPath}\n` +
      '  这可能是她现在的记忆。要换掉就加 --force（会先备份）；想合并进现有记忆库，目前不支持。')
    process.exit(4)
  }
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const backup = `${dbPath}.bak-${stamp}`
  fs.copyFileSync(dbPath, backup)
  console.log(`已备份现有记忆库：${backup}`)
}
fs.copyFileSync(snapshot, dbPath)

// 日记：合并，默认不覆盖已有。
const diaryFrom = path.join(fromDir, 'diary')
const diaryTo = path.join(dataHome, 'diary')
let imported = 0
let skipped = 0
if (fs.existsSync(diaryFrom)) {
  fs.mkdirSync(diaryTo, { recursive: true })
  for (const name of fs.readdirSync(diaryFrom)) {
    if (!/^\d{4}-\d{2}-\d{2}\.md$/.test(name)) continue
    const dest = path.join(diaryTo, name)
    if (fs.existsSync(dest) && !args.force) { skipped += 1; continue }
    fs.copyFileSync(path.join(diaryFrom, name), dest)
    imported += 1
  }
}

// 点数：不装样子。
const db = new DatabaseSync(dbPath)
const counts = {}
for (const [table, expected] of Object.entries(manifest.counts || {})) {
  try {
    counts[table] = db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n
  } catch {
    counts[table] = 0
  }
  if (counts[table] !== expected) {
    console.error(`点数不一致：${table} 期望 ${expected}，实际 ${counts[table]}`)
    process.exit(5)
  }
}
db.close()

console.log(`已接入 ${dbPath}`)
console.log(`  来源 ${manifest.exportedAt}（${manifest.exportedBy}）`)
console.log(`  ` + Object.entries(counts).map(([k, v]) => `${k}=${v}`).join(' '))
console.log(`  日记：导入 ${imported} 篇，跳过已有 ${skipped} 篇`)
