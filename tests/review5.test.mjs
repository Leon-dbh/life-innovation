import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { MemoryStore } from '../lib/store.js'
import { buildMemoryContext } from '../lib/context.js'
import { createFocusState } from '../lib/focus.js'

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'jingjing-review5-'))
const store = new MemoryStore(path.join(tmp, 'a.sqlite'))
const now = Date.parse('2026-11-14T12:00:00+08:00')

// 回收一条原话：返回值必须是回收站编号；梗概 source_refs 只摘掉完整匹配，
// 不能把 raw:10 一起误删。
const id1 = store.addRaw(now - 1000, 's1', 'user', '第一条要被忘掉的话')
store.addSummary(now - 900, 's1', '梗概', now - 1000, now - 900, id1, ['raw:1', 'raw:10'])
const recycleId = store.recycleRaw(id1, { reason: '测试回收', actor: '她' })
assert.equal(typeof recycleId, 'number')
assert.ok(recycleId > 0, 'recycleRaw 要返回真实的回收站编号')
assert.deepEqual(store.summaryById(1).sourceRefs, ['raw:10'], '只摘掉 raw:1，不误删 raw:10')
assert.equal(store.memoryAudit(1)[0].action, 'forget')
assert.equal(store.memoryAudit(1)[0].meta.summaries, 1)

// 恢复中途 audit 写失败：事务必须回滚，原话留在回收站，不能半恢复。
const id2 = store.addRaw(now - 800, 's1', 'user', '第二条要恢复的话')
const bin2 = store.recycleRaw(id2)
const beforeBin = store.recycleCount()
const realAudit = store.addMemoryAudit
store.addMemoryAudit = () => { throw new Error('audit down') }
assert.throws(() => store.recycleRestore(bin2), /audit down/)
assert.equal(store.recycleCount(), beforeBin, '恢复失败时回收站记录不能先被删掉')
assert.equal(store.rawById(id2), null, '恢复失败时不能留下半条 raw_turns')
store.addMemoryAudit = realAudit
const restored = store.recycleRestore(bin2)
assert.equal(restored.id, id2)
assert.ok(store.rawById(id2), '回滚后再恢复应成功')
assert.equal(store.memoryAudit(1)[0].action, 'restore')

// 归档后的相邻回复：rawAfter 必须跨 raw_turns/raw_archive 查。
const uid = store.addRaw(now - 700, 's2', 'user', '归档前的提问')
const rid = store.addRaw(now - 699, 's2', 'her', '归档后的回答')
store.archiveRawBefore(now + 1000)
assert.deepEqual(store.rawAfter(uid, 's2').map((r) => r.id), [rid])
assert.equal(store.rawAnyById(uid).id, uid)

// 归档后装配上下文时，命中的旧问句仍要带回紧随的她那句。
const archived = new MemoryStore(path.join(tmp, 'archive.sqlite'))
const archivedQ = archived.addRaw(now - 600, 's4', 'user', '你还记得那只陶罐吗')
archived.addRaw(now - 599, 's4', 'her', '记得，在博物馆看到的，边上有一道裂纹')
archived.archiveRawBefore(now + 1000)
const archivedCtx = buildMemoryContext({ store: archived, userText: '陶罐', now, budget: 2400 })
assert.match(archivedCtx.text, /博物馆看到的/)
assert.match(archivedCtx.focusText, /博物馆看到的/)
archived.close()

// 上下文：命中他的问句后，即使中间还有一条他的补充，也要找到真正接话的她。
const s2 = new MemoryStore(path.join(tmp, 'b.sqlite'))
const q = s2.addRaw(now - 500, 's3', 'user', '你还记得那只青铜器吗')
s2.addRaw(now - 499, 's3', 'user', '就是上次说的那只')
s2.addRaw(now - 498, 's3', 'her', '记得，在故宫看到的那只')
const ctx = buildMemoryContext({ store: s2, userText: '青铜器', now, budget: 2400 })
assert.match(ctx.text, /故宫看到的那只/)
assert.match(ctx.focusText, /故宫看到的那只/)
assert.ok(ctx.sections.every((s) => (s.refs || []).length <= s.lines.length), 'refs 不能和实际行错位')
assert.ok(ctx.text.length <= 2400)
s2.close()

// 话题状态按会话隔离，别让 A 窗口的最后一句话跑到 B 窗口。
const focus = createFocusState(2)
focus.set('a', 'A 说的话')
focus.set('b', 'B 说的话')
assert.equal(focus.get('a'), 'A 说的话')
assert.equal(focus.get('b'), 'B 说的话')
focus.set('c', 'C 说的话')
assert.equal(focus.get('a'), '', '超过上限时淘汰最久没用的会话')
assert.equal(focus.get('b'), 'B 说的话')

store.close()
fs.rmSync(tmp, { recursive: true, force: true })
console.log('OK: 审查修复（回收清理/恢复回滚/归档相邻/上下文跨 user/会话隔离）')
