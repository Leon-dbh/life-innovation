/**
 * 把「较早的原话」机械压成一条梗概（不调模型、不编内容）。
 *
 * 触发条件不能按「总条数 % 12」：她自己的回复、定时提醒（用户那条被过滤）、
 * 失败的回复都会改变奇偶；原话超过 90 天归档后总数还会回落——任何一种都会让
 * 整除条件永远不成立（生产库里就是这么一条梗概都没有的）。
 *
 * 所以改成水位制：记住「最后一条被压进梗概的原话 id」，只压它后面的新原话；
 * 一次最多压 batch 条（summarizeTurns 总长 240 字，塞太多只会被截成半句），
 * 最近 keepRecent 条留给记忆包直接用，不进梗概。
 *
 * 水位用 id 而不是时间戳：同一毫秒的两条消息不会漏，合并/导入的历史数据也能对。
 */
import { summarizeTurns } from './extract.js'

export function maybeSummarize({ store, sessionId = '', ts = Date.now(), batch = 12, keepRecent = 8 }) {
  const { rawId } = store.lastSummaryWatermark()
  const fresh = store.rawAfterId(rawId)
  if (fresh.length < batch) return null
  const candidate = fresh.length > keepRecent ? fresh.slice(0, -keepRecent) : []
  const rows = candidate.slice(0, batch)
  if (rows.length < 4) return null
  const text = summarizeTurns(rows)
  if (!text) return null
  const sourceRefs = rows.map((row) => `raw:${row.id}`)
  store.addSummary(ts, sessionId, text, rows[0].ts, rows[rows.length - 1].ts, rows[rows.length - 1].id, sourceRefs)
  return { rows: rows.length, text, toRawId: rows[rows.length - 1].id, sourceRefs }
}
