/**
 * 合并测试：两份库各有各的自增 id，合起来不能把「证据」指错人。
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { MemoryStore } from '../lib/store.js'
import { Outbox } from '../lib/outbox.js'
import { mergeDatabase } from '../lib/merge.js'

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jingjing-merge-'))
const targetPath = path.join(dir, 'target.sqlite')
const sourcePath = path.join(dir, 'source.sqlite')

const t = new MemoryStore(targetPath)
const s = new MemoryStore(sourcePath)

// 目标库：一份已有的日子。
const tRaw1 = t.addRaw(1000, 's-target', 'user', '我叫林晚，住在杭州')
t.addAssertion({ ts: 1000, subject: '他', predicate: '名字', value: '林晚', source: `raw:${tRaw1}` })
t.addAssertion({ ts: 1000, subject: '他', predicate: '住在', value: '杭州', source: `raw:${tRaw1}` })
t.addAction({ ts: 1100, sessionId: 's-target', kind: 'tool', tool: 'memory_find', summary: '翻了一下记忆', callId: 'call-t1', status: 'ok' })
t.setProfile('他', '名字', '林晚', 'raw:1', 1200)
t.setProfile('他', '住在', '杭州', 'raw:1', 1200)
t.touchRelation('他', 1200)
t.replaceLifeBlocks('2026-11-05', [
  { activity: '和他说说话', startedAt: 1000, endedAt: 1000, evidence: [`raw:${tRaw1}`] },
], 1300)
const tBox = new Outbox(t.db)
tBox.create({ channel: 'test', target: 'p1', text: '在吗', now: 1400 })
t.close()

// 来源库：有一模一样的原话（应当只留一份）、也有一模一样的 call_id。
const sRaw1 = s.addRaw(1000, 's-source', 'user', '我叫林晚，住在杭州')
const sRaw2 = s.addRaw(2000, 's-source', 'user', '我在字节上班，养了一只猫叫团子')
s.addAssertion({ ts: 2000, subject: '他', predicate: '工作', value: '字节', source: `raw:${sRaw2}` })
s.addAssertion({ ts: 2100, subject: '他', predicate: '住在', value: '上海', source: `raw:${sRaw2}` })
s.addAction({ ts: 1100, sessionId: 's-source', kind: 'tool', tool: 'memory_find', summary: '翻了一下记忆', callId: 'call-t1', status: 'ok' })
s.addAction({ ts: 2200, sessionId: 's-source', kind: 'file', tool: 'write_diary', summary: '把今天记成日记', callId: 'call-s1', status: 'ok' })
s.setProfile('他', '工作', '字节', `raw:${sRaw2}`, 2200)
s.setProfile('他', '名字', '林晚', `raw:${sRaw1}`, 900)
s.touchRelation('他', 2500)
s.replaceLifeBlocks('2026-11-05', [
  { activity: '写日记', startedAt: 2200, endedAt: 2200, evidence: ['act:2'] },
], 2300)
const sBox = new Outbox(s.db)
sBox.create({ channel: 'test', target: 'p1', text: '在吗', now: 1400 })
sBox.create({ channel: 'test', target: 'p1', text: '另一条', now: 1600 })
s.close()

const report = mergeDatabase({ targetPath, sourcePath })

// 1) 原话：重复的跳过，新原话进来。
assert.equal(report.raw_turns.added, 1)
assert.equal(report.raw_turns.skipped, 1)

// 2) 动作：call_id 相同的跳过，不同 id 的进来。
assert.equal(report.actions.added, 1)
assert.equal(report.actions.skipped, 1)

// 3) 断言：工作进来，住在上海作为历史留下并指向杭州那条。
assert.equal(report.assertions.added, 2)
assert.equal(report.assertions.demoted, 1)

const m = new MemoryStore(targetPath)
const live = m.liveAssertions()
assert.equal(live.length, 3)
assert.equal(live.find((a) => a.predicate === '工作').value, '字节')
assert.equal(live.find((a) => a.predicate === '住在').value, '杭州')

const shanghai = m.db.prepare("SELECT * FROM assertions WHERE predicate = '住在' AND value = '上海'").get()
assert.ok(shanghai.valid_to, '上海那条应当被标成历史')
const hangzhou = m.db.prepare("SELECT * FROM assertions WHERE predicate = '住在' AND value = '杭州' AND valid_to IS NULL").get()
assert.equal(Number(shanghai.superseded_by), Number(hangzhou.id), '历史应当指向当前有效的那条')

// 4) 合并进来的断言，source 必须指向合并后的真实原话。
const workRow = m.db.prepare("SELECT * FROM assertions WHERE predicate = '工作' AND valid_to IS NULL").get()
assert.match(String(workRow.source), /^raw:\d+$/)
assert.ok(m.rawById(Number(String(workRow.source).split(':')[1])), 'source 指向的原话必须存在')

// 5) 画像：新的赢，旧的保留目标值。
const profiles = m.profiles()
assert.equal(profiles.find((p) => p.key === '工作').value, '字节')
assert.equal(profiles.find((p) => p.key === '名字').value, '林晚')

// 6) 关系：last_seen 取更晚的。
assert.equal(m.relation().lastSeen, 2500)

// 7) 日子块：证据从来源库的 act:2 改到合并后的动作 id。
const blocks = m.lifeForDate('2026-11-05')
assert.equal(blocks.length, 2)
const diaryBlock = blocks.find((b) => b.activity === '写日记')
assert.equal(diaryBlock.evidence.length, 1)
const actionId = Number(diaryBlock.evidence[0].split(':')[1])
assert.ok(m.actionById(actionId), '证据指向的动作必须存在')
assert.equal(m.actionById(actionId).tool, 'write_diary')

// 8) 外发账本：同一条不重复，不同的一条进来。
assert.equal(report.outbox.added, 1)
assert.equal(report.outbox.skipped, 1)
const outCount = Number(m.db.prepare('SELECT COUNT(*) AS n FROM outbox').get().n)
assert.equal(outCount, 2)

m.close()

// 9) 再合并一次：只增不删的语义下应当什么都不加。
const again = mergeDatabase({ targetPath, sourcePath })
assert.equal(again.raw_turns.added, 0)
assert.equal(again.actions.added, 0)
assert.equal(again.assertions.added, 0)
assert.equal(again.life_blocks.added, 0)
assert.equal(again.outbox.added, 0)

// 10) 不允许把库合并到自己。
assert.throws(() => mergeDatabase({ targetPath, sourcePath: targetPath }), /同一个文件/)

fs.rmSync(dir, { recursive: true, force: true })
console.log('OK: merge（去重 / id 重映射 / 冲突保留历史 / 幂等 / 拒绝自我合并）')
