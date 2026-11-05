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

const TZ = 'Asia/Shanghai'
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

function dateKey(now) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date(now))
}

function clock(ts) {
  if (!Number.isFinite(Number(ts))) return '--:--'
  return new Intl.DateTimeFormat('zh-CN', {
    timeZone: TZ, hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(new Date(Number(ts)))
}

function dateLabel(date) {
  const d = new Date(`${date}T00:00:00+08:00`)
  // 不用 getFullYear()/getMonth()：它们取的是服务器本地时区，
  // 在 UTC 机器上会把 11 月 6 日显示成 11 月 5 日。这里固定按上海时区取。
  const parts = new Intl.DateTimeFormat('zh-CN', {
    timeZone: TZ, year: 'numeric', month: 'numeric', day: 'numeric', weekday: 'long',
  }).formatToParts(d)
  const pick = (type) => parts.find((x) => x.type === type)?.value || ''
  return `${pick('year')} 年 ${pick('month')} 月 ${pick('day')} 日 · ${pick('weekday')}`
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

export function collectHome({ home, dbPath, now = Date.now() }) {
  const today = dateKey(now)
  const dayStart = Date.parse(`${today}T00:00:00+08:00`)
  const dayEnd = dayStart + 86400000 - 1
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
    const facts = rows(db, 'SELECT subject, predicate, value, due_at FROM assertions WHERE valid_to IS NULL ORDER BY id DESC LIMIT 16')
    const summaries = rows(db, 'SELECT ts, text FROM summaries ORDER BY id DESC LIMIT 2')
    const dreams = rows(db, 'SELECT date, text, evidence FROM dreams ORDER BY id DESC LIMIT 1')
    const relation = row(db, 'SELECT person_id, stage, first_seen, last_seen, turns FROM relations ORDER BY last_seen DESC LIMIT 1')
    const profileName = row(db, "SELECT value FROM profiles WHERE key = '名字' LIMIT 1")
    const current = row(db, 'SELECT phase, started_at, reason FROM life_phases WHERE ended_at IS NULL ORDER BY id DESC LIMIT 1')
    const last = current || row(db, 'SELECT phase, started_at, reason FROM life_phases ORDER BY id DESC LIMIT 1')

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

function track(phases, dayStart, now) {
  const total = 86400000
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

function timeline(blocks) {
  if (!blocks.length) {
    return '<p class="empty">今天还没有留下动作。空白也是真的——她不会替自己编。</p>'
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
    return `<li>${esc(factLine(f))}${due}</li>`
  }).join('')}</ul>`
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

function dreamBlock(dreams) {
  if (!dreams.length) {
    return '<p class="empty">还没有梦。梦只在一天收起来之后才会出现。</p>'
  }
  return dreams.map((d) => `<div class="dream">
    <div class="dream-tag">梦 · 不是真事</div>
    <p>${esc(clip(d.text, 220))}</p>
    <div class="ev">${evidenceChips(d.evidence)}</div>
  </div>`).join('')
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

export function renderHome({ home, dbPath, now = Date.now(), chatUrl = '', agentName = '' }) {
  const data = collectHome({ home, dbPath, now })
  const today = data.today
  const dayStart = Date.parse(`${today}T00:00:00+08:00`)
  const currentMeta = data.current ? (PHASE[data.current.phase] || { name: data.current.phase }) : null
  const name = data.name || '他'
  const homeTitle = agentName ? `${agentName}的家` : '家'
  const chat = chatUrl
    ? `<a class="back" href="${esc(chatUrl)}">回她的房间 <span>→</span></a>`
    : '<span class="back muted">房间这会儿没开</span>'

  const body = data.missing
    ? `<section class="card"><h2>她还没有家</h2>
       <p class="empty">数据库还没建：${esc(data.error || '找不到记忆库')}。<br>等她第一次醒来、说上话，这里就会有东西。</p></section>`
    : `<section class="today">
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
            ${track(data.phases, dayStart, now)}
            ${now >= dayStart && now <= dayStart + 86400000
              ? `<span class="nowline" style="left:${(((now - dayStart) / 86400000) * 100).toFixed(3)}%"></span>`
              : ''}
          </div>
          <div class="ticks"><span>00</span><span>06</span><span>12</span><span>18</span><span>24</span></div>
          <div class="legend-row">${phaseLegend(data.phases) || '<span class="muted">今天还没有节律记录</span>'}</div>
        </div>

        <h3>她做过的事</h3>
        ${timeline(data.blocks)}

        ${data.actions.length ? `<details class="actions">
          <summary>动作明细（${data.actions.length}）</summary>
          <ul>${data.actions.map((a) => `<li><time>${esc(clock(a.ts))}</time><code>${esc(a.tool)}</code><span>${esc(a.summary || '')}</span></li>`).join('')}</ul>
        </details>` : ''}
      </section>

      <div class="grid">
        <section class="card">
          <div class="eyebrow">她最近想着的</div>
          <h2>记得的关于你的事</h2>
          ${factsBlock(data.facts, data.now)}
        </section>
        <section class="card">
          <div class="eyebrow">你们</div>
          <h2>关系</h2>
          ${relationBlock(data.relation, data.name, agentName)}
        </section>
      </div>

      <div class="grid">
        <section class="card">
          <div class="eyebrow">更早</div>
          <h2>她叠起来的印象</h2>
          ${summaryBlock(data.summaries)}
        </section>
        <section class="card">
          <div class="eyebrow">夜里</div>
          <h2>梦</h2>
          ${dreamBlock(data.dreams)}
        </section>
      </div>

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
.today { background:linear-gradient(180deg, rgba(255,255,255,.045), rgba(255,255,255,.015)); border:1px solid var(--line); border-radius:22px; padding:26px 28px 24px; }
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
.facts { list-style:none; margin:12px 0 0; padding:0; }
.facts li { padding:6px 0; border-bottom:1px dashed rgba(255,255,255,.06); font-size:14px; }
.facts li:last-child { border-bottom:0; }
.relation { margin-top:12px; }
.rel-name { font-size:17px; }
.rel-stage { display:inline-block; margin:10px 0 8px; padding:3px 10px; border-radius:999px; background:rgba(228,176,122,.12); color:var(--accent); font-size:12px; }
.quote { margin-top:12px; }
.quote p, .dream p { margin:4px 0 0; font-size:14px; color:#d9d3c8; }
.dream { margin-top:12px; border:1px dashed rgba(83,103,156,.5); border-radius:14px; padding:12px 14px; background:rgba(83,103,156,.07); }
.dream-tag { color:#8fa2cf; font-size:10px; letter-spacing:.16em; }
footer { margin-top:26px; border-top:1px solid var(--line); padding-top:16px; display:flex; flex-direction:column; gap:6px; }
.stats { display:flex; gap:8px; align-items:center; flex-wrap:wrap; font-size:12px; color:var(--muted); }
.stats i { font-style:normal; color:#4a4f58; }
@media (max-width: 760px) {
  .wrap { width:calc(100% - 24px); padding-top:32px; }
  header { flex-direction:column; align-items:flex-start; gap:12px; }
  h1 { font-size:34px; }
  .grid { grid-template-columns:1fr; }
  .timeline li { grid-template-columns:88px 1fr; }
  .timeline li .ev { grid-column:2; justify-self:start; }
  .chips { justify-content:flex-start; }
  .today { padding:20px 16px; }
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

export function homeDiaryDir(home) {
  return path.join(home, 'diary')
}

export function readDiaryPeek(home, date) {
  try {
    const file = path.join(homeDiaryDir(home), `${date}.md`)
    if (!fs.existsSync(file)) return ''
    return fs.readFileSync(file, 'utf8').slice(0, 600)
  } catch {
    return ''
  }
}
