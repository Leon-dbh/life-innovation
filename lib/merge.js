/**
 * 把另一台机器的记忆合进来，而不是整库覆盖。
 *
 * 为什么不能直接拷库：两边的 raw_turns.id、actions.id 都是各自自增的，
 * assertions.source 写着 `raw:12`、life_blocks.evidence 写着 `act:7`——直接覆盖会
 * 让她「记得的事」指向别人的原话。所以合并要：去重、重建 id、再把引用改到新 id。
 *
 * 规则（都是确定的，不猜）：
 * - 原话：按「时间 + 谁说的 + 原话」去重（同一条消息出现在两份导出里只留一份）。
 * - 动作：优先按 call_id 去重（同一次工具调用）；没有 call_id 才按时间+工具+摘要。
 * - 断言：同一件事同一说法同一时间只留一份；两边各自「当前有效」但说法不同时，
 *   保留目标库当前的，另一条作为历史（valid_to=now、superseded_by 指向当前）。
 * - 画像：按 (person,key) 合并，updated_at 新的赢。
 * - 关系：first_seen 取更早、last_seen 取更晚、turns 取较大值，阶段跟更晚见到的那条。
 * - 日子块：按「日期+活动+起止」去重；证据重新映射到合并后的 id，映射不到的丢掉。
 * - 外发账本：按「时间+渠道+对象+正文」去重。
 */
import fs from 'node:fs'
import { randomUUID } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { MemoryStore } from './store.js'

const DAY = 86400000

function sameFile(a, b) {
  return String(a).toLowerCase() === String(b).toLowerCase()
}

function num(v) {
  return Number(v ?? 0)
}

/** 把 "raw:12" / "act:3" 里的旧 id 换成新 id；换不到就返回 null。 */
function remapRef(ref, rawMap, actMap) {
  const m = /^(raw|act):(\d+)$/.exec(String(ref || ''))
  if (!m) return null
  const [, kind, oldId] = m
  const map = kind === 'raw' ? rawMap : actMap
  const next = map.get(num(oldId))
  return next === undefined ? null : `${kind}:${next}`
}

export function mergeDatabase({ targetPath, sourcePath, now = Date.now() }) {
  if (!fs.existsSync(sourcePath)) throw new Error(`来源库不存在：${sourcePath}`)
  if (sameFile(targetPath, sourcePath)) throw new Error('目标库和来源库是同一个文件')

  const store = new MemoryStore(targetPath)
  const tdb = store.db
  const sdb = new DatabaseSync(sourcePath, { readOnly: true })
  const report = {}

  try {
    // ---------- 原话 ----------
    const findRaw = tdb.prepare('SELECT id FROM raw_turns WHERE ts = ? AND role = ? AND text = ?')
    const insRaw = tdb.prepare('INSERT INTO raw_turns (ts, session_id, role, text) VALUES (?, ?, ?, ?)')
    const rawMap = new Map()
    let rawAdded = 0
    let rawSkipped = 0
    // 来源库里超过 90 天的原话可能已经在 raw_archive 表里。不搬它们，
    // 引用这些 ref 的生活块就会因为映射不到被整块丢掉（合并看起来成功，日子少了一截）。
    const sourceRaw = sdb.prepare(`SELECT id, ts, session_id, role, text, NULL AS archived FROM raw_turns
      UNION ALL SELECT id, ts, session_id, role, text, 1 AS archived FROM raw_archive ORDER BY id`).all()
    let rawArchived = 0
    for (const r of sourceRaw) {
      if (r.archived) rawArchived += 1
      const hit = findRaw.get(r.ts, r.role, r.text)
      if (hit) {
        rawMap.set(num(r.id), num(hit.id))
        rawSkipped += 1
      } else {
        const info = insRaw.run(r.ts, r.session_id, r.role, r.text)
        rawMap.set(num(r.id), num(info.lastInsertRowid))
        rawAdded += 1
      }
    }
    report.raw_turns = { added: rawAdded, skipped: rawSkipped, fromArchive: rawArchived }

    // ---------- 梗概 ----------
    const findSummary = tdb.prepare('SELECT id FROM summaries WHERE ts = ? AND text = ? AND from_ts IS ? AND to_ts IS ?')
    const insSummary = tdb.prepare('INSERT INTO summaries (ts, session_id, text, from_ts, to_ts, to_raw_id) VALUES (?, ?, ?, ?, ?, ?)')
    let sumAdded = 0
    let sumSkipped = 0
    for (const r of sdb.prepare('SELECT * FROM summaries ORDER BY id').all()) {
      if (findSummary.get(r.ts, r.text, r.from_ts, r.to_ts)) { sumSkipped += 1; continue }
      // 水位 ref 也要重映射；旧版梗概没有 to_raw_id，就让它保持 NULL（按 to_ts 回退推算）。
      const toRaw = r.to_raw_id === null || r.to_raw_id === undefined ? null : rawMap.get(num(r.to_raw_id)) ?? null
      insSummary.run(r.ts, r.session_id, r.text, r.from_ts, r.to_ts, toRaw)
      sumAdded += 1
    }
    report.summaries = { added: sumAdded, skipped: sumSkipped }

    // ---------- 动作 ----------
    const actMap = new Map()
    const findActByCall = tdb.prepare('SELECT id FROM actions WHERE call_id = ?')
    const findActByText = tdb.prepare('SELECT id FROM actions WHERE call_id IS NULL AND ts = ? AND tool IS ? AND summary = ?')
    const insAct = tdb.prepare(`INSERT INTO actions (ts, session_id, kind, tool, summary, call_id, status, meta)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
    let actAdded = 0
    let actSkipped = 0
    for (const r of sdb.prepare('SELECT * FROM actions ORDER BY id').all()) {
      // 老版本把「没有 call_id」写成空字符串；空字符串在 UNIQUE 列上会互相冲突，
      // 统一归一成 NULL，才能按「时间+工具+摘要」去重。
      const cid = r.call_id === null || String(r.call_id).trim() === '' ? null : r.call_id
      const hit = cid === null
        ? findActByText.get(r.ts, r.tool, r.summary)
        : findActByCall.get(cid)
      if (hit) {
        actMap.set(num(r.id), num(hit.id))
        actSkipped += 1
      } else {
        const info = insAct.run(r.ts, r.session_id, r.kind, r.tool, r.summary, cid, r.status, r.meta)
        actMap.set(num(r.id), num(info.lastInsertRowid))
        actAdded += 1
      }
    }
    report.actions = { added: actAdded, skipped: actSkipped }

    // ---------- 断言 ----------
    const findAssertion = tdb.prepare('SELECT id FROM assertions WHERE subject = ? AND predicate = ? AND value = ? AND ts = ?')
    const findLive = tdb.prepare('SELECT id, value FROM assertions WHERE subject = ? AND predicate = ? AND valid_to IS NULL ORDER BY id DESC LIMIT 1')
    const insAssertion = tdb.prepare(`INSERT INTO assertions
      (ts, subject, predicate, value, source, source_ts, valid_from, valid_to, superseded_by, due_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    const assertMap = new Map()
    const pendingSupersede = []
    let asAdded = 0
    let asSkipped = 0
    let asDemoted = 0
    for (const r of sdb.prepare('SELECT * FROM assertions ORDER BY id').all()) {
      const hit = findAssertion.get(r.subject, r.predicate, r.value, r.ts)
      if (hit) {
        assertMap.set(num(r.id), num(hit.id))
        asSkipped += 1
        if (r.superseded_by !== null) pendingSupersede.push([num(r.id), num(r.superseded_by)])
        continue
      }
      const source = remapRef(r.source, rawMap, actMap) || String(r.source || 'import')
      let validTo = r.valid_to
      let supersededBy = null
      if (validTo === null) {
        const live = findLive.get(r.subject, r.predicate)
        if (live && String(live.value) !== String(r.value)) {
          // 目标库已有「当前有效」的另一种说法：这条只作为历史留下，指向当前那条。
          validTo = Math.trunc(now)
          supersededBy = num(live.id)
          asDemoted += 1
        }
      }
      const info = insAssertion.run(r.ts, r.subject, r.predicate, r.value, source, r.source_ts, r.valid_from, validTo, supersededBy, r.due_at)
      const newId = num(info.lastInsertRowid)
      assertMap.set(num(r.id), newId)
      if (r.superseded_by !== null) pendingSupersede.push([num(r.id), num(r.superseded_by)])
      asAdded += 1
    }
    // superseded_by 指向的可能是后插入的断言，统一补一遍。
    const setSuperseded = tdb.prepare('UPDATE assertions SET superseded_by = ? WHERE id = ?')
    let links = 0
    for (const [oldId, oldTarget] of pendingSupersede) {
      const from = assertMap.get(oldId)
      const to = assertMap.get(oldTarget)
      if (from && to && from !== to) { setSuperseded.run(to, from); links += 1 }
    }
    report.assertions = { added: asAdded, skipped: asSkipped, demoted: asDemoted, links }

    // ---------- 画像 ----------
    const upsertProfile = tdb.prepare(`INSERT INTO profiles (person_id, key, value, source, updated_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(person_id, key) DO UPDATE SET value = excluded.value, source = excluded.source, updated_at = excluded.updated_at
      WHERE excluded.updated_at > profiles.updated_at`)
    let profAdded = 0
    let profKept = 0
    for (const r of sdb.prepare('SELECT * FROM profiles').all()) {
      const changed = Number(upsertProfile.run(r.person_id, r.key, r.value, r.source, r.updated_at).changes)
      if (changed > 0) profAdded += 1
      else profKept += 1
    }
    report.profiles = { updated: profAdded, kept: profKept }

    // ---------- 关系 ----------
    const getRel = tdb.prepare('SELECT * FROM relations WHERE person_id = ?')
    const putRel = tdb.prepare(`INSERT INTO relations (person_id, stage, first_seen, last_seen, turns)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(person_id) DO UPDATE SET stage = excluded.stage, first_seen = excluded.first_seen,
        last_seen = excluded.last_seen, turns = excluded.turns`)
    let relMerged = 0
    for (const r of sdb.prepare('SELECT * FROM relations').all()) {
      const cur = getRel.get(r.person_id)
      if (!cur) {
        putRel.run(r.person_id, r.stage, r.first_seen, r.last_seen, r.turns)
      } else {
        const latest = num(r.last_seen) >= num(cur.last_seen) ? r : cur
        putRel.run(r.person_id, latest.stage,
          Math.min(num(r.first_seen), num(cur.first_seen)),
          Math.max(num(r.last_seen), num(cur.last_seen)),
          Math.max(num(r.turns), num(cur.turns)))
      }
      relMerged += 1
    }
    report.relations = { merged: relMerged }

    // ---------- 日子块 ----------
    const findBlock = tdb.prepare('SELECT id FROM life_blocks WHERE date = ? AND activity = ? AND started_at = ? AND ended_at = ?')
    const insBlock = tdb.prepare('INSERT INTO life_blocks (date, activity, started_at, ended_at, evidence, created_at) VALUES (?, ?, ?, ?, ?, ?)')
    let blkAdded = 0
    let blkSkipped = 0
    let blkEmpty = 0
    for (const r of sdb.prepare('SELECT * FROM life_blocks ORDER BY id').all()) {
      if (findBlock.get(r.date, r.activity, r.started_at, r.ended_at)) { blkSkipped += 1; continue }
      let evidence = []
      try { evidence = JSON.parse(String(r.evidence || '[]')) } catch { evidence = [] }
      const mapped = evidence.map((ref) => remapRef(ref, rawMap, actMap)).filter(Boolean)
      if (mapped.length === 0 && String(r.activity) !== '空档') {
        // 证据全断了，就宁可不搬这一块——不能留一条点不开的「做过的事」。
        blkEmpty += 1
        continue
      }
      insBlock.run(r.date, r.activity, r.started_at, r.ended_at, JSON.stringify(mapped), r.created_at)
      blkAdded += 1
    }
    report.life_blocks = { added: blkAdded, skipped: blkSkipped, dropped_without_evidence: blkEmpty }

    // ---------- 外发账本 ----------
    const findOut = tdb.prepare('SELECT id FROM outbox WHERE ts = ? AND channel = ? AND target = ? AND text = ?')
    const insOut = tdb.prepare(`INSERT INTO outbox (id, ts, channel, target, text, state, attempts, last_error, meta, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    let outAdded = 0
    let outSkipped = 0
    for (const r of sdb.prepare('SELECT * FROM outbox ORDER BY ts').all()) {
      if (findOut.get(r.ts, r.channel, r.target, r.text)) { outSkipped += 1; continue }
      const id = tdb.prepare('SELECT 1 FROM outbox WHERE id = ?').get(r.id) ? randomUUID() : r.id
      insOut.run(id, r.ts, r.channel, r.target, r.text, r.state, r.attempts, r.last_error, r.meta, r.created_at, r.updated_at)
      outAdded += 1
    }
    report.outbox = { added: outAdded, skipped: outSkipped }
  } finally {
    sdb.close()
    store.close()
  }
  return report
}

export const MERGE_TABLES = ['raw_turns', 'summaries', 'assertions', 'profiles', 'relations', 'actions', 'life_blocks', 'outbox']
