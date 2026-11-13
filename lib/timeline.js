/**
 * 生活时间线：把一天里真实发生过的几层记录缝在一起。
 *
 * 边界：
 * - 只读已有记录，不推断、不补写；
 * - 对话、动作、梦、书是“发生的事”；life_blocks 是已经聚合过的“章节”；
 * - 每条都带 ref，能回到原始记录；
 * - 空档不伪装成活动；没有记录就返回空。
 */
import { dateKey, startOfDay, addDays, toolActivity } from './life.js'

const PHASE_NAMES = {
  awake: '醒着',
  quiet: '安静',
  night: '夜里',
  closed: '今天已经收起来',
  offline: '没在运行',
}

function clock(ts) {
  const d = new Date(Number(ts))
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

function clip(text, n = 160) {
  const chars = Array.from(String(text || '').replace(/\s+/g, ' ').trim())
  return chars.length > n ? `${chars.slice(0, n - 1).join('')}…` : chars.join('')
}

/** 把 YYYY-MM-DD 解析成本地日界线；不合法返回 null。 */
export function boundsForDate(date) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(date || ''))
  if (!m) return null
  const year = Number(m[1])
  const month = Number(m[2])
  const day = Number(m[3])
  const start = new Date(year, month - 1, day).getTime()
  const check = new Date(start)
  if (check.getFullYear() !== year || check.getMonth() !== month - 1 || check.getDate() !== day) return null
  return { start, end: new Date(year, month - 1, day + 1).getTime() - 1 }
}

/** 把 phases 里跨日的状态裁到当天；没有结束时间的，裁到当天结束。 */
function phasesForDay(store, date, end) {
  const rows = store.phasesBetween
    ? store.phasesBetween(startOfDay(end), end)
    : (store.phasesForDate(date) || [])
  return (rows || []).map((p) => {
    const from = Math.max(Number(p.startedAt), startOfDay(end))
    const to = Math.min(p.endedAt === null ? end : Number(p.endedAt), end)
    return {
      ref: `phase:${p.id}`,
      phase: String(p.phase),
      label: PHASE_NAMES[p.phase] || String(p.phase),
      from: Math.max(from, Number(p.startedAt) || from),
      to: Math.max(to, from),
      reason: String(p.reason || ''),
      evidence: Array.isArray(p.evidence) ? p.evidence : [],
    }
  })
}

function eventOrder(kind) {
  return { talk: 0, action: 1, dream: 2, book: 3 }[kind] ?? 9
}

/**
 * @param {{store: object, date?: string, now?: number}} input
 * @returns {{date:string, start:number, end:number, phases:Array, chapters:Array, events:Array, counts:object, text:string}}
 */
export function buildTimeline({ store, date = dateKey(Date.now()), now = Date.now() } = {}) {
  const bounds = boundsForDate(date)
  const day = bounds ? String(date) : dateKey(now)
  const b = bounds || { start: startOfDay(now), end: addDays(startOfDay(now), 1) - 1 }
  const end = Math.min(b.end, Math.max(b.start, Number(now)))
  const phases = phasesForDay(store, day, end)
  const blocks = store.lifeForDate(day) || []
  const chapters = blocks
    .filter((x) => !x.idle)
    .map((x) => ({
      ref: `life:${x.id}`,
      activity: String(x.activity),
      from: Number(x.startedAt),
      to: Number(x.endedAt),
      evidence: Array.isArray(x.evidence) ? x.evidence : [],
    }))

  const events = []
  for (const t of store.rawBetween(b.start, end) || []) {
    events.push({
      at: Number(t.ts), time: clock(t.ts), kind: 'talk', ref: `raw:${t.id}`,
      who: t.role === 'user' ? '他' : '她', text: clip(t.text), status: '',
    })
  }
  for (const a of store.actionsBetween(b.start, end) || []) {
    events.push({
      at: Number(a.ts), time: clock(a.ts), kind: 'action', ref: `act:${a.id}`,
      who: '动作', text: clip(a.summary || toolActivity(a.tool, '', a.meta)), status: String(a.status || ''),
    })
  }
  const dream = store.dreamForDate(day)
  if (dream) {
    events.push({
      at: Number(dream.ts), time: clock(dream.ts), kind: 'dream', ref: `dream:${dream.id}`,
      who: '梦', text: clip(dream.text), status: dream.nonFactual === false ? 'fact' : 'dream',
    })
  }
  for (const book of store.booksTouchedBetween(b.start, end) || []) {
    events.push({
      at: Number(book.updatedAt), time: clock(book.updatedAt), kind: 'book', ref: `book:${book.id}`,
      who: '书', text: `《${clip(book.title, 40)}》读到 ${Number(book.offset)}/${Number(book.total)} 字`, status: '',
    })
  }
  events.sort((x, y) => x.at - y.at || eventOrder(x.kind) - eventOrder(y.kind) || String(x.ref).localeCompare(String(y.ref)))

  const counts = {
    talk: events.filter((e) => e.kind === 'talk').length,
    actions: events.filter((e) => e.kind === 'action').length,
    dreams: events.filter((e) => e.kind === 'dream').length,
    books: events.filter((e) => e.kind === 'book').length,
    chapters: chapters.length,
    phases: phases.length,
  }
  const text = renderTimelineText({ date: day, chapters, phases, events })
  return { date: day, start: b.start, end, phases, chapters, events, counts, text }
}

export function renderTimelineText({ date, chapters = [], phases = [], events = [] }) {
  const lines = [`${date} 的一天`]
  if (chapters.length) {
    lines.push('', '章节：')
    for (const c of chapters) {
      const span = c.to > c.from ? `${clock(c.from)}–${clock(c.to)}` : clock(c.from)
      lines.push(`- ${span} ${c.activity}（${c.ref}）`)
    }
  }
  if (phases.length) {
    lines.push('', '状态：')
    for (const p of phases) {
      const span = p.to > p.from ? `${clock(p.from)}–${clock(p.to)}` : clock(p.from)
      lines.push(`- ${span} ${p.label}${p.reason ? `：${p.reason}` : ''}`)
    }
  }
  if (events.length) {
    lines.push('', '发生的事：')
    for (const e of events) {
      const status = e.status ? `（${e.status}）` : ''
      lines.push(`- ${e.time} ${e.who}：${e.text}${status}（${e.ref}）`)
    }
  } else {
    lines.push('', '这一天没有留下可查的记录。')
  }
  return lines.join('\n')
}
