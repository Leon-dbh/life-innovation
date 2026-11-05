/**
 * 外发账本：一条消息离开她之后，到底算「发出去了」还是「不确定」。
 *
 * 为什么不是布尔值：渠道会超时、会断线、会被拒。把「已发送」和「不知道发没发出去」混成一个 true，
 * 迟早会出现「她以为说过、对方没收到」或者反过来「对方收到了、她又不承认」。
 *
 * 四态（只能单向走）：
 *   pending   已生成，还没交出去
 *   sent      渠道确认收下了
 *   uncertain 交出去了，但没拿到确认（超时/断线/异常）——不能当已送达，也不能当没发
 *   failed    渠道明确拒绝（不是网络不明），可以重试或放弃
 *
 * 这一层目前只有表和状态机，还没有接通任何渠道（微信按计划延后到 M4）。
 */
import { randomUUID } from 'node:crypto'

export const OUTBOX_STATES = ['pending', 'sent', 'uncertain', 'failed']

const TRANSITIONS = {
  pending: new Set(['pending', 'sent', 'uncertain', 'failed']),
  uncertain: new Set(['uncertain', 'sent', 'failed']),
  failed: new Set(['failed', 'pending']),
  sent: new Set(['sent']),
}

export function canTransition(from, to) {
  const allowed = TRANSITIONS[from]
  return Boolean(allowed && allowed.has(to))
}

export class Outbox {
  constructor(db) {
    this.db = db
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS outbox (
        id TEXT PRIMARY KEY,
        ts INTEGER NOT NULL,
        channel TEXT NOT NULL,
        target TEXT NOT NULL DEFAULT '',
        text TEXT NOT NULL,
        state TEXT NOT NULL DEFAULT 'pending',
        attempts INTEGER NOT NULL DEFAULT 0,
        last_error TEXT,
        meta TEXT NOT NULL DEFAULT '{}',
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_outbox_state ON outbox(state);
    `)
    this.sql = {
      insert: this.db.prepare(`INSERT INTO outbox (id, ts, channel, target, text, state, attempts, last_error, meta, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, 'pending', 0, NULL, ?, ?, ?)`),
      get: this.db.prepare('SELECT * FROM outbox WHERE id = ?'),
      set: this.db.prepare('UPDATE outbox SET state = ?, attempts = attempts + 1, last_error = ?, updated_at = ? WHERE id = ?'),
      list: this.db.prepare('SELECT * FROM outbox WHERE state = ? ORDER BY ts ASC LIMIT ?'),
      recent: this.db.prepare('SELECT * FROM outbox ORDER BY ts DESC LIMIT ?'),
    }
  }

  /** 生成一条待外发的消息（还没有交出去）。 */
  create({ channel, target = '', text, meta = {}, now = Date.now() }) {
    const id = randomUUID()
    this.sql.insert.run(id, Math.trunc(now), String(channel), String(target), String(text), JSON.stringify(meta), Math.trunc(now), Math.trunc(now))
    return this.get(id)
  }

  get(id) {
    const row = this.sql.get.get(String(id))
    return row ? this.row(row) : null
  }

  row(r) {
    return {
      id: String(r.id), ts: Number(r.ts), channel: String(r.channel), target: String(r.target),
      text: String(r.text), state: String(r.state), attempts: Number(r.attempts),
      lastError: r.last_error === null ? null : String(r.last_error),
      meta: JSON.parse(String(r.meta || '{}')), createdAt: Number(r.created_at), updatedAt: Number(r.updated_at),
    }
  }

  /** 状态只能往前走；非法迁移返回 false 并保持原状态。 */
  transition(id, to, { error = null, now = Date.now() } = {}) {
    const current = this.get(id)
    if (!current) return false
    if (OUTBOX_STATES.includes(to) === false) return false
    if (!canTransition(current.state, to)) return false
    this.sql.set.run(String(to), error === null ? null : String(error), Math.trunc(now), String(id))
    return true
  }

  markSent(id, now = Date.now()) { return this.transition(id, 'sent', { now }) }
  markUncertain(id, error = 'no acknowledgement', now = Date.now()) { return this.transition(id, 'uncertain', { error, now }) }
  markFailed(id, error = 'rejected', now = Date.now()) { return this.transition(id, 'failed', { error, now }) }
  retry(id, now = Date.now()) { return this.transition(id, 'pending', { now }) }

  pending(limit = 20) { return this.sql.list.all('pending', Math.trunc(limit)).map((r) => this.row(r)) }
  uncertain(limit = 20) { return this.sql.list.all('uncertain', Math.trunc(limit)).map((r) => this.row(r)) }
  recent(limit = 20) { return this.sql.recent.all(Math.trunc(limit)).map((r) => this.row(r)) }
}

/**
 * 把一次「她主动说的话」化成账本记录：渠道说 sent 才 sent；
 * 没拿到确认一律 uncertain，不许写成 sent。
 */
export function recordDelivery(outbox, { channel, target, text, outcome, error, now = Date.now() }) {
  const entry = outbox.create({ channel, target, text, now })
  if (outcome === 'sent') outbox.markSent(entry.id, now)
  else if (outcome === 'failed') outbox.markFailed(entry.id, error, now)
  else outbox.markUncertain(entry.id, error, now)
  return outbox.get(entry.id)
}
