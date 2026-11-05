import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { MemoryStore } from '../lib/store.js'
import { renderHome, renderHomeError, homeFilePath } from '../install/home.mjs'

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
store.touchRelation('他', at(18, 29))
store.setProfile('他', '名字', '林晚', 'raw:1', at(18, 29))
store.close()

const html = renderHome({ home, dbPath, now, chatUrl: 'http://127.0.0.1:60080/' })
assert.match(html, /鲸鲸的家/)
assert.match(html, /她做过的事/)
assert.match(html, /和他说说话/)
assert.match(html, /写日记/)
assert.match(html, /原话 1/)
assert.match(html, /动作 1/)
assert.match(html, /他叫林晚/)
assert.match(html, /他住在杭州/)
assert.match(html, /他的猫叫团子/)
assert.doesNotMatch(html, /他养了猫/, '有名字的宠物就不该再显示泛称「养了猫」')
assert.match(html, /他不喜欢香菜/)
assert.match(html, /去医院复查/)
assert.match(html, /11 月 6 日/)
assert.match(html, /梦 · 不是真事/)
assert.match(html, /梦见一把伞/)
assert.match(html, /没有留下动作|空着/)

// 摘要里的 markdown 与「你说/他说」不该原样出现在页面上
assert.doesNotMatch(html, /\*\*/)
assert.doesNotMatch(html, /你说：/)

// XSS：数据库里的活动名与事实都只当文本
assert.match(html, /&lt;script&gt;alert\(2\)&lt;\/script&gt;/)
assert.doesNotMatch(html, /<script>alert\(2\)/)
assert.match(html, /class="seg"/)

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
assert.equal(path.basename(dbPath), 'jingjing.sqlite')

fs.rmSync(tmp, { recursive: true, force: true })
console.log('OK: 家（只读、证据、节律、事实去重、梦、XSS、缺库）')
