/**
 * 召回打分：只认字面，不调模型。
 *
 * 一条原话的分数由三部分组成：
 * - 词面：查询切成 bigram/英文词后，每个词在多少条原话里出现（越稀有越值钱）。
 * - 新鲜度：按生命力曲线衰减（普通 30 天半衰，情绪句 7 天；见 lifecycle.js）。
 * - 情绪：带情绪词的原话略加权——人更容易记住「那天你很难过」。
 *
 * 同分时按时间新的在前、id 大的在前，保证同样的库每次返回同一顺序。
 */
import { vitalityOf } from './lifecycle.js'

const LATIN = /[a-z0-9]{2,}/gi

function cjkBigrams(text) {
  const chars = String(text || '').replace(/[^\u4e00-\u9fa5]/g, '')
  const out = []
  for (let i = 0; i + 1 < chars.length; i += 1) out.push(chars.slice(i, i + 2))
  return out
}

export function termsOf(query) {
  const q = String(query || '').trim()
  if (!q) return []
  const set = new Set()
  for (const m of q.matchAll(LATIN)) set.add(m[0].toLowerCase())
  const cjk = q.replace(/[^\u4e00-\u9fa5]/g, '')
  if (cjk.length === 1) set.add(cjk)
  for (const bg of cjkBigrams(q)) set.add(bg)
  return [...set].slice(0, 8)
}

/**
 * @param {{store: import('./store.js').MemoryStore, query: string, limit: number, now: number}} args
 */
export function rankedRecall({ store, query, limit = 8, now = Date.now() }) {
  const terms = termsOf(query)
  const maxLimit = Math.min(8, Math.max(1, Math.trunc(limit) || 6))
  if (!terms.length) return { terms: [], hits: [], dropped: [], scanned: 0 }

  const rows = store.candidateRaw(terms, 400)
  const totalDocs = Math.max(1, store.countRawAll())
  const df = new Map(terms.map((t) => [t, store.countRawMatches(t)]))
  const idf = (t) => Math.log(1 + totalDocs / (1 + (df.get(t) || 0)))

  const scored = rows.map((r) => {
    const text = String(r.text || '').toLowerCase()
    const hitTerms = terms.filter((t) => text.includes(t.toLowerCase()))
    const lexical = hitTerms.reduce((sum, t) => sum + idf(t), 0)
    const fresh = vitalityOf(r.ts, now, r.text)
    const emotional = /(难过|伤心|害怕|怕|累|生气|烦|想念|想你|开心|高兴|焦虑|紧张|哭)/.test(text) ? 0.2 : 0
    // 词面是主项；新鲜度和情绪是加成，不改变「完全不沾边」的排序。
    const score = lexical * (1 + fresh * 0.6 + emotional)
    return { ...r, score: Math.round(score * 10000) / 10000, terms: hitTerms, reason: reasonOf(hitTerms, fresh, emotional) }
  })
  scored.sort((a, b) => (b.score - a.score) || (b.ts - a.ts) || (b.id - a.id))

  const hits = scored.slice(0, maxLimit)
  const dropped = scored.slice(maxLimit, maxLimit + 5).map((r) => ({
    ref: `raw:${r.id}`, score: r.score, why: '排在后面（名额已满）',
  }))
  return { terms, hits, dropped, scanned: rows.length, totalDocs }
}

function reasonOf(hitTerms, fresh, emotional) {
  const parts = []
  if (hitTerms.length) parts.push(`词面命中 ${hitTerms.join('/')}`)
  parts.push(fresh >= 0.5 ? '还算新鲜' : fresh >= 0.15 ? '有些旧' : '很旧')
  if (emotional) parts.push('带情绪')
  return parts.join('，')
}
