/**
 * 主动开口：不是“定时发消息”，而是先看她有没有由头、对方是不是刚聊完、
 * 今天是不是已经说过、上一次是不是没人理。默认关；没有桥接就只留草稿。
 *
 * 这里的判断全是确定性的，不调模型，也不猜对方的心思。
 */

export const INITIATIVE_DEFAULTS = Object.freeze({
  enabled: false,
  channel: 'wechat',
  target: '',
  bridgeUrl: '',
  bridgeToken: '',
  minSilenceHours: 8,
  minGapHours: 6,
  dailyMax: 2,
  maxUnanswered: 2,
  quietStart: '23:30',
  quietEnd: '08:00',
})

const STATE_SCHEMA = `
  CREATE TABLE IF NOT EXISTS initiative_state (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at INTEGER NOT NULL
  );
`

function asBool(value) {
  if (typeof value === 'boolean') return value
  const text = String(value ?? '').trim().toLowerCase()
  return ['1', 'true', 'yes', 'on'].includes(text)
}

function asInt(value, fallback) {
  const n = Number(value)
  return Number.isFinite(n) && n >= 0 ? Math.trunc(n) : fallback
}

function clip(text, max = 60) {
  const clean = String(text ?? '').replace(/\s+/g, ' ').trim()
  return clean.length > max ? `${clean.slice(0, max)}…` : clean
}

function localDateKey(now) {
  const d = new Date(now)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

function localDayStart(now) {
  const d = new Date(now)
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
}

function minuteOfDay(now) {
  const d = new Date(now)
  return d.getHours() * 60 + d.getMinutes()
}

function parseClock(text, fallback) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(text ?? '').trim())
  if (!m) return fallback
  const hour = Number(m[1])
  const minute = Number(m[2])
  if (hour > 23 || minute > 59) return fallback
  return hour * 60 + minute
}

/** 23:30–08:00 这类跨午夜的静默时段。 */
export function inQuietHours(now, config = INITIATIVE_DEFAULTS) {
  const start = parseClock(config.quietStart, 23 * 60 + 30)
  const end = parseClock(config.quietEnd, 8 * 60)
  const at = minuteOfDay(now)
  if (start === end) return false
  return start < end ? (at >= start && at < end) : (at >= start || at < end)
}

export function readInitiativeConfig({ env = process.env, config = {} } = {}) {
  const raw = config?.initiative || config?.life?.initiative || {}
  return {
    enabled: raw.enabled !== undefined ? asBool(raw.enabled) : asBool(env.LIFE_INITIATIVE),
    channel: String(raw.channel || env.LIFE_INITIATIVE_CHANNEL || 'wechat'),
    target: String(raw.target || env.LIFE_INITIATIVE_CHAT_ID || ''),
    bridgeUrl: String(raw.bridgeUrl || env.LIFE_INITIATIVE_BRIDGE_URL || ''),
    bridgeToken: String(raw.bridgeToken || env.LIFE_INITIATIVE_BRIDGE_TOKEN || ''),
    minSilenceHours: asInt(raw.minSilenceHours ?? env.LIFE_INITIATIVE_MIN_SILENCE_HOURS, 8),
    minGapHours: asInt(raw.minGapHours ?? env.LIFE_INITIATIVE_MIN_GAP_HOURS, 6),
    dailyMax: asInt(raw.dailyMax ?? env.LIFE_INITIATIVE_DAILY_MAX, 2),
    maxUnanswered: asInt(raw.maxUnanswered ?? env.LIFE_INITIATIVE_MAX_UNANSWERED, 2),
    quietStart: String(raw.quietStart || '23:30'),
    quietEnd: String(raw.quietEnd || '08:00'),
  }
}

export function ensureInitiativeState(store) {
  store.db.exec(STATE_SCHEMA)
}

export function initiativeStopped(store) {
  ensureInitiativeState(store)
  const row = store.db.prepare("SELECT value FROM initiative_state WHERE key = 'stopped'").get()
  return Boolean(row && String(row.value) === '1')
}

export function setInitiativeStopped(store, stopped, now = Date.now()) {
  ensureInitiativeState(store)
  store.db.prepare(`INSERT INTO initiative_state (key, value, updated_at) VALUES ('stopped', ?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`)
    .run(stopped ? '1' : '0', Math.trunc(now))
}

function initiativeEntries(outbox, limit = 200) {
  return outbox.recent(limit).filter((entry) => entry && entry.meta && entry.meta.kind === 'initiative')
}

function baseStatus(store, entries, config, now) {
  const lastIn = store.lastAnyRawTs('user')
  const todayStart = localDayStart(now)
  return {
    enabled: Boolean(config.enabled),
    stopped: initiativeStopped(store),
    lastIn,
    lastAt: entries.length ? Math.max(...entries.map((e) => Number(e.ts) || 0)) : 0,
    todayCount: entries.filter((e) => Number(e.ts) >= todayStart && e.state !== 'failed').length,
    unanswered: entries.filter((e) => Number(e.ts) > lastIn && (e.state === 'sent' || e.state === 'uncertain')).length,
    pending: entries.find((e) => e.state === 'pending') || null,
  }
}

/**
 * 判断这一分钟该不该开口；返回的 reason 是“为什么没开口/为什么可以”。
 * 顺序很重要：没有由头、刚聊完、今天说够了，都不该被“意愿”强行覆盖。
 */
export function initiativeDue({ store, outbox, now = Date.now(), config = INITIATIVE_DEFAULTS, willCheck = null } = {}) {
  const cfg = { ...INITIATIVE_DEFAULTS, ...config }
  ensureInitiativeState(store)
  const entries = initiativeEntries(outbox)
  const status = baseStatus(store, entries, cfg, now)
  const blocked = (reason, extra = {}) => ({ due: false, reason, ...status, ...extra })

  if (!cfg.enabled) return blocked('disabled')
  if (status.stopped) return blocked('stopped')
  if (status.pending) {
    // pending 是具体草稿，但它也要服从“现在还想不想说”。
    // 否则 status 会报 pending，而 tick 在补发前又因为意愿拒绝而不发，两边说法不一致。
    if (typeof willCheck === 'function') {
      try {
        const will = willCheck({ store, now, text: '主动开口' })
        if (will && will.decision && will.decision !== 'allow') {
          return blocked(will.decision === 'refuse' ? 'will_refuse' : 'will_defer', { pending_id: status.pending.id })
        }
      } catch { /* 意愿读取失败时保留 pending，让补发继续 */ }
    }
    return blocked('pending', { pending_id: status.pending.id })
  }
  if (!status.lastIn) return blocked('no_inbound')
  if (status.unanswered >= cfg.maxUnanswered) return blocked('unanswered')
  if (now - status.lastIn < cfg.minSilenceHours * 3600000) return blocked('recent_chat')
  if (inQuietHours(now, cfg)) return blocked('quiet_hours')
  if (status.todayCount >= cfg.dailyMax) return blocked('daily_limit')
  if (status.lastAt && now - status.lastAt < cfg.minGapHours * 3600000) return blocked('min_gap')

  if (typeof willCheck === 'function') {
    try {
      const will = willCheck({ store, now, text: '主动开口' })
      if (will && will.decision && will.decision !== 'allow') {
        return blocked(will.decision === 'refuse' ? 'will_refuse' : 'will_defer')
      }
    } catch {
      // 意愿层读取失败不能把主动开口卡死；它只是基调，不是安全闸门。
    }
  }

  const plan = store.livePlans('他', 1, now)[0]
  if (plan) {
    return {
      due: true, reason: 'open_loop', ref: `assert:${plan.id}`, ...status,
      detail: { value: plan.value, dueAt: plan.dueAt || null },
    }
  }
  const book = store.bookState ? store.bookState() : null
  // 读完了就不再拿“还在读”当由头；否则一本旧书会永远挡住梦和“忽然想起你”。
  const bookOpen = book && (!(Number(book.total) > 0 && Number(book.offset) >= Number(book.total)))
  if (bookOpen) {
    return {
      due: true, reason: 'book', ref: `book:${book.id}`, ...status,
      detail: { title: book.title, offset: book.offset, total: book.total },
    }
  }
  const dream = store.dreamForDate ? store.dreamForDate(localDateKey(now - 86400000)) : null
  if (dream) {
    return {
      due: true, reason: 'dream', ref: `dream:${dream.id}`, ...status,
      detail: { text: dream.text },
    }
  }
  // “忽然想起你”没有具体的生活证据，但至少要指向“从哪一句之后安静下来”，
  // 这样 outbox/actions 里的每条主动开口都能回查；不伪造一个不存在的记忆。
  const lastUser = store.lastAnyRaw ? store.lastAnyRaw('user') : null
  return {
    due: true, reason: 'missing_you', ref: lastUser ? `raw:${lastUser.id}` : '', ...status,
    detail: lastUser ? { lastIn: lastUser.ts } : {},
  }
}

/** 只按已有证据写一句，不编造“我今天做了什么”。 */
export function composeInitiative({ reason, detail = {} } = {}) {
  if (reason === 'open_loop') {
    return `你之前说「${clip(detail.value, 48)}」。后来怎么样了？`
  }
  if (reason === 'book') {
    const title = clip(detail.title, 32)
    const total = Number(detail.total) || 0
    const offset = Number(detail.offset) || 0
    if (total > 0 && offset >= total) return `《${title}》我已经读完了。你最近有没有看书？`
    // 用 floor，避免 999/1000 被四舍五入成“100%”后说成读完。
    const progress = total > 0 ? Math.min(99, Math.floor((offset / total) * 100)) : null
    const where = progress === null ? '翻了几页' : progress > 0 ? `读到 ${progress}%` : '刚翻开'
    return `我最近在读《${title}》，${where}。你最近有没有看书？`
  }
  if (reason === 'dream') {
    // 梦的原文本身就以“梦见”开头（rhythm 生成），别再叠一层“梦见梦见”。
    const dream = String(detail.text || '').replace(/^梦见/, '').trim()
    return `我昨晚梦见${clip(dream, 72)}。醒来还记得一点。`
  }
  return '今天安静下来的时候，忽然想起你。你那边还好吗？'
}

export function outboxCounts(outbox) {
  const rows = initiativeEntries(outbox, 500)
  const counts = { pending: 0, sent: 0, uncertain: 0, failed: 0 }
  for (const row of rows) if (counts[row.state] !== undefined) counts[row.state] += 1
  return { ...counts, total: rows.length }
}

/**
 * 发送到桥接的 /send。成功必须拿到 {ok:true}；没有确认就标 uncertain，不能标 sent。
 * 没配置 bridgeUrl 时保持 pending，不把“写了草稿”说成“说出去了”。
 */
export async function sendViaBridge({ outbox, entry, config = INITIATIVE_DEFAULTS, fetchImpl = globalThis.fetch } = {}) {
  const url = String(config.bridgeUrl || '')
  if (!url) return { ok: false, state: 'pending', error: 'no_bridge' }
  // 补发旧 pending 时用这条消息当初记下的 target：后来改全局 target 不能
  // 把旧草稿发给另一个人。
  const target = String(entry.target || config.target || '')
  if (!target) return { ok: false, state: 'pending', error: 'no_target' }
  if (typeof fetchImpl !== 'function') return { ok: false, state: 'pending', error: 'no_fetch' }
  try {
    const res = await fetchImpl(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(config.bridgeToken ? { 'x-bot-token': String(config.bridgeToken) } : {}),
      },
      body: JSON.stringify({ reply_id: entry.id, chat_id: target, bubbles: [entry.text] }),
      signal: AbortSignal.timeout(8000),
    })
    let data = null
    try { data = await res.json() } catch { data = null }
    if (res.ok && data && data.ok === true) {
      const marked = outbox.markSent(entry.id)
      const stored = outbox.get(entry.id)
      if (!marked || stored?.state !== 'sent') {
        return { ok: false, state: stored?.state || 'uncertain', error: 'state_not_sent' }
      }
      return { ok: true, state: 'sent', externalId: String(data.external_id || '') }
    }
    const error = String(data?.error || `http_${res.status}`)
    if (res.status >= 400 && res.status < 500) {
      outbox.markFailed(entry.id, error)
      return { ok: false, state: 'failed', error }
    }
    outbox.markUncertain(entry.id, error)
    return { ok: false, state: 'uncertain', error }
  } catch (error) {
    outbox.markUncertain(entry.id, error?.message || String(error))
    return { ok: false, state: 'uncertain', error: error?.message || String(error) }
  }
}

function recordInitiativeAction({ store, entry, reason, text, delivery, now, retry = false, ref = '' }) {
  const state = String(delivery?.state || 'pending')
  store.addAction({
    ts: now,
    kind: 'life',
    tool: 'initiative',
    summary: `${retry ? '主动开口补发' : '主动开口'}（${reason}）：${clip(text, 50)}`,
    // 同一条 pending 可能补发多次；每次都要留下自己的动作，不能被 UNIQUE 静默吞掉。
    callId: `${retry ? 'initiative-retry' : 'initiative'}:${entry.id}${retry ? `:${now}` : ''}`,
    status: state === 'sent' ? 'ok' : (state === 'failed' ? 'error' : 'called'),
    meta: { reason, ref: String(ref || ''), outbox: entry.id, delivery: state },
  })
}

async function deliverInitiative({ store, outbox, entry, config, now, sender }) {
  let delivery = { ok: false, state: 'pending', error: 'no_sender' }
  if (typeof sender === 'function') {
    try {
      delivery = (await sender({ store, outbox, entry, config, now })) || delivery
    } catch (error) {
      outbox.markUncertain(entry.id, error?.message || String(error))
      delivery = { ok: false, state: 'uncertain', error: error?.message || String(error) }
    }
  }
  // sender 说 sent 不算数，账本里真的变成 sent 才算。
  const stored = outbox.get(entry.id)
  return { ...delivery, state: stored?.state || delivery.state }
}

/**
 * 判断 → 生成草稿 → 记账；sender 只有在配置了桥接时才传。
 * 如果 sender 失败，entry 仍在 outbox，状态由 sender 决定，绝不在这里伪造 sent。
 *
 * 之前没桥接时留下的 pending 不能把后面永久堵死：桥接配好后，下一次 tick
 * 先用 sender 补发这一条，不再新建第二条。
 */
export async function tickInitiative({ store, outbox, now = Date.now(), config = INITIATIVE_DEFAULTS, willCheck = null, sender = null } = {}) {
  const cfg = { ...INITIATIVE_DEFAULTS, ...(config || {}) }
  const due = initiativeDue({ store, outbox, now, config: cfg, willCheck })

  if (!due.due) {
    // pending 在“意愿暂时拒绝”时也会带着 pending_id；旧草稿该过期的仍要过期，
    // 不能因为当前不想说话就让一条旧草稿永久堵住。
    const pendingReason = due.reason === 'pending' || due.reason === 'will_refuse' || due.reason === 'will_defer'
    if (pendingReason && due.pending_id && typeof sender === 'function' && cfg.bridgeUrl && !inQuietHours(now, cfg)) {
      const pending = outbox.get(due.pending_id)
      // 旧 pending 自己记了 target；全局 target 后来清空也不该阻止补发。
      if (pending && pending.state === 'pending' && pending.meta?.kind === 'initiative' && (pending.target || cfg.target)) {
        const pendingTs = Number(pending.ts || 0)
        // 如果草稿写好后用户又说话了，或者已经放了一天，这句话就过期了：
        // 不能拿旧语境追着人发。标记失败，下一次 tick 再按当前状态决定。
        const staleReason = Number(due.lastIn || 0) > pendingTs
          ? 'user_replied'
          : (pendingTs > 0 && now - pendingTs > 24 * 3600000 ? 'expired' : '')
        if (staleReason) {
          outbox.markFailed(pending.id, staleReason)
          const delivery = { ok: false, state: 'failed', error: staleReason }
          recordInitiativeAction({
            store, entry: pending, reason: 'pending_stale', text: pending.text, delivery, now,
            retry: true, ref: pending.meta?.ref || '',
          })
          return {
            ...due, due: false, reason: 'pending_stale', pending_id: pending.id,
            stale_reason: staleReason, retried: false, delivery,
          }
        }
        // 意愿层当前拒绝时，只顺手清理过期草稿；不要借补发分支绕过意愿。
        if (due.reason !== 'pending') return { ...due, pending_id: pending.id, retried: false }
        // 补发也要看当下的意愿：草稿写的时候 allow，不代表现在还想说。
        // 意愿只是基调，读取失败时仍按草稿补发，不把它变成硬闸门。
        if (typeof willCheck === 'function') {
          try {
            const will = willCheck({ store, now, text: '主动开口' })
            if (will && will.decision && will.decision !== 'allow') {
              return {
                ...due, due: false, reason: will.decision === 'refuse' ? 'will_refuse' : 'will_defer',
                pending_id: pending.id, retried: false,
              }
            }
          } catch { /* 意愿读取失败不拦补发 */ }
        }
        const delivery = await deliverInitiative({ store, outbox, entry: pending, config: cfg, now, sender })
        recordInitiativeAction({ store, entry: pending, reason: 'pending_retry', text: pending.text, delivery, now, retry: true, ref: pending.meta?.ref || '' })
        return {
          ...due, due: true, reason: 'pending_retry', original_reason: 'pending',
          text: pending.text, entry: pending, delivery, retried: true,
        }
      }
    }
    return due
  }

  const text = composeInitiative(due)
  const entry = outbox.create({
    channel: String(cfg.channel || 'wechat'),
    target: String(cfg.target || ''),
    text,
    now,
    meta: { kind: 'initiative', reason: due.reason, ref: due.ref || '', detail: due.detail || {} },
  })
  const delivery = await deliverInitiative({ store, outbox, entry, config: cfg, now, sender })
  recordInitiativeAction({ store, entry, reason: due.reason, text, delivery, now, ref: due.ref || '' })
  return { ...due, text, entry, delivery }
}

export function createInitiativeTool({ store, outbox, config = INITIATIVE_DEFAULTS, willCheck = null } = {}) {
  const snapshot = (now) => {
    const due = initiativeDue({ store, outbox, now, config, willCheck })
    const status = baseStatus(store, initiativeEntries(outbox), config, now)
    return { due, status }
  }
  const valueFor = (status, due, extra = {}) => ({
    enabled: Boolean(config.enabled),
    stopped: Boolean(status.stopped),
    due: Boolean(due?.due),
    reason: String(due?.reason || ''),
    ref: String(due?.ref || ''),
    draft: due?.due ? composeInitiative(due) : '',
    last_in: Number(status.lastIn || 0),
    today_count: Number(status.todayCount || 0),
    unanswered: Number(status.unanswered || 0),
    pending: String(status.pending?.id || ''),
    stopped_now: false,
    ...extra,
  })

  return {
    name: 'life_initiative',
    description: '看主动开口现在该不该发生、为什么没发生；也可以一键停下。默认关，停下不需要确认。',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['status', 'check', 'stop', 'resume'], description: 'status/check 只看；stop 一键停；resume 需要 confirm=RESUME。' },
        confirm: { type: 'string', description: 'resume 时写 RESUME。' },
      },
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          enabled: { type: 'boolean' },
          stopped: { type: 'boolean' },
          due: { type: 'boolean' },
          reason: { type: 'string' },
          ref: { type: 'string' },
          draft: { type: 'string' },
          last_in: { type: 'integer' },
          today_count: { type: 'integer' },
          unanswered: { type: 'integer' },
          pending: { type: 'string' },
          stopped_now: { type: 'boolean' },
        },
        required: ['enabled', 'stopped', 'due', 'reason', 'ref', 'draft', 'last_in', 'today_count', 'unanswered', 'pending', 'stopped_now'],
        additionalProperties: false,
      },
      render: (_args, value) => [{ type: 'text', text: value.draft || `现在不开口：${value.reason}${value.stopped ? '（已停）' : ''}` }],
    },
    async execute(args = {}) {
      const action = String(args.action || 'status')
      if (action === 'stop') {
        const now = Date.now()
        setInitiativeStopped(store, true, now)
        const { status } = snapshot(now)
        return valueFor(status, null, {
          due: false, reason: 'stopped', ref: '', draft: '', stopped_now: true,
        })
      }
      if (action === 'resume') {
        if (String(args.confirm || '') !== 'RESUME') {
          const now = Date.now()
          const { status } = snapshot(now)
          return valueFor(status, null, {
            due: false, reason: 'resume_needs_confirm', ref: '', draft: '', stopped_now: false,
          })
        }
        setInitiativeStopped(store, false, Date.now())
      }
      const now = Date.now()
      const { due, status } = snapshot(now)
      return valueFor(status, due)
    },
  }
}
