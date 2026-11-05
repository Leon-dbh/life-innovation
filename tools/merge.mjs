#!/usr/bin/env node
/**
 * 把另一台机器的记忆合并到现有记忆库（不覆盖）。
 *
 * 用法：
 *   node tools/merge.mjs --target D:/jingjing-home/state/jingjing.sqlite \
 *                        --source D:/backup/export-.../jingjing.sqlite \
 *                        [--data D:/jingjing-home] [--no-backup]
 *
 * 合并前默认把目标库备份成 <target>.before-merge-<时间>；合并只增不删。
 */
import fs from 'node:fs'
import path from 'node:path'
import { mergeDatabase } from '../lib/merge.js'

/** 是否同一个文件：两边都先解析成绝对路径（存在时再解真实路径），再统一小写比较。 */
function sameFile(a, b) {
  const norm = (p) => {
    let out = path.resolve(String(p))
    try { out = fs.realpathSync.native(out) } catch { /* 文件不存在就按绝对路径比 */ }
    return out.replace(/[\\/]+$/, '').toLowerCase()
  }
  return norm(a) === norm(b)
}

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
if (!args.target || !args.source) {
  console.error('用法: node tools/merge.mjs --target <现有库> --source <另一份库> [--data <home>] [--no-backup]')
  process.exit(2)
}
// --data 不带值时 parseArgs 会记成 true，path.resolve 之后就成了一个叫 "true" 的目录。
if (args.data === true) {
  console.error('--data 需要跟一个目录，例如 --data D:/jingjing-home')
  process.exit(2)
}
const target = path.resolve(String(args.target))
const source = path.resolve(String(args.source))
if (!fs.existsSync(target)) {
  console.error(`目标库不存在：${target}\n  先导入（import.mjs）再合并。`)
  process.exit(3)
}
if (!fs.existsSync(source)) {
  console.error(`来源库不存在：${source}`)
  process.exit(3)
}
if (sameFile(target, source)) {
  console.error('目标库和来源库是同一个文件')
  process.exit(4)
}

if (!args['no-backup']) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const bak = `${target}.before-merge-${stamp}`
  fs.copyFileSync(target, bak)
  console.log(`已备份目标库：${bak}`)
}

const report = mergeDatabase({ targetPath: target, sourcePath: source })

// 日记：只补目标里没有的日期，绝不覆盖已有的。
if (args.data) {
  const diaryTo = path.join(path.resolve(String(args.data)), 'diary')
  const diaryFrom = path.join(path.dirname(source), 'diary')
  let copied = 0
  if (fs.existsSync(diaryFrom)) {
    fs.mkdirSync(diaryTo, { recursive: true })
    for (const name of fs.readdirSync(diaryFrom)) {
      if (!/^\d{4}-\d{2}-\d{2}\.md$/.test(name)) continue
      const dest = path.join(diaryTo, name)
      if (fs.existsSync(dest)) continue
      fs.copyFileSync(path.join(diaryFrom, name), dest)
      copied += 1
    }
  }
  report.diary = { copied }
}

console.log('合并完成（只增不删）：')
for (const [table, stat] of Object.entries(report)) {
  console.log(`  ${table}: ${typeof stat === 'object' ? JSON.stringify(stat) : stat}`)
}
