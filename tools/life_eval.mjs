#!/usr/bin/env node
/**
 * 生活体评测（0.4.0）。不是助手 KPI：
 * - 连续性：最近 7 天有几天真的留下过生活痕迹；
 * - 睡眠巩固覆盖率：已经收起来的日子，有多少留下 self snapshot；
 * - 生活证据覆盖：日子块有多少带证据；
 * - 修复率：改口后旧说法是否被正确取代；
 * - 助手腔：她的回复里出现客服话术的比例；
 * - recall@3 / token / p95：技术底线。
 *
 * 只读数据库，不调模型、不发消息。
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { MemoryStore } from '../lib/store.js'
import { rankedRecall } from '../lib/search.js'
import { buildPack } from '../lib/pack.js'
import { addDays, dateKey, startOfDay } from '../lib/life.js'

const DAY = 86400000
const TONE = /有什么可以帮|很高兴为您|请问还有什么|希望以上|作为一个AI|作为一个人工智能|我可以帮您|如需帮助/i

function localDate(ts) {
  return dateKey(Number(ts))
}

function activeDaySet(store, start, end) {
  const days = new Set()
  for (const r of store.rawBetween(start, end)) days.add(localDate(r.ts))
  for (const a of store.actionsBetween(start, end)) days.add(localDate(a.ts))
  for (const d of store.db.prepare('SELECT date FROM dreams WHERE ts >= ? AND ts <= ?').all(start, end)) days.add(String(d.date))
  for (const s of store.recentSelfSnapshots ? store.recentSelfSnapshots(60) : []) {
    if (s.ts >= start && s.ts <= end) days.add(String(s.date))
  }
  return days
}

export function evaluateLife({ store, now = Date.now(), queries = [], windowDays = 30, recallRuns = 12 } = {}) {
  const end = Math.trunc(now)
  const start = startOfDay(addDays(now, -(windowDays - 1)))
  const weekStart = startOfDay(addDays(now, -6))
  const active7 = activeDaySet(store, weekStart, end)
  const continuity7d = Math.round((active7.size / 7) * 1000) / 1000

  const closedRows = store.db.prepare(`
    SELECT call_id FROM actions
    WHERE kind = 'system' AND tool = 'close_day' AND status = 'ok'
      AND ts >= ? AND ts <= ?
  `).all(start, end)
  const closed = closedRows
    .map((r) => String(r.call_id || '').replace(/^close_day:/, ''))
    .filter(Boolean)
  const snapshotRows = store.db.prepare('SELECT date FROM self_snapshots WHERE date >= ? AND date <= ?').all(localDate(start), localDate(end))
  const snapSet = new Set(snapshotRows.map((r) => String(r.date)))
  const snapshotCoverage = closed.length
    ? Math.round((closed.filter((d) => snapSet.has(d)).length / closed.length) * 1000) / 1000
    : null

  const blocks = store.db.prepare('SELECT id, evidence FROM life_blocks WHERE started_at >= ? AND started_at <= ?').all(start, end)
  const evidenceCoverage = blocks.length
    ? Math.round((blocks.filter((b) => {
      try { return JSON.parse(String(b.evidence || '[]')).length > 0 } catch { return false }
    }).length / blocks.length) * 1000) / 1000
    : null

  const corrections = store.db.prepare(`
    SELECT a.id, a.predicate, a.value, a.superseded_by, b.value AS newer, b.valid_to AS newer_valid_to
    FROM assertions a LEFT JOIN assertions b ON b.id = a.superseded_by
    WHERE a.valid_to IS NOT NULL AND a.superseded_by IS NOT NULL
  `).all()
  const repaired = corrections.filter((c) => c.newer !== null && String(c.newer) !== String(c.value) && c.newer_valid_to === null)
  const repairRate = corrections.length
    ? Math.round((repaired.length / corrections.length) * 1000) / 1000
    : null

  const live = store.db.prepare('SELECT predicate, COUNT(*) AS n FROM assertions WHERE valid_to IS NULL GROUP BY predicate').all()
  const conflictRows = live.filter((r) => Number(r.n) > 1).length
  const selfConsistency = live.length ? Math.round((1 - conflictRows / live.length) * 1000) / 1000 : 1

  const assistantRows = store.rawBetween(start, end).filter((r) => String(r.role) !== 'user')
  const toneRows = assistantRows.filter((r) => TONE.test(String(r.text || '')))
  const assistantToneRate = assistantRows.length
    ? Math.round((toneRows.length / assistantRows.length) * 1000) / 1000
    : null

  const recall = queries.map((q) => {
    const query = String(q.query || q.q || '').trim()
    const expect = String(q.expect || q.expected || '').trim()
    if (!query) return { query, expect, hit: false, refs: [] }
    const out = rankedRecall({ store, query, limit: 3, now })
    const refs = out.hits.map((h) => h.ref || `raw:${h.id}`)
    return {
      query, expect,
      hit: Boolean(expect) && out.hits.some((h) => String(h.text || '').includes(expect)),
      refs,
    }
  })
  const recallHits = recall.filter((r) => r.hit).length
  const recallAt3 = recall.length ? Math.round((recallHits / recall.length) * 1000) / 1000 : null

  const timings = []
  for (let i = 0; i < Math.max(1, recallRuns); i += 1) {
    const q = queries.length ? String(queries[i % queries.length].query || queries[i % queries.length].q || '') : ''
    if (!q) continue
    const t0 = performance.now()
    rankedRecall({ store, query: q, limit: 3, now })
    timings.push(performance.now() - t0)
  }
  timings.sort((a, b) => a - b)
  const p95 = timings.length ? Math.round(timings[Math.min(timings.length - 1, Math.floor(timings.length * 0.95))] * 100) / 100 : null

  let token = null
  try {
    const pack = buildPack({ store, now, maxChars: 1200 })
    token = Math.ceil(pack.length / 4)
  } catch { token = null }

  return {
    generatedAt: new Date(now).toISOString(),
    windowDays,
    counts: {
      raw: store.rawBetween(start, end).length,
      closedDays: closed.length,
      snapshots: snapSet.size,
      lifeBlocks: blocks.length,
      assistantTurns: assistantRows.length,
      corrections: corrections.length,
      recallQuestions: recall.length,
    },
    metrics: {
      continuity7d,
      snapshotCoverage,
      lifeEvidenceCoverage: evidenceCoverage,
      repairRate,
      selfConsistency,
      assistantToneRate,
      recallAt3,
      token,
      p95RecallMs: p95,
    },
    recall,
    failures: recall.filter((r) => !r.hit).map((r) => ({ query: r.query, expect: r.expect, refs: r.refs })),
  }
}

function markdown(report) {
  const m = report.metrics
  const pct = (v) => v === null || v === undefined ? '—' : `${(Number(v) * 100).toFixed(1)}%`
  return [
    '# 生活体评测（0.4.0）',
    '',
    `生成：${report.generatedAt}；窗口：${report.windowDays} 天`,
    '',
    '| 指标 | 值 |',
    '|---|---|',
    `| continuity@7d | ${pct(m.continuity7d)} |`,
    `| 睡眠巩固覆盖 | ${pct(m.snapshotCoverage)} |`,
    `| 生活证据覆盖 | ${pct(m.lifeEvidenceCoverage)} |`,
    `| 修复率 | ${pct(m.repairRate)} |`,
    `| 自我一致 | ${pct(m.selfConsistency)} |`,
    `| 助手腔 | ${pct(m.assistantToneRate)} |`,
    `| recall@3 | ${pct(m.recallAt3)} |`,
    `| token（约） | ${m.token ?? '—'} |`,
    `| p95 召回 | ${m.p95RecallMs ?? '—'} ms |`,
    '',
    `样本：raw ${report.counts.raw} / 收起来的日子 ${report.counts.closedDays} / 快照 ${report.counts.snapshots} / 日子块 ${report.counts.lifeBlocks} / 助手回复 ${report.counts.assistantTurns} / 改口 ${report.counts.corrections}`,
    '',
    ...(report.failures.length
      ? ['## 未命中', ...report.failures.map((f) => `- 「${f.query}」期望「${f.expect}」；前 3 条：${f.refs.join(', ') || '无'}`)]
      : ['## 未命中', '无。']),
    '',
    '> 这是生活体评测，不是任务完成率；它只检查她是否连贯、是否有证据、是否还在用助手腔。',
    '',
  ].join('\n')
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2)
  const dbArg = args.find((a) => a.startsWith('--db='))?.slice(5)
    || process.env.LIFE_DB
    || path.join(process.env.LIFE_HOME || 'D:/life-innovation-home', 'state', 'life-innovation.sqlite')
  if (!dbArg) {
    console.error('用法：node tools/life_eval.mjs --db=<记忆库> [--md]')
    process.exit(2)
  }
  if (!fs.existsSync(dbArg)) {
    console.error(`找不到记忆库：${dbArg}`)
    process.exit(2)
  }
  const fixture = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'tests', 'fixtures', 'life-eval.json')
  const queries = fs.existsSync(fixture) ? JSON.parse(fs.readFileSync(fixture, 'utf8')) : []
  const store = new MemoryStore(dbArg)
  try {
    const report = evaluateLife({ store, queries })
    process.stdout.write(args.includes('--md') ? markdown(report) : `${JSON.stringify(report, null, 2)}\n`)
  } finally {
    store.close()
  }
}
