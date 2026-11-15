import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { MemoryStore } from '../lib/store.js'
import { buildMemoryContext } from '../lib/context.js'

const now = Date.parse('2026-11-14T10:00:00+08:00')
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'jingjing-context-'))
const db = path.join(tmp, 'life-innovation.sqlite')
const store = new MemoryStore(db)

store.setProfile('他', '名字', '林晚', '我叫林晚', now - 86400000)
store.setProfile('他', '住在', '杭州', '我住在杭州', now - 86400000)
store.addAssertion({ ts: now - 3600000, subject: '他', predicate: '工作', value: '在杭州做设计', source: '我在杭州做设计' })
store.addAssertion({ ts: now - 1800000, subject: '他', predicate: '计划:周末', value: '去西湖边走走', source: '周末想去西湖', dueAt: now + 86400000 })

const oldId = store.addRaw(now - 5 * 86400000, 's1', 'user', '我住在杭州，喜欢下雨天。')
const oldReplyId = store.addRaw(now - 5 * 86400000 + 1000, 's1', 'her', '我也记得，杭州的雨天适合慢慢走。')
store.addRaw(now - 60000, 's1', 'her', '我用了「web_read」工具，返回 https://example.com，端口 60080 和一段日志。')
store.addRaw(now - 30000, 's1', 'user', '杭州的雨你还记得吗？')
store.addSummary(now - 2 * 86400000, 's1', '之前聊过杭州的雨和西湖。', now - 5 * 86400000, now - 4 * 86400000, null, [`raw:${oldId}`])

const out = buildMemoryContext({ store, userText: '杭州的雨你还记得吗？', now, budget: 2400 })
assert.ok(out.text.startsWith('这一轮你想起的事'))
assert.ok(out.text.includes('林晚'), '核心画像进上下文')
assert.ok(out.text.includes('去西湖边走走'), '未放下的计划进上下文')
assert.ok(out.text.includes('杭州的雨'), '相关旧事进上下文')
assert.ok(out.text.includes(`raw:${oldId}`), '相关旧事带 ref')
assert.ok(out.text.includes('杭州的雨天适合慢慢走'), '命中他说的话时带回紧随的她的话')
assert.ok(out.text.includes(`raw:${oldReplyId}`), '相邻回复也带 ref')
assert.ok(out.text.includes('更早的印象'), '梗概进上下文')
assert.ok(!out.text.includes('https://example.com'), '工具汇报不占上下文')
assert.ok(!out.text.includes('杭州的雨你还记得吗？'), '当前这句话不在旧事里复述')
assert.ok(out.sections.every((s) => Array.isArray(s.lines)), 'sections 返回实际行')
assert.ok(out.text.length <= 2400)
assert.equal(out.used, out.text.length)
assert.ok(out.refs.includes(`raw:${oldId}`))
assert.ok(out.sections.some((s) => s.title === '你们最近说的话（只留要紧的）'))

const focus = buildMemoryContext({ store, userText: '杭州的雨你还记得吗？', now, budget: 2400 }).focusText
assert.ok(focus.includes('这一刻想起的旧事'))
assert.ok(focus.includes(`raw:${oldId}`))
assert.ok(!focus.includes('你们最近说的话'), '动态注入只补相关旧事，避免与常驻包重复')

const small = buildMemoryContext({ store, userText: '杭州', now, budget: 260 })
assert.ok(small.text.length <= 260)
assert.ok(small.used <= 260)
assert.ok(small.focusText.length <= 260, '动态注入也不能超预算')

const emptyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jingjing-context-empty-'))
const empty = new MemoryStore(path.join(emptyDir, 'life-innovation.sqlite'))
const blank = buildMemoryContext({ store: empty, userText: '', now, budget: 800 })
assert.equal(blank.text, '')
assert.equal(blank.focusText, '')
empty.close()
fs.rmSync(emptyDir, { recursive: true, force: true })

// P2-7：注入路径只装 relevant 一层，其他层连查都不查。
const onlyRelevant = buildMemoryContext({
  store, userText: '杭州的雨你还记得吗？', now, budget: 2400, only: ['relevant'],
})
assert.ok(onlyRelevant.text.includes('这一刻想起的旧事'))
assert.ok(onlyRelevant.focusText.includes('这一刻想起的旧事'))
assert.ok(!onlyRelevant.text.includes('你自己正在过的日子'))
assert.ok(!onlyRelevant.text.includes('关于他'))
assert.ok(!onlyRelevant.text.includes('你们最近说的话'))
assert.ok(!onlyRelevant.text.includes('你还没放下的事'))
assert.equal(onlyRelevant.counts.profiles, 0)
assert.equal(onlyRelevant.counts.recent, 0)
assert.equal(onlyRelevant.counts.plans, 0)

// P3-1：同一句话以前说过时，只去掉刚入库的最新一条，旧原话要留下。
const dupOld = store.addRaw(now - 120000, 's2', 'user', '同一句话')
const dupNow = store.addRaw(now - 60000, 's2', 'user', '同一句话')
const dup = buildMemoryContext({ store, userText: '同一句话', now, budget: 2400 })
assert.ok(dup.refs.includes(`raw:${dupOld}`), '旧原话不能被当成当前句删掉')
assert.ok(!dup.refs.includes(`raw:${dupNow}`), '刚入库的当前句不重复进上下文')

// P3-2：本轮刚抽出的断言（source 就是当前句）不能当旧事复述。
const queryNow = '我搬到杭州了'
const freshAssertion = store.addAssertion({
  ts: now, subject: '他', predicate: '住在', value: '杭州', source: queryNow,
})
const oldAssertion = store.addAssertion({
  ts: now - 3600000, subject: '他', predicate: '工作', value: '在杭州做设计', source: '我在杭州做设计',
})
const assertCtx = buildMemoryContext({ store, userText: queryNow, now, budget: 2400 })
assert.ok(assertCtx.refs.includes(`assert:${oldAssertion.id}`), '旧断言仍可被想起')
assert.ok(!assertCtx.refs.includes(`assert:${freshAssertion.id}`), '本轮刚抽出的断言不复述')

store.close()
fs.rmSync(tmp, { recursive: true, force: true })
console.log('OK: 记忆上下文四层装配（核心/相关/近期/计划、预算、ref）')
