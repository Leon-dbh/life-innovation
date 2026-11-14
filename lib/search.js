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

// 中文里很多关键意思只有一个字（累/猫/水/书/病）。只加 bigram 会漏掉
// “我今晚为什么累”和“今天下班好晚，累死了”这种没有共同双字的句子。
// 只补这些有信息量的单字，不把“我/你/的/了”这类高频虚字放进来。
const CONTENT_CHARS = new Set('累猫水书梦灯钱病药雨雪吃睡家班名网查读写走笑哭怕忙闲冷热住'.split(''))

// 只做少量、可解释的词面归一，不引入同义词库或模型。
// 例：问“工作单位”时，原话可能只说了“在字节上班”。
const SYNONYM_TERMS = [
  [/单位|公司|上班|工作/, ['上班', '公司', '单位', '工作']],
  [/城市|住在|住哪/, ['住', '城市']],
  [/检查/, ['复查', '检查']],
  [/机器人/, ['电脑', '程序', '算是']],
  [/为什么累|好累|累死|加班/, ['下班', '加班', '累']],
  [/晚上|夜里/, ['晚上', '灯']],
]

/** 把问句里的“她”拉回对话里的“你”：她说“想你”，不是“想她”。 */
function normalizeQuery(text) {
  return String(text || '')
    .replace(/想她|想他/g, '想你')
    .replace(/她/g, '你')
}

export function termsOf(query) {
  const q = normalizeQuery(query).trim()
  if (!q) return []
  const set = new Set()
  for (const m of q.matchAll(LATIN)) set.add(m[0].toLowerCase())
  const cjk = q.replace(/[^\u4e00-\u9fa5]/g, '')
  if (cjk.length === 1) set.add(cjk)
  for (const bg of cjkBigrams(q)) set.add(bg)
  for (const ch of cjk) if (CONTENT_CHARS.has(ch)) set.add(ch)
  const synonyms = new Set()
  for (const [pattern, words] of SYNONYM_TERMS) {
    if (pattern.test(q)) for (const word of words) synonyms.add(word)
  }
  // 长问句的 bigram 可能把同义词挤出 16 个名额；先保留前 12 个直接词，
  // 再把同义词接上，最后补回被挤掉的直接词。这样“工作单位”这类长问句
  // 仍能带上“上班/公司”，不会被自己的长度截断。
  const direct = [...set]
  const head = direct.slice(0, 12)
  const tail = direct.slice(12)
  const merged = []
  const seen = new Set()
  for (const word of [...head, ...synonyms, ...tail]) {
    if (seen.has(word)) continue
    seen.add(word)
    merged.push(word)
  }
  return merged.slice(0, 16)
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
