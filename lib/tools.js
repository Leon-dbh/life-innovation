/**
 * 她翻自己记忆的两个只读工具。
 *
 * 目的：记忆包（系统提示词）里只放压缩后的要点；当她想确认「原话是怎么说的」「我们第一次提这个是什么时候」，
 * 让她自己去查原文，而不是让我们把 200 轮原文常驻在上下文里。
 *
 * 边界：
 * - 只读，不改库。
 * - memory_find 最多 8 条、每条最多 200 字；memory_read 最多 2000 字。
 * - 只查她自己的库（raw_turns / actions），没有网络、没有别的会话读取。
 */

const FIND_MAX = 8
const SNIPPET_MAX = 200
const READ_MAX = 2000

function fmtWhen(ts) {
  const d = new Date(ts)
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

function who(role) {
  if (role === 'user') return '他说'
  if (role === 'assistant') return '她说'
  return '记录'
}

function snippet(text, max = SNIPPET_MAX) {
  const flat = String(text).replace(/\s+/g, ' ').trim()
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat
}

const findTool = {
  name: 'memory_find',
  description: '在自己的记忆里按关键词找原话。想确认某件事是不是真的听过、原话怎么说的、什么时候说的时用。只返回摘要片段；要看全文用 memory_read。',
  parameters: {
    type: 'object',
    properties: {
      query: { type: 'string', description: '要找的关键词，尽量短（人名、地点、事件名）。' },
      limit: { type: 'integer', description: '最多几条，1–8，默认 6。' },
    },
    required: ['query'],
    additionalProperties: false,
  },
  output: {
    schema: {
      type: 'object',
      properties: {
        total: { type: 'integer' },
        hits: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              ref: { type: 'string' },
              when: { type: 'string' },
              who: { type: 'string' },
              text: { type: 'string' },
            },
            required: ['ref', 'when', 'who', 'text'],
            additionalProperties: false,
          },
        },
      },
      required: ['total', 'hits'],
      additionalProperties: false,
    },
    render: (_args, value) => {
      if (!value.hits.length) return [{ type: 'text', text: '没有找到相关的原话。' }]
      const lines = value.hits.map((h, i) => `${i + 1}. ${h.when} ${h.who}：${h.text}（ref: ${h.ref}）`)
      return [{ type: 'text', text: lines.join('\n') }]
    },
  },
  async execute(args) {
    const limit = Math.min(FIND_MAX, Math.max(1, Math.trunc(Number(args.limit) || 6)))
    const rows = this.store.searchRaw(String(args.query || '').trim(), limit)
    const hits = rows.map((r) => ({
      ref: `raw:${r.id}`, when: fmtWhen(r.ts), who: who(r.role), text: snippet(r.text),
    }))
    return { total: hits.length, hits }
  },
}

const readTool = {
  name: 'memory_read',
  description: '按 ref 读一条记忆的原文（ref 来自 memory_find，例如 raw:12）。最多返回 2000 字。',
  parameters: {
    type: 'object',
    properties: {
      ref: { type: 'string', description: '记录的引用，形如 raw:12 或 act:3。' },
    },
    required: ['ref'],
    additionalProperties: false,
  },
  output: {
    schema: {
      type: 'object',
      properties: {
        ref: { type: 'string' },
        when: { type: 'string' },
        who: { type: 'string' },
        text: { type: 'string' },
        truncated: { type: 'boolean' },
      },
      required: ['ref', 'when', 'who', 'text', 'truncated'],
      additionalProperties: false,
    },
    render: (_args, value) => [{ type: 'text', text: `${value.text}\n\n（${value.ref}，${value.when} ${value.who}）` }],
  },
  async execute(args) {
    const ref = String(args.ref || '').trim()
    const m = /^(raw|act):(\d+)$/.exec(ref)
    if (!m) return { ref, when: '', who: '', text: `看不懂这个 ref：${ref}`, truncated: false }
    if (m[1] === 'act') {
      const a = this.store.actionById(Number(m[2]))
      if (!a) return { ref, when: '', who: '', text: `没有这条记录：${ref}`, truncated: false }
      const text = `${a.summary || a.tool || '做了一件事'}（工具：${a.tool || '未知'}，状态：${a.status || '未知'}）`
      return { ref, when: fmtWhen(a.ts), who: '动作', text, truncated: false }
    }
    const row = this.store.rawById(Number(m[2]))
    if (!row) return { ref, when: '', who: '', text: `没有这条记录：${ref}`, truncated: false }
    const full = String(row.text)
    const cut = full.length > READ_MAX
    return {
      ref, when: fmtWhen(row.ts), who: who(row.role),
      text: cut ? `${full.slice(0, READ_MAX)}…` : full, truncated: cut,
    }
  },
}

/**
 * 注册工具；返回一个可释放的 dispose。
 * @param {{ ctx: any, store: import('./store.js').MemoryStore }} deps
 */
export function registerMemoryTools({ ctx, store }) {
  const disposers = []
  for (const base of [findTool, readTool]) {
    const def = {
      ...base,
      execute: base.execute.bind({ store }),
    }
    disposers.push(ctx.tools.register(def))
  }
  return () => {
    for (const dispose of disposers) {
      try { dispose() } catch { /* 释放失败不阻塞卸载 */ }
    }
  }
}
