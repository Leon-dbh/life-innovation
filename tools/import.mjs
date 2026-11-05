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
import { snapshotDatabase, removeDbFiles, restoreDatabase } from '../lib/backup.js'

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

// 只读打开一个库，按 manifest 里的表名单点数；表不存在按 0 算（不同版本的导出表不一样）。
function readCounts(file) {
  const db = new DatabaseSync(file, { readOnly: true })
  try {
    db.exec('PRAGMA busy_timeout = 5000')
    const out = {}
    for (const table of Object.keys(manifest.counts || {})) {
      try {
        out[table] = Number(db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n)
      } catch {
        out[table] = 0
      }
    }
    return out
  } finally {
    db.close()
  }
}

/** 点数对不上返回 null；对得上返回 counts。where 只用于报错文案。 */
function verifyCounts(file, where) {
  let counts
  try {
    counts = readCounts(file)
  } catch (err) {
    console.error(`打不开${where}：${err.message}`)
    return null
  }
  const bad = Object.entries(manifest.counts || {}).filter(([table, expected]) => counts[table] !== expected)
  if (bad.length) {
    for (const [table, expected] of bad) {
      console.error(`点数不一致（${where}）：${table} 期望 ${expected}，实际 ${counts[table]}`)
    }
    return null
  }
  return counts
}

fs.mkdirSync(path.dirname(dbPath), { recursive: true })
if (args.merge && !fs.existsSync(dbPath)) {
  // 没有旧库就没有「合并」这回事，按首次导入处理；不能悄悄把 --merge 吞掉。
  console.log('目标记忆库不存在，按首次导入处理（--merge 只在已有记忆时生效）')
}
if (fs.existsSync(dbPath) && args.merge) {
  // 合并前也先验快照：坏包不能碰到现有库。
  if (!verifyCounts(snapshot, '快照')) process.exit(5)
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const bak = dbPath + '.before-merge-' + stamp
  snapshotDatabase(dbPath, bak)
  console.log('已备份现有记忆库：' + bak)
  let report
  try {
    report = mergeDatabase({ targetPath: dbPath, sourcePath: snapshot })
  } catch (err) {
    console.error('合并失败，现有记忆库没有改动：' + (err?.message || err))
    process.exit(6)
  }
  const diaryFrom = path.join(fromDir, 'diary')
  const diaryTo = path.join(dataHome, 'diary')
  let copied = 0
  let kept = 0
  if (fs.existsSync(diaryFrom)) {
    fs.mkdirSync(diaryTo, { recursive: true })
    for (const name of fs.readdirSync(diaryFrom)) {
      // 只认日记文件名（YYYY-MM-DD.md）；README.md 之类不是日记，不能搬过去。
      if (!/^\d{4}-\d{2}-\d{2}\.md$/.test(name)) continue
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
// 覆盖/接入前先在快照上点数：坏包不能碰到现有库。
if (!verifyCounts(snapshot, '快照')) process.exit(5)

const replacing = fs.existsSync(dbPath)
if (replacing && !args.force) {
  console.error(`目标记忆库已存在：${dbPath}\n` +
    '  这可能是她现在的记忆。要换掉就加 --force（会先备份）；想合并进现有记忆库，加 --merge。')
  process.exit(4)
}

// 先备份旧库（保持 .bak-<时间> 的命名），再删主库和 -wal/-shm，最后复制。
let backup = null
if (replacing) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  backup = `${dbPath}.bak-${stamp}`
  // WAL 里的最新事务也要进备份，否则回滚会回到一个更旧的空库。
  snapshotDatabase(dbPath, backup)
  console.log(`已备份现有记忆库：${backup}`)
}
// 先复制到临时文件并校验，确认是完整库之后再动旧库；这样磁盘满/拷贝失败不会先把旧库删掉。
const staged = `${dbPath}.importing-${process.pid}`
try {
  fs.copyFileSync(snapshot, staged)
} catch (err) {
  try { fs.rmSync(staged, { force: true }) } catch { /* ignore */ }
  console.error('复制导入库失败，现有记忆库没有改动：' + (err?.message || err))
  process.exit(6)
}
if (!verifyCounts(staged, '待替换库')) {
  try { fs.rmSync(staged, { force: true }) } catch { /* ignore */ }
  process.exit(5)
}
removeDbFiles(dbPath)
try {
  fs.renameSync(staged, dbPath)
} catch (err) {
  // 旧库已经删了但新库没就位：从导入前快照恢复，不能留下空目录。
  try { fs.rmSync(staged, { force: true }) } catch { /* ignore */ }
  if (backup) restoreDatabase(dbPath, backup)
  console.error('替换记忆库失败' + (backup ? `，已恢复 ${backup}` : '') + '：' + (err?.message || err))
  process.exit(6)
}

// 替换完再点一次；失败就回滚到导入前的备份，绝不留下半套库。
const counts = verifyCounts(dbPath, '导入后')
if (!counts) {
  removeDbFiles(dbPath)
  if (backup) {
    restoreDatabase(dbPath, backup)
    console.error(`导入后校验失败，已恢复导入前的备份：${backup}`)
  } else {
    console.error('导入后校验失败，已删除未完成的库')
  }
  process.exit(6)
}

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

console.log(`已接入 ${dbPath}`)
console.log(`  来源 ${manifest.exportedAt}（${manifest.exportedBy}）`)
console.log(`  ` + Object.entries(counts).map(([k, v]) => `${k}=${v}`).join(' '))
console.log(`  日记：导入 ${imported} 篇，跳过已有 ${skipped} 篇`)
