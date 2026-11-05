/**
 * 把另一台机器的记忆合进来，而不是整库覆盖。
 *
 * 为什么不能直接拷库：两边的 raw_turns.id、actions.id 都是各自自增的，
 * assertions.source 写着 `raw:12`、life_blocks.evidence 写着 `act:7`——直接覆盖会
 * 让她「记得的事」指向别人的原话。所以合并要：去重、重建 id、再把引用改到新 id。
 *
 * 规则（都是确定的，不猜）：
 * - 原话：按「时间 + 谁说的 + 原话」去重（同一条消息出现在两份导出里只留一份）。
 * - 动作：优先按 call_id 去重（同一次工具调用）；没有 call_id 才按时间+工具+摘要；
 *   命中时取更靠后的状态（pending < called < uncertain < error < ok，ok 是最终态不降级）。
 * - 断言：同一件事同一说法同一时间只留一份；说法相同但时间不同、两边都「当前有效」
 *   也只留一条（映射到已有行，不再新增 live 行）；两边说法不同时保留目标库当前的，
 *   另一条作为历史（valid_to=now、superseded_by 指向当前）。
 * - 画像：按 (person,key) 合并，updated_at 新的赢；source 里的 raw:/act: 引用重新映射。
 * - 关系：first_seen 取更早、last_seen 取更晚、turns 取较大值，阶段跟更晚见到的那条。
 * - 日子块：按「日期+活动+起止」去重；命中时证据取并集，引用重新映射到合并后的 id。
 * - 外发账本：按「时间+渠道+对象+正文」去重；状态取更靠后的
 *   （pending < uncertain < failed < sent，sent 不降级）；两库都没有这张表时整段跳过。
 *
 * 所有写入包在一个 BEGIN IMMEDIATE … COMMIT 里：任何一步失败都 ROLLBACK 后再抛，
 * 绝不留下半合并的目标库。sdb 是只读连接，事务只开在目标 store.db 上。
 */
import fs from 'node:fs'
import { randomUUID } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { MemoryStore } from './store.js'

const DAY = 86400000

// 状态只会往前走：ok 是最终态；error 比 uncertain 更确定；called/pending 是没跑完。
const ACTION_STATUS_RANK = { pending: 0, called: 1, uncertain: 2, error: 3, ok: 4 }
// 外发账本：sent 是最终态；failed（渠道明确拒绝）比 uncertain（不知道发没发）更靠后。
const OUTBOX_STATE_RANK = { pending: 0, uncertain: 1, failed: 2, sent: 3 }
// 与 lib/outbox.js:34-49 完全一致。outbox 不归 MemoryStore 的 SCHEMA 管，
// 只有真正接渠道的一方才会建；合并时需要按两边实际情况判断。
const OUTBOX_SCHEMA = `
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
`

function tableExists(db, name) {
  return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(String(name)))
}

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
  let inTransaction = false

  try {
    // 合并必须整体成功或整体失败：先开写事务（IMMEDIATE 立刻拿写锁，
    // 也避免读取别处未提交的中间态）。调用方若已经开了事务就不重复 BEGIN，
    // SQLite 不支持嵌套事务；那种情况下回滚由调用方负责。
    if (!tdb.isTransaction) {
      tdb.exec('BEGIN IMMEDIATE')
      inTransaction = true
    }

    // ---------- 原话 ----------
    // 目标库已归档的同句也算「已有」，不能因为它在 raw_archive 里就再插一条。
    const findRaw = tdb.prepare(`SELECT id FROM raw_turns WHERE ts = ? AND role = ? AND text = ?
      UNION ALL SELECT id FROM raw_archive WHERE ts = ? AND role = ? AND text = ? LIMIT 1`)
    const insRaw = tdb.prepare('INSERT INTO raw_turns (ts, session_id, role, text) VALUES (?, ?, ?, ?)')
    const rawMap = new Map()
    let rawAdded = 0
    let rawSkipped = 0
    // 来源库里超过 90 天的原话可能已经在 raw_archive 表里。不搬它们，
    // 引用这些 ref 的生活块就会因为映射不到被整块丢掉（合并看起来成功，日子少了一截）。
    // 旧导出包/手工精简库可能没有 raw_archive：按存在性拼 UNION，而不是直接引用表名。
    const sourceHasArchive = tableExists(sdb, 'raw_archive')
    if (sourceHasArchive) {
      const clash = Number(sdb.prepare(`SELECT COUNT(*) AS n FROM raw_turns r
        JOIN raw_archive a ON a.id = r.id`).get()?.n || 0)
      if (clash > 0) {
        throw new Error(`来源库的 raw_turns 与 raw_archive 有 ${clash} 个重复 id，证据引用无法安全重映射`)
      }
    }
    const sourceRaw = sourceHasArchive
      ? sdb.prepare(`SELECT id, ts, session_id, role, text, NULL AS archived FROM raw_turns
        UNION ALL SELECT id, ts, session_id, role, text, 1 AS archived FROM raw_archive ORDER BY id`).all()
      : sdb.prepare('SELECT id, ts, session_id, role, text, NULL AS archived FROM raw_turns ORDER BY id').all()
    let rawArchived = 0
    for (const r of sourceRaw) {
      if (r.archived) rawArchived += 1
      const hit = findRaw.get(r.ts, r.role, r.text, r.ts, r.role, r.text)
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
    const findActByCall = tdb.prepare('SELECT id, status, summary FROM actions WHERE call_id = ?')
    const findActByText = tdb.prepare('SELECT id, status, summary FROM actions WHERE call_id IS NULL AND ts = ? AND tool IS ? AND summary = ?')
    const insAct = tdb.prepare(`INSERT INTO actions (ts, session_id, kind, tool, summary, call_id, status, meta)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
    const updateAct = tdb.prepare('UPDATE actions SET status = ?, summary = ? WHERE id = ?')
    let actAdded = 0
    let actSkipped = 0
    let actUpgraded = 0
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
        // 同一次调用在两边可能停在不同阶段。ok 是最终态，其余按
        // pending < called < uncertain < error < ok 吸收更靠后的状态，绝不把 ok 降级。
        // （按 call_id 命中的是同一个调用；按文本命中的 summary 本来就相同。）
        const srcStatus = String(r.status || 'called')
        const srcRank = ACTION_STATUS_RANK[srcStatus] ?? -1
        const tgtStatus = String(hit.status || 'called')
        const tgtRank = ACTION_STATUS_RANK[tgtStatus] ?? -1
        if (srcRank > tgtRank) {
          updateAct.run(srcStatus, r.summary, num(hit.id))
          actUpgraded += 1
        }
      } else {
        const info = insAct.run(r.ts, r.session_id, r.kind, r.tool, r.summary, cid, r.status, r.meta)
        actMap.set(num(r.id), num(info.lastInsertRowid))
        actAdded += 1
      }
    }
    report.actions = { added: actAdded, skipped: actSkipped, status_upgraded: actUpgraded }

    // ---------- 断言 ----------
    const findAssertion = tdb.prepare('SELECT id FROM assertions WHERE subject = ? AND predicate = ? AND value = ? AND ts = ?')
    // 同一个说法（subject+predicate+value）只要已经有一条「当前有效」，就视为同一件事：
    // 时间不同也不再插入 live 行，否则会出现两条同时有效、pack 里重复。
    const findLiveSame = tdb.prepare(`SELECT id FROM assertions
      WHERE subject = ? AND predicate = ? AND value = ? AND valid_to IS NULL ORDER BY id DESC LIMIT 1`)
    const findLive = tdb.prepare('SELECT id, value, ts FROM assertions WHERE subject = ? AND predicate = ? AND valid_to IS NULL ORDER BY id DESC LIMIT 1')
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
      // 来源和目标都「当前有效」且说法一致：只是同一件事在不同时间被重复提取，
      // 映射到已有行即可，不再插入第二条 valid_to IS NULL。
      if (r.valid_to === null) {
        const sameLive = findLiveSame.get(r.subject, r.predicate, r.value)
        if (sameLive) {
          assertMap.set(num(r.id), num(sameLive.id))
          asSkipped += 1
          continue
        }
      }
      const source = remapRef(r.source, rawMap, actMap) || String(r.source || 'import')
      let validTo = r.valid_to
      let supersededBy = null
      let demoteLiveId = null
      if (validTo === null) {
        const live = findLive.get(r.subject, r.predicate)
        if (live && String(live.value) !== String(r.value)) {
          // 两种说法并存时，谁是「现在」看时间，不看哪台机器先合并：
          // 来源更新就把目标那条降级；来源更旧才把自己写成历史。
          if (num(r.ts) > num(live.ts)) demoteLiveId = num(live.id)
          else {
            validTo = Math.trunc(now)
            supersededBy = num(live.id)
            asDemoted += 1
          }
        }
      }
      const info = insAssertion.run(r.ts, r.subject, r.predicate, r.value, source, r.source_ts, r.valid_from, validTo, supersededBy, r.due_at)
      const newId = num(info.lastInsertRowid)
      assertMap.set(num(r.id), newId)
      if (demoteLiveId) {
        tdb.prepare('UPDATE assertions SET valid_to = ?, superseded_by = ? WHERE id = ?').run(Math.trunc(now), newId, demoteLiveId)
        asDemoted += 1
      }
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
      // profiles.source 可能是 raw:N / act:N；两库自增 id 不同，能映射就映射，
      // 其它来源字符串（例如手写备注）原样保留。
      const source = remapRef(r.source, rawMap, actMap) ?? r.source
      const changed = Number(upsertProfile.run(r.person_id, r.key, r.value, source, r.updated_at).changes)
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
    const findBlock = tdb.prepare('SELECT id, evidence FROM life_blocks WHERE date = ? AND activity = ? AND started_at = ? AND ended_at = ?')
    const updateBlockEvidence = tdb.prepare('UPDATE life_blocks SET evidence = ? WHERE id = ?')
    const insBlock = tdb.prepare('INSERT INTO life_blocks (date, activity, started_at, ended_at, evidence, created_at) VALUES (?, ?, ?, ?, ?, ?)')
    let blkAdded = 0
    let blkSkipped = 0
    let blkEmpty = 0
    let blkEvidenceMerged = 0
    for (const r of sdb.prepare('SELECT * FROM life_blocks ORDER BY id').all()) {
      let evidence = []
      try { evidence = JSON.parse(String(r.evidence || '[]')) } catch { evidence = [] }
      const mapped = evidence.map((ref) => remapRef(ref, rawMap, actMap)).filter(Boolean)
      const hit = findBlock.get(r.date, r.activity, r.started_at, r.ended_at)
      if (hit) {
        blkSkipped += 1
        // 两边都记了同一段时间：证据取并集，别让目标库丢掉来源库那边能点开的原话/动作。
        let current = []
        try { current = JSON.parse(String(hit.evidence || '[]')) } catch { current = [] }
        if (!Array.isArray(current)) current = []
        const union = current.slice()
        for (const ref of mapped) if (!union.includes(ref)) union.push(ref)
        if (union.length > current.length) {
          updateBlockEvidence.run(JSON.stringify(union), num(hit.id))
          blkEvidenceMerged += 1
        }
        continue
      }
      if (mapped.length === 0 && String(r.activity) !== '空档') {
        // 证据全断了，就宁可不搬这一块——不能留一条点不开的「做过的事」。
        blkEmpty += 1
        continue
      }
      insBlock.run(r.date, r.activity, r.started_at, r.ended_at, JSON.stringify(mapped), r.created_at)
      blkAdded += 1
    }
    report.life_blocks = { added: blkAdded, skipped: blkSkipped, dropped_without_evidence: blkEmpty, evidence_merged: blkEvidenceMerged }

    // ---------- 节律状态 ----------
    let phaseAdded = 0
    let phaseMerged = 0
    if (tableExists(sdb, 'life_phases')) {
      const findPhase = tdb.prepare('SELECT id, ended_at, evidence FROM life_phases WHERE date = ? AND phase = ? AND started_at = ?')
      const insPhase = tdb.prepare(`INSERT INTO life_phases (date, phase, started_at, ended_at, reason, evidence, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)`)
      for (const r of sdb.prepare('SELECT * FROM life_phases ORDER BY id').all()) {
        let evidence = []
        try { evidence = JSON.parse(String(r.evidence || '[]')) } catch { evidence = [] }
        const mapped = (Array.isArray(evidence) ? evidence : []).map((ref) => remapRef(ref, rawMap, actMap)).filter(Boolean)
        const hit = findPhase.get(r.date, r.phase, r.started_at)
        if (hit) {
          const union = new Set()
          try { for (const ref of JSON.parse(String(hit.evidence || '[]'))) union.add(String(ref)) } catch { /* ignore */ }
          for (const ref of mapped) union.add(ref)
          const ended = hit.ended_at === null && r.ended_at !== null ? r.ended_at : hit.ended_at
          tdb.prepare('UPDATE life_phases SET ended_at = ?, evidence = ? WHERE id = ?')
            .run(ended, JSON.stringify([...union]), num(hit.id))
          phaseMerged += 1
        } else {
          insPhase.run(r.date, r.phase, r.started_at, r.ended_at, r.reason, JSON.stringify(mapped), r.created_at)
          phaseAdded += 1
        }
      }
    }
    report.life_phases = { added: phaseAdded, merged: phaseMerged }

    // ---------- 梦（非事实层，按日期去重） ----------
    let dreamAdded = 0
    let dreamSkipped = 0
    if (tableExists(sdb, 'dreams')) {
      const findDream = tdb.prepare('SELECT id FROM dreams WHERE date = ?')
      const insDream = tdb.prepare(`INSERT INTO dreams (date, ts, text, evidence, non_factual, created_at)
        VALUES (?, ?, ?, ?, 1, ?)`)
      for (const r of sdb.prepare('SELECT * FROM dreams ORDER BY id').all()) {
        if (findDream.get(r.date)) { dreamSkipped += 1; continue }
        let evidence = []
        try { evidence = JSON.parse(String(r.evidence || '[]')) } catch { evidence = [] }
        const mapped = (Array.isArray(evidence) ? evidence : []).map((ref) => remapRef(ref, rawMap, actMap)).filter(Boolean)
        insDream.run(r.date, r.ts, r.text, JSON.stringify(mapped), r.created_at)
        dreamAdded += 1
      }
    }
    report.dreams = { added: dreamAdded, skipped: dreamSkipped }

    // ---------- 书与读到哪了 ----------
    let bookAdded = 0
    let bookMerged = 0
    if (tableExists(sdb, 'books')) {
      const findBook = tdb.prepare('SELECT id, offset, total FROM books WHERE url = ?')
      const insBook = tdb.prepare(`INSERT INTO books (title, url, path, offset, total, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)`)
      for (const r of sdb.prepare('SELECT * FROM books ORDER BY id').all()) {
        const hit = findBook.get(r.url)
        if (hit) {
          if (num(r.offset) > num(hit.offset)) {
            tdb.prepare('UPDATE books SET offset = ?, total = ?, updated_at = ? WHERE id = ?')
              .run(r.offset, Math.max(num(r.total), num(hit.total)), r.updated_at, num(hit.id))
          }
          bookMerged += 1
        } else {
          // 路径是来源机器的；到这台机器上可能打不开，但进度和书名还在。
          insBook.run(r.title, r.url, r.path, r.offset, r.total, r.created_at, r.updated_at)
          bookAdded += 1
        }
      }
    }
    report.books = { added: bookAdded, merged: bookMerged }

    // ---------- 回收站（可恢复的已删记忆） ----------
    let recycleAdded = 0
    let recycleSkipped = 0
    if (tableExists(sdb, 'recycle')) {
      const findRecycle = tdb.prepare('SELECT id FROM recycle WHERE kind = ? AND ref = ? AND payload = ? AND moved_at = ?')
      const insRecycle = tdb.prepare('INSERT INTO recycle (kind, ref, payload, moved_at) VALUES (?, ?, ?, ?)')
      for (const r of sdb.prepare('SELECT * FROM recycle ORDER BY id').all()) {
        if (findRecycle.get(r.kind, r.ref, r.payload, r.moved_at)) { recycleSkipped += 1; continue }
        insRecycle.run(r.kind, r.ref, r.payload, r.moved_at)
        recycleAdded += 1
      }
    }
    report.recycle = { added: recycleAdded, skipped: recycleSkipped }

    // ---------- 外发账本 ----------
    // outbox 只由 lib/outbox.js 创建，MemoryStore 的 SCHEMA 里没有；两个库都可能没这张表。
    // 来源没有就整段跳过（目标有没有都无所谓）；来源有、目标没有，才在目标建表（与 outbox.js 同构）。
    const targetHasOutbox = tableExists(tdb, 'outbox')
    const sourceHasOutbox = tableExists(sdb, 'outbox')
    if (!sourceHasOutbox) {
      report.outbox = { skipped: 'no_table' }
    } else {
      if (!targetHasOutbox) tdb.exec(OUTBOX_SCHEMA)
      const findOut = tdb.prepare('SELECT id, state, updated_at FROM outbox WHERE ts = ? AND channel = ? AND target = ? AND text = ?')
      const findOutById = tdb.prepare('SELECT 1 FROM outbox WHERE id = ?')
      const updateOut = tdb.prepare('UPDATE outbox SET state = ?, updated_at = ? WHERE id = ?')
      const insOut = tdb.prepare(`INSERT INTO outbox (id, ts, channel, target, text, state, attempts, last_error, meta, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      let outAdded = 0
      let outSkipped = 0
      let outUpgraded = 0
      for (const r of sdb.prepare('SELECT * FROM outbox ORDER BY ts').all()) {
        const hit = findOut.get(r.ts, r.channel, r.target, r.text)
        if (hit) {
          outSkipped += 1
          // 同一条外发记录可能一边停在 pending、一边已经 sent：只吸收更靠后的状态
          // （sent > failed > uncertain > pending），sent 永远不降级。
          const srcState = String(r.state || 'pending')
          const tgtState = String(hit.state || 'pending')
          const srcRank = OUTBOX_STATE_RANK[srcState] ?? -1
          const tgtRank = OUTBOX_STATE_RANK[tgtState] ?? -1
          if (srcRank > tgtRank && tgtState !== 'sent') {
            // outbox.id 是 TEXT（randomUUID），不能走 num()，否则 WHERE 命中不到任何行。
            updateOut.run(srcState, Math.max(num(hit.updated_at), num(r.updated_at)), String(hit.id))
            outUpgraded += 1
          }
          continue
        }
        const id = findOutById.get(r.id) ? randomUUID() : r.id
        insOut.run(id, r.ts, r.channel, r.target, r.text, r.state, r.attempts, r.last_error, r.meta, r.created_at, r.updated_at)
        outAdded += 1
      }
      report.outbox = { added: outAdded, skipped: outSkipped, state_upgraded: outUpgraded }
      if (!targetHasOutbox) report.outbox.created_table = true
    }

    if (inTransaction) {
      tdb.exec('COMMIT')
      inTransaction = false
    }
  } catch (err) {
    // 任何一步失败都把目标库恢复原样，不能留下「合并了一半」的状态。
    if (inTransaction) {
      try { tdb.exec('ROLLBACK') } catch { /* 连接关闭时 SQLite 也会回滚 */ }
      inTransaction = false
    }
    throw err
  } finally {
    sdb.close()
    store.close()
  }
  return report
}

export const MERGE_TABLES = ['raw_turns', 'raw_archive', 'summaries', 'assertions', 'profiles', 'relations', 'actions', 'life_blocks', 'life_phases', 'dreams', 'books', 'recycle', 'outbox']
