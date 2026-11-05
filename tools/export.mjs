#!/usr/bin/env node
/**
 * 把她的一生存档导出成一个文件夹：记忆库 + 日记 + 清单。
 *
 * 用法：
 *   node tools/export.mjs --db D:/life-innovation-home/state/life-innovation.sqlite \
 *                         --data D:/life-innovation-home \
 *                         --out D:/life-innovation-home/backups/export-2026-11-05
 *
 * 导出不锁死运行中的宿主：用 SQLite 的 VACUUM INTO 取一致快照（它自己会等读锁）。
 */
import fs from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'

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
if (!args.db || !args.out) {
  console.error('用法: node tools/export.mjs --db <memory.sqlite> --data <home> --out <目录>')
  process.exit(2)
}
const dbPath = path.resolve(String(args.db))
const dataHome = path.resolve(String(args.data || path.dirname(path.dirname(dbPath))))
const outDir = path.resolve(String(args.out))

if (!fs.existsSync(dbPath)) {
  console.error(`记忆库不存在：${dbPath}`)
  process.exit(3)
}
if (fs.existsSync(outDir) && fs.readdirSync(outDir).length > 0 && !args.force) {
  console.error(`导出目录不是空的：${outDir}（要覆盖就加 --force）`)
  process.exit(4)
}
fs.mkdirSync(outDir, { recursive: true })

// 1) 记忆库：VACUUM INTO 生成一致快照（不会把 -wal 拆开）。
const snapshot = path.join(outDir, 'life-innovation.sqlite')
if (fs.existsSync(snapshot)) fs.rmSync(snapshot)
const source = new DatabaseSync(dbPath, { readOnly: true })
source.exec('PRAGMA busy_timeout = 5000')
source.exec(`VACUUM INTO '${snapshot.replaceAll("'", "''")}'`)
source.close()

// 点数必须在快照上数：VACUUM INTO 之后宿主仍可能继续写源库，
// 用源连接数出来的 counts 会超前于快照，导入端点数校验就会失败（exit 5）。
const db = new DatabaseSync(snapshot, { readOnly: true })
db.exec('PRAGMA busy_timeout = 5000')
const counts = {}
for (const table of ['raw_turns', 'raw_archive', 'assertions', 'profiles', 'relations', 'summaries', 'actions', 'life_blocks', 'life_phases', 'dreams', 'recycle', 'books', 'outbox']) {
  try {
    counts[table] = db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n
  } catch {
    counts[table] = 0
  }
}
db.close()

// 2) 日记：只导出 YYYY-MM-DD.md，别的文件不碰。
const diarySrc = path.join(dataHome, 'diary')
const diaryOut = path.join(outDir, 'diary')

// --force 时先清掉目标 diary 里上次留下的 *.md，否则旧日期会留在“新”导出里。
if (args.force && fs.existsSync(diaryOut)) {
  for (const name of fs.readdirSync(diaryOut)) {
    if (!name.endsWith('.md')) continue
    const p = path.join(diaryOut, name)
    if (fs.statSync(p).isFile()) fs.rmSync(p, { force: true })
  }
}

let diaryCount = 0
if (fs.existsSync(diarySrc)) {
  fs.mkdirSync(diaryOut, { recursive: true })
  for (const name of fs.readdirSync(diarySrc)) {
    if (!/^\d{4}-\d{2}-\d{2}\.md$/.test(name)) continue
    fs.copyFileSync(path.join(diarySrc, name), path.join(diaryOut, name))
    diaryCount += 1
  }
}

// 3) 清单：人看得懂，机器也校验得了。
const manifest = {
  format: 'life-innovation-export/1',
  dbFile: path.basename(snapshot),
  exportedAt: new Date().toISOString(),
  exportedBy: process.env.USERNAME || process.env.USER || 'unknown',
  sourceDb: dbPath,
  sourceHome: dataHome,
  dbBytes: fs.statSync(snapshot).size,
  diaryCount,
  counts,
}
fs.writeFileSync(path.join(outDir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n', 'utf8')

console.log(`已导出到 ${outDir}`)
console.log(`  记忆库 ${(manifest.dbBytes / 1024).toFixed(1)} KB：` +
  Object.entries(counts).map(([k, v]) => `${k}=${v}`).join(' '))
console.log(`  日记 ${diaryCount} 篇`)
