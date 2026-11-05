#!/usr/bin/env node
/**
 * 回收站：列出被移出的原话，或把其中一条放回去。
 *
 * 记忆生命周期里有三条路会「移走」东西：超过 90 天归档（还能读、还能召回）、
 * 超过归档期删除（进回收站）、她/人类主动忘掉（进回收站）。前两条已有工具，
 * 这条补上“放回去”——原来只有「移进回收站」的单向通道，误删就没救了。
 *
 * 用法：
 *   node tools/restore.mjs --list
 *   node tools/restore.mjs --id 3
 *   node tools/restore.mjs --db D:/jingjing-home/state/jingjing.sqlite --list
 */
import fs from 'node:fs'
import { MemoryStore } from '../lib/store.js'

function parseArgs(argv) {
  const out = { db: process.env.JINGJING_DB || 'D:/jingjing-home/state/jingjing.sqlite', list: false, id: null, json: false }
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i]
    if (a === '--db') out.db = argv[++i]
    else if (a === '--list') out.list = true
    else if (a === '--id') out.id = Number(argv[++i])
    else if (a === '--json') out.json = true
    else if (a === '-h' || a === '--help') out.help = true
    else throw new Error(`不认识的参数：${a}`)
  }
  return out
}

function main() {
  const args = parseArgs(process.argv.slice(2))
  if (args.help) {
    console.log('用法：node tools/restore.mjs [--db 路径] --list | --id N [--json]')
    return 0
  }
  if (!fs.existsSync(args.db)) {
    console.error(`没有这个库：${args.db}`)
    return 2
  }
  const store = new MemoryStore(args.db)
  try {
    if (args.list) {
      const rows = store.recycleRows(50)
      if (args.json) console.log(JSON.stringify(rows, null, 2))
      else if (!rows.length) console.log('回收站是空的。')
      else {
        console.log(`回收站里有 ${rows.length} 条（最多显示 50 条）：`)
        for (const r of rows) console.log(`#${r.id}  ${r.ref}  ${new Date(r.movedAt).toLocaleString('zh-CN')}`)
      }
      return 0
    }
    if (!args.id) {
      console.error('要么 --list，要么 --id N。')
      return 2
    }
    const result = store.recycleRestore(args.id)
    if (!result) {
      console.error(`回收站里没有 #${args.id}。`)
      return 1
    }
    if (result.moved) console.log(`已放回，但原来的 id 被占用了，新 ref 是 ${result.ref}。`)
    else console.log(`已放回：${result.ref}`)
    return 0
  } finally {
    store.close()
  }
}

process.exitCode = main()
