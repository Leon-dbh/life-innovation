/**
 * 记忆包：每次组装系统提示词时，从库里现算一段「她记得的事」。
 * 纯确定性（同样的库 → 同样的字），便于 prompt cache，也便于审计。
 */

import { dateKey } from './life.js'

const MAX_LINE = 90

function clip(text, n = MAX_LINE) {
  const clean = String(text || '').replace(/\s+/g, ' ').trim()
  return clean.length > n ? `${clean.slice(0, n - 1)}…` : clean
}

function dayLabel(ts, now) {
  const a = new Date(ts)
  const b = new Date(now)
  const startOf = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
  const diff = Math.round((startOf(b) - startOf(a)) / 86400000)
  if (diff <= 0) return '今天'
  if (diff === 1) return '昨天'
  return `${a.getMonth() + 1} 月 ${a.getDate()} 日`
}

function clock(ts) {
  const d = new Date(ts)
  const hh = String(d.getHours()).padStart(2, '0')
  const mm = String(d.getMinutes()).padStart(2, '0')
  return `${hh}:${mm}`
}

function when(ts, now) {
  return `${dayLabel(ts, now)} ${clock(ts)}`
}

const PROFILE_ORDER = ['名字', '住在', '工作', '年龄', '生日', '养了', '宠物', '喜欢']

function describeProfile(key, value) {
  switch (key) {
    case '名字': return `他叫${value}`
    case '住在': return `他住在${value}`
    case '工作': return `他在${value}上班`
    case '年龄': return `他今年${value}`
    case '生日': return `他生日在${value}`
    case '养了': return `他养了${value}`
    case '宠物': return `他的${value}`
    default: return `他${value}`
  }
}

export function buildPackDetailed({ store, now = Date.now(), maxChars = 1200, subject = '他' }) {
  const sections = []

  const profiles = store.profiles(subject, 10)
  if (profiles.length) {
    const items = profiles
      .sort((a, b) => {
        const ia = PROFILE_ORDER.indexOf(a.key)
        const ib = PROFILE_ORDER.indexOf(b.key)
        return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib)
      })
      .slice(0, 6)
      .map((p) => `- ${describeProfile(p.key, clip(p.value, 40))}（${dayLabel(p.updatedAt, now)}）`)
    sections.push({ title: '关于他（都是他亲口说的）', lines: items })
  }

  const plans = store.livePlans(subject, 2, now)
  if (plans.length) {
    sections.push({
      title: '他最近提过的打算',
      lines: plans.map((p) => `- ${clip(p.predicate.replace(/^计划:/, ''), 12)}${clip(p.value, 40)}（${dayLabel(p.ts, now)}）${p.dueAt ? `，约在 ${when(p.dueAt, now)}` : ''}`),
    })
  }

  const today = store.lifeForDate(dateKey(now)).filter((b) => b.evidence.length > 0)
  if (today.length) {
    sections.push({
      title: '你今天的日子（每一件都真的做过）',
      lines: today.slice(0, 4).map((b) => {
        const span = b.endedAt > b.startedAt + 60 * 1000 ? `${clock(b.startedAt)}–${clock(b.endedAt)}` : clock(b.startedAt)
        return `- ${span} ${clip(b.activity, 20)}（${b.evidence.length} 条记录）`
      }),
    })
  }

  // 只列真的做成了的事：pending 是还没动手，error 是没做成，都不能写成「你做过」。
  const actions = store.recentActions(6).filter((a) => a.status === 'ok' || a.status === 'called').slice(-3)
  if (actions.length) {
    sections.push({
      title: '你最近做过的事',
      lines: actions.map((a) => `- ${dayLabel(a.ts, now)} ${clock(a.ts)} 你${a.tool ? `用了「${a.tool}」` : '做了点事'}：${clip(a.summary || a.status, 60)}`),
    })
  }

  const recent = store.recentRaw(6)
  if (recent.length) {
    sections.push({
      title: '你们最近说的话',
      lines: recent.map((r) => `- ${when(r.ts, now)} ${r.role === 'user' ? '他说' : '你说'}：${clip(r.text)}`),
    })
  }

  const summaries = store.recentSummaries(2)
  if (summaries.length) {
    sections.push({
      title: '更早的印象',
      lines: summaries.map((s) => `- ${dayLabel(s.ts, now)}：${clip(s.text, 120)}`),
    })
  }

  const relation = store.relation(subject)
  if (relation) {
    sections.push({
      title: '你们',
      lines: [`- 第一次说话是 ${dayLabel(relation.firstSeen, now)}，之后一共说过 ${relation.turns} 句话`],
    })
  }

  if (!sections.length) return { text: '', sections: [] }

  const header = '你记得的事（只有这些是真的；没写的，就是想不起来）：'
  let out = header
  for (const section of sections) {
    const title = `\n\n${section.title}：`
    if (out.length + title.length + 4 > maxChars) break
    out += title
    for (const line of section.lines) {
      const piece = `\n${line}`
      if (out.length + piece.length <= maxChars) {
        out += piece
        continue
      }
      // 预算不够整行时不切半行：能放下一个短版就放短版，否则停在上一行。
      const remain = maxChars - out.length - 1
      if (remain >= 12) out += `\n${clip(line, remain - 1)}`
      return { text: out, sections: sectionMeta(sections) }
    }
  }
  return { text: out, sections: sectionMeta(sections) }
}

function sectionMeta(sections) {
  return sections.map((s) => ({ title: s.title, lines: s.lines.length }))
}

/** 只要文字（大多数调用方用这个）。 */
export function buildPack(args) {
  return buildPackDetailed(args).text
}
