import assert from 'node:assert'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { MemoryStore } from '../lib/store.js'
import { extractAssertions, summarizeTurns } from '../lib/extract.js'
import { buildPack } from '../lib/pack.js'

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jingjing-m1-'))
const file = path.join(dir, 'memory.sqlite')
const store = new MemoryStore(file)
const now = Date.now()

// 1) 抽取：名字 / 城市 / 工作 / 好恶 / 计划
const said = '我叫林晚，住在杭州，在字节上班。我不喜欢香菜。我明天要去医院复查。'
const items = extractAssertions(said)
const byKey = Object.fromEntries(items.map((i) => [i.predicate, i.value]))
assert.equal(byKey['名字'], '林晚')
assert.equal(byKey['住在'], '杭州')
assert.equal(byKey['工作'], '字节')
assert.equal(byKey['喜欢'], '不喜欢香菜')
assert.ok(Object.keys(byKey).some((k) => k.startsWith('计划:')), '应当抽出计划')

// 2) 写入：原话 + 断言 + 画像 + 关系
store.addRaw(now - 3600_000, 's1', 'user', said)
store.touchRelation('他', now - 3600_000)
for (const item of items) {
  const { id } = store.addAssertion({ ts: now - 3600_000, subject: '他', predicate: item.predicate, value: item.value, source: said })
  if (!item.predicate.startsWith('计划:')) store.setProfile('他', item.predicate, item.value, said.slice(0, 60), now - 3600_000)
  assert.ok(id > 0)
}
store.addRaw(now - 3500_000, 's1', 'her', '杭州啊，那边现在冷不冷？')
store.addRaw(now - 3400_000, 's1', 'user', '有点冷，风大。')

const pack = buildPack({ store, now, maxChars: 1200 })
assert.ok(pack.includes('你记得的事'), '记忆包有标题')
assert.ok(pack.includes('林晚'), '记得名字')
assert.ok(pack.includes('杭州'), '记得城市')
assert.ok(pack.includes('计划') || pack.includes('明天'), '记得打算')
assert.ok(pack.length <= 1200, `记忆包超预算：${pack.length}`)
assert.equal(pack, buildPack({ store, now, maxChars: 1200 }), '同一状态应产出同一段文字（对缓存友好）')

// 3) 新事实取代旧事实
const moved = '我搬到上海了。'
const moveItems = extractAssertions(moved)
assert.equal(moveItems[0].value, '上海')
store.addAssertion({ ts: now, subject: '他', predicate: '住在', value: '上海', source: moved })
store.setProfile('他', '住在', '上海', moved, now)
const live = store.liveAssertions('他', 20).filter((a) => a.predicate === '住在')
assert.equal(live.length, 1, '同一件事只留一条活着的')
assert.equal(live[0].value, '上海')
const pack2 = buildPack({ store, now, maxChars: 1200 })
assert.ok(pack2.includes('上海'), '画像里应是新事实')
assert.ok(!/关于他[\s\S]*杭州/.test(pack2.split('你们最近说的话')[0]), '关于他那一段不该还写着旧城市')

// 4) 梗概：机械压缩，不超长度
const rows = store.recentRaw(10)
const summary = summarizeTurns(rows, 80)
assert.ok(summary.length <= 80)
assert.ok(summary.includes('他说') || summary.includes('你说'))
store.addSummary(now - 86400000, 's1', summary, now - 86400000, now - 80000000)
assert.ok(buildPack({ store, now, maxChars: 1200 }).includes('更早的印象'))

// 5) 预算很小时也不崩
const tiny = buildPack({ store, now, maxChars: 80 })
assert.ok(tiny.length <= 80)


// 6) 真实动作账本：只记真的调用，状态能更新
store.addAction({ ts: now, sessionId: 's1', kind: 'tool', tool: 'read_file', summary: '{"path":"日记.txt"}', callId: 'c1', status: 'called' })
store.addAction({ ts: now + 1, sessionId: 's1', kind: 'tool', tool: 'web_search', summary: '{"query":"杭州天气"}', callId: 'c2', status: 'called' })
store.updateAction('c1', 'ok')
const acts = store.recentActions(5)
assert.equal(acts.length, 2)
assert.equal(acts.find((a) => a.tool === 'read_file').status, 'ok')
assert.equal(acts.find((a) => a.tool === 'web_search').status, 'called')
assert.ok(buildPack({ store, now: now + 2, maxChars: 1200 }).includes('你最近做过的事'), '有动作时记忆包应带上「做过的事」')


// 7) 旧计划没有 due_at 时不能永久挂着：超过 2 天就退役
store.addAssertion({ ts: now - 3 * 86400000, subject: '他', predicate: '计划:去医院复查', value: '去医院复查', source: 'x' })
assert.equal(store.livePlans('他', 5, now).some((p) => p.ts < now - 2 * 86400000), false, '旧的无期限计划应失效')
store.expirePlans(now)
const expired = store.db.prepare("SELECT valid_to FROM assertions WHERE predicate = '计划:去医院复查' AND value = '去医院复查'").get()
assert.ok(expired && expired.valid_to !== null, '过期计划应写 valid_to')

store.close()
fs.rmSync(dir, { recursive: true, force: true })
console.log('OK: memory store / extract / pack 全过；最后 pack 长度', pack.length)
