/**
 * 鲸鲸的记忆库。五层里的四层在这里落盘：
 * raw_turns（原话）→ summaries（梗概）→ assertions（要点）→ profiles（画像）+ relations（关系）。
 * 只做确定性读写，不在这一层调用模型。
 */
import fs from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'

const SCHEMA = `
CREATE TABLE IF NOT EXISTS raw_turns (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,
  session_id TEXT NOT NULL,
  role TEXT NOT NULL,
  text TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_raw_ts ON raw_turns(ts);
CREATE TABLE IF NOT EXISTS summaries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,
  session_id TEXT NOT NULL,
  text TEXT NOT NULL,
  from_ts INTEGER,
  to_ts INTEGER
);
CREATE TABLE IF NOT EXISTS assertions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,
  subject TEXT NOT NULL,
  predicate TEXT NOT NULL,
  value TEXT NOT NULL,
  source TEXT NOT NULL,
  source_ts INTEGER NOT NULL,
  valid_from INTEGER NOT NULL,
  valid_to INTEGER,
  superseded_by INTEGER,
  due_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_assertion_live ON assertions(subject, predicate, valid_to);
CREATE TABLE IF NOT EXISTS profiles (
  person_id TEXT NOT NULL,
  key TEXT NOT NULL,
  value TEXT NOT NULL,
  source TEXT,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (person_id, key)
);
CREATE TABLE IF NOT EXISTS actions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,
  session_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  tool TEXT,
  summary TEXT NOT NULL,
  call_id TEXT UNIQUE,
  status TEXT NOT NULL DEFAULT 'called',
  meta TEXT
);
CREATE TABLE IF NOT EXISTS life_blocks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  date TEXT NOT NULL,
  activity TEXT NOT NULL,
  started_at INTEGER NOT NULL,
  ended_at INTEGER NOT NULL,
  evidence TEXT NOT NULL DEFAULT '[]',
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_life_date ON life_blocks(date);
CREATE TABLE IF NOT EXISTS relations (
  person_id TEXT PRIMARY KEY,
  stage TEXT NOT NULL DEFAULT '刚认识',
  first_seen INTEGER NOT NULL,
  last_seen INTEGER NOT NULL,
  turns INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS raw_archive (
  id INTEGER PRIMARY KEY,
  ts INTEGER NOT NULL,
  session_id TEXT NOT NULL,
  role TEXT NOT NULL,
  text TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_archive_ts ON raw_archive(ts);
CREATE TABLE IF NOT EXISTS recycle (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL,
  ref TEXT,
  payload TEXT NOT NULL,
  moved_at INTEGER NOT NULL
);
`

export class MemoryStore {
  constructor(file) {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    this.file = file
    this.db = new DatabaseSync(file)
    this.db.exec('PRAGMA journal_mode = WAL')
    this.db.exec('PRAGMA busy_timeout = 3000')
    this.db.exec(SCHEMA)
    const assertionCols = this.db.prepare('PRAGMA table_info(assertions)').all()
    if (!assertionCols.some((c) => String(c.name) === 'due_at')) {
      this.db.exec('ALTER TABLE assertions ADD COLUMN due_at INTEGER')
    }
    this.env = {
      rawRecent: this.db.prepare('SELECT id, ts, session_id, role, text FROM raw_turns ORDER BY id DESC LIMIT ?'),
      rawOld: this.db.prepare('SELECT id, ts, session_id, role, text FROM raw_turns WHERE id <= ? ORDER BY id ASC'),
      rawCount: this.db.prepare('SELECT COUNT(*) AS n FROM raw_turns'),
      insertRaw: this.db.prepare('INSERT INTO raw_turns (ts, session_id, role, text) VALUES (?, ?, ?, ?)'),
      insertSummary: this.db.prepare('INSERT INTO summaries (ts, session_id, text, from_ts, to_ts) VALUES (?, ?, ?, ?, ?)'),
      recentSummaries: this.db.prepare('SELECT id, ts, text FROM summaries ORDER BY id DESC LIMIT ?'),
      insertAssertion: this.db.prepare(`INSERT INTO assertions
        (ts, subject, predicate, value, source, source_ts, valid_from, valid_to, superseded_by, due_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?)`),
      liveAssertion: this.db.prepare(`SELECT id, ts, value, due_at FROM assertions
        WHERE subject = ? AND predicate = ? AND valid_to IS NULL ORDER BY id DESC LIMIT 1`),
      supersede: this.db.prepare('UPDATE assertions SET valid_to = ?, superseded_by = ? WHERE id = ?'),
      liveAssertions: this.db.prepare(`SELECT id, ts, predicate, value FROM assertions
        WHERE subject = ? AND valid_to IS NULL ORDER BY id DESC LIMIT ?`),
      livePlans: this.db.prepare(`SELECT id, ts, predicate, value, due_at FROM assertions
        WHERE subject = ? AND valid_to IS NULL AND predicate LIKE '计划:%'
          AND ((due_at IS NULL AND ts > ?) OR due_at > ?) ORDER BY id DESC LIMIT ?`),
      expirePlans: this.db.prepare(`UPDATE assertions SET valid_to = ?
        WHERE subject = ? AND valid_to IS NULL AND predicate LIKE '计划:%'
          AND ((due_at IS NOT NULL AND due_at <= ?) OR (due_at IS NULL AND ts <= ?))`),
      setProfile: this.db.prepare(`INSERT INTO profiles (person_id, key, value, source, updated_at)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(person_id, key) DO UPDATE SET value = excluded.value, source = excluded.source, updated_at = excluded.updated_at`),
      getProfiles: this.db.prepare('SELECT key, value, source, updated_at FROM profiles WHERE person_id = ? ORDER BY updated_at DESC LIMIT ?'),
      touchRelation: this.db.prepare(`INSERT INTO relations (person_id, first_seen, last_seen, turns)
        VALUES (?, ?, ?, 1)
        ON CONFLICT(person_id) DO UPDATE SET last_seen = excluded.last_seen, turns = turns + 1`),
      getRelation: this.db.prepare('SELECT stage, first_seen, last_seen, turns FROM relations WHERE person_id = ?'),
      insertAction: this.db.prepare(`INSERT OR IGNORE INTO actions (ts, session_id, kind, tool, summary, call_id, status, meta)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`),
      updateAction: this.db.prepare('UPDATE actions SET status = ? WHERE call_id = ?'),
      recentActions: this.db.prepare('SELECT id, ts, kind, tool, summary, status FROM actions ORDER BY id DESC LIMIT ?'),
      rawBetween: this.db.prepare('SELECT id, ts, role, text FROM raw_turns WHERE ts >= ? AND ts <= ? ORDER BY ts ASC'),
      rawSince: this.db.prepare('SELECT id, ts, role, text FROM raw_turns WHERE ts > ? ORDER BY ts ASC'),
      lastSummary: this.db.prepare('SELECT COALESCE(MAX(to_ts), 0) AS toTs FROM summaries'),
      actionsBetween: this.db.prepare('SELECT id, ts, kind, tool, summary, status FROM actions WHERE ts >= ? AND ts <= ? ORDER BY ts ASC'),
      lastActivity: this.db.prepare(`SELECT MAX(ts) AS ts FROM (
        SELECT ts FROM raw_turns UNION ALL SELECT ts FROM actions)`),
      fingerprintAssertions: this.db.prepare('SELECT COALESCE(MAX(id), 0) AS maxId, COUNT(*) AS live FROM assertions WHERE valid_to IS NULL'),
      fingerprintActions: this.db.prepare('SELECT COALESCE(MAX(id), 0) AS maxId FROM actions'),
      fingerprintSummaries: this.db.prepare('SELECT COALESCE(MAX(id), 0) AS maxId FROM summaries'),
      fingerprintProfiles: this.db.prepare('SELECT COALESCE(MAX(updated_at), 0) AS maxAt, COUNT(*) AS n FROM profiles'),
      insertLife: this.db.prepare(`INSERT INTO life_blocks (date, activity, started_at, ended_at, evidence, created_at)
        VALUES (?, ?, ?, ?, ?, ?)`),
      deleteLifeForDate: this.db.prepare('DELETE FROM life_blocks WHERE date = ?'),
      lifeForDate: this.db.prepare('SELECT id, date, activity, started_at, ended_at, evidence FROM life_blocks WHERE date = ? ORDER BY started_at ASC'),
    }
  }

  addRaw(ts, sessionId, role, text) {
    const clean = String(text || '').trim()
    if (!clean) return 0
    const info = this.env.insertRaw.run(Math.trunc(ts), String(sessionId || ''), String(role || ''), clean)
    return Number(info.lastInsertRowid || 0)
  }

  countRaw() {
    return Number(this.env.rawCount.get()?.n || 0)
  }

  recentRaw(limit = 8) {
    return this.env.rawRecent.all(Math.trunc(limit)).reverse().map((r) => ({
      id: Number(r.id), ts: Number(r.ts), sessionId: String(r.session_id), role: String(r.role), text: String(r.text),
    }))
  }

  /** 取「较早」的原话，供机械摘要；最近 keepRecent 条留给最近上下文。 */
  rawForSummary(keepRecent = 8) {
    const total = this.countRaw()
    const cutoff = total - keepRecent
    if (cutoff <= 0) return []
    return this.env.rawOld.all(Math.trunc(cutoff)).map((r) => ({
      id: Number(r.id), ts: Number(r.ts), sessionId: String(r.session_id), role: String(r.role), text: String(r.text),
    }))
  }

  addSummary(ts, sessionId, text, fromTs, toTs) {
    this.env.insertSummary.run(Math.trunc(ts), String(sessionId || ''), String(text || ''), Math.trunc(fromTs || ts), Math.trunc(toTs || ts))
  }

  recentSummaries(limit = 3) {
    return this.env.recentSummaries.all(Math.trunc(limit)).reverse().map((r) => ({
      id: Number(r.id), ts: Number(r.ts), text: String(r.text),
    }))
  }

  /** 新事实取代旧事实：同一 subject + predicate 只留一条活着的。
   *  同一个说法重复出现时不新建行：否则每说一次「我叫林晚」都会改指纹、
   *  把系统提示词前缀缓存整段打掉。 */
  addAssertion({ ts, subject, predicate, value, source, dueAt = null }) {
    const at = Math.trunc(ts)
    const prev = this.env.liveAssertion.get(subject, predicate)
    const due = dueAt === null || dueAt === undefined ? null : Math.trunc(dueAt)
    const sameDue = prev && ((prev.due_at === null && due === null) || Number(prev.due_at) === due)
    if (prev && String(prev.value) === String(value) && sameDue) {
      return { id: Number(prev.id), superseded: 0, unchanged: true }
    }
    const info = this.env.insertAssertion.run(at, subject, predicate, String(value), String(source || ''), at, at, due)
    const id = Number(info.lastInsertRowid || 0)
    if (prev) this.env.supersede.run(at, id, Number(prev.id))
    return { id, superseded: prev ? Number(prev.id) : 0 }
  }

  liveAssertions(subject = '他', limit = 8) {
    return this.env.liveAssertions.all(subject, Math.trunc(limit)).map((r) => ({
      id: Number(r.id), ts: Number(r.ts), predicate: String(r.predicate), value: String(r.value),
    }))
  }

  livePlans(subject = '他', limit = 2, now = Date.now()) {
    const staleCutoff = Math.trunc(now) - 2 * 86400000
    return this.env.livePlans.all(subject, staleCutoff, Math.trunc(now), Math.trunc(limit)).map((r) => ({
      id: Number(r.id), ts: Number(r.ts), predicate: String(r.predicate), value: String(r.value),
      dueAt: r.due_at === null ? null : Number(r.due_at),
    }))
  }

  /** 过期的计划退役（不删，valid_to 记下）。 */
  expirePlans(now = Date.now(), subject = '他') {
    this.env.expirePlans.run(Math.trunc(now), subject, Math.trunc(now), Math.trunc(now) - 2 * 86400000)
  }

  setProfile(personId, key, value, source, ts) {
    this.env.setProfile.run(String(personId), String(key), String(value), String(source || ''), Math.trunc(ts))
  }

  profiles(personId = '他', limit = 8) {
    return this.env.getProfiles.all(String(personId), Math.trunc(limit)).map((r) => ({
      key: String(r.key), value: String(r.value), source: String(r.source || ''), updatedAt: Number(r.updated_at),
    }))
  }

  touchRelation(personId, ts) {
    this.env.touchRelation.run(String(personId), Math.trunc(ts), Math.trunc(ts))
  }

  relation(personId = '他') {
    const row = this.env.getRelation.get(String(personId))
    if (!row) return null
    return { stage: String(row.stage), firstSeen: Number(row.first_seen), lastSeen: Number(row.last_seen), turns: Number(row.turns) }
  }

  /** 真实动作账本：她真的调用过什么工具、成没成。M2 的生活线只能从这里聚合。
   *  call_id 为空时必须写 NULL：SQLite 的 UNIQUE 允许很多 NULL，但不允许很多 ''。
   *  以前写 '' 会导致第二条没有 callId 的动作被 INSERT OR IGNORE 静默吞掉。 */
  addAction({ ts, sessionId, kind, tool = '', summary = '', callId = '', status = 'called', meta = null }) {
    const cid = String(callId || '').trim()
    this.env.insertAction.run(
      Math.trunc(ts), String(sessionId || ''), String(kind), String(tool), String(summary),
      cid || null, String(status), meta ? JSON.stringify(meta) : null,
    )
  }

  updateAction(callId, status, summary = null) {
    if (summary === null) this.env.updateAction.run(String(status), String(callId))
    else this.db.prepare('UPDATE actions SET status = ?, summary = ? WHERE call_id = ?').run(String(status), String(summary), String(callId))
  }

  recentActions(limit = 5) {
    return this.env.recentActions.all(Math.trunc(limit)).reverse().map((r) => ({
      id: Number(r.id), ts: Number(r.ts), kind: String(r.kind), tool: String(r.tool || ''),
      summary: String(r.summary || ''), status: String(r.status || ''),
    }))
  }

  rawBetween(startTs, endTs) {
    return this.env.rawBetween.all(Math.trunc(startTs), Math.trunc(endTs)).map((r) => ({
      id: Number(r.id), ts: Number(r.ts), role: String(r.role), text: String(r.text),
    }))
  }

  /** 上次梗概之后的新原话（按时间正序）。用于增量摘要，避免每次都把全部旧原话重摘一遍。 */
  rawSince(ts) {
    return this.env.rawSince.all(Math.trunc(ts)).map((r) => ({
      id: Number(r.id), ts: Number(r.ts), role: String(r.role), text: String(r.text),
    }))
  }

  lastSummaryTo() {
    return Number(this.env.lastSummary.get()?.toTs || 0)
  }

  actionsBetween(startTs, endTs) {
    return this.env.actionsBetween.all(Math.trunc(startTs), Math.trunc(endTs)).map((r) => ({
      id: Number(r.id), ts: Number(r.ts), kind: String(r.kind), tool: String(r.tool || ''),
      summary: String(r.summary || ''), status: String(r.status || ''),
    }))
  }

  searchRaw(query, limit = 8) {
    const rows = this.db.prepare(`SELECT id, ts, role, text FROM raw_turns
      WHERE instr(text, ?) > 0 ORDER BY ts DESC LIMIT ?`).all(String(query), Math.trunc(limit))
    return rows.map((r) => ({ id: Number(r.id), ts: Number(r.ts), role: String(r.role), text: String(r.text) }))
  }

  /** 按词面取候选（未排序）。查询词已经由 search.js 切成 bigram/英文词。 */
  candidateRaw(terms, limit = 400) {
    if (!terms.length) return []
    const where = terms.map(() => 'instr(text, ?) > 0').join(' OR ')
    const sql = `SELECT id, ts, role, text, 0 AS archived FROM raw_turns WHERE ${where}
      UNION ALL
      SELECT id, ts, role, text, 1 AS archived FROM raw_archive WHERE ${where}
      ORDER BY ts DESC LIMIT ?`
    const params = [...terms, ...terms, Math.trunc(limit)]
    return this.db.prepare(sql).all(...params).map((r) => ({
      id: Number(r.id), ts: Number(r.ts), role: String(r.role), text: String(r.text), archived: Number(r.archived) === 1,
    }))
  }

  countRawAll() {
    return Number(this.db.prepare('SELECT (SELECT COUNT(*) FROM raw_turns) + (SELECT COUNT(*) FROM raw_archive) AS n').get()?.n || 0)
  }

  countRawMatches(term) {
    return Number(this.db.prepare(`SELECT
      (SELECT COUNT(*) FROM raw_turns WHERE instr(text, ?) > 0) +
      (SELECT COUNT(*) FROM raw_archive WHERE instr(text, ?) > 0) AS n`).get(String(term), String(term))?.n || 0)
  }

  /** 旧原文归档：只搬家，不改 id；证据里的 raw:N 仍然有效（查询会同时扫归档）。 */
  archiveRawBefore(ts) {
    const before = this.db.prepare('SELECT COUNT(*) AS n FROM raw_turns WHERE ts < ?').get(Math.trunc(ts))?.n || 0
    this.db.prepare(`INSERT OR IGNORE INTO raw_archive (id, ts, session_id, role, text)
      SELECT id, ts, session_id, role, text FROM raw_turns WHERE ts < ?`).run(Math.trunc(ts))
    this.db.prepare('DELETE FROM raw_turns WHERE ts < ?').run(Math.trunc(ts))
    return Number(before)
  }

  /** 回收站：把一条原话从「想得起」里拿走，但保留内容可恢复。 */
  recycleRaw(id) {
    const row = this.db.prepare('SELECT id, ts, session_id, role, text FROM raw_turns WHERE id = ?').get(Number(id))
      || this.db.prepare('SELECT id, ts, session_id, role, text FROM raw_archive WHERE id = ?').get(Number(id))
    if (!row) return false
    this.db.prepare('INSERT INTO recycle (kind, ref, payload, moved_at) VALUES (?, ?, ?, ?)')
      .run('raw', `raw:${row.id}`, JSON.stringify(row), Date.now())
    this.db.prepare('DELETE FROM raw_turns WHERE id = ?').run(Number(id))
    this.db.prepare('DELETE FROM raw_archive WHERE id = ?').run(Number(id))
    return true
  }

  recycleCount() {
    return Number(this.db.prepare('SELECT COUNT(*) AS n FROM recycle').get()?.n || 0)
  }

  stats() {
    const one = (sql) => Number(this.db.prepare(sql).get()?.n || 0)
    return {
      raw: one('SELECT COUNT(*) AS n FROM raw_turns'),
      archived: one('SELECT COUNT(*) AS n FROM raw_archive'),
      summaries: one('SELECT COUNT(*) AS n FROM summaries'),
      assertions: one('SELECT COUNT(*) AS n FROM assertions WHERE valid_to IS NULL'),
      profiles: one('SELECT COUNT(*) AS n FROM profiles'),
      actions: one('SELECT COUNT(*) AS n FROM actions'),
      lifeBlocks: one('SELECT COUNT(*) AS n FROM life_blocks'),
      recycle: one('SELECT COUNT(*) AS n FROM recycle'),
    }
  }

  rawById(id) {
    const row = this.db.prepare('SELECT id, ts, role, text, 0 AS archived FROM raw_turns WHERE id = ?').get(Number(id))
      || this.db.prepare('SELECT id, ts, role, text, 1 AS archived FROM raw_archive WHERE id = ?').get(Number(id))
    return row ? {
      id: Number(row.id), ts: Number(row.ts), role: String(row.role), text: String(row.text),
      archived: Number(row.archived) === 1,
    } : null
  }

  actionById(id) {
    const row = this.db.prepare('SELECT id, ts, kind, tool, summary, status FROM actions WHERE id = ?').get(Number(id))
    return row ? { id: Number(row.id), ts: Number(row.ts), kind: String(row.kind), tool: String(row.tool || ''), summary: String(row.summary || ''), status: String(row.status || '') } : null
  }

  lastActivityTs() {
    const row = this.env.lastActivity.get()
    return row && row.ts !== null ? Number(row.ts) : 0
  }

  /**
   * 记忆状态的指纹：日期 + live 断言（最大 id / 条数）+ 动作库最大 id
   * + 梗概最大 id + 画像最后更新时间。
   * 指纹不变时，记忆包可以整段复用——系统提示词前缀不变，provider 缓存才命中。
   */
  fingerprint(now = Date.now()) {
    const a = this.env.fingerprintAssertions.get()
    const b = this.env.fingerprintActions.get()
    const s = this.env.fingerprintSummaries.get()
    const p = this.env.fingerprintProfiles.get()
    const d = new Date(now)
    const day = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
    return `${day}|${Number(a.maxId)}|${Number(a.live)}|${Number(b.maxId)}|${Number(s.maxId)}|${Number(p.maxAt)}|${Number(p.n)}`
  }

  replaceLifeBlocks(date, blocks, now = Date.now()) {
    this.env.deleteLifeForDate.run(String(date))
    for (const b of blocks) {
      this.env.insertLife.run(String(date), String(b.activity), Math.trunc(b.startedAt), Math.trunc(b.endedAt), JSON.stringify(b.evidence || []), Math.trunc(now))
    }
  }

  lifeForDate(date) {
    return this.env.lifeForDate.all(String(date)).map((r) => ({
      id: Number(r.id), date: String(r.date), activity: String(r.activity),
      startedAt: Number(r.started_at), endedAt: Number(r.ended_at),
      evidence: JSON.parse(String(r.evidence || '[]')),
    }))
  }

  close() {
    try { this.db.close() } catch { /* 已关就算了 */ }
  }
}
