/**
 * 换机器：导出 → 导入 → 点数一致；已有库不许覆盖；每日存档只留 N 份。
 * 跑法：node tests/portability.test.mjs
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { MemoryStore } from '../lib/store.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const tools = path.join(here, '..', 'tools')
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jingjing-port-'))

function run(script, args) {
  const r = spawnSync(process.execPath, [path.join(tools, script), ...args], { encoding: 'utf8' })
  return r
}

function seedHome(home) {
  fs.mkdirSync(path.join(home, 'state'), { recursive: true })
  fs.mkdirSync(path.join(home, 'diary'), { recursive: true })
  const store = new MemoryStore(path.join(home, 'state', 'jingjing.sqlite'))
  const now = Date.now()
  store.addRaw(now - 3000, 's1', 'user', '我叫林晚，住在杭州。')
  store.addRaw(now - 2000, 's1', 'assistant', '记住了，林晚。')
  store.addAssertion({ ts: now - 2500, subject: '他', predicate: '名字', value: '林晚', source: 'raw:1' })
  store.addAction({ ts: now - 1500, sessionId: 's1', kind: 'tool', tool: 'write_diary', summary: '把今天记成日记（1 件事）', callId: 'diary:test', status: 'ok' })
  const day = new Date(now).toISOString().slice(0, 10)
  store.replaceLifeBlocks(day, [{ activity: '和他说说话', startedAt: now - 3000, endedAt: now - 2000, evidence: ['raw:1', 'raw:2'] }], now)
  store.close()
  fs.writeFileSync(path.join(home, 'diary', '2026-11-05.md'), '# 2026-11-05\n\n- 和他说说话（证据：raw:1–2）\n', 'utf8')
  return { now, day }
}

// 1) 导出
const home = path.join(root, 'home-a')
const { now, day } = seedHome(home)
const outDir = path.join(root, 'export')
let r = run('export.mjs', ['--db', path.join(home, 'state', 'jingjing.sqlite'), '--data', home, '--out', outDir])
assert.equal(r.status, 0, r.stderr)
const manifest = JSON.parse(fs.readFileSync(path.join(outDir, 'manifest.json'), 'utf8'))
assert.equal(manifest.format, 'life-innovation-export/1')
assert.equal(manifest.dbFile, 'life-innovation.sqlite')
assert.equal(manifest.counts.raw_turns, 2)
assert.equal(manifest.counts.assertions, 1)
assert.equal(manifest.counts.actions, 1)
assert.equal(manifest.counts.life_blocks, 1)
assert.equal(manifest.diaryCount, 1)
assert.ok(fs.existsSync(path.join(outDir, 'diary', '2026-11-05.md')), '日记应随导出')

// 2) 导入到新家
const home2 = path.join(root, 'home-b')
fs.mkdirSync(home2, { recursive: true })
r = run('import.mjs', ['--from', outDir, '--db', path.join(home2, 'state', 'jingjing.sqlite'), '--data', home2])
assert.equal(r.status, 0, r.stderr)
const store2 = new MemoryStore(path.join(home2, 'state', 'jingjing.sqlite'))
assert.equal(store2.recentRaw(10).length, 2)
assert.equal(store2.liveAssertions('他').find((a) => a.predicate === '名字')?.value, '林晚')
assert.equal(store2.recentActions(5).length, 1)
assert.equal(store2.lifeForDate(day).length, 1)
assert.equal(store2.lifeForDate(day)[0].activity, '和他说说话')
store2.close()
assert.ok(fs.existsSync(path.join(home2, 'diary', '2026-11-05.md')), '日记应被导入')

// 3) 已有库默认不许覆盖
r = run('import.mjs', ['--from', outDir, '--db', path.join(home2, 'state', 'jingjing.sqlite'), '--data', home2])
assert.equal(r.status, 4, '目标库已存在时应拒绝')
assert.match(r.stderr, /--force/)

// 4) --force 会先备份
r = run('import.mjs', ['--from', outDir, '--db', path.join(home2, 'state', 'jingjing.sqlite'), '--data', home2, '--force'])
assert.equal(r.status, 0, r.stderr)
const backups = fs.readdirSync(path.join(home2, 'state')).filter((n) => n.includes('.bak-'))
assert.equal(backups.length, 1, '应留下一个备份')

// 5) 每日存档只保留最近 2 份（名字带秒，等一秒避免撞名）
for (let i = 0; i < 3; i += 1) {
  r = run('backup.mjs', ['--db', path.join(home, 'state', 'jingjing.sqlite'), '--data', home, '--keep', '2'])
  assert.equal(r.status, 0, r.stderr)
  await new Promise((resolve) => setTimeout(resolve, 1100))
}
const kept = fs.readdirSync(path.join(home, 'backups')).filter((n) => n.startsWith('export-'))
assert.equal(kept.length, 2, `应保留 2 份，实际 ${kept.length}`)

// 6) 点数不一样时导入要报错，不装成功
const tampered = path.join(root, 'tampered')
fs.cpSync(outDir, tampered, { recursive: true })
const m = JSON.parse(fs.readFileSync(path.join(tampered, 'manifest.json'), 'utf8'))
m.counts.raw_turns = 99
fs.writeFileSync(path.join(tampered, 'manifest.json'), JSON.stringify(m), 'utf8')
const home3 = path.join(root, 'home-c')
r = run('import.mjs', ['--from', tampered, '--db', path.join(home3, 'state', 'jingjing.sqlite'), '--data', home3])
assert.equal(r.status, 5, '点数不一致应失败')
assert.match(r.stderr, /点数不一致/)

fs.rmSync(root, { recursive: true, force: true })
console.log('OK: export / import / refuse-overwrite / force-backup / backup-rotate / count-mismatch')
