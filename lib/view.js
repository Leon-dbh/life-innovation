/**
 * 只读视图（M3.5）：把已经发生的事摊开给人看。
 * 数据只来自 life_phases / life_blocks / actions / dreams；这里不生成任何新事实。
 */
import { startOfDay, addDays, dateKey, evidenceLabel } from './life.js'

const WEEKDAYS = ['星期日', '星期一', '星期二', '星期三', '星期四', '星期五', '星期六']

function clock(ts) {
  const d = new Date(ts)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

export function dayView({ store, now = Date.now(), days = 1 }) {
  const n = Math.max(1, Math.min(7, Number(days) || 1))
  const out = []
  for (let i = 0; i < n; i += 1) {
    const dayStart = startOfDay(addDays(now, -i))
    const date = dateKey(dayStart)
    const phases = store.phasesForDate(date).map((p) => ({
      phase: p.phase,
      start: clock(p.startedAt),
      end: p.endedAt ? clock(p.endedAt) : '现在',
      reason: p.reason,
    }))
    const blocks = store.lifeForDate(date).map((b) => ({
      activity: b.activity,
      start: clock(b.startedAt),
      end: b.endedAt > b.startedAt ? clock(b.endedAt) : '',
      evidence: b.evidence,
      idle: Boolean(b.idle || b.activity === '空档'),
    }))
    const actions = store.actionsBetween(dayStart, addDays(dayStart, 1) - 1)
      .filter((a) => a.status === 'ok')
      .map((a) => ({ ref: `act:${a.id}`, time: clock(a.ts), tool: a.tool || '', summary: a.summary }))
    const dreams = store.dreamsForDate(date).map((d) => d.text)
    out.push({
      date,
      weekday: WEEKDAYS[new Date(dayStart).getDay()],
      closed: store.isDayClosed(date),
      phases,
      blocks,
      actions,
      dreams,
    })
  }
  return { days: out }
}

export function renderDays(args) {
  const { days } = dayView(args)
  const lines = []
  for (const d of days) {
    lines.push(`# ${d.date}（${d.weekday}）${d.closed ? ' · 已归档' : ''}`, '')
    if (d.phases.length) {
      lines.push('## 状态')
      for (const p of d.phases) lines.push(`- ${p.start}–${p.end} ${p.phase}${p.reason ? `（${p.reason}）` : ''}`)
      lines.push('')
    }
    lines.push('## 这一天真的做过的事')
    const real = d.blocks.filter((b) => !b.idle)
    if (!real.length) lines.push('- （没有记录到动作。）')
    for (const b of real) {
      const ev = b.evidence.length ? `（证据：${evidenceLabel(b.evidence)}）` : '（证据：无）'
      lines.push(`- ${b.start}${b.end ? `–${b.end}` : ''} ${b.activity} ${ev}`)
    }
    const idle = d.blocks.filter((b) => b.idle)
    if (idle.length) {
      lines.push('', '空着的时间（没有动作，不是活动）：')
      for (const b of idle) lines.push(`- ${b.start}–${b.end} 空档`)
    }
    if (d.actions.length) {
      lines.push('', '## 动作账本（可核对）')
      for (const a of d.actions) lines.push(`- ${a.time} ${a.ref} ${a.summary}`)
    }
    if (d.dreams.length) {
      lines.push('', '## 梦（不是真事）')
      for (const text of d.dreams) lines.push(`- ${text}`)
    }
    lines.push('')
  }
  return lines.join('\n').trimEnd()
}
