/**
 * 她翻自己记忆的只读工具，以及一个「看自己现在是什么状态」的只读工具。
 *
 * 目的：记忆包（系统提示词）里只放压缩后的要点；当她想确认「原话是怎么说的」
 * 「我们第一次提这个是什么时候」，让她自己去查原文，而不是把 200 轮原文常驻在上下文里。
 *
 * 边界：
 * - 只读，不改库（回收站/归档是维护命令的事，不给她工具）。
 * - memory_find 最多 8 条、每条最多 200 字；memory_read 最多 2000 字。
 * - 只查她自己的库（raw_turns / raw_archive / actions），没有网络。
 */
import { rankedRecall } from './search.js'
import { recordRecall } from './observe.js'
import { dateKey } from './life.js'
import { dayView } from './view.js'

const FIND_MAX = 8
const SNIPPET_MAX = 200
const READ_MAX = 2000
const SUBJECT = '他'

function fmtWhen(ts) {
  const d = new Date(ts)
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

function who(role) {
  if (role === 'user') return '他说'
  // 库里她的原话存成 'her'（历史数据也可能是 'assistant'）。
  if (role === 'her' || role === 'assistant') return '她说'
  return '记录'
}

function snippet(text, max = SNIPPET_MAX) {
  const flat = String(text).replace(/\s+/g, ' ').trim()
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat
}

const HIT_SCHEMA = {
  type: 'object',
  properties: {
    ref: { type: 'string' },
    when: { type: 'string' },
    who: { type: 'string' },
    text: { type: 'string' },
    score: { type: 'number' },
    why: { type: 'string' },
    archived: { type: 'boolean' },
  },
  required: ['ref', 'when', 'who', 'text', 'score', 'why', 'archived'],
  additionalProperties: false,
}

const findTool = {
  name: 'memory_find',
  description: '在自己的记忆里按关键词找原话（按相关度排序，会考虑新鲜度和情绪，不是只按时间）。想确认某件事是不是真的听过、原话怎么说的、什么时候说的时用。只返回摘要片段；要看全文用 memory_read。',
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
        recall: {
          type: 'object',
          properties: {
            terms: { type: 'array', items: { type: 'string' } },
            scanned: { type: 'integer' },
          },
          required: ['terms', 'scanned'],
          additionalProperties: false,
        },
        hits: { type: 'array', items: HIT_SCHEMA },
      },
      required: ['total', 'recall', 'hits'],
      additionalProperties: false,
    },
    render: (_args, value) => {
      if (!value.hits.length) return [{ type: 'text', text: '没有找到相关的原话。' }]
      const lines = value.hits.map((h, i) => `${i + 1}. ${h.when} ${h.who}：${h.text}（ref: ${h.ref}，${h.why}${h.archived ? '，已归档' : ''}）`)
      return [{ type: 'text', text: lines.join('\n') }]
    },
  },
  async execute(args) {
    const limit = Math.min(FIND_MAX, Math.max(1, Math.trunc(Number(args.limit) || 6)))
    const query = String(args.query || '').trim()
    const { terms, hits: ranked, dropped, scanned } = rankedRecall({ store: this.store, query, limit })
    const hits = ranked.map((r) => ({
      ref: `raw:${r.id}`, when: fmtWhen(r.ts), who: who(r.role), text: snippet(r.text),
      score: r.score, why: r.reason, archived: Boolean(r.archived),
    }))
    recordRecall({
      tool: 'memory_find', query, terms, scanned,
      hits: hits.map((h) => ({ ref: h.ref, score: h.score, why: h.why })),
      dropped,
    })
    return { total: hits.length, recall: { terms, scanned }, hits }
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
        archived: { type: 'boolean' },
      },
      required: ['ref', 'when', 'who', 'text', 'truncated', 'archived'],
      additionalProperties: false,
    },
    render: (_args, value) => [{ type: 'text', text: `${value.text}\n\n（${value.ref}，${value.when} ${value.who}${value.archived ? '，已归档' : ''}）` }],
  },
  async execute(args) {
    const ref = String(args.ref || '').trim()
    const m = /^(raw|act):(\d+)$/.exec(ref)
    if (!m) return { ref, when: '', who: '', text: `看不懂这个 ref：${ref}`, truncated: false, archived: false }
    if (m[1] === 'act') {
      const a = this.store.actionById(Number(m[2]))
      if (!a) return { ref, when: '', who: '', text: `没有这条记录：${ref}`, truncated: false, archived: false }
      const text = `${a.summary || a.tool || '做了一件事'}（工具：${a.tool || '未知'}，状态：${a.status || '未知'}）`
      return { ref, when: fmtWhen(a.ts), who: '动作', text, truncated: false, archived: false }
    }
    const row = this.store.rawById(Number(m[2]))
    if (!row) return { ref, when: '', who: '', text: `没有这条记录：${ref}`, truncated: false, archived: false }
    const full = String(row.text)
    const cut = full.length > READ_MAX
    return {
      ref, when: fmtWhen(row.ts), who: who(row.role),
      text: cut ? `${full.slice(0, READ_MAX - 1)}…` : full, truncated: cut, archived: Boolean(row.archived),
    }
  },
}

// 宿主的 JSON Schema 只认布尔 additionalProperties（dsh-tools 的受限子集），
// 嵌套对象必须逐字段声明；而 lastPack/lastRecall/relation 在还没有记录时是 null，
// 所以用 oneOf 显式允许 null，否则第一次调用 jingjing_status 会因输出校验失败而报错。
const NULLABLE_OBJECT = {
  oneOf: [
    { type: 'object', additionalProperties: true },
    { type: 'null' },
  ],
}

const STATS_SCHEMA = {
  type: 'object',
  properties: {
    raw: { type: 'integer' },
    archived: { type: 'integer' },
    summaries: { type: 'integer' },
    assertions: { type: 'integer' },
    profiles: { type: 'integer' },
    actions: { type: 'integer' },
    lifeBlocks: { type: 'integer' },
    recycle: { type: 'integer' },
  },
  required: ['raw', 'archived', 'summaries', 'assertions', 'profiles', 'actions', 'lifeBlocks', 'recycle'],
  additionalProperties: false,
}


const PHASE_SCHEMA = {
  type: 'object',
  properties: {
    phase: { type: 'string' },
    start: { type: 'string' },
    end: { type: 'string' },
    reason: { type: 'string' },
  },
  required: ['phase', 'start', 'end', 'reason'],
  additionalProperties: false,
}

const BLOCK_SCHEMA = {
  type: 'object',
  properties: {
    activity: { type: 'string' },
    start: { type: 'string' },
    end: { type: 'string' },
    evidence: { type: 'array', items: { type: 'string' } },
    idle: { type: 'boolean' },
  },
  required: ['activity', 'start', 'end', 'evidence', 'idle'],
  additionalProperties: false,
}

const ACTION_SCHEMA = {
  type: 'object',
  properties: {
    ref: { type: 'string' },
    time: { type: 'string' },
    tool: { type: 'string' },
    summary: { type: 'string' },
  },
  required: ['ref', 'time', 'tool', 'summary'],
  additionalProperties: false,
}

const DAY_SCHEMA = {
  type: 'object',
  properties: {
    date: { type: 'string' },
    weekday: { type: 'string' },
    closed: { type: 'boolean' },
    phases: { type: 'array', items: PHASE_SCHEMA },
    blocks: { type: 'array', items: BLOCK_SCHEMA },
    actions: { type: 'array', items: ACTION_SCHEMA },
    dreams: { type: 'array', items: { type: 'string' } },
  },
  required: ['date', 'weekday', 'closed', 'phases', 'blocks', 'actions', 'dreams'],
  additionalProperties: false,
}

function renderDaysSummary(value) {
  const lines = []
  for (const d of value.days) {
    lines.push(`${d.date}（${d.weekday}）${d.closed ? ' · 已归档' : ''}`)
    const real = d.blocks.filter((b) => !b.idle)
    if (real.length) {
      for (const b of real) {
        const ev = b.evidence.length ? `（${b.evidence.join('、')}）` : ''
        lines.push(`- ${b.start}${b.end ? `–${b.end}` : ''} ${b.activity}${ev}`)
      }
    } else {
      lines.push('- （没有记录到动作。）')
    }
    if (d.dreams.length) lines.push(`- 梦：${d.dreams.join('；')}（不是真事）`)
  }
  return lines.join(String.fromCharCode(10))
}

const daysTool = {
  name: 'jingjing_days',
  description: '看自己这几天的日子：状态、真实做过的事、动作账本、梦（梦不是真事）。只读，默认今天，最多 7 天。',
  parameters: {
    type: 'object',
    properties: {
      days: { type: 'integer', description: '往前看几天，1–7，默认 1。' },
    },
    required: [],
    additionalProperties: false,
  },
  output: {
    schema: {
      type: 'object',
      properties: {
        days: { type: 'array', items: DAY_SCHEMA },
      },
      required: ['days'],
      additionalProperties: false,
    },
    render: (_args, value) => [{ type: 'text', text: renderDaysSummary(value) }],
  },
  async execute(args) {
    const days = Math.max(1, Math.min(7, Math.trunc(Number(args.days) || 1)))
    return dayView({ store: this.store, now: Date.now(), days })
  },
}

const statusTool = {
  name: 'jingjing_status',
  description: '看自己现在的记忆与日子状态：记得多少条、今天做过什么、最近一次想起来的是什么（只读，不改任何东西）。',
  parameters: { type: 'object', properties: {}, additionalProperties: false },
  output: {
    schema: {
      type: 'object',
      properties: {
        stats: STATS_SCHEMA,
        today: { type: 'array', items: { type: 'string' } },
        lastPack: NULLABLE_OBJECT,
        lastRecall: NULLABLE_OBJECT,
        relation: NULLABLE_OBJECT,
      },
      required: ['stats', 'today', 'lastPack', 'lastRecall', 'relation'],
      additionalProperties: false,
    },
    render: (_args, value) => {
      const s = value.stats
      const lines = [
        `记忆：原话 ${s.raw} 条（归档 ${s.archived}，回收站 ${s.recycle}）｜要点 ${s.assertions}｜梗概 ${s.summaries}｜画像 ${s.profiles}`,
        `动作 ${s.actions} 条｜日子块 ${s.lifeBlocks} 块`,
      ]
      if (value.today.length) lines.push(`今天：${value.today.join('；')}`)
      if (value.lastPack?.chars) lines.push(`上次注入记忆包 ${value.lastPack.chars} 字（${value.lastPack.cache}）`)
      if (value.lastRecall?.query) lines.push(`上次召回「${value.lastRecall.query}」：${(value.lastRecall.hits || []).map((h) => h.ref).join('、') || '无'}`)
      return [{ type: 'text', text: lines.join('\n') }]
    },
  },
  async execute() {
    const stats = this.store.stats()
    const today = this.store.lifeForDate(dateKey(Date.now()))
      .filter((b) => b.evidence && b.evidence.length)
      .map((b) => b.activity)
    const { packs, recalls } = this.observe.snapshot()
    return {
      stats,
      today,
      lastPack: packs.length ? packs[packs.length - 1] : null,
      lastRecall: recalls.length ? recalls[recalls.length - 1] : null,
      relation: this.store.relation(SUBJECT),
    }
  },
}

/**
 * 注册工具；返回一个可释放的 dispose。
 * @param {{ ctx: any, store: import('./store.js').MemoryStore, observe?: any }} deps
 */
export function registerMemoryTools({ ctx, store, observe }) {
  const { snapshot } = observe || { snapshot: () => ({ packs: [], recalls: [] }) }
  const disposers = []
  for (const base of [findTool, readTool, statusTool, daysTool]) {
    const def = {
      ...base,
      execute: base.execute.bind({ store, observe: { snapshot } }),
    }
    disposers.push(ctx.tools.register(def))
  }
  return () => {
    for (const dispose of disposers) {
      try { dispose() } catch { /* 释放失败不阻塞卸载 */ }
    }
  }
}
