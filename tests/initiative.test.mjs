import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { MemoryStore } from '../lib/store.js'
import { Outbox } from '../lib/outbox.js'
import {
  INITIATIVE_DEFAULTS, readInitiativeConfig, inQuietHours,
  initiativeDue, composeInitiative, sendViaBridge, tickInitiative,
  createInitiativeTool, setInitiativeStopped,
} from '../lib/initiative.js'

const dirs = []
function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jingjing-initiative-'))
  dirs.push(dir)
  const store = new MemoryStore(path.join(dir, 'life.sqlite'))
  return { dir, store, outbox: new Outbox(store.db) }
}
function close({ dir, store }) {
  try { store.close() } catch { /* already closed */ }
  fs.rmSync(dir, { recursive: true, force: true })
}

const at = (hour, minute = 0) => new Date(2026, 10, 14, hour, minute, 0, 0).getTime()
const base = {
  ...INITIATIVE_DEFAULTS,
  enabled: true,
  target: 'chat-1',
  bridgeUrl: 'http://127.0.0.1:8789/send',
  minSilenceHours: 8,
  minGapHours: 6,
  dailyMax: 2,
  maxUnanswered: 2,
  quietStart: '23:30',
  quietEnd: '08:00',
}

// 默认关：没有配置时连表都不该触发外发。
{
  const s = setup()
  assert.equal(initiativeDue({ ...s, now: at(10), config: INITIATIVE_DEFAULTS }).reason, 'disabled')
  assert.equal(initiativeDue({ ...s, now: at(10), config: base }).reason, 'no_inbound')
  close(s)
}

// 刚聊完、静默时段都不能开口。
{
  const s = setup()
  s.store.addRaw(at(9), 's1', 'user', '在吗')
  assert.equal(initiativeDue({ ...s, now: at(10), config: base }).reason, 'recent_chat')
  assert.equal(initiativeDue({ ...s, now: at(23, 45), config: base }).reason, 'quiet_hours')
  close(s)
}

// 已有 pending、连续未回应、今天说够了、间隔太短，都停在对应原因。
{
  const s = setup()
  s.store.addRaw(at(1), 's1', 'user', '早')
  const pending = s.outbox.create({ channel: 'wechat', target: 'chat-1', text: '草稿', now: at(10), meta: { kind: 'initiative', reason: 'open_loop' } })
  assert.equal(initiativeDue({ ...s, now: at(11), config: base }).reason, 'pending')
  s.outbox.markFailed(pending.id, 'test', at(11))

  const a = s.outbox.create({ channel: 'wechat', target: 'chat-1', text: '第一句', now: at(11), meta: { kind: 'initiative' } })
  const b = s.outbox.create({ channel: 'wechat', target: 'chat-1', text: '第二句', now: at(11, 1), meta: { kind: 'initiative' } })
  s.outbox.markSent(a.id, at(11))
  s.outbox.markSent(b.id, at(11, 1))
  assert.equal(initiativeDue({ ...s, now: at(20), config: base }).reason, 'unanswered')
  close(s)
}

{
  const s = setup()
  s.store.addRaw(at(1), 's1', 'user', '早')
  const sent = s.outbox.create({ channel: 'wechat', target: 'chat-1', text: '说过了', now: at(10), meta: { kind: 'initiative' } })
  s.outbox.markSent(sent.id, at(10))
  assert.equal(initiativeDue({ ...s, now: at(11), config: { ...base, dailyMax: 1 } }).reason, 'daily_limit')
  assert.equal(initiativeDue({ ...s, now: at(11), config: { ...base, minGapHours: 6 } }).reason, 'min_gap')
  close(s)
}

// 由头：没放下的计划优先于书/梦/泛泛的想念。
{
  const s = setup()
  s.store.addRaw(at(1), 's1', 'user', '早')
  s.store.addAssertion({ ts: at(9), subject: '他', predicate: '计划:明天', value: '去医院复查', source: 'raw:1', dueAt: at(10) + 86400000 })
  const plan = initiativeDue({ ...s, now: at(10), config: base })
  assert.equal(plan.due, true)
  assert.equal(plan.reason, 'open_loop')
  assert.equal(plan.ref.startsWith('assert:'), true)
  assert.match(composeInitiative(plan), /去医院复查/)
  close(s)
}

{
  const s = setup()
  s.store.addRaw(at(1), 's1', 'user', '早')
  const bookId = s.store.addBook({ title: '小王子', url: 'https://example.test/book', path: '/tmp/book.epub', total: 100, now: at(9) })
  const book = initiativeDue({ ...s, now: at(10), config: base })
  assert.equal(book.reason, 'book')
  assert.equal(book.ref, `book:${bookId}`)
  assert.match(composeInitiative(book), /小王子/)
  assert.match(composeInitiative(book), /刚翻开/)

  // 999/1000 不能被四舍五入成“读完了”。
  s.store.setBookProgress(bookId, 999, 1000, at(10))
  const almost = initiativeDue({ ...s, now: at(10), config: base })
  assert.equal(almost.reason, 'book')
  assert.doesNotMatch(composeInitiative(almost), /读完/)
  assert.match(composeInitiative(almost), /99%/)

  // 读完之后不能再说“还在读”，也不能永远挡住别的由头。
  s.store.setBookProgress(bookId, 1000, 1000, at(10))
  const finished = initiativeDue({ ...s, now: at(10), config: base })
  assert.notEqual(finished.reason, 'book')
  close(s)
}

{
  const s = setup()
  s.store.addRaw(at(1), 's1', 'user', '早')
  s.store.addDream({ date: '2026-11-13', ts: at(2), text: '梦见一条会发光的鱼', evidence: [] })
  const dream = initiativeDue({ ...s, now: at(10), config: base })
  assert.equal(dream.reason, 'dream')
  assert.match(composeInitiative(dream), /我昨晚梦见一条会发光的鱼/)
  assert.doesNotMatch(composeInitiative(dream), /梦见梦见/)
  close(s)
}

{
  const s = setup()
  s.store.addRaw(at(1), 's1', 'user', '早')
  const fallback = initiativeDue({ ...s, now: at(10), config: base })
  assert.equal(fallback.reason, 'missing_you')
  assert.match(fallback.ref, /^raw:\d+$/)
  assert.match(composeInitiative(fallback), /忽然想起你/)
  close(s)
}

// 意愿：安全例外不受影响；拒绝/推迟只挡住非安全主动开口。
{
  const s = setup()
  s.store.addRaw(at(1), 's1', 'user', '早')
  assert.equal(initiativeDue({ ...s, now: at(10), config: base, willCheck: () => ({ decision: 'refuse' }) }).reason, 'will_refuse')
  assert.equal(initiativeDue({ ...s, now: at(10), config: base, willCheck: () => ({ decision: 'defer' }) }).reason, 'will_defer')
  close(s)
}

// 发送：只有 2xx + ok:true 才算 sent；4xx failed；5xx/异常 uncertain；没桥接保持 pending。
{
  const s = setup()
  s.store.addRaw(at(1), 's1', 'user', '早')
  const entry = s.outbox.create({ channel: 'wechat', target: 'chat-1', text: '你好', now: at(10), meta: { kind: 'initiative' } })
  let sentBody = null
  const ok = await sendViaBridge({
    outbox: s.outbox, entry, config: base,
    fetchImpl: async (_url, init) => {
      sentBody = JSON.parse(init.body)
      return { ok: true, status: 200, json: async () => ({ ok: true, external_id: 'x' }) }
    },
  })
  assert.equal(ok.state, 'sent')
  assert.equal(s.outbox.get(entry.id).state, 'sent')
  assert.equal(sentBody.chat_id, 'chat-1')

  // 旧 pending 的 target 不能被后来改过的全局 target 覆盖。
  const e6 = s.outbox.create({ channel: 'wechat', target: 'chat-old', text: '给旧人', now: at(15), meta: { kind: 'initiative' } })
  let retryBody = null
  const retry = await sendViaBridge({
    outbox: s.outbox, entry: e6, config: { ...base, target: 'chat-new' },
    fetchImpl: async (_url, init) => {
      retryBody = JSON.parse(init.body)
      return { ok: true, status: 200, json: async () => ({ ok: true }) }
    },
  })
  assert.equal(retry.state, 'sent')
  assert.equal(retryBody.chat_id, 'chat-old')

  const e2 = s.outbox.create({ channel: 'wechat', target: 'chat-1', text: '被拒', now: at(11), meta: { kind: 'initiative' } })
  const bad = await sendViaBridge({
    outbox: s.outbox, entry: e2, config: base,
    fetchImpl: async () => ({ ok: false, status: 400, json: async () => ({ ok: false, error: 'bad' }) }),
  })
  assert.equal(bad.state, 'failed')

  const e3 = s.outbox.create({ channel: 'wechat', target: 'chat-1', text: '不确定', now: at(12), meta: { kind: 'initiative' } })
  const maybe = await sendViaBridge({
    outbox: s.outbox, entry: e3, config: base,
    fetchImpl: async () => ({ ok: false, status: 503, json: async () => ({ ok: false }) }),
  })
  assert.equal(maybe.state, 'uncertain')

  const e4 = s.outbox.create({ channel: 'wechat', target: 'chat-1', text: '没桥', now: at(13), meta: { kind: 'initiative' } })
  const noBridge = await sendViaBridge({ outbox: s.outbox, entry: e4, config: { ...base, bridgeUrl: '' } })
  assert.equal(noBridge.state, 'pending')

  // 2xx 但没有 {ok:true} 不能算送达。
  const e5 = s.outbox.create({ channel: 'wechat', target: 'chat-1', text: '空回执', now: at(14), meta: { kind: 'initiative' } })
  const emptyAck = await sendViaBridge({
    outbox: s.outbox, entry: e5, config: base,
    fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({}) }),
  })
  assert.equal(emptyAck.state, 'uncertain')
  close(s)
}

// tick 记账：生成 outbox、动作记录、发送状态；默认关时不写任何东西。
{
  const s = setup()
  s.store.addRaw(at(1), 's1', 'user', '早')
  s.store.addAssertion({ ts: at(9), subject: '他', predicate: '计划:明天', value: '去修伞', source: 'raw:1', dueAt: at(10) + 86400000 })
  const sent = await tickInitiative({
    ...s, now: at(10), config: base,
    sender: async ({ outbox, entry }) => { outbox.markSent(entry.id, at(10)); return { ok: true, state: 'sent' } },
  })
  assert.equal(sent.due, true)
  assert.equal(sent.delivery.state, 'sent')
  const action = s.store.db.prepare("SELECT tool, status, meta FROM actions WHERE tool = 'initiative'").get()
  assert.equal(action.tool, 'initiative')
  assert.equal(action.status, 'ok')
  assert.equal(JSON.parse(action.meta).ref, sent.ref)

  const s2 = setup()
  s2.store.addRaw(at(1), 's1', 'user', '早')
  const off = await tickInitiative({ ...s2, now: at(10), config: { ...base, enabled: false } })
  assert.equal(off.due, false)
  assert.equal(s2.outbox.recent(1).length, 0)
  close(s2)
  close(s)
}

// 没桥接时留下的 pending 不能永久堵死：桥接配好后下一次 tick 补发同一条。
{
  const s = setup()
  s.store.addRaw(at(1), 's1', 'user', '早')
  s.store.addAssertion({ ts: at(9), subject: '他', predicate: '计划:明天', value: '去修伞', source: 'raw:1', dueAt: at(10) + 86400000 })
  const first = await tickInitiative({ ...s, now: at(10), config: { ...base, bridgeUrl: '' } })
  assert.equal(first.due, true)
  assert.equal(first.delivery.state, 'pending')
  const pending = s.outbox.pending(5)
  assert.equal(pending.length, 1)

  const sentIds = []
  const second = await tickInitiative({
    // 全局 target 被清掉也不影响补发旧 pending：target 记在这条消息自己身上。
    ...s, now: at(11), config: { ...base, target: '' },
    sender: async ({ outbox, entry }) => {
      sentIds.push(entry.id)
      outbox.markSent(entry.id, at(11))
      return { ok: true, state: 'sent' }
    },
  })
  assert.equal(second.due, true)
  assert.equal(second.reason, 'pending_retry')
  assert.equal(second.entry.id, pending[0].id)
  assert.deepEqual(sentIds, [pending[0].id])
  assert.equal(s.outbox.get(pending[0].id).state, 'sent')
  assert.equal(s.outbox.pending(5).length, 0)
  const actions = s.store.db.prepare("SELECT COUNT(*) AS n FROM actions WHERE tool = 'initiative'").get().n
  assert.equal(actions, 2)
  close(s)
}

// 草稿写好后意愿变了：补发也要重新看当下，不能拿旧允许当通行证。
{
  const s = setup()
  s.store.addRaw(at(1), 's1', 'user', '早')
  s.store.addAssertion({ ts: at(9), subject: '他', predicate: '计划:明天', value: '去修伞', source: 'raw:1', dueAt: at(10) + 86400000 })
  const first = await tickInitiative({ ...s, now: at(10), config: { ...base, bridgeUrl: '' } })
  assert.equal(first.delivery.state, 'pending')

  let sent = 0
  const refused = await tickInitiative({
    ...s, now: at(11), config: base,
    willCheck: () => ({ decision: 'refuse', reason: '现在不想说' }),
    sender: async ({ outbox, entry }) => { sent += 1; outbox.markSent(entry.id, at(11)); return { ok: true, state: 'sent' } },
  })
  assert.equal(refused.due, false)
  assert.equal(refused.reason, 'will_refuse')
  assert.equal(sent, 0)
  assert.equal(s.outbox.pending(5).length, 1)

  const allowed = await tickInitiative({
    ...s, now: at(12), config: base,
    sender: async ({ outbox, entry }) => { sent += 1; outbox.markSent(entry.id, at(12)); return { ok: true, state: 'sent' } },
  })
  assert.equal(allowed.reason, 'pending_retry')
  assert.equal(sent, 1)
  close(s)
}

// 补发要守静默时间；用户已经回话的旧草稿不能再追着发。
{
  const s = setup()
  s.store.addRaw(at(1), 's1', 'user', '早')
  s.store.addAssertion({ ts: at(9), subject: '他', predicate: '计划:明天', value: '去修伞', source: 'raw:1', dueAt: at(10) + 86400000 })
  const first = await tickInitiative({ ...s, now: at(22), config: { ...base, bridgeUrl: '' } })
  assert.equal(first.delivery.state, 'pending')

  let sent = 0
  const quiet = await tickInitiative({
    ...s, now: at(23, 45), config: base,
    sender: async ({ outbox, entry }) => { sent += 1; outbox.markSent(entry.id, at(23, 45)); return { ok: true, state: 'sent' } },
  })
  assert.equal(quiet.due, false)
  assert.equal(quiet.reason, 'pending')
  assert.equal(sent, 0)
  assert.equal(s.outbox.pending(5).length, 1)

  const morning = await tickInitiative({
    ...s, now: at(22) + 10 * 3600000 + 60000, config: base,
    sender: async ({ outbox, entry }) => { sent += 1; outbox.markSent(entry.id, at(22) + 10 * 3600000 + 60000); return { ok: true, state: 'sent' } },
  })
  assert.equal(morning.reason, 'pending_retry')
  assert.equal(sent, 1)
  close(s)
}

{
  const s = setup()
  s.store.addRaw(at(1), 's1', 'user', '早')
  s.store.addAssertion({ ts: at(9), subject: '他', predicate: '计划:明天', value: '去修伞', source: 'raw:1', dueAt: at(10) + 86400000 })
  await tickInitiative({ ...s, now: at(22), config: { ...base, bridgeUrl: '' } })
  s.store.addRaw(at(22) + 3600000, 's1', 'user', '睡了吗')
  let sent = 0
  const stale = await tickInitiative({
    ...s, now: at(22) + 10 * 3600000 + 60000, config: base,
    willCheck: () => ({ decision: 'refuse' }),
    sender: async ({ outbox, entry }) => { sent += 1; outbox.markSent(entry.id, at(22) + 10 * 3600000 + 60000); return { ok: true, state: 'sent' } },
  })
  assert.equal(stale.due, false)
  assert.equal(stale.reason, 'pending_stale')
  assert.equal(stale.stale_reason, 'user_replied')
  assert.equal(sent, 0)
  assert.equal(s.outbox.pending(5).length, 0)
  const failed = s.store.db.prepare("SELECT COUNT(*) AS n FROM outbox WHERE state = 'failed'").get().n
  assert.equal(failed, 1)
  close(s)
}

// status/check 必须看到和 tick 同一套意愿判断。
{
  const s = setup()
  s.store.addRaw(at(1), 's1', 'user', '早')
  const tool = createInitiativeTool({
    ...s, config: base,
    willCheck: () => ({ decision: 'refuse', reason: '测试拒绝' }),
  })
  const status = await tool.execute({ action: 'status' })
  assert.equal(status.due, false)
  assert.equal(status.reason, 'will_refuse')
  assert.equal(status.draft, '')
  close(s)
}

// 有 pending 时 status 也要看到当下的意愿，不能只报 pending。
{
  const s = setup()
  s.store.addRaw(at(1), 's1', 'user', '早')
  const pending = s.outbox.create({ channel: 'wechat', target: 'chat-1', text: '草稿', now: at(10), meta: { kind: 'initiative' } })
  const tool = createInitiativeTool({
    ...s, config: base,
    willCheck: () => ({ decision: 'refuse', reason: '现在不想说' }),
  })
  const status = await tool.execute({ action: 'status' })
  assert.equal(status.due, false)
  assert.equal(status.reason, 'will_refuse')
  assert.equal(status.pending, pending.id)
  close(s)
}

// stop/resume 不能把 last_in / pending 一律报成 0。
{
  const s = setup()
  s.store.addRaw(at(1), 's1', 'user', '早')
  const pending = s.outbox.create({ channel: 'wechat', target: 'chat-1', text: '草稿', now: at(10), meta: { kind: 'initiative' } })
  const tool = createInitiativeTool({ ...s, config: base })
  const stopped = await tool.execute({ action: 'stop' })
  assert.equal(stopped.stopped_now, true)
  assert.equal(stopped.last_in, at(1))
  assert.equal(stopped.pending, pending.id)
  assert.equal(stopped.today_count, 1)

  const notYet = await tool.execute({ action: 'resume' })
  assert.equal(notYet.reason, 'resume_needs_confirm')
  assert.equal(notYet.last_in, at(1))
  assert.equal(notYet.pending, pending.id)
  close(s)
}

// 一键停/恢复 + 工具输出。
{
  const s = setup()
  s.store.addRaw(at(1), 's1', 'user', '早')
  setInitiativeStopped(s.store, true, at(10))
  const tool = createInitiativeTool({ ...s, config: base })
  const stopped = await tool.execute({ action: 'status' })
  assert.equal(stopped.stopped, true)
  assert.equal(stopped.due, false)
  const notYet = await tool.execute({ action: 'resume' })
  assert.equal(notYet.reason, 'resume_needs_confirm')
  const resumed = await tool.execute({ action: 'resume', confirm: 'RESUME' })
  assert.equal(resumed.stopped, false)
  const stop = await tool.execute({ action: 'stop' })
  assert.equal(stop.stopped_now, true)
  close(s)
}

// 配置：默认关，环境变量/配置只认显式值；静默时段跨午夜。
assert.equal(readInitiativeConfig({ env: {}, config: {} }).enabled, false)
assert.equal(readInitiativeConfig({ env: { LIFE_INITIATIVE: '1' }, config: {} }).enabled, true)
assert.equal(readInitiativeConfig({ env: {}, config: { initiative: { enabled: true, dailyMax: 1 } } }).dailyMax, 1)
assert.equal(inQuietHours(at(23, 45)), true)
assert.equal(inQuietHours(at(7, 59)), true)
assert.equal(inQuietHours(at(8, 0)), false)
assert.equal(inQuietHours(at(12, 0)), false)

for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true })
console.log('OK: initiative 默认关/由头/静默/频率/发送/停止')
