import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'
import { MemoryStore } from '../lib/store.js'
import { mergeDatabase } from '../lib/merge.js'
import { createHands } from '../lib/hands.js'
import { renderHome, homeFilePath } from '../install/home.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const pkg = path.resolve(here, '..')
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'jingjing-review3-'))

function fresh(name) {
  const home = path.join(tmp, name)
  fs.mkdirSync(home, { recursive: true })
  const dbPath = homeFilePath(home)
  fs.mkdirSync(path.dirname(dbPath), { recursive: true })
  const store = new MemoryStore(dbPath)
  return { home, dbPath, store }
}

// 1. 安装器/服务/客户端只认一个 DB 路径，且家页面走 DSH 同源路由
{
  const svc = fs.readFileSync(path.join(pkg, 'install', 'service.ps1'), 'utf8')
  const ins = fs.readFileSync(path.join(pkg, 'install', 'install.ps1'), 'utf8')
  const client = fs.readFileSync(path.join(pkg, 'client.js'), 'utf8')
  assert.match(svc, /\$DbPath\s+=\s+'@DB_PATH@'/, 'service 必须有 DB 占位符')
  assert.match(svc, /LIFE_INNOVATION_DB = \$DbPath/, 'service 必须把同一个 DB 传给 dsh')
  assert.doesNotMatch(svc, /Join-Path \$DataHome 'state\\jingjing\.sqlite'/, 'service 不能自己猜旧库')
  assert.match(ins, /Replace\('@DB_PATH@', \$dbPs\)/, 'install 必须替换 DB 占位符')
  assert.match(ins, /\$nodePs = \$nodePath\.Replace\("'", "''"\)/, 'backup.ps1 必须转义单引号')
  assert.match(client, /HOME_URL = '\/life-innovation\/home'/, '客户端必须走同源路径，不猜 60080')
  const idx = fs.readFileSync(path.join(pkg, 'index.js'), 'utf8')
  assert.match(idx, /path: '\/life-innovation\/home'/, '插件必须注册同源家页面路由')
}

// 2. 梦只展示今天，不把很久以前的梦当成今天
{
  const { home, dbPath, store } = fresh('dream')
  const now = Date.parse('2026-11-05T23:20:00+08:00')
  const today = new Intl.DateTimeFormat('en-CA', {
    year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date(now))
  store.addDream({ date: '2026-01-01', ts: now - 300 * 86400000, text: '很久以前的梦', evidence: [] })
  store.addDream({ date: today, ts: now, text: '今天的梦', evidence: [] })
  store.close()
  const html = renderHome({ home, dbPath, now })
  assert.match(html, /今天的梦/)
  assert.doesNotMatch(html, /很久以前的梦/)
}

// 3. merge 要把回收站也搬过去
{
  const src = fresh('merge-src')
  src.store.addRaw(1000, 's1', 'user', '要被回收的一句')
  const rawId = src.store.recentRaw(1)[0].id
  src.store.recycleRaw(rawId)
  assert.equal(src.store.recycleCount(), 1)
  src.store.close()

  const dst = fresh('merge-dst')
  dst.store.close()
  const report = mergeDatabase({ targetPath: dst.dbPath, sourcePath: src.dbPath, now: Date.now() })
  assert.equal(report.recycle.added, 1)
  const db = new DatabaseSync(dst.dbPath, { readOnly: true })
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM recycle').get().n, 1)
  db.close()
}

// 4. 合并进来的书路径坏了，按 basename 在家里找到并修正
{
  const { home, dbPath, store } = fresh('book')
  fs.mkdirSync(path.join(home, 'books'), { recursive: true })
  const local = path.join(home, 'books', 'pg289.txt')
  fs.writeFileSync(local, '第一章\n\n' + 'x'.repeat(500), 'utf8')
  store.addBook({ title: '柳林风声', url: 'https://www.gutenberg.org/cache/epub/289/pg289.txt', path: 'Z:/old-machine/books/pg289.txt', total: 999 })
  const hands = createHands({
    home,
    store,
    config: {},
    fetchImpl: () => { throw new Error('不该联网') },
  })
  const row = await hands.ensureBook()
  assert.equal(row.path, local)
  assert.equal(store.bookByUrl(row.url).path, local, '修正后的路径要落库')
  store.close()
}

// 5. 入口端口非法时回退 60080（从源码约束，启动测试会占端口）
{
  const entry = fs.readFileSync(path.join(pkg, 'install', 'entry.mjs'), 'utf8')
  assert.match(entry, /rawPort >= 1 && rawPort <= 65535/)
  assert.match(entry, /改用 \$\{port\}/)
}

fs.rmSync(tmp, { recursive: true, force: true })
console.log('OK: review3（DB 单源 / 同源家页面 / 今日梦 / 回收站合并 / 书路径修复 / 端口校验）')
