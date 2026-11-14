/**
 * 「她的家」只读页面（M5）。
 *
 * 这一页只读：打开 SQLite 时用 readOnly，不写任何表、不生成动作、
 * 不替她编生活。数据全部来自 actions → life_blocks / life_phases /
 * assertions / summaries / dreams / relations。
 *
 * 被 install/entry.mjs 的 /home 路由调用；样式和文案都在这里，
 * 不依赖外网字体或 CDN，断网也能看。
 */
import fs from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'

const PHASE = {
  awake: { name: '醒着', color: '#e4b07a', hint: '刚和你说过话' },
  quiet: { name: '安静', color: '#7e9ab5', hint: '没人在说话，她自己在过' },
  night: { name: '夜里', color: '#53679c', hint: '23 点到 8 点，她不主动找人' },
  closed: { name: '今天已经收起来', color: '#8a8275', hint: '这一天已经写进日记' },
  offline: { name: '没在运行', color: '#4a4f58', hint: '宿主没开，这段时间没有记录' },
}

function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]))
}

function clip(text, max) {
  const s = String(text || '').replace(/\s+/g, ' ').trim()
  if (s.length <= max) return s
  return s.slice(0, Math.max(0, max - 1)) + '…'
}

function localParts(now) {
  const d = new Date(now)
  return { y: d.getFullYear(), m: d.getMonth() + 1, d: d.getDate(), h: d.getHours(), mi: d.getMinutes() }
}

function pad(n) { return String(n).padStart(2, '0') }

// 页面和 life_blocks 用同一套本地日历：数据按服务器本地时间写，页面也按本地时间读。
// 不固定 Asia/Shanghai——否则换一台非 +08 的机器，页面和日子会差一天。
function dateKey(now) {
  const p = localParts(now)
  return `${p.y}-${pad(p.m)}-${pad(p.d)}`
}

function clock(ts) {
  if (!Number.isFinite(Number(ts))) return '--:--'
  const p = localParts(Number(ts))
  return `${pad(p.h)}:${pad(p.mi)}`
}

function startOfDay(date) {
  const [y, m, d] = String(date).split('-').map(Number)
  return new Date(y, m - 1, d).getTime()
}

function nextDayStart(date) {
  const [y, m, d] = String(date).split('-').map(Number)
  return new Date(y, m - 1, d + 1).getTime()
}

function dateLabel(date) {
  const [y, m, d] = String(date).split('-').map(Number)
  const dt = new Date(y, m - 1, d)
  const weekday = new Intl.DateTimeFormat('zh-CN', { weekday: 'long' }).format(dt)
  return `${y} 年 ${m} 月 ${d} 日 · ${weekday}`
}

function shiftDate(date, delta) {
  const [y, m, d] = String(date).split('-').map(Number)
  return dateKey(new Date(y, m - 1, d + delta, 12).getTime())
}

function monthDay(date) {
  const [, m, d] = String(date).split('-').map(Number)
  return `${m} 月 ${d} 日`
}

function evidenceList(raw) {
  try {
    const list = JSON.parse(String(raw || '[]'))
    return Array.isArray(list) ? list.filter((x) => typeof x === 'string') : []
  } catch {
    return []
  }
}

function evidenceChips(raw) {
  const list = evidenceList(raw)
  if (!list.length) return ''
  return `<span class="chips">${list.slice(0, 8).map((ref) => {
    const [kind, id] = ref.split(':')
    const label = kind === 'raw' ? `原话 ${id}` : kind === 'act' ? `动作 ${id}` : ref
    return `<span class="chip" title="${esc(ref)}">${esc(label)}</span>`
  }).join('')}</span>`
}

function rows(db, sql, params = []) {
  try {
    return db.prepare(sql).all(...params)
  } catch {
    return []
  }
}

function row(db, sql, params = []) {
  try {
    return db.prepare(sql).get(...params)
  } catch {
    return undefined
  }
}

function count(db, table) {
  try {
    return Number(db.prepare(`SELECT COUNT(*) AS c FROM ${table}`).get().c) || 0
  } catch {
    return 0
  }
}

function factLine(fact) {
  const p = String(fact.predicate || '')
  const v = String(fact.value || '')
  if (p === '名字') return `他叫${v}`
  if (p === '住在') return `他住在${v}`
  if (p === '工作') return `他在${v}上班`
  if (p === '养了') return `他养了${v}`
  if (p === '宠物') return `他的${v}`
  if (p === '喜欢') return `他${v}`
  if (p.startsWith('计划')) {
    const when = p.slice(3).replace(/^[:：]/, '')
    return `他打算${when}：${v}`
  }
  return `${fact.subject || '他'} ${p}：${v}`
}

function memoryHits(db, query, limit = 12) {
  const q = String(query || '').trim()
  if (!q) return []
  // LIKE 里的 %/_ 是通配符；她搜“%”时不该把整库都倒出来。
  const escaped = q.replace(/[!%_]/g, '!$&')
  const like = `%${escaped}%`
  return rows(db, `SELECT id, ts, role, text, 0 AS archived FROM raw_turns WHERE text LIKE ? ESCAPE '!'
    UNION ALL
    SELECT id, ts, role, text, 1 AS archived FROM raw_archive WHERE text LIKE ? ESCAPE '!'
    ORDER BY ts DESC LIMIT ?`, [like, like, Math.trunc(limit)])
}

function conflictRows(db) {
  const all = rows(db, 'SELECT id, subject, predicate, value, valid_from, valid_to FROM assertions ORDER BY subject, predicate, id')
  const groups = new Map()
  for (const r of all) {
    const key = `${r.subject || ''}\u0000${r.predicate}`
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key).push(r)
  }
  const out = []
  for (const list of groups.values()) {
    const predicate = list[0].predicate
    const subject = list[0].subject || ''
    const values = [...new Set(list.map((r) => String(r.value)))]
    if (values.length < 2) continue
    const live = list.filter((r) => r.valid_to === null)
    const current = live[live.length - 1] || list[list.length - 1]
    out.push({
      subject,
      predicate,
      current: current.value,
      current_ref: `assert:${current.id}`,
      previous: list
        .filter((r) => r.id !== current.id && String(r.value) !== String(current.value))
        .map((r) => ({ value: r.value, ref: `assert:${r.id}`, when: fmtWhen(r.valid_from) })),
    })
    if (out.length >= 4) break
  }
  return out
}

function fmtWhen(ts) {
  const d = new Date(Number(ts) || 0)
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${clock(ts)}`
}

function selfNarrative({ date, blocks, actions, dream, book, talkCount, now }) {
  const lines = []
  const real = (blocks || []).filter((b) => b && b.activity !== '空档')
  const active = real
    .filter((b) => !b.endedAt || Number(b.endedAt) >= now - 90 * 60 * 1000)
    .at(-1)
  if (active) lines.push(`- 此刻：${clip(active.activity, 48)}（life:${active.id}）`)
  const last = [...(actions || [])].sort((a, b) => Number(a.ts) - Number(b.ts)).at(-1)
  if (last) lines.push(`- 最近你做了：${clip(last.summary || last.tool || '一件事', 48)}（act:${last.id}）`)
  if (talkCount > 0) lines.push(`- 今天和他说过 ${talkCount} 段话（day:${date}）`)
  if (dream) lines.push(`- 你梦见过的（不是真事）：${clip(dream.text, 52)}（dream:${dream.id}）`)
  if (book && book.total > 0) {
    const p = Math.max(0, Math.min(100, Math.floor((book.offset / book.total) * 100)))
    lines.push(`- 你最近在读《${clip(book.title, 30)}》${p > 0 ? `，读到 ${p}%` : ''}（book:${book.id}）`)
  }
  return lines
}

export function collectHome({ home, dbPath, now = Date.now(), dreamLookback = true, memoryQuery = '' }) {
  const today = dateKey(now)
  const dayStart = startOfDay(today)
  const dayEnd = nextDayStart(today) - 1
  let db
  try {
    db = new DatabaseSync(dbPath, { readOnly: true })
  } catch (error) {
    return {
      missing: true,
      today,
      now,
      home,
      error: error && error.message ? error.message : String(error),
    }
  }

  try {
    const phases = rows(db, 'SELECT phase, started_at, ended_at, reason FROM life_phases WHERE date = ? ORDER BY started_at', [today])
    const blocks = rows(db, 'SELECT id, activity, started_at, ended_at, evidence FROM life_blocks WHERE date = ? ORDER BY started_at, id', [today])
    const actions = rows(db, "SELECT id, ts, tool, summary FROM actions WHERE ts BETWEEN ? AND ? AND status = 'ok' ORDER BY ts DESC, id DESC LIMIT 24", [dayStart, dayEnd])
    const facts = rows(db, 'SELECT id, subject, predicate, value, due_at, source FROM assertions WHERE valid_to IS NULL ORDER BY id DESC LIMIT 16')
    const summaries = rows(db, 'SELECT ts, text FROM summaries ORDER BY id DESC LIMIT 2')
    // 梦是在「一天收起来之后」才生成的，页面打开时它通常属于昨天；
    // 只查今天会显示成「还没有梦」。今天有就看今天，没有就退回昨晚。
    const yesterday = shiftDate(today, -1)
    const dreams = dreamLookback
      ? rows(db, 'SELECT date, text, evidence FROM dreams WHERE date IN (?, ?) ORDER BY date DESC, id DESC LIMIT 1', [today, yesterday])
      : rows(db, 'SELECT date, text, evidence FROM dreams WHERE date = ? ORDER BY id DESC LIMIT 1', [today])
    const relation = row(db, 'SELECT person_id, stage, first_seen, last_seen, turns FROM relations ORDER BY last_seen DESC LIMIT 1')
    const profileName = row(db, "SELECT value FROM profiles WHERE key = '名字' LIMIT 1")
    const current = row(db, 'SELECT phase, started_at, reason FROM life_phases WHERE ended_at IS NULL ORDER BY id DESC LIMIT 1')
    const last = current || row(db, 'SELECT phase, started_at, reason FROM life_phases ORDER BY id DESC LIMIT 1')
    const rawToday = row(db, 'SELECT COUNT(*) AS c FROM raw_turns WHERE ts BETWEEN ? AND ?', [dayStart, dayEnd])
    const firstRun = count(db, 'raw_turns') === 0 && count(db, 'raw_archive') === 0
    const hasSnapshots = Boolean(row(db, "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'self_snapshots'"))
    const snapshot = hasSnapshots
      ? row(db, 'SELECT id, date, text FROM self_snapshots WHERE date < ? ORDER BY date DESC LIMIT 1', [today])
      : null
    const book = row(db, 'SELECT id, title, offset, total FROM books WHERE offset < total ORDER BY updated_at DESC LIMIT 1')
    const self = {
      lines: selfNarrative({
        date: today,
        blocks: blocks.map((b) => ({
          id: Number(b.id), activity: b.activity,
          startedAt: Number(b.started_at), endedAt: Number(b.ended_at),
        })),
        actions: actions.map((a) => ({ ...a, status: 'ok' })),
        dream: dreams[0] || null,
        book: book || null,
        talkCount: Number(rawToday?.c) || 0,
        now,
      }),
    }

    return {
      missing: false,
      today,
      now,
      home,
      phases,
      blocks,
      actions,
      facts,
      summaries,
      dreams,
      relation,
      name: profileName ? profileName.value : '',
      current: last || null,
      self,
      book: book || null,
      memoryQuery: String(memoryQuery || '').trim(),
      memoryHits: memoryHits(db, memoryQuery),
      conflicts: conflictRows(db),
      audit: rows(db, 'SELECT id, ts, action, ref, reason, actor FROM memory_audit ORDER BY id DESC LIMIT 8'),
      snapshot: snapshot || null,
      firstRun,
      stats: {
        raw: count(db, 'raw_turns'),
        archived: count(db, 'raw_archive'),
        summaries: count(db, 'summaries'),
        actions: count(db, 'actions'),
        blocks: count(db, 'life_blocks'),
        dreams: count(db, 'dreams'),
      },
    }
  } finally {
    try { db.close() } catch { /* 只读连接，关不掉也不影响页面 */ }
  }
}

function track(phases, dayStart, now, total) {
  return phases.map((p) => {
    const start = Math.max(dayStart, Number(p.started_at) || dayStart)
    const end = Math.min(dayStart + total, Number(p.ended_at) || now)
    if (!(end > start)) return ''
    const left = ((start - dayStart) / total) * 100
    const width = Math.max(0.25, ((end - start) / total) * 100)
    const meta = PHASE[p.phase] || { name: p.phase, color: '#5a6068' }
    return `<span class="seg" style="left:${left.toFixed(3)}%;width:${width.toFixed(3)}%;background:${meta.color}" title="${esc(meta.name)} ${clock(start)}–${clock(end)}"></span>`
  }).join('')
}

function phaseLegend(phases) {
  const seen = new Set()
  return phases.filter((p) => {
    if (seen.has(p.phase)) return false
    seen.add(p.phase)
    return PHASE[p.phase]
  }).map((p) => {
    const meta = PHASE[p.phase]
    return `<span class="legend"><i style="background:${meta.color}"></i>${esc(meta.name)}</span>`
  }).join('')
}

function chipsFromList(list, max = 8) {
  if (!list.length) return ''
  return list.slice(0, max).map((ref) => {
    const [kind, id] = String(ref).split(':')
    const label = kind === 'raw' ? `原话 ${id}` : kind === 'act' ? `动作 ${id}` : String(ref)
    return `<span class="chip">${esc(label)}</span>`
  }).join('') + (list.length > max ? `<span class="chip">+${list.length - max}</span>` : '')
}

// 把五分钟内连续发生的动作并成一段“她在做什么”，避免时间线被
// 一句一句的「和他说说话」切碎；空档保持独立，不并进去。
function sessions(blocks) {
  const out = []
  for (const b of blocks) {
    if (b.activity === '空档') {
      out.push({ idle: true, started_at: b.started_at, ended_at: b.ended_at, activities: [], evidence: [] })
      continue
    }
    const prev = out[out.length - 1]
    const gap = prev && !prev.idle ? Number(b.started_at) - Number(prev.ended_at) : Infinity
    if (prev && !prev.idle && gap <= 5 * 60 * 1000) {
      prev.ended_at = Math.max(Number(prev.ended_at), Number(b.ended_at))
      if (!prev.activities.includes(b.activity)) prev.activities.push(b.activity)
      for (const ref of evidenceList(b.evidence)) if (!prev.evidence.includes(ref)) prev.evidence.push(ref)
    } else {
      out.push({
        idle: false,
        started_at: b.started_at,
        ended_at: b.ended_at,
        activities: [b.activity],
        evidence: evidenceList(b.evidence),
      })
    }
  }
  return out
}

function sessionLabel(activities) {
  const list = [...new Set(activities)]
  const shown = list.slice(0, 3).join(' · ')
  return list.length > 3 ? `${shown} 等 ${list.length} 件` : shown
}

function timeline(blocks, emptyText = '今天还没有留下动作。空白也是真的——她不会替自己编。') {
  if (!blocks.length) {
    return `<p class="empty">${esc(emptyText)}</p>`
  }
  return `<ol class="timeline">${sessions(blocks).map((b) => {
    const start = clock(b.started_at)
    const end = clock(b.ended_at)
    const range = start === end ? start : `${start}–${end}`
    return `<li class="${b.idle ? 'gap' : ''}">
      <time>${esc(range)}</time>
      <div class="what">${esc(b.idle ? '空着' : sessionLabel(b.activities))}</div>
      <div class="ev">${b.idle ? '<span class="muted">没有留下动作</span>' : chipsFromList(b.evidence)}</div>
    </li>`
  }).join('')}</ol>`
}

const FACT_ORDER = { 名字: 0, 住在: 1, 工作: 2, 年龄: 3, 生日: 4, 宠物: 5, 养了: 6, 喜欢: 7 }

function factList(facts) {
  const hasNamedPet = facts.some((f) => f.predicate === '宠物')
  const seen = new Set()
  return [...facts]
    .filter((f) => !(hasNamedPet && f.predicate === '养了'))
    .sort((a, b) => {
      const ap = String(a.predicate || '').startsWith('计划') ? -1 : (FACT_ORDER[a.predicate] ?? 8)
      const bp = String(b.predicate || '').startsWith('计划') ? -1 : (FACT_ORDER[b.predicate] ?? 8)
      return ap - bp
    })
    .filter((f) => {
      const line = factLine(f)
      if (seen.has(line)) return false
      seen.add(line)
      return true
    })
    .slice(0, 9)
}

function dueText(ts, now) {
  const when = Number(ts)
  if (!when) return ''
  const dueDate = dateKey(when)
  const today = dateKey(now)
  if (dueDate === today) return `约在 ${clock(when)}`
  return `约在 ${dateLabel(dueDate)} ${clock(when)}`
}

function factsBlock(facts, now) {
  if (!facts.length) return '<p class="empty">她还没有记住关于你的事。</p>'
  return `<ul class="facts">${factList(facts).map((f) => {
    const due = f.due_at ? ` <span class="muted">（${esc(dueText(f.due_at, now))}）</span>` : ''
    const source = f.source ? ` <span class="ref">${esc(f.source)}</span>` : ''
    return `<li>${esc(factLine(f))}${due}${source}</li>`
  }).join('')}</ul>`
}

function snapshotBlock(snapshot) {
  if (!snapshot) return ''
  const lines = String(snapshot.text || '').split('\n').filter(Boolean)
  const body = lines.length
    ? `<ul class="memory-lines">${lines.map((line) => `<li>${esc(line)}</li>`).join('')}</ul>`
    : '<p class="empty">这一天收起来时，她没有留下可读的巩固记录。</p>'
  return `<section class="card snapshot">
    <div class="eyebrow">睡眠巩固 · 只读</div>
    <h2>${esc(snapshot.date)} 收起来的时候</h2>
    ${body}
    <p class="muted small">这一段来自那天真实的原话、动作、梦和书；不是模型编的旁白，也不改写已经收起来的日子。</p>
  </section>`
}

function memorySection(data, span) {
  if (!data || data.missing) return ''
  const selfLines = data.self?.lines || []
  const query = data.memoryQuery || ''
  const self = selfLines.length
    ? `<ul class="memory-lines">${selfLines.map((line) => `<li>${esc(line)}</li>`).join('')}</ul>`
    : '<p class="empty">今天还没有留下她自己的日子。空白也是真的。</p>'
  const conflicts = data.conflicts.length
    ? `<div class="memory-conflicts"><h3>她改过口的事（旧说法没有删）</h3><ul>${data.conflicts.map((c) => {
      const old = c.previous.map((p) => `「${esc(p.value)}」 ${esc(p.when)}（${esc(p.ref)}）`).join('；')
      return `<li><strong>${esc(c.subject ? `${c.subject} · ${c.predicate}` : c.predicate)}</strong>：现在是「${esc(c.current)}」（${esc(c.current_ref)}）${old ? `；以前说过 ${old}` : ''}</li>`
    }).join('')}</ul></div>`
    : ''
  let hits = ''
  if (query) {
    hits = data.memoryHits.length
      ? `<div class="memory-hits"><h3>搜「${esc(query)}」找到的原话</h3><ul>${data.memoryHits.map((h) => {
        const who = h.role === 'user' ? '他' : '她'
        const tag = h.archived ? '已归档' : `raw:${h.id}`
        return `<li><span class="muted">${esc(fmtWhen(h.ts))} ${who}说</span> ${esc(clip(h.text, 220))} <span class="ref">${esc(tag)}</span></li>`
      }).join('')}</ul></div>`
      : `<p class="empty">没有搜到「${esc(query)}」的原话。</p>`
  }
  return `<section class="card memory" id="memory">
    <div class="eyebrow">她的记忆 · 只读</div>
    <h2>她记得的，和为什么</h2>
    <form class="memory-search" method="get">
      <input type="hidden" name="days" value="${esc(span)}">
      <input type="search" name="memory" value="${esc(query)}" placeholder="搜一句原话，例如：西湖" aria-label="搜她的记忆">
      <button type="submit">查</button>
    </form>
    <h3>她正在过的日子</h3>
    ${self}
    ${conflicts}
    ${hits}
    <p class="muted small">每条都带 ref：raw/act 是原话和动作，assert 是事实档案。旧说法保留在取代链里；这一页只读。</p>
  </section>`
}

function summaryText(text) {
  return String(text || '')
    .replace(/\*\*/g, '')
    .replace(/(?:你|他)说：/g, '')
    .replace(/。\s*；/g, '。')
    .replace(/[；;]\s*[；;]+/g, '；')
    .replace(/^[；;]\s*/, '')
    .replace(/\s+/g, ' ')
    .trim()
}

function summaryBlock(summaries) {
  if (!summaries.length) return '<p class="empty">还没有更早的印象——多聊几次，她才会开始把日子叠起来。</p>'
  return summaries.map((s) => `<div class="quote">
    <div class="muted">${esc(clock(s.ts))} 记下的</div>
    <p>${esc(clip(summaryText(s.text), 180))}</p>
  </div>`).join('')
}

function dreamBlock(dreams, today, past = false) {
  if (!dreams.length) {
    return '<p class="empty">还没有梦。梦只在一天收起来之后才会出现。</p>'
  }
  return dreams.map((d) => {
    const when = past ? '那天的梦' : d.date === today ? '今天的梦' : `昨晚的梦 · ${monthDay(d.date)}`
    return `<div class="dream">
    <div class="dream-when">${esc(when)}</div>
    <div class="dream-tag">梦 · 不是真事</div>
    <p>${esc(clip(d.text, 220))}</p>
    <div class="ev">${evidenceChips(d.evidence)}</div>
  </div>`
  }).join('')
}

function relationBlock(relation, name, agentName = '') {
  if (!relation) return '<p class="empty">还没有关系记录。</p>'
  const who = name || '他'
  return `<div class="relation">
    <div class="rel-name">${esc(who)} <span class="muted">与${esc(agentName || '你')}</span></div>
    <div class="rel-stage">${esc(relation.stage || '还没有阶段')}</div>
    <div class="muted">第一次说话 ${esc(clock(relation.first_seen))} · 已经聊过 ${Number(relation.turns) || 0} 轮</div>
  </div>`
}

function statsLine(stats) {
  return [
    `${stats.raw} 条原话`,
    `${stats.summaries} 条梗概`,
    `${stats.actions} 个动作`,
    `${stats.blocks} 段日子`,
    `${stats.dreams} 个梦`,
  ].map((x) => `<span>${esc(x)}</span>`).join('<i>·</i>')
}

function clampDays(value) {
  return Number(value) >= 7 ? 7 : 1
}

function reviewTabs(days) {
  const link = (n, label) => `<a href="?view=today&amp;days=${n}"${days === n ? ' class="active" aria-current="page"' : ''}>${label}</a>`
  return `<nav class="tabs day-tabs" aria-label="查看范围">${link(1, '今天')}${link(7, '最近七天')}</nav>`
}

function viewTabs(view, days, memoryQuery) {
  const items = [
    ['today', '今天'],
    ['memory', '她记得'],
    ['room', '她的房间'],
    ['self', '她是谁'],
  ]
  return `<nav class="tabs home-tabs" aria-label="家的四个角落">${items.map(([key, label]) => {
    let href = `?view=${key}`
    if (key === 'today' && days > 1) href += `&amp;days=${days}`
    if (key === 'memory' && memoryQuery) href += `&amp;memory=${encodeURIComponent(memoryQuery).replace(/&/g, '&amp;')}`
    return `<a href="${href}"${view === key ? ' class="active" aria-current="page"' : ''}>${label}</a>`
  }).join('')}</nav>`
}

function collectPreviousDays({ home, dbPath, now, days }) {
  const today = dateKey(now)
  const out = []
  for (let i = 1; i < days; i += 1) {
    const date = shiftDate(today, -i)
    out.push(collectHome({
      home,
      dbPath,
      now: startOfDay(date) + 12 * 3600000,
      dreamLookback: false,
    }))
  }
  return out
}

function pastDayCard(data) {
  // 同一 dbPath 下某天缺库的概率极低，但逐日读时不能因为一天 missing 就整页 503。
  if (!data || data.missing) return ''
  const dayStart = startOfDay(data.today)
  const total = nextDayStart(data.today) - dayStart
  const last = data.phases[data.phases.length - 1] || null
  const meta = last ? (PHASE[last.phase] || { name: last.phase, color: '#5a6068' }) : null
  return `<section class="today week-day">
    <div class="day-head">
      <div>
        <div class="eyebrow">更早</div>
        <h2>${esc(dateLabel(data.today))}</h2>
      </div>
      ${meta ? `<div class="now-phase"><i style="background:${meta.color}"></i><div><strong>${esc(meta.name)}</strong><span class="muted">这一天</span></div></div>` : ''}
    </div>

    <div class="track-wrap" aria-label="${esc(data.today)} 的节律">
      <div class="track">${track(data.phases, dayStart, dayStart + total, total)}</div>
      <div class="ticks"><span>00</span><span>06</span><span>12</span><span>18</span><span>24</span></div>
      <div class="legend-row">${phaseLegend(data.phases) || '<span class="muted">这一天没有节律记录</span>'}</div>
    </div>

    <h3>她做过的事</h3>
    ${timeline(data.blocks, '这一天没有留下动作。空白也是真的——她不会替自己编。')}

    ${data.actions.length ? `<details class="actions">
      <summary>动作明细（${data.actions.length}）</summary>
      <ul>${data.actions.map((a) => `<li><time>${esc(clock(a.ts))}</time><code>${esc(a.tool)}</code><span>${esc(a.summary || '')}</span></li>`).join('')}</ul>
    </details>` : ''}

    ${data.dreams.length ? `<h3>梦</h3>${dreamBlock(data.dreams, data.today, true)}` : ''}
  </section>`
}

function weekBlock(days) {
  if (!days.length) return ''
  const newest = days[0].today
  const oldest = days[days.length - 1].today
  return `<section class="week">
    <div class="week-head">
      <div class="eyebrow">最近七天</div>
      <h2>再往前六天 · ${esc(monthDay(oldest))} — ${esc(monthDay(newest))}</h2>
      <p class="empty">今天在上面；再往前六天，空着就是空着。</p>
    </div>
    <div class="week-list">${days.map(pastDayCard).join('')}</div>
  </section>`
}

export function roomFiles(home, sub, limit = 6, maxBytes = 64 * 1024) {
  const dir = path.join(home, sub)
  try {
    // 先 stat 排序、截前 N 个，再读；不能先把整个目录里的每个文件读进内存。
    const picked = fs.readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isFile() && !e.name.startsWith('.') && /\.(md|txt)$/i.test(e.name))
      .map((e) => {
        const file = path.join(dir, e.name)
        try {
          const stat = fs.statSync(file)
          return { name: e.name, mtime: stat.mtimeMs, file }
        } catch {
          // 文件可能刚被删掉/是坏链接；一个坏文件不该让整个家 503。
          return null
        }
      })
      .filter(Boolean)
      .sort((a, b) => b.mtime - a.mtime)
      .slice(0, Math.max(0, Math.trunc(limit)))

    const cap = Math.max(1024, Math.trunc(Number(maxBytes) || 64 * 1024))
    return picked.map((entry) => {
      const buffer = Buffer.allocUnsafe(cap)
      const fd = fs.openSync(entry.file, 'r')
      let size = 0
      try {
        size = fs.readSync(fd, buffer, 0, cap, 0)
      } finally {
        fs.closeSync(fd)
      }
      return { name: entry.name, mtime: entry.mtime, text: buffer.subarray(0, size).toString('utf8') }
    })
  } catch {
    return []
  }
}

function roomShelf(home, sub, eyebrow, title) {
  const files = roomFiles(home, sub)
  const body = files.length
    ? `<div class="room-list">${files.map((f) => `<article class="room-note">
        <div class="room-when">${esc(fmtWhen(f.mtime))} · ${esc(f.name)}</div>
        <p>${esc(clip(f.text, 700))}</p>
      </article>`).join('')}</div>`
    : `<p class="empty">这里还空着。她还没有把${esc(title)}放进来。</p>`
  return `<section class="card room-shelf">
    <div class="eyebrow">${esc(eyebrow)}</div>
    <h2>${esc(title)}</h2>
    ${body}
  </section>`
}

function roomBlock(home, data) {
  const book = data.book
  const reading = book && book.total > 0
    ? `<div class="room-book"><div class="eyebrow">最近在读</div><h2>《${esc(clip(book.title, 40))}》</h2>
       <p class="empty">读到 ${Math.floor((Number(book.offset) / Number(book.total)) * 100)}%。书还在她的书架上。</p></div>`
    : '<p class="empty">她最近没有翻书。</p>'
  return `<div class="room-grid">
    ${roomShelf(home, 'notes', '便签', '她写下的便签')}
    ${roomShelf(home, 'diary', '日记', '她收起来的日子')}
    ${roomShelf(home, 'books', '书架', '她读过的书')}
    <section class="card">
      <div class="eyebrow">书架</div>
      <h2>她最近在读</h2>
      ${reading}
      ${dreamBlock(data.dreams, data.today)}
    </section>
  </div>`
}

function auditBlock(audits) {
  const list = Array.isArray(audits) ? audits : []
  if (!list.length) return ''
  return `<section class="card audit">
    <div class="eyebrow">她整理过的</div>
    <h2>忘掉与找回</h2>
    <ul class="memory-lines">${list.map((a) => `<li>
      <span class="muted">${esc(fmtWhen(a.ts))}</span>
      ${a.action === 'restore' ? '找回' : '忘掉'} <code>${esc(a.ref)}</code>
      ${a.actor ? `· ${esc(a.actor)}` : ''}${a.reason ? ` · ${esc(a.reason)}` : ''}
    </li>`).join('')}</ul>
  </section>`
}

function memoryView(data, span) {
  return `<div class="grid">
      <section class="card">
        <div class="eyebrow">她最近想着的</div>
        <h2>记得的关于你的事</h2>
        ${factsBlock(data.facts, data.now)}
      </section>
      <section class="card">
        <div class="eyebrow">你们</div>
        <h2>关系</h2>
        ${relationBlock(data.relation, data.name, '')}
      </section>
    </div>
    ${memorySection(data, span)}
    ${snapshotBlock(data.snapshot)}
    <section class="card">
      <div class="eyebrow">更早</div>
      <h2>她叠起来的印象</h2>
      ${summaryBlock(data.summaries)}
    </section>
    ${auditBlock(data.audit)}`
}

function selfView(data) {
  const lines = data.self?.lines || []
  return `<section class="card self-card">
    <div class="eyebrow">她是谁</div>
    <h2>她自己记得的样子</h2>
    ${lines.length ? `<ul class="memory-lines">${lines.map((line) => `<li>${esc(line)}</li>`).join('')}</ul>` : '<p class="empty">她还没有留下关于自己的记录。</p>'}
    <p class="empty">这里不是人格设定，也不是别人给她的形容词；只是她从自己的日子里留下的痕迹。</p>
  </section>
  <div class="grid">
    <section class="card">
      <div class="eyebrow">夜里</div>
      <h2>最近的梦</h2>
      ${dreamBlock(data.dreams, data.today)}
    </section>
    <section class="card">
      <div class="eyebrow">你们</div>
      <h2>关系</h2>
      ${relationBlock(data.relation, data.name, '')}
    </section>
  </div>
  ${snapshotBlock(data.snapshot)}`
}

function firstRunBlock() {
  return `<section class="card first-run">
    <div class="eyebrow">把她接到你家</div>
    <h2>她刚住进来</h2>
    <ol class="first-steps">
      <li><b>先跟她说一句话</b><span>在 DSH 里随便聊一句，不用自我介绍。</span></li>
      <li><b>回来看今天</b><span>刷新这一页，看她怎么过今天、做了什么。</span></li>
      <li><b>去她的房间</b><span>便签、日记、书架都在那里；她记得的人与事在「她记得」。</span></li>
    </ol>
  </section>`
}

export function renderHome({ home, dbPath, now = Date.now(), chatUrl = '', agentName = '', days = 1, memoryQuery = '', view = 'today' }) {
  const span = clampDays(days)
  const data = collectHome({ home, dbPath, now, memoryQuery })
  const pastDays = !data.missing && span > 1 ? collectPreviousDays({ home, dbPath, now, days: span }) : []
  const today = data.today
  const dayStart = startOfDay(today)
  const total = nextDayStart(today) - dayStart
  const currentMeta = data.current ? (PHASE[data.current.phase] || { name: data.current.phase }) : null
  const name = data.name || '他'
  const homeTitle = agentName ? `${agentName}的家` : '家'
  const chat = chatUrl
    ? `<a class="back" href="${esc(chatUrl)}">回她的房间 <span>→</span></a>`
    : '<span class="back muted">房间这会儿没开</span>'

  const activeView = ['today', 'memory', 'room', 'self'].includes(String(view)) ? String(view) : 'today'
  const todaySection = `<section class="today">
        <div class="day-head">
          <div>
            <div class="eyebrow">今天</div>
            <h2>${esc(dateLabel(today))}</h2>
          </div>
          <div class="now-phase">
            <i style="background:${currentMeta ? (PHASE[data.current.phase]?.color || '#8a8275') : '#4a4f58'}"></i>
            <div>
              <strong>${esc(currentMeta ? currentMeta.name : '还没有状态')}</strong>
              <span class="muted">${data.current ? `从 ${esc(clock(data.current.started_at))} 起` : '等她下一次醒来'}</span>
            </div>
          </div>
        </div>

        <div class="track-wrap" aria-label="今天的节律">
          <div class="track">
            ${track(data.phases || [], dayStart, now, total)}
            ${now >= dayStart && now <= dayStart + total
              ? `<span class="nowline" style="left:${(((now - dayStart) / total) * 100).toFixed(3)}%"></span>`
              : ''}
          </div>
          <div class="ticks"><span>00</span><span>06</span><span>12</span><span>18</span><span>24</span></div>
          <div class="legend-row">${phaseLegend(data.phases || []) || '<span class="muted">今天还没有节律记录</span>'}</div>
        </div>

        <h3>她做过的事</h3>
        ${timeline(data.blocks || [])}

        ${(data.actions || []).length ? `<details class="actions">
          <summary>动作明细（${data.actions.length}）</summary>
          <ul>${data.actions.map((a) => `<li><time>${esc(clock(a.ts))}</time><code>${esc(a.tool)}</code><span>${esc(a.summary || '')}</span></li>`).join('')}</ul>
        </details>` : ''}

        ${(data.dreams || []).length ? `<h3>梦</h3>${dreamBlock(data.dreams, data.today)}` : ''}
      </section>`

  const body = data.missing
    ? `<section class="card"><h2>她还没有家</h2>
       <p class="empty">数据库还没建：${esc(data.error || '找不到记忆库')}。<br>等她第一次醒来、说上话，这里就会有东西。</p></section>`
    : `${viewTabs(activeView, span, memoryQuery)}
      ${activeView === 'today' && data.firstRun ? firstRunBlock() : ''}
      ${activeView === 'today' ? `${reviewTabs(span)}${todaySection}${weekBlock(pastDays)}` : ''}
      ${activeView === 'memory' ? memoryView(data, span) : ''}
      ${activeView === 'room' ? roomBlock(home, data) : ''}
      ${activeView === 'self' ? selfView(data) : ''}
      <footer>
        <div class="stats">${statsLine(data.stats)}</div>
        <div class="muted">这一页只读：不写库、不改记忆、不替她说话。数据来自她自己的记忆库。</div>
        <div class="muted small">每 90 秒自己刷新一次 · ${esc(clock(now))}</div>
      </footer>`

  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="dark">
<title>${esc(homeTitle)}</title>
<style>
:root { --ink:#f1ece2; --muted:#9a958c; --line:rgba(241,236,226,.12); --card:rgba(255,255,255,.035); --accent:#e4b07a; }
* { box-sizing:border-box; }
html,body { margin:0; padding:0; }
body { position:relative; background:#0e1014; color:var(--ink); font:15px/1.65 -apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif; }
body::before { content:""; position:absolute; inset:0; pointer-events:none; background:
  radial-gradient(900px 500px at 18% -10%, rgba(228,176,122,.10), transparent 60%),
  radial-gradient(700px 400px at 92% 8%, rgba(83,103,156,.12), transparent 60%),
  #0e1014; }
.wrap { position:relative; width:min(1080px, calc(100% - 40px)); margin:0 auto; padding:56px 0 48px; }
header { display:flex; align-items:flex-end; justify-content:space-between; gap:20px; margin-bottom:32px; }
.eyebrow { color:var(--accent); letter-spacing:.22em; font-size:11px; text-transform:uppercase; }
h1 { font-family:"Songti SC","Noto Serif SC",SimSun,serif; font-weight:500; font-size:44px; letter-spacing:.04em; margin:8px 0 6px; }
.sub { color:var(--muted); font-size:14px; }
.back { color:var(--ink); text-decoration:none; border:1px solid var(--line); padding:9px 14px; border-radius:999px; font-size:13px; white-space:nowrap; }
.back:hover { border-color:var(--accent); color:var(--accent); }
.back span { color:var(--accent); }
.tabs { display:flex; gap:8px; margin:0 0 18px; }
.tabs a { color:var(--muted); text-decoration:none; border:1px solid var(--line); border-radius:999px; padding:7px 14px; font-size:12px; }
.tabs a:hover { color:var(--ink); border-color:rgba(241,236,226,.3); }
.tabs a.active { color:#0e1014; background:var(--accent); border-color:var(--accent); }
.home-tabs { margin-bottom:14px; }
.home-tabs a { font-size:14px; padding:9px 18px; }
.day-tabs { margin:0 0 14px; }
.day-tabs a { font-size:11px; padding:5px 12px; }
.today { background:linear-gradient(180deg, rgba(255,255,255,.045), rgba(255,255,255,.015)); border:1px solid var(--line); border-radius:22px; padding:26px 28px 24px; }
.week { margin-top:26px; }
.week-head { margin:0 0 14px; }
.week-head h2 { font-size:18px; }
.week-head .empty { margin-top:4px; }
.week-list { display:grid; gap:16px; }
.week-day { padding:22px 24px 20px; }
.day-head { display:flex; justify-content:space-between; align-items:flex-start; gap:16px; }
h2 { font-size:19px; font-weight:500; margin:6px 0 0; letter-spacing:.01em; }
h3 { font-size:14px; font-weight:500; color:var(--muted); margin:28px 0 12px; letter-spacing:.08em; }
.now-phase { display:flex; gap:10px; align-items:center; padding-top:4px; }
.now-phase i { width:9px; height:9px; border-radius:50%; display:block; box-shadow:0 0 0 4px rgba(228,176,122,.08); }
.now-phase strong { display:block; font-weight:500; font-size:14px; }
.now-phase .muted { display:block; font-size:12px; }
.muted { color:var(--muted); }
.small { font-size:12px; }
.track-wrap { margin:22px 0 4px; }
.track { position:relative; height:16px; border-radius:999px; background:rgba(255,255,255,.04); overflow:hidden; border:1px solid rgba(255,255,255,.05); }
.seg { position:absolute; top:0; bottom:0; opacity:.9; }
.nowline { position:absolute; top:-3px; bottom:-3px; width:1px; background:var(--ink); box-shadow:0 0 0 3px rgba(14,16,20,.7); }
.ticks { display:flex; justify-content:space-between; color:#666; font-size:10px; margin-top:6px; letter-spacing:.08em; }
.legend-row { display:flex; gap:16px; flex-wrap:wrap; margin-top:10px; font-size:12px; color:var(--muted); }
.legend { display:inline-flex; align-items:center; gap:6px; }
.legend i { width:7px; height:7px; border-radius:50%; display:inline-block; }
.timeline { list-style:none; margin:0; padding:0; border-left:1px solid var(--line); }
.timeline li { position:relative; padding:0 0 16px 18px; display:grid; grid-template-columns:118px 1fr auto; gap:10px; align-items:baseline; }
.timeline li::before { content:""; position:absolute; left:-3px; top:8px; width:5px; height:5px; border-radius:50%; background:var(--accent); opacity:.8; }
.timeline li.gap::before { background:#555; }
.timeline li.gap .what { color:#6c6a66; }
.timeline time { color:var(--muted); font-size:12px; font-variant-numeric:tabular-nums; }
.what { font-size:15px; }
.ev { justify-self:end; }
.chips { display:flex; gap:5px; flex-wrap:wrap; justify-content:flex-end; }
.chip { font-size:10px; color:#8f8a80; border:1px solid rgba(255,255,255,.08); padding:2px 7px; border-radius:999px; white-space:nowrap; }
.empty { color:var(--muted); font-size:13px; margin:8px 0 0; }
.actions { margin-top:18px; border-top:1px solid var(--line); padding-top:12px; }
.actions summary { cursor:pointer; color:var(--muted); font-size:12px; }
.actions ul { list-style:none; padding:10px 0 0; margin:0; }
.actions li { display:grid; grid-template-columns:56px 140px 1fr; gap:10px; padding:4px 0; font-size:12px; color:#c9c3b8; }
.actions code { color:var(--accent); font-family:ui-monospace,SFMono-Regular,Consolas,monospace; font-size:11px; }
.grid { display:grid; grid-template-columns:1.15fr .85fr; gap:18px; margin-top:18px; }
.card { background:var(--card); border:1px solid var(--line); border-radius:20px; padding:22px 24px; }
.first-run { margin-bottom:18px; border-color:rgba(228,176,122,.32); background:linear-gradient(180deg, rgba(228,176,122,.08), rgba(255,255,255,.025)); }
.first-run h2 { margin-top:2px; }
.first-steps { margin:14px 0 0; padding-left:20px; display:grid; gap:10px; }
.first-steps li { padding-left:2px; }
.first-steps b { display:block; font-weight:500; }
.first-steps span { display:block; color:var(--muted); font-size:13px; }
.room-grid { display:grid; grid-template-columns:1fr 1fr; gap:18px; margin-top:18px; }
.room-list { display:grid; gap:10px; margin-top:12px; }
.room-note { border-left:2px solid rgba(228,176,122,.35); padding:2px 0 2px 12px; }
.room-when { color:var(--muted); font-size:11px; letter-spacing:.04em; }
.room-note p { margin:5px 0 0; color:#d9d3c8; font-size:13px; white-space:pre-wrap; }
.room-book { margin-top:12px; }
.audit code { color:var(--accent); font-size:11px; }
.self-card { margin-top:18px; }
.facts { list-style:none; margin:12px 0 0; padding:0; }
.facts li { padding:6px 0; border-bottom:1px dashed rgba(255,255,255,.06); font-size:14px; }
.facts li:last-child { border-bottom:0; }
.ref { color:#8f8a80; font-family:ui-monospace,SFMono-Regular,Consolas,monospace; font-size:10px; margin-left:6px; }
.memory { margin-top:18px; }
.memory h3 { margin-top:22px; }
.memory-search { display:flex; gap:8px; margin:16px 0 4px; }
.memory-search input { flex:1; min-width:0; background:rgba(255,255,255,.04); color:var(--ink); border:1px solid var(--line); border-radius:999px; padding:9px 14px; font:13px inherit; outline:none; }
.memory-search input:focus { border-color:var(--accent); }
.memory-search button { background:var(--accent); color:#0e1014; border:0; border-radius:999px; padding:9px 18px; font:13px inherit; cursor:pointer; }
.memory-lines, .memory-hits ul, .memory-conflicts ul { list-style:none; margin:8px 0 0; padding:0; }
.memory-lines li, .memory-hits li, .memory-conflicts li { padding:6px 0; border-bottom:1px dashed rgba(255,255,255,.06); font-size:13px; color:#d9d3c8; }
.memory-lines li:last-child, .memory-hits li:last-child, .memory-conflicts li:last-child { border-bottom:0; }
.memory-hits li .muted { margin-right:6px; }
.relation { margin-top:12px; }
.rel-name { font-size:17px; }
.rel-stage { display:inline-block; margin:10px 0 8px; padding:3px 10px; border-radius:999px; background:rgba(228,176,122,.12); color:var(--accent); font-size:12px; }
.quote { margin-top:12px; }
.quote p, .dream p { margin:4px 0 0; font-size:14px; color:#d9d3c8; }
.dream { margin-top:12px; border:1px dashed rgba(83,103,156,.5); border-radius:14px; padding:12px 14px; background:rgba(83,103,156,.07); }
.dream-when { color:#a9b8da; font-size:11px; letter-spacing:.08em; margin-bottom:4px; }
.dream-tag { color:#8fa2cf; font-size:10px; letter-spacing:.16em; }
footer { margin-top:26px; border-top:1px solid var(--line); padding-top:16px; display:flex; flex-direction:column; gap:6px; }
.stats { display:flex; gap:8px; align-items:center; flex-wrap:wrap; font-size:12px; color:var(--muted); }
.stats i { font-style:normal; color:#4a4f58; }
@media (max-width: 760px) {
  .wrap { width:calc(100% - 24px); padding-top:32px; }
  header { flex-direction:column; align-items:flex-start; gap:12px; }
  h1 { font-size:34px; }
  .grid { grid-template-columns:1fr; }
  .room-grid { grid-template-columns:1fr; }
  .timeline li { grid-template-columns:88px 1fr; }
  .timeline li .ev { grid-column:2; justify-self:start; }
  .chips { justify-content:flex-start; }
  .today, .week-day { padding:20px 16px; }
  .tabs { margin-bottom:14px; }
}
</style>
</head>
<body>
<div class="wrap">
  <header>
    <div>
      <div class="eyebrow">life-innovation · 只读</div>
      <h1>${esc(homeTitle)}</h1>
      <div class="sub">${esc(dateLabel(today))} · ${esc(clock(now))}</div>
    </div>
    ${chat}
  </header>
  ${body}
</div>
<script>setTimeout(function(){ location.reload() }, 90000)</script>
</body>
</html>`
}

export function renderHomeError(error, agentName = '') {
  const homeTitle = agentName ? `${agentName}的家` : '家'
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="color-scheme" content="dark"><title>${esc(homeTitle)}</title>
  <style>body{background:#0e1014;color:#f1ece2;font:15px/1.7 system-ui,"Microsoft YaHei",sans-serif;padding:12vh 8vw}h1{font-size:28px}code{color:#e4b07a}</style></head>
  <body><h1>她的家暂时没打开</h1><p>${esc(error)}</p><p>回固定入口 <code>/</code> 可以回到她的房间。</p></body></html>`
}

export function homeFilePath(home) {
  const next = path.join(home, 'state', 'life-innovation.sqlite')
  const legacy = path.join(home, 'state', 'jingjing.sqlite')
  if (!fs.existsSync(next) && fs.existsSync(legacy)) return legacy
  return next
}

/** 插件启动时把「这次实际打开的库」写在这里，固定入口读它。
 *  这样手改 config.dbPath、又没重跑安装脚本时，/home 也不会读旧库。 */
export function homeDbHintFile(home) {
  return path.join(home, 'state', 'home-db.txt')
}

export function readHomeDbHint(home) {
  try {
    const hinted = fs.readFileSync(homeDbHintFile(home), 'utf8').trim()
    return hinted && fs.existsSync(hinted) ? hinted : ''
  } catch {
    return ''
  }
}


