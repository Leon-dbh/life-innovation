/**
 * 复审 0.2.4（review-life-innovation-61437b8.md）的回归：
 * P2-1 旧家回退、P2-2 patch 同步、P2-3 旧任务清理、P3 的安装/工具/补录边界。
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { databaseUsable, defaultHome, resolvePaths } from '../lib/paths.js'
import { MemoryStore } from '../lib/store.js'
import { toolActivity } from '../lib/life.js'
import { extractAssertions } from '../lib/extract.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '..')
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8')

// P2-1：0.1.x 旧默认家不能被新默认值直接盖掉。
assert.equal(defaultHome((p) => p.endsWith('jingjing-home/state/jingjing.sqlite')), 'D:/jingjing-home')
assert.equal(defaultHome(() => false), 'D:/life-innovation-home')
assert.equal(resolvePaths({}, {}, { exists: () => false, usable: () => false }).home, 'D:/life-innovation-home')
assert.equal(resolvePaths({ home: 'E:/explicit' }, {}).home, 'E:/explicit')
// 空的新库不算「已有实例」；有真实原话的旧库才算。
const probeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'life-review4-db-'))
const emptyDb = path.join(probeDir, 'empty.sqlite')
const fullDb = path.join(probeDir, 'full.sqlite')
new MemoryStore(emptyDb).close()
const fullStore = new MemoryStore(fullDb)
fullStore.addRaw(Date.now(), 'test', 'user', '我住在杭州。')
fullStore.close()
assert.equal(databaseUsable(emptyDb), false)
assert.equal(databaseUsable(fullDb), true)
fs.rmSync(probeDir, { recursive: true, force: true })

// P2-2：已有 patch 里显式 dbPath/agentName 必须一起更新，不能只改 home。
const install = read('install/install.ps1')
assert.match(install, /\[switch\]\$ForceNewInstance/, '升级要能显式新建空实例')
assert.match(install, /function Quote-Yaml/, 'YAML 值必须统一加引号')
assert.match(install, /function Set-MemoryOverride\(\[string\]\$text,[^)]*\[string\]\$dbPath,[^)]*\[string\]\$agentName/)
assert.match(install, /-dbPath \$DbPath -agentName \$AgentName/, '迁移 patch 时要把 dbPath/agentName 一起传进去')
assert.match(install, /\$DataYaml = Quote-Yaml \$DataFwd/)
assert.match(install, /\$DbYaml = Quote-Yaml \$DbPath/)
assert.match(install, /\$AgentNameYaml = Quote-Yaml \$AgentName/)
assert.ok(install.includes("$LegacyDataHome = 'D:\\jingjing-home'"), '安装器要认旧家')
assert.ok(install.includes("$LegacyDefaultDb = Join-Path $LegacyDataHome 'state\\jingjing.sqlite'"))

// P2-3：新任务/新自启项建好后，清掉 0.1.x 的旧项。
const taskAt = install.indexOf('/TN "LifeInnovationDailyBackup"')
const oldTaskAt = install.lastIndexOf('Remove-LegacyBackupTask')
const runAt = install.indexOf("-Name 'LifeInnovationService'")
const oldRunAt = install.lastIndexOf('Remove-LegacyRunValue')
assert.ok(taskAt >= 0 && oldTaskAt > taskAt, '旧备份任务应在注册新任务之后清理')
assert.ok(runAt >= 0 && oldRunAt > runAt, '旧自启项应在写新 Run 值之后清理')

// P3-1：service 占位符里的单引号必须转义后再替换。
assert.match(install, /\$agentPs = \$AgentName\.Replace\("'", "''"\)/)
assert.match(install, /\$dbPs = \$DbPath\.Replace\("'", "''"\)/)
assert.match(install, /Replace\('@AGENT_NAME@', \$agentPs\)/)
assert.match(install, /Replace\('@DB_PATH@', \$dbPs\)/)
assert.match(read('install/service.ps1'), /\$AgentName\s+= '@AGENT_NAME@'/)
assert.match(read('install/service.ps1'), /\$DbPath\s+= '@DB_PATH@'/)
assert.match(install, /function Test-DatabaseHasRows/)
assert.match(install, /function Stop-OldService/)
assert.match(install, /Stop-OldService\s*\r?\n/)

// P3-2：补录要把原话时间和 dueAt 带上。
const backfill = read('tools/backfill.mjs')
assert.match(backfill, /extractAssertions\(row\.text, row\.ts\)/)
assert.match(backfill, /dueAt: item\.dueAt \?\? null/)
const due = extractAssertions('我明天要去医院复查。', new Date(2026, 10, 6, 10, 0, 0).getTime())
assert.ok(due.some((item) => item.dueAt && item.dueAt > new Date(2026, 10, 6, 10, 0, 0).getTime()))

// P3-3/4/5：梦判据走结构化 meta，不再看 summary 里有没有「梦」。
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'life-review4-'))
const store = new MemoryStore(path.join(dir, 't.sqlite'))
const now = Date.now()
store.addAction({ ts: now, sessionId: 's1', kind: 'life', tool: 'note_write', summary: '把梦记成便签', callId: 'a1', status: 'ok', meta: { dreamDate: '2026-11-05' } })
store.addAction({ ts: now + 1, sessionId: 's1', kind: 'life', tool: 'note_write', summary: '梦见一把伞，随手写下来', callId: 'a2', status: 'ok' })
const recent = store.recentActions(2)
assert.deepEqual(recent[0].meta, { dreamDate: '2026-11-05' }, 'action meta 要能读回')
assert.equal(recent[1].meta, null)
assert.equal(toolActivity('note_write', recent[0].summary, recent[0].meta), '把梦记了下来')
assert.equal(toolActivity('note_write', recent[1].summary, recent[1].meta), '写了张便签')

// P3-8：家页面不再保留未使用的日记预览死代码。
const home = read('install/home.mjs')
assert.ok(!home.includes('homeDiaryDir'), '死代码应已删除')
assert.ok(!home.includes('readDiaryPeek'), '死代码应已删除')
assert.match(home, /if \(!data \|\| data\.missing\) return ''/, '缺某一天时不能整页抛')

console.log('OK: review4（旧家回退 / patch 同步 / 旧任务清理 / 单引号 / dueAt / 梦 meta / 家页面边界）')
