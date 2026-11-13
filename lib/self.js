/**
 * 她的“自我叙事”：只说她自己的日子，不评价他。
 *
 * 这些行全部来自库里已经发生的事（life_blocks / actions / dreams / books / raw_turns），
 * 不调用模型、不编造；每条都带 ref，方便 memory_explain 和 /home 回查。
 */

import { dateKey, startOfDay, toolActivity } from './life.js'

const MAX_LINE = 60

function clip(text, n = MAX_LINE) {
  const chars = Array.from(String(text || '').replace(/\s+/g, ' ').trim())
  return chars.length > n ? `${chars.slice(0, n - 1).join('')}…` : chars.join('')
}

function percent(book) {
  if (!book || !book.total) return ''
  const p = Math.max(0, Math.min(100, Math.floor((book.offset / book.total) * 100)))
  return p > 0 ? `，读到 ${p}%` : ''
}

/**
 * 把已经查好的数据排成自我叙事。/home 为了不依赖 lib 目录，保留了一份等价的本地实现。
 * @param {{date:string, blocks?:Array, actions?:Array, dream?:object|null, book?:object|null, talkCount?:number, now?:number}} data
 */
export function selfFromData({
  date,
  blocks = [],
  actions = [],
  dream = null,
  book = null,
  snapshot = null,
  talkCount = 0,
  now = Date.now(),
} = {}) {
  const items = []

  const real = blocks.filter((b) => b && !b.idle)
  const active = real
    .filter((b) => !b.endedAt || Number(b.endedAt) >= now - 90 * 60 * 1000)
    .at(-1)
  if (active) {
    items.push({
      kind: 'now',
      ref: `life:${active.id}`,
      text: `此刻：${clip(active.activity, 48)}`,
      why: '来自今天的日子块',
    })
  }

  const done = actions.filter((a) => a && a.status === 'ok')
  const last = done.at(-1)
  if (last) {
    items.push({
      kind: 'did',
      ref: `act:${last.id}`,
      text: `最近你做了：${clip(last.summary || toolActivity(last.tool, '', last.meta), 48)}`,
      why: '来自动作账本，只算真的做成了的',
    })
  }

  if (talkCount > 0) {
    items.push({
      kind: 'talk',
      ref: `day:${date}`,
      text: `今天和他说过 ${talkCount} 段话`,
      why: '来自今天的原话记录',
    })
  }

  if (snapshot) {
    const remembered = String(snapshot.text || '').split('\n').slice(1).join('；')
    items.push({
      kind: 'snapshot',
      ref: `self:${snapshot.id}`,
      text: `收起来的那一天记得：${clip(remembered, 80)}`,
      why: '来自睡眠巩固；是一天结束时她自己留下的记录',
    })
  }

  if (dream) {
    items.push({
      kind: 'dream',
      ref: `dream:${dream.id}`,
      text: `你梦见过的（不是真事）：${clip(dream.text, 52)}`,
      why: '来自梦的记录',
    })
  }

  if (book && book.total > 0) {
    items.push({
      kind: 'book',
      ref: `book:${book.id}`,
      text: `你最近在读《${clip(book.title, 30)}》${percent(book)}`,
      why: '来自书架进度',
    })
  }

  const lines = items.map((i) => `- ${i.text}（${i.ref}）`)
  return {
    date,
    items,
    lines,
    text: lines.length
      ? `你正在过的日子（这些是你自己的日子，不是他对你的评价）：\n${lines.join('\n')}`
      : '',
  }
}

/** 从 MemoryStore 查当前数据，组装她自己的叙事。 */
export function buildSelf({ store, now = Date.now() } = {}) {
  const date = dateKey(now)
  const dayStart = startOfDay(now)
  const blocks = store.lifeForDate(date) || []
  const actions = store.actionsBetween(dayStart, now) || []
  const dream = store.dreamForDate(date) || store.dreamForDate(dateKey(dayStart - 86400000))
  const book = store.bookState()
  const talkCount = (store.rawBetween(dayStart, now) || []).length
  const snapshot = typeof store.latestSelfSnapshot === 'function' ? store.latestSelfSnapshot(date) : null
  return selfFromData({ date, blocks, actions, dream, book, snapshot, talkCount, now })
}
