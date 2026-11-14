/**
 * 这一轮的「记忆上下文」装配：四层，按预算拼，不删原文。
 *
 *   1. 自己（正在过的日子 / 画像 / 关系）
 *   2. 相关（按他这句话，从旧原话和事实里找 2–3 条，带出处）
 *   3. 近期（角色平衡的最近几轮，工具汇报不进）
 *   4. 没放下的事（活着的计划）
 *
 * 这是给「让她自己回答」用的上下文；不是检索命中率本身。
 * 所有内容都带 ref，方便 memory_explain / /home 回查。
 */
import { buildSelf } from './self.js'
import { rankedRecall, termsOf } from './search.js'
import { clipText, isToolReport, selectRecent } from './value.js'

const HEADER = '这一轮你想起的事（只有这些是真的；没写的，就是想不起来）：'
const DEFAULT_BUDGET = 2400

function dayLabel(ts, now) {
  const a = new Date(ts)
  const b = new Date(now)
  const start = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
  const diff = Math.round((start(b) - start(a)) / 86400000)
  if (diff === 0) return '今天'
  if (diff === 1) return '昨天'
  if (diff === -1) return '明天'
  return `${a.getMonth() + 1} 月 ${a.getDate()} 日`
}

function clock(ts) {
  const d = new Date(ts)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

function when(ts, now) {
  return `${dayLabel(ts, now)} ${clock(ts)}`
}

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

function norm(text) {
  return String(text || '').replace(/\s+/g, ' ').trim()
}

function hasTerm(text, terms) {
  const t = String(text || '').toLowerCase()
  return terms.some((term) => t.includes(String(term).toLowerCase()))
}

function assertLines(store, query, subject, now, limit = 3) {
  const terms = termsOf(query)
  if (!terms.length) return []
  const rows = store.liveAssertions ? store.liveAssertions(subject, 60) : []
  return rows
    .filter((a) => hasTerm(`${a.predicate} ${a.value}`, terms))
    .map((a) => ({
      line: `- ${clipText(a.predicate.replace(/^计划:/, ''), 16)}：${clipText(a.value, 60)}（${when(a.ts, now)}，assert:${a.id}）`,
      ref: `assert:${a.id}`,
      score: 3,
    }))
    .slice(0, limit)
}

function rawLine(row, now, why) {
  return {
    line: `- ${when(row.ts, now)} ${row.role === 'user' ? '他说' : '你说'}：${clipText(row.text, 110)}（raw:${row.id}）`,
    ref: `raw:${row.id}`,
    score: Number(row.score) || 0,
    why,
  }
}

function rawLines(store, query, now, limit = 6) {
  if (!norm(query)) return []
  const out = rankedRecall({ store, query, limit: 8, now })
  const lines = []
  const seen = new Set()
  const push = (row, why) => {
    if (!row || seen.has(Number(row.id)) || lines.length >= limit) return
    if (isToolReport(row.text)) return
    if (row.role === 'user' && norm(row.text) === norm(query)) return
    seen.add(Number(row.id))
    lines.push(rawLine(row, now, why))
  }

  for (const hit of out.hits) {
    push(hit, hit.reason)
    // 很多问题问的是「她当时怎么答的」：命中他说的话时，把紧随其后的那句她的话一起带回来。
    if (hit.role === 'user' && lines.length < limit && store.rawAfter) {
      const replies = store.rawAfter(hit.id, hit.sessionId, 6) || []
      // 下一条可能还是他的补充，也可能是一条工具汇报；继续往后找真正接住这句话的回复。
      for (const reply of replies) {
        if (reply.role === 'user') continue
        const before = lines.length
        push(reply, '接在他这句后面的话')
        if (lines.length > before) break
      }
    }
    if (lines.length >= limit) break
  }
  return lines
}

function makeSection(title, lines, refs) {
  const clean = (lines || []).filter(Boolean)
  return clean.length ? { title, lines: clean, refs: refs.filter(Boolean) } : null
}

export function buildMemoryContext({ store, userText = '', now = Date.now(), budget = DEFAULT_BUDGET, subject = '他', recentMax = 8 } = {}) {
  const sections = []

  // 1）她自己：先写自己的日子，再写别人。顺序就是注意力顺序。
  const self = buildSelf({ store, now })
  if (self.lines.length) {
    sections.push(makeSection(
      '你自己正在过的日子',
      self.lines.slice(0, 4).map((line) => `- ${clipText(String(line).replace(/^-\s*/, ''), 120)}`),
      self.items.slice(0, 4).map((i) => i.ref),
    ))
  }

  const profiles = store.profiles(subject, 6)
  if (profiles.length) {
    const lines = profiles.slice(0, 4).map((p) => `- ${describeProfile(p.key, clipText(p.value, 40))}`)
    sections.push(makeSection('关于他（他亲口说过）', lines, []))
  }

  const relation = store.relation(subject)
  if (relation) {
    sections.push(makeSection(
      '你们',
      [`- 第一次说话是 ${dayLabel(relation.firstSeen, now)}；现在的关系：${relation.stage}`],
      [],
    ))
  }

  // 2）相关：旧原话 + 相关事实；不要当前这条用户消息的复述。
  const query = norm(userText)
  const raw = rawLines(store, query, now, 6)
  const facts = assertLines(store, query, subject, now, 2)
  const relevant = [...facts, ...raw].slice(0, 7)
  const relevantSection = makeSection(
    '这一刻想起的旧事（有出处）',
    relevant.map((r) => r.line),
    relevant.map((r) => r.ref),
  )
  if (relevantSection) sections.push(relevantSection)

  // 3）近期：过滤工具汇报，角色平衡；当前这句用户消息不重复放进来。
  let recentRows = store.recentRaw(30)
  if (query) {
    let removed = false
    recentRows = recentRows.filter((r) => {
      if (!removed && r.role === 'user' && norm(r.text) === query) {
        removed = true
        return false
      }
      return true
    })
  }
  const recent = selectRecent(recentRows, { max: Math.max(6, Math.min(12, Number(recentMax) || 8)), perRole: 4, herMax: 180 })
  if (recent.length) {
    const lines = recent.map((r) => `- ${when(r.ts, now)} ${r.role === 'user' ? '他说' : '你说'}：${r.injectText}（raw:${r.id}）`)
    sections.push(makeSection('你们最近说的话（只留要紧的）', lines, recent.map((r) => `raw:${r.id}`)))
  }

  const summaries = store.recentSummaries(2)
  if (summaries.length) {
    const lines = summaries.map((s) => `- ${dayLabel(s.ts, now)}：${clipText(s.text, 120)}（sum:${s.id}）`)
    sections.push(makeSection('更早的印象', lines, summaries.map((s) => `sum:${s.id}`)))
  }

  // 4）没放下的事：活着的计划，带 assert ref。
  const plans = store.livePlans(subject, 3, now)
  if (plans.length) {
    const lines = plans.map((p) => `- ${clipText(p.predicate.replace(/^计划:/, ''), 16)}：${clipText(p.value, 60)}${p.dueAt ? `（约在 ${when(p.dueAt, now)}）` : ''}（assert:${p.id}）`)
    sections.push(makeSection('你还没放下的事', lines, plans.map((p) => `assert:${p.id}`)))
  }

  const header = HEADER
  const cap = Math.max(240, Math.trunc(Number(budget) || DEFAULT_BUDGET))
  let text = header
  const included = []
  for (const section of sections) {
    const title = `\n\n${section.title}：`
    // 标题放不下也不代表后面标题更短的 section 放不下；继续试。
    if (text.length + title.length + 4 > cap) continue
    const keptLines = []
    const keptRefs = []
    for (let i = 0; i < section.lines.length; i += 1) {
      const line = section.lines[i]
      const piece = `\n${line}`
      // 一行放不下不代表后面的短行也放不下；跳过它，继续试。
      if (text.length + title.length + keptLines.join('\n').length + piece.length > cap) continue
      keptLines.push(line)
      if (Array.isArray(section.refs) && section.refs[i]) keptRefs.push(section.refs[i])
    }
    if (!keptLines.length && section.lines.length) continue
    text += title + keptLines.map((line) => `\n${line}`).join('')
    included.push({ ...section, lines: keptLines, refs: keptRefs })
  }

  // 注入时只加“相关旧事”，避免和常驻记忆包重复；评测用 text 看四层总覆盖。
  // 预算不够时这段可能没被装进去，此时不能把没进上下文的内容说成“想起来了”。
  const relevantIncluded = included.find((s) => s.title === '这一刻想起的旧事（有出处）')
  const focus = relevantIncluded
    ? `${HEADER}\n\n${relevantIncluded.title}：\n${relevantIncluded.lines.map((line) => `- ${line.replace(/^-\s*/, '')}`).join('\n')}`
    : ''
  const finalText = included.length ? text : ''

  return {
    text: finalText,
    focusText: focus,
    sections: included,
    refs: included.flatMap((s) => s.refs || []),
    used: finalText.length,
    budget: cap,
    counts: {
      sections: included.length,
      relevant: relevant.length,
      recent: recent.length,
      plans: plans.length,
      profiles: profiles.length,
    },
    note: '原文仍在库里；这里只是这一轮装进提示词的部分。',
  }
}
