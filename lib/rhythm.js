/**
 * 节律（M3.5）：把「她处在什么状态」做成一个由时钟 + 真实事件推导的状态机。
 *
 * 边界（比 CAA 更窄，也更诚实）：
 * - 状态只有 awake / quiet / night / closed / offline 五种，不代表任何具体活动；
 * - 生活内容仍然只能来自 actions 与 raw_turns，这一层不编「冲咖啡/读旧书」；
 * - 宿主没运行时记 offline，不补写「她在睡觉」；
 * - 23 点后第一次「安静够久」才归档当天；凌晨补归档前一天；
 * - 梦是非事实层，单独落 dreams，永远不进 life_blocks / assertions。
 */
import { startOfDay, addDays, dateKey, syncDay, writeDiaryFile, toolActivity } from './life.js'
import { rankedRecall } from './search.js'

export const NIGHT_START = 23
export const NIGHT_END = 8
const AWAKE_MS = 10 * 60 * 1000
const OFFLINE_MS = 5 * 60 * 1000
const CLOSE_QUIET_MS = 30 * 60 * 1000
const REVIEW_EVERY_MS = 3 * 3600 * 1000

const PHASE_NAMES = {
  awake: '醒着',
  quiet: '安静',
  night: '夜里',
  closed: '今天已经收起来',
  offline: '没在运行',
}

function clock(ts) {
  const d = new Date(ts)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

function dayStartOf(date) {
  const [y, m, d] = String(date).split('-').map(Number)
  return new Date(y, m - 1, d).getTime()
}

function lastUserTs(store) {
  const rows = store.recentRaw(30)
  for (let i = rows.length - 1; i >= 0; i -= 1) {
    if (rows[i].role === 'user') return rows[i].ts
  }
  return 0
}

function hash(text) {
  let h = 2166136261
  for (const ch of String(text)) {
    h ^= ch.codePointAt(0)
    h = Math.imul(h, 16777619) >>> 0
  }
  return h >>> 0
}

function clip(text, n = 40) {
  const chars = Array.from(String(text || '').replace(/\s+/g, ' ').trim())
  return chars.length > n ? `${chars.slice(0, n - 1).join('')}…` : chars.join('')
}

function phaseEvidence(store) {
  const evidence = []
  const user = store.recentRaw(30).filter((r) => r.role === 'user').slice(-1)[0]
  if (user) evidence.push(`raw:${user.id}`)
  const act = store.recentActions(3).filter((a) => a.status === 'ok' && a.tool !== 'close_day').slice(-1)[0]
  if (act) evidence.push(`act:${act.id}`)
  return evidence
}

/** 现在「应该」是什么状态；只看时钟和真实事件。 */
export function desiredPhase({ store, now = Date.now() }) {
  const hour = new Date(now).getHours()
  if (store.isDayClosed(dateKey(now))) return { phase: 'closed', reason: '今天的日子已经收起来了' }
  if (hour >= NIGHT_START || hour < NIGHT_END) return { phase: 'night', reason: `${NIGHT_START} 点到 ${NIGHT_END} 点是夜里` }
  const last = lastUserTs(store)
  if (last && now - last <= AWAKE_MS) return { phase: 'awake', reason: '他刚跟你说过话' }
  return { phase: 'quiet', reason: '没人在说话' }
}

/** 状态不变就不写新行；变了才结束上一条、开下一条。 */
export function syncPhase({ store, now = Date.now() }) {
  const want = desiredPhase({ store, now })
  let cur = store.currentPhase()
  // 跨午夜必须切开：前一天的状态不能一路盖到第二天，否则第二天的 phases 是空的。
  if (cur && cur.date !== dateKey(now)) {
    const midnight = startOfDay(now)
    store.endPhase(cur.id, midnight)
    store.appendPhase({
      date: dateKey(now), phase: want.phase, startedAt: midnight,
      reason: want.reason, evidence: phaseEvidence(store),
    })
    cur = store.currentPhase()
  }
  if (cur && cur.phase === want.phase) return { phase: cur, changed: false }
  if (cur) store.endPhase(cur.id, now)
  store.appendPhase({
    date: dateKey(now), phase: want.phase, startedAt: now,
    reason: want.reason, evidence: phaseEvidence(store),
  })
  return { phase: store.currentPhase(), changed: true }
}

/**
 * 进程启动时对账：上一个状态还开着，但机器可能关了很久。
 * 用「最后一次真实事件」作为分界，中间记 offline——不知道她那时在干嘛，就不写。
 */
export function reconcileOnStart({ store, now = Date.now() }) {
  const last = store.lastPhase()
  if (!last) return syncPhase({ store, now })

  const closeAt = Math.max(last.startedAt, store.lastActivityTs() || last.startedAt)
  if (!last.endedAt) {
    if (now - closeAt > OFFLINE_MS) {
      store.endPhase(last.id, closeAt)
      const offId = store.appendPhase({
        date: dateKey(closeAt), phase: 'offline', startedAt: closeAt,
        reason: '宿主没运行，这段时间没有记录', evidence: [],
      })
      store.endPhase(offId, now)
      return syncPhase({ store, now })
    }
    return syncPhase({ store, now })
  }

  if (now - last.endedAt > OFFLINE_MS) {
    const offId = store.appendPhase({
      date: dateKey(last.endedAt), phase: 'offline', startedAt: last.endedAt,
      reason: '宿主没运行，这段时间没有记录', evidence: [],
    })
    store.endPhase(offId, now)
  }
  return syncPhase({ store, now })
}

function addCloseAction(store, date, now, summary) {
  store.addAction({
    ts: now, sessionId: '', kind: 'system', tool: 'close_day',
    summary, callId: `close_day:${date}`, status: 'ok',
  })
}

/** 只收「已经过完」的日子：扫最近 7 天，把还没关、且有真实动作的一天收起来。
 *  当天永远不关——23:00 关掉会把 23:00–24:00 的话弄丢（两天都不记）。
 *  机子关机到第二天早上才开，也能在这里补上；空日子不写文件、不落归档。 */
export function closeDayIfDue({ store, now = Date.now(), dir = 'D:/life-innovation-home/diary' }) {
  const today = startOfDay(now)
  const closed = []
  for (let i = 1; i <= 7; i += 1) {
    const dayStart = addDays(today, -i)
    const date = dateKey(dayStart)
    if (store.isDayClosed(date)) continue
    // 用本地日历：23:59:59.999，不把最后一分钟切掉，也不受夏令时影响。
    const targetNow = addDays(dayStart, 1) - 1
    const blocks = syncDay({ store, now: targetNow })
    const real = blocks.filter((b) => !b.idle)
    if (!real.length) continue
    const { file } = writeDiaryFile({ store, now: targetNow, dir })
    addCloseAction(store, date, now, `把 ${date} 收起来（${real.length} 件事）`)
    closed.push({ date, count: real.length, file })
  }
  return closed.length ? { closed } : null
}

/** 梦：非事实层。只从「已经收起来的那一天」里挑真实原话当引子，标清来源，不冒充事实。
 *  不在 23 点后立刻做梦：那天还没收；第二天开机时再补，不会漏。 */
export function maybeDream({ store, now = Date.now() }) {
  const today = startOfDay(now)
  let date = null
  for (let i = 1; i <= 7; i += 1) {
    const d = dateKey(addDays(today, -i))
    if (store.isDayClosed(d) && !store.dreamForDate(d)) { date = d; break }
  }
  if (!date) return null

  const dayStart = dayStartOf(date)
  const from = addDays(dayStart, -2)
  const to = addDays(dayStart, 1) - 1
  const raws = store.rawBetween(from, to).filter((r) => String(r.text).trim().length >= 6)
  if (!raws.length) return null
  const seed = hash(date)
  const pick = raws[seed % raws.length]
  const acts = store.actionsBetween(from, to).filter((a) => a.status === 'ok' && a.tool !== 'close_day')
  const act = acts.length ? acts[seed % acts.length] : null
  const frag = clip(pick.text.replace(/[「」]/g, ''), 36)
  const templates = [
    `梦见一句没头没尾的话：「${frag}」。醒来只记得下雨。`,
    `梦里有人在等末班车，伞骨上写着「${frag}」。`,
    `梦见${act ? toolActivity(act.tool) : '自己在屋里走'}，走着走着，那句话又浮上来：「${frag}」。`,
    `梦里回到一个不认识的房间，墙上只有一行字：「${frag}」。`,
  ]
  const text = templates[seed % templates.length]
  const evidence = [`raw:${pick.id}`, ...(act ? [`act:${act.id}`] : [])]
  store.addDream({ date, ts: now, text, evidence })
  return { date, text, evidence }
}

/** 安静时真的翻一次旧记忆：落一条 ok 动作，不是假装。 */
export function maybeQuietAction({ store, now = Date.now() }) {
  const cur = store.currentPhase()
  if (!cur || cur.phase !== 'quiet') return null
  const bucket = Math.floor(now / REVIEW_EVERY_MS)
  const callId = `quiet_review:${bucket}`
  if (store.actionByCallId(callId)) return null
  const items = store.liveAssertions('他', 20)
  if (!items.length) return null
  const pick = items[hash(String(bucket)) % items.length]
  let count = 0
  try {
    count = rankedRecall({ store, query: pick.value, limit: 3 }).hits.length
  } catch {
    return null
  }
  store.addAction({
    ts: now, sessionId: '', kind: 'memory', tool: 'memory_find',
    summary: `翻了翻记得的事（「${clip(pick.value, 18)}」，找到 ${count} 条原话）`,
    callId, status: 'ok',
  })
  return { query: pick.value, hits: count }
}

/** 给她看的「现在」：一句话，只在状态变化/跨天/新梦时变，保住缓存。 */
export function rhythmText({ store, now = Date.now(), hasDreamNote = null }) {
  const cur = store.currentPhase()
  if (!cur) return ''
  const name = PHASE_NAMES[cur.phase] || cur.phase
  let text = `你现在是「${name}」的状态（从 ${clock(cur.startedAt)} 起${cur.reason ? `，${cur.reason}` : ''}）。`
  const today = dateKey(now)
  const dream = store.dreamForDate(today) || store.dreamForDate(dateKey(addDays(startOfDay(now), -1)))
  if (dream) {
    const when = dream.date === today ? '今天的梦' : '昨晚的梦'
    text += ` ${when}：${dream.text}（梦不是真事。）`
    // 只给「可以怎么留下痕迹」这个事实，不替她决定写不写。
    if (dream.date !== today && typeof hasDreamNote === 'function' && !hasDreamNote(dream.date)) {
      text += ` 如果想把梦记下来，可以用 note_write，dream_date 填 ${dream.date}。`
    }
  }
  return text
}

/** 60 秒一次的节律 tick：归档 → 状态 → 梦 → 安静时翻旧记忆。 */
export function tickRhythm({ store, now = Date.now(), dir = 'D:/life-innovation-home/diary', quietAction = null }) {
  const closed = closeDayIfDue({ store, now, dir })
  const phase = syncPhase({ store, now })
  const dream = maybeDream({ store, now })
  let quiet = null
  if (phase.phase === 'quiet' && typeof quietAction === 'function') {
    try { quiet = quietAction() } catch { quiet = null }
  }
  if (!quiet) quiet = maybeQuietAction({ store, now })
  return { closed, phase: phase.phase, dream, quiet }
}
