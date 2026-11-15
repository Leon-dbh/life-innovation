#!/usr/bin/env node
/**
 * 把她接回家之前，先看看缺什么。
 *
 * 只读：不建库、不写配置、不装依赖。所有检查都能指出下一步。
 *
 *   node tools/doctor.mjs
 *   node tools/doctor.mjs --home D:\life-innovation-home --json
 */
import fs from 'node:fs'
import net from 'node:net'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { resolvePaths } from '../lib/paths.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')

// 逐段比较版本号，避免把 22.9 当成 >= 22.13。
function atLeast(version, minimum) {
  const a = String(version).replace(/^v/, '').split('.').map((n) => Number(n) || 0)
  const b = String(minimum).split('.').map((n) => Number(n) || 0)
  for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
    const x = a[i] || 0
    const y = b[i] || 0
    if (x !== y) return x > y
  }
  return true
}

function canWrite(dir) {
  try {
    const probe = path.join(dir, `.doctor-${process.pid}.tmp`)
    fs.writeFileSync(probe, 'ok')
    fs.unlinkSync(probe)
    return true
  } catch {
    return false
  }
}

function portOpen(port, host = '127.0.0.1', timeout = 450) {
  return new Promise((resolve) => {
    const socket = net.connect({ port, host })
    const done = (ok) => {
      socket.destroy()
      resolve(ok)
    }
    socket.setTimeout(timeout)
    socket.once('connect', () => done(true))
    socket.once('timeout', () => done(false))
    socket.once('error', () => done(false))
  })
}

async function inspectDb(file) {
  if (!fs.existsSync(file)) return { state: 'missing', tables: {}, raw: 0 }
  let db
  try {
    // 动态 import：Node 22.0–22.12 没有默认可用的 node:sqlite。
    // 放在这里而不是模块顶层，版本太旧时 doctor 仍能先给出人话提示。
    let DatabaseSync
    try {
      ({ DatabaseSync } = await import('node:sqlite'))
    } catch (error) {
      return { state: 'unsupported', error: error?.message || String(error), tables: {}, raw: 0 }
    }
    db = new DatabaseSync(file, { readOnly: true })
    const tables = {}
    for (const name of ['raw_turns', 'raw_archive', 'summaries', 'assertions', 'profiles', 'actions', 'life_blocks', 'dreams', 'books', 'self_snapshots', 'memory_audit']) {
      try {
        tables[name] = Number(db.prepare(`SELECT COUNT(*) AS n FROM ${name}`).get()?.n || 0)
      } catch {
        tables[name] = null
      }
    }
    // SQLite 能打开文件不代表它是我们的库：损坏/别的格式会打开成功但所有表都查不到。
    if (Object.values(tables).every((n) => n === null)) {
      return { state: 'unreadable', error: '数据库里没有任何可读的表', tables, raw: 0 }
    }
    return { state: 'ok', tables, raw: tables.raw_turns || 0 }
  } catch (error) {
    return { state: 'unreadable', error: error?.message || String(error), tables: {}, raw: 0 }
  } finally {
    try { db?.close() } catch { /* 已关闭 */ }
  }
}

function pluginProfiles(dshHome) {
  const base = path.join(dshHome, 'profiles')
  let entries = []
  try {
    if (!fs.existsSync(base)) return []
    entries = fs.readdirSync(base)
  } catch {
    return []
  }
  const found = []
  for (const name of entries) {
    const pkgPath = path.join(base, name, 'package.json')
    try {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'))
      const spec = pkg.dependencies?.['life-innovation'] || pkg.devDependencies?.['life-innovation']
      if (spec) found.push({ name, spec })
    } catch { /* 不是可读 profile */ }
  }
  return found
}

/**
 * @param {{home?:string, dbPath?:string, checkPorts?:boolean, env?:object, now?:number}} [options]
 */
export async function runDoctor(options = {}) {
  const env = options.env || process.env
  const paths = resolvePaths({ home: options.home, dbPath: options.dbPath }, env)
  const checks = []
  const add = (level, title, detail, next = '') => checks.push({ level, title, detail, next })

  const nodeOk = atLeast(process.versions.node, '22.13')
  add(nodeOk ? 'ok' : 'fail', 'Node.js', `当前 ${process.versions.node}；需要 >=22.13（node:sqlite 默认开启）`, nodeOk ? '' : '安装 Node.js 22.13+ 或 24，再重跑。')

  let sqliteError = ''
  try {
    await import('node:sqlite')
  } catch (error) {
    sqliteError = error?.message || String(error)
  }
  add(sqliteError ? 'fail' : 'ok', 'node:sqlite', sqliteError || '可用', sqliteError ? '当前 Node 版本没有默认可用的 node:sqlite；升级到 22.13+ 或 24。' : '')

  add(fs.existsSync(paths.home) ? 'ok' : 'warn', '家目录', paths.home, fs.existsSync(paths.home) ? '' : '先跑一次安装器；或把 LIFE_INNOVATION_HOME 指到已有数据目录。')

  let writable = false
  try {
    if (fs.existsSync(paths.home)) writable = canWrite(paths.home)
  } catch { /* 没权限 */ }
  add(writable ? 'ok' : 'warn', '可写', writable ? '家目录可写' : '家目录不存在或不可写', writable ? '' : '检查目录权限；安装器需要写 state/、diary/、notes/、books/。')

  const db = await inspectDb(paths.dbPath)
  if (db.state === 'ok') {
    const missing = Object.entries(db.tables).filter(([, n]) => n === null).map(([name]) => name)
    add(missing.length === 0 ? 'ok' : 'warn', '数据库', `${paths.dbPath}；原话 ${db.raw} 条${missing.length ? `；缺表 ${missing.join(', ')}` : ''}`, missing.length ? '先在 DSH 里启动一次插件，让迁移补表；旧库会保留原数据。' : '')
  } else if (db.state === 'missing') {
    add('warn', '数据库', `${paths.dbPath} 还不存在`, '这是新家：启动 DSH、让插件跑一次，库会自动建出来。')
  } else if (db.state === 'unsupported') {
    add('fail', '数据库', `当前 Node 不能用 node:sqlite：${db.error}`, '升级 Node.js 到 22.13+ 或 24，再重跑 doctor。')
  } else {
    add('fail', '数据库', `${paths.dbPath} 打不开：${db.error}`, '确认文件没被占用、路径没写错；先备份再动它。')
  }

  const pkgPath = path.join(ROOT, 'package.json')
  try {
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'))
    add('ok', '插件', `${pkg.name}@${pkg.version}`, '')
  } catch (error) {
    add('warn', '插件', `读不到 ${pkgPath}：${error.message}`, '确认安装目录完整；重跑 npm install 或重新解包。')
  }

  const dshHome = env.DSH_HOME || path.join(process.env.USERPROFILE || process.env.HOME || '', '.dsh')
  add(dshHome && fs.existsSync(dshHome) ? 'ok' : 'warn', 'DSH_HOME', dshHome || '未设置', dshHome && fs.existsSync(dshHome) ? '' : '如果 DSH 装在别处，把 DSH_HOME 指过去，doctor 才能检查 profile。')
  if (dshHome && fs.existsSync(dshHome)) {
    const linked = pluginProfiles(dshHome)
    add(linked.length ? 'ok' : 'warn', '插件挂载', linked.length ? linked.map((p) => `${p.name}: ${p.spec}`).join('；') : '没有 profile 挂载 life-innovation', linked.length ? '' : '重跑安装器，或手动执行 dsh plugin --profile <name> add <插件目录>。')
  }

  if (options.checkPorts !== false) {
    const ports = [60080, 60081, 8789]
    const opened = await Promise.all(ports.map((port) => portOpen(port)))
    add(opened.some(Boolean) ? 'ok' : 'warn', '服务端口', ports.map((port, i) => `${port}:${opened[i] ? '开' : '关'}`).join(' '), opened.some(Boolean) ? '' : '固定入口/桥接没起时，先跑 service.ps1；只聊天不打开家页面也可以先不管。')
  }

  const fails = checks.filter((c) => c.level === 'fail').length
  const warns = checks.filter((c) => c.level === 'warn').length
  return {
    ok: fails === 0,
    problems: fails,
    warnings: warns,
    home: paths.home,
    dbPath: paths.dbPath,
    checks,
    next: fails ? '先修 fail；warn 可以按需处理。' : warns ? '能跑；warn 项按提示补齐会更稳。' : '都好；打开 /home 看她今天。',
  }
}

function print(result) {
  const mark = { ok: 'OK  ', warn: 'WARN', fail: 'FAIL' }
  console.log(`life-innovation doctor`)
  console.log(`家：${result.home}`)
  console.log(`库：${result.dbPath}`)
  for (const c of result.checks) {
    console.log(`${mark[c.level]} ${c.title}：${c.detail}`)
    if (c.next) console.log(`     → ${c.next}`)
  }
  console.log(`\n${result.next}`)
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2)
  const get = (name) => {
    const i = args.indexOf(name)
    return i >= 0 ? args[i + 1] : ''
  }
  const result = await runDoctor({
    home: get('--home') || '',
    dbPath: get('--db') || '',
    checkPorts: !args.includes('--no-ports'),
  })
  if (args.includes('--json')) console.log(JSON.stringify(result, null, 2))
  else print(result)
  process.exit(result.ok ? 0 : 1)
}
