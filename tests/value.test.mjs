import assert from 'node:assert/strict'
import { clipText, contextValue, isAck, isToolReport, selectRecent } from '../lib/value.js'

assert.equal(clipText('abcdef', 4), 'abc…')
assert.equal(isAck('晚安～'), true)
assert.equal(isAck('晚安，我今天把书读完了'), false)
assert.equal(isToolReport('https://example.com/a'), true)
assert.equal(isToolReport('D:\\workspace\\x.txt'), true)
assert.equal(isToolReport('我用了「memory_find」工具，返回 3 条结果'), true)
assert.equal(isToolReport('今天把阳台上的花修了一下，还浇了水。'), false)

assert.ok(contextValue('我决定以后每天晚饭后走一圈。') > contextValue('好的'))
assert.ok(contextValue('嗯') < 0)
assert.ok(contextValue('我用了「web_read」工具，返回一段很长的日志和端口配置。') < 0)

const rows = [
  { id: 1, ts: 100, role: 'user', text: '我叫林晚。' },
  { id: 2, ts: 200, role: 'her', text: '我用了工具，返回 https://example.com，端口 60080。' },
  { id: 3, ts: 300, role: 'her', text: '记得你说过杭州的雨很细。' },
  { id: 4, ts: 400, role: 'user', text: '嗯' },
  { id: 5, ts: 500, role: 'her', text: '我把今天读到的句子抄在便签上了。' },
  { id: 6, ts: 600, role: 'user', text: '那本书读到哪里了？' },
]
const recent = selectRecent(rows, { max: 4, perRole: 2 })
assert.equal(recent.length, 4)
assert.ok(recent.some((r) => r.id === 1), '用户的事实句保留')
assert.ok(recent.some((r) => r.id === 6), '用户最近的问句保留')
assert.ok(recent.some((r) => r.id === 5), '她真实的生活句保留')
assert.ok(!recent.some((r) => r.id === 2), '工具汇报不占上下文')
assert.deepEqual(recent.map((r) => r.id), [...recent.map((r) => r.id)].sort((a, b) => a - b), '按时间正序')
assert.ok(recent.every((r) => r.injectText.length <= 160))

console.log('OK: 上下文价值过滤（工具汇报/寒暄/角色平衡/截断）')
