import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { MemoryStore } from '../lib/store.js'
import { renderHome, renderHomeError, homeFilePath, homeDbHintFile, readHomeDbHint } from '../install/home.mjs'

const TZ = 'Asia/Shanghai'
const now = Date.parse('2026-11-05T23:20:00+08:00')
const day = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' })
  .format(new Date(now))
const dayStart = Date.parse(`${day}T00:00:00+08:00`)
const at = (hour, minute = 0) => dayStart + hour * 3600000 + minute * 60000

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'jingjing-home-test-'))
const home = tmp
const dbPath = homeFilePath(home)
fs.mkdirSync(path.dirname(dbPath), { recursive: true })

const store = new MemoryStore(dbPath)
store.appendPhase({ date: day, phase: 'quiet', startedAt: at(0), reason: '夜里，没人在说话' })
store.endPhase(store.lastPhase().id, at(8))
store.appendPhase({ date: day, phase: 'awake', startedAt: at(8), reason: '有人说话' })

store.addRaw(at(18, 29), 's1', 'user', '我叫林晚，住在杭州。')
store.addAssertion({ ts: at(18, 29), subject: '他', predicate: '名字', value: '林晚', source: 'raw:1' })
store.addAssertion({ ts: at(18, 29), subject: '他', predicate: '住在', value: '杭州', source: 'raw:1' })
store.addAssertion({ ts: at(18, 30), subject: '他', predicate: '养了', value: '猫', source: 'raw:1' })
store.addAssertion({ ts: at(18, 30), subject: '他', predicate: '宠物', value: '猫叫团子', source: 'raw:1' })
store.addAssertion({ ts: at(18, 31), subject: '他', predicate: '喜欢', value: '不喜欢香菜', source: 'raw:1' })
store.addAssertion({ ts: at(18, 31), subject: '他', predicate: '工作', value: '老师', source: 'raw:1' })
store.addAssertion({ ts: at(18, 32), subject: '他', predicate: '工作', value: '程序员', source: 'raw:1' })
store.addAssertion({ ts: at(18, 32), subject: '他', predicate: '计划:明天', value: '去医院复查', source: 'raw:1', dueAt: at(10) + 86400000 })

store.replaceLifeBlocks(day, [
  { activity: '和他说说话', startedAt: at(18, 29), endedAt: at(18, 39), evidence: ['raw:1'] },
  { activity: '写日记', startedAt: at(18, 59), endedAt: at(18, 59), evidence: ['act:1'] },
  { activity: '<script>alert(2)</script>', startedAt: at(19, 0), endedAt: at(19, 1), evidence: ['raw:2'] },
  { activity: '空档', startedAt: at(19, 5), endedAt: at(19, 30), evidence: [] },
])
store.addAction({
  ts: at(18, 59), sessionId: 's1', kind: 'system', tool: 'write_diary',
  summary: '把今天记成日记', callId: 'diary:' + day, status: 'ok',
})
store.addSummary(at(18, 59), 's1', '**记住** 你说：我叫林晚。；他说：好的。', at(18, 29), at(18, 59), 1)
store.addDream({ date: day, ts: at(23, 5), text: '梦见一把伞，伞骨上写着「算了」。', evidence: ['raw:1'] })

// 给七天视图准备前一天：一个真实动作 + 一个梦。
const pastDay = '2026-11-04'
const pastAt = at(18, 0) - 86400000
store.appendPhase({ date: pastDay, phase: 'quiet', startedAt: pastAt - 3600000, reason: '夜里，没人在说话' })
store.replaceLifeBlocks(pastDay, [
  { activity: '读了一段书', startedAt: pastAt, endedAt: pastAt, evidence: ['act:9'] },
])
store.addAction({
  ts: pastAt, sessionId: 's1', kind: 'life', tool: 'book_next',
  summary: '读了《柳林风声》一段', callId: 'past-book', status: 'ok',
})
store.addDream({ date: pastDay, ts: pastAt + 60000, text: '梦见旧书里夹着一片叶子。', evidence: ['raw:1'] })

store.touchRelation('他', at(18, 29))
store.setProfile('他', '名字', '林晚', 'raw:1', at(18, 29))
store.close()

const html = renderHome({ home, dbPath, now, chatUrl: 'http://127.0.0.1:60080/' })
fs.mkdirSync(path.join(home, 'notes'), { recursive: true })
fs.writeFileSync(path.join(home, 'notes', '喝水.md'), '今天记得喝水。', 'utf8')
const memory = renderHome({ home, dbPath, now, view: 'memory' })
const room = renderHome({ home, dbPath, now, view: 'room' })
const selfPage = renderHome({ home, dbPath, now, view: 'self' })
assert.match(html, /<title>家<\/title>/)
const named = renderHome({ home: tmp, dbPath, now, agentName: '鲸鲸' })
assert.match(named, /<title>鲸鲸的家<\/title>/)
assert.match(html, /她做过的事/)
assert.match(html, /和他说说话/)
assert.match(html, /写日记/)
assert.match(html, /原话 1/)
assert.match(html, /动作 1/)
assert.doesNotMatch(html, /他叫林晚/, '今天不再塞事实，事实在「她记得」')
assert.match(memory, /他叫林晚/)
assert.match(memory, /他住在杭州/)
assert.match(memory, /他的猫叫团子/)
assert.doesNotMatch(memory, /他养了猫/, '有名字的宠物就不该再显示泛称「养了猫」')
assert.match(memory, /他不喜欢香菜/)
assert.match(memory, /去医院复查/)
assert.match(memory, /11 月 6 日/)
assert.match(memory, /她的记忆 · 只读/)
assert.match(memory, /你梦见过的（不是真事）/)
assert.match(memory, /她改过口的事/)
assert.match(memory, /以前说过/)
assert.match(html, /梦 · 不是真事/)
assert.match(html, /今天的梦/)
assert.match(html, /梦见一把伞/)
assert.match(html, /没有留下动作|空着/)
assert.doesNotMatch(html, /<section class="week">/, '默认只显示今天')
assert.match(html, /href="\?view=today&amp;days=7"/)
assert.match(html, /class="active" aria-current="page">今天<\/a>/)
assert.match(html, /href="\?view=memory"/)
assert.match(html, /href="\?view=room"/)
assert.match(html, /href="\?view=self"/)

// 七天视图：今天不变，再补六天；过去的日子有动作和梦就展示，没有就空着。
const week = renderHome({ home, dbPath, now, days: 7 })
assert.match(week, /最近七天/)
assert.match(week, /2026 年 11 月 4 日/)
assert.match(week, /读了一段书/)
assert.match(week, /梦见旧书/)
assert.match(week, /那天的梦/)
assert.match(week, /这一天没有留下动作/)
assert.match(week, /href="\?view=today&amp;days=1"/)
assert.match(week, /class="active" aria-current="page">最近七天<\/a>/)

// 摘要里的 markdown 与「你说/他说」不该原样出现在页面上
assert.doesNotMatch(memory, /\*\*/)
assert.doesNotMatch(memory, /你说：/)

// XSS：数据库里的活动名与事实都只当文本
assert.match(html, /&lt;script&gt;alert\(2\)&lt;\/script&gt;/)
assert.doesNotMatch(html, /<script>alert\(2\)/)
assert.match(html, /class="seg"/)

// 她的记忆：按原话搜索只读展示；XSS 查询被转义。
const searched = renderHome({ home, dbPath, now, view: 'memory', memoryQuery: '林晚' })
assert.match(searched, /搜「林晚」找到的原话/)
assert.match(searched, /我叫林晚/)
assert.match(searched, /raw:1/)
const xssSearch = renderHome({ home, dbPath, now, view: 'memory', memoryQuery: '<script>alert(9)</script>' })
assert.doesNotMatch(xssSearch, /<script>alert\(9\)/)

// 她的房间：只读列出便签/日记/书架，不把路径写出去。
assert.match(room, /她的房间/)
assert.match(room, /便签/)
assert.match(room, /今天记得喝水/)
assert.match(selfPage, /她自己记得的样子/)
assert.match(selfPage, /她是谁/)

// 只读：连续渲染不改变库文件大小与 mtime
const before = fs.statSync(dbPath)
const again = renderHome({ home, dbPath, now, chatUrl: '' })
const after = fs.statSync(dbPath)
assert.equal(after.size, before.size)
assert.equal(after.mtimeMs, before.mtimeMs)
assert.match(again, /房间这会儿没开/)

// 缺库时给人话，不是堆栈
const missing = renderHome({ home, dbPath: path.join(home, 'state', 'missing.sqlite'), now })
assert.match(missing, /她还没有家/)
assert.match(missing, /还没有家|找不到记忆库/)

assert.match(renderHomeError('数据库被锁了'), /数据库被锁了/)
assert.match(renderHomeError('<x>'), /&lt;x&gt;/)
assert.equal(path.basename(dbPath), 'life-innovation.sqlite')

// 梦是「一天收起来之后」才生成的，第二天页面要退回去显示昨晚的梦。
const tmp2 = fs.mkdtempSync(path.join(os.tmpdir(), 'jingjing-home-dream-'))
const db2 = homeFilePath(tmp2)
fs.mkdirSync(path.dirname(db2), { recursive: true })
const store2 = new MemoryStore(db2)
store2.addDream({ date: '2026-11-04', ts: at(0) - 3600000, text: '昨晚梦见抽屉里有一封没寄出去的信。', evidence: ['raw:7'] })
store2.close()
const lastNight = renderHome({ home: tmp2, dbPath: db2, now })
assert.match(lastNight, /昨晚的梦 · 11 月 4 日/)
assert.match(lastNight, /昨晚梦见抽屉/)
assert.match(lastNight, /原话 7/)
fs.rmSync(tmp2, { recursive: true, force: true })

// 固定入口通过插件写下的提示文件找到「这次真正打开的库」，
// 所以手改 config.dbPath、没重跑安装脚本时也不会读旧库。
const hintHome = fs.mkdtempSync(path.join(os.tmpdir(), 'jingjing-home-hint-'))
const hintedDb = path.join(hintHome, 'custom.sqlite')
fs.mkdirSync(path.dirname(hintedDb), { recursive: true })
fs.writeFileSync(hintedDb, '')
fs.mkdirSync(path.dirname(homeDbHintFile(hintHome)), { recursive: true })
fs.writeFileSync(homeDbHintFile(hintHome), hintedDb, 'utf8')
assert.equal(readHomeDbHint(hintHome), hintedDb)
fs.writeFileSync(homeDbHintFile(hintHome), path.join(hintHome, 'missing.sqlite'), 'utf8')
assert.equal(readHomeDbHint(hintHome), '')
fs.rmSync(hintHome, { recursive: true, force: true })

fs.rmSync(tmp, { recursive: true, force: true })
console.log('OK: 家（只读、证据、节律、事实去重、梦、XSS、缺库）')
