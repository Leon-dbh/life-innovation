/**
 * 睡眠巩固：一天收起来之后，她只留下自己确认记得的那一小段。
 *
 * 边界：
 * - 只读已归档的那一天；没关的日子不巩固；
 * - 不调用模型，不编没有证据的活动；
 * - 一天一条，INSERT OR IGNORE；重复跑不覆盖旧记录；
 * - 梦只作为“不是真事”的一行，不进事实。
 */
import { addDays, dateKey, startOfDay } from './life.js'
import { buildTimeline } from './timeline.js'

function clock(ts) {
  const d = new Date(Number(ts))
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

function clip(text, n = 80) {
  const chars = Array.from(String(text || '').replace(/\s+/g, ' ').trim())
  return chars.length > n ? `${chars.slice(0, n - 1).join('')}…` : chars.join('')
}

/** 从时间线生成一天的自我巩固文本；没有任何真实记录时返回 null。 */
export function snapshotFromTimeline({ date, timeline, dream = null }) {
  const chapters = timeline.chapters || []
  const events = timeline.events || []
  if (!chapters.length && !events.length) return null
  const lines = [`${date} 收起来的时候，她记得这一天真的发生过：`]
  if (chapters.length) {
    for (const c of chapters.slice(0, 12)) {
      const span = c.to > c.from ? `${clock(c.from)}–${clock(c.to)}` : clock(c.from)
      lines.push(`- ${span} ${clip(c.activity, 48)}（${c.ref}）`)
    }
  }
  if (timeline.counts.talk) lines.push(`- 和他说过 ${timeline.counts.talk} 段话`)
  if (timeline.counts.actions) lines.push(`- 做成了 ${timeline.counts.actions} 件有记录的事`)
  if (timeline.counts.books) lines.push(`- 翻过 ${timeline.counts.books} 次书`)
  if (dream) lines.push(`- 夜里梦见：${clip(dream.text, 70)}（梦不是真事，${`dream:${dream.id}`}）`)
  const evidence = [
    ...chapters.map((c) => c.ref),
    ...(dream ? [`dream:${dream.id}`] : []),
    ...events.filter((e) => e.kind === 'book').map((e) => e.ref),
  ].filter(Boolean)
  return { text: lines.join('\n'), evidence: [...new Set(evidence)].slice(0, 80) }
}

/**
 * 巩固某一天。已经巩固过就直接返回旧记录（created:false）。
 * @returns {{snapshot:object, created:boolean}|null}
 */
export function consolidateDay({ store, date, now = Date.now(), dream = null } = {}) {
  const day = String(date || '')
  if (!day) return null
  const existing = store.selfSnapshotForDate(day)
  if (existing) return { snapshot: existing, created: false }
  const timeline = buildTimeline({ store, date: day, now })
  const d = dream || store.dreamForDate(day)
  const built = snapshotFromTimeline({ date: day, timeline, dream: d })
  if (!built) return null
  const snapshot = store.addSelfSnapshot({ date: day, ts: now, text: built.text, evidence: built.evidence })
  return { snapshot, created: true }
}

/** 扫最近几天已经收起来、但还没有巩固的日子；一天只做一次。 */
export function consolidateClosedDays({ store, now = Date.now(), lookback = 7 } = {}) {
  const today = startOfDay(now)
  const made = []
  for (let i = 1; i <= Math.max(1, Number(lookback) || 7); i += 1) {
    const day = dateKey(addDays(today, -i))
    if (!store.isDayClosed(day)) continue
    const result = consolidateDay({ store, date: day, now })
    if (result?.created) made.push(result.snapshot)
  }
  return made
}
