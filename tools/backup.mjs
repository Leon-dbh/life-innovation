#!/usr/bin/env node
/**
 * 每日存档：按日期建一个导出目录，只留最近 14 份。
 *
 * 用法：node tools/backup.mjs --db <memory.sqlite> --data <home> [--keep 14]
 *
 * 计划任务直接跑这个（见 install/install.ps1），不需要人记得。
 */
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

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

const here = path.dirname(fileURLToPath(import.meta.url))
const args = parseArgs(process.argv.slice(2))
if (!args.db) {
  console.error('用法: node tools/backup.mjs --db <memory.sqlite> --data <home> [--keep 14]')
  process.exit(2)
}
const dbPath = path.resolve(String(args.db))
const dataHome = path.resolve(String(args.data || path.dirname(path.dirname(dbPath))))
const keep = Math.max(1, Number(args.keep || 14))
const backupsDir = path.join(dataHome, 'backups')
fs.mkdirSync(backupsDir, { recursive: true })

const stamp = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 19)
const outDir = path.join(backupsDir, `export-${stamp}`)

const result = spawnSync(process.execPath, [
  path.join(here, 'export.mjs'),
  '--db', dbPath,
  '--data', dataHome,
  '--out', outDir,
  '--force',
], { stdio: 'inherit', env: process.env })
if (result.status !== 0) {
  console.error(`存档失败（exit ${result.status}）`)
  process.exit(result.status || 1)
}

// 只留最近 keep 份；按名字排序即可（名字里就是时间）。
const exports = fs.readdirSync(backupsDir)
  .filter((name) => /^export-/.test(name))
  .sort()
for (const name of exports.slice(0, Math.max(0, exports.length - keep))) {
  fs.rmSync(path.join(backupsDir, name), { recursive: true, force: true })
  console.log(`  已清理旧存档 ${name}`)
}
console.log(`存档完成：${outDir}（保留最近 ${keep} 份）`)
