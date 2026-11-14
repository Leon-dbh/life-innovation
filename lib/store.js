/**
 * life-innovation 的记忆库。五层里的四层在这里落盘：
 * raw_turns（原话）→ summaries（梗概）→ assertions（要点）→ profiles（画像）+ relations（关系）。
 * 只做确定性读写，不在这一层调用模型。
 */
import fs from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'

/** actions.meta 是 JSON 文本；坏数据不能拖垮生活线，解析失败就当没有。 */
function parseMeta(raw) {
  if (!raw) return null
  try {
    const value = JSON.parse(String(raw))
    return value && typeof value === 'object' ? value : null
  } catch {
    return null
  }
}

function parseRefs(raw) {
  if (!raw) return []
  try {
    const value = JSON.parse(String(raw))
    return Array.isArray(value) ? value.map(String).filter(Boolean) : []
  } catch {
    return []
  }
}

function mapSummary(r) {
  return {
    id: Number(r.id),
    ts: Number(r.ts),
    text: String(r.text),
    toRawId: r.to_raw_id === null || r.to_raw_id === undefined ? null : Number(r.to_raw_id),
    sourceRefs: parseRefs(r.source_refs),
  }
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS raw_turns (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,
  session_id TEXT NOT NULL,
  role TEXT NOT NULL,
  text TEXT NOT NULL,
  keep_until INTEGER
);
CREATE INDEX IF NOT EXISTS idx_raw_ts ON raw_turns(ts);
CREATE TABLE IF NOT EXISTS summaries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,
  session_id TEXT NOT NULL,
  text TEXT NOT NULL,
  from_ts INTEGER,
  to_ts INTEGER,
  source_refs TEXT
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
CREATE TABLE IF NOT EXISTS memory_audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,
  action TEXT NOT NULL,
  ref TEXT NOT NULL,
  reason TEXT NOT NULL DEFAULT '',
  actor TEXT NOT NULL DEFAULT '她',
  meta TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS idx_memory_audit_ts ON memory_audit(ts);
CREATE TABLE IF NOT EXISTS life_phases (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  date TEXT NOT NULL,
  phase TEXT NOT NULL,
  started_at INTEGER NOT NULL,
  ended_at INTEGER,
  reason TEXT NOT NULL DEFAULT '',
  evidence TEXT NOT NULL DEFAULT '[]',
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_phase_date ON life_phases(date);
CREATE TABLE IF NOT EXISTS dreams (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  date TEXT NOT NULL,
  ts INTEGER NOT NULL,
  text TEXT NOT NULL,
  evidence TEXT NOT NULL DEFAULT '[]',
  non_factual INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_dream_date ON dreams(date);
CREATE TABLE IF NOT EXISTS books (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  url TEXT NOT NULL UNIQUE,
  path TEXT NOT NULL,
  offset INTEGER NOT NULL DEFAULT 0,
  total INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS self_snapshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  date TEXT NOT NULL UNIQUE,
  ts INTEGER NOT NULL,
  text TEXT NOT NULL,
  evidence TEXT NOT NULL DEFAULT '[]',
  created_at INTEGER NOT NULL
);
`

function mapPhase(r) {
  return {
    id: Number(r.id), date: String(r.date), phase: String(r.phase),
    startedAt: Number(r.started_at),
    endedAt: r.ended_at === null || r.ended_at === undefined ? null : Number(r.ended_at),
    reason: String(r.reason || ''),
    evidence: JSON.parse(String(r.evidence || '[]')),
  }
}

function mapBook(r) {
  return {
    id: Number(r.id), title: String(r.title), url: String(r.url), path: String(r.path),
    offset: Number(r.offset), total: Number(r.total),
  }
}

function mapDream(r) {
  return {
    id: Number(r.id), date: String(r.date), ts: Number(r.ts), text: String(r.text),
    evidence: JSON.parse(String(r.evidence || '[]')),
    nonFactual: Number(r.non_factual) === 1,
  }
}

function mapSelfSnapshot(r) {
  return {
    id: Number(r.id), date: String(r.date), ts: Number(r.ts), text: String(r.text),
    evidence: JSON.parse(String(r.evidence || '[]')),
  }
}

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
    // 梗概水位改用「最后一条被压进梗概的原话 id」。时间戳水位在两条消息同毫秒时会漏，
    // 而且合并/导入后的历史数据没有 id 可对；旧的 to_ts 仍保留，用于回退推算。
    const summaryCols = this.db.prepare('PRAGMA table_info(summaries)').all()
    if (!summaryCols.some((c) => String(c.name) === 'to_raw_id')) {
      this.db.exec('ALTER TABLE summaries ADD COLUMN to_raw_id INTEGER')
    }
    if (!summaryCols.some((c) => String(c.name) === 'source_refs')) {
      this.db.exec('ALTER TABLE summaries ADD COLUMN source_refs TEXT')
    }
    // 从回收站恢复的原话，7 天内不允许再被归档：否则恢复完下一分钟就被搬走。
    const rawCols = this.db.prepare('PRAGMA table_info(raw_turns)').all()
    if (!rawCols.some((c) => String(c.name) === 'keep_until')) {
      this.db.exec('ALTER TABLE raw_turns ADD COLUMN keep_until INTEGER')
    }
    this.searchAvailable = this.initSearch()
    this.env = {
      rawRecent: this.db.prepare('SELECT id, ts, session_id, role, text FROM raw_turns ORDER BY id DESC LIMIT ?'),
      rawOld: this.db.prepare('SELECT id, ts, session_id, role, text FROM raw_turns WHERE id <= ? ORDER BY id ASC'),
      rawCount: this.db.prepare('SELECT COUNT(*) AS n FROM raw_turns'),
      insertRaw: this.db.prepare('INSERT INTO raw_turns (ts, session_id, role, text) VALUES (?, ?, ?, ?)'),
      insertSummary: this.db.prepare('INSERT INTO summaries (ts, session_id, text, from_ts, to_ts, to_raw_id, source_refs) VALUES (?, ?, ?, ?, ?, ?, ?)'),
      recentSummaries: this.db.prepare('SELECT id, ts, text, to_raw_id, source_refs FROM summaries ORDER BY id DESC LIMIT ?'),
      summaryById: this.db.prepare('SELECT id, ts, text, from_ts, to_ts, to_raw_id, source_refs FROM summaries WHERE id = ?'),
      insertAssertion: this.db.prepare(`INSERT INTO assertions
        (ts, subject, predicate, value, source, source_ts, valid_from, valid_to, superseded_by, due_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?)`),
      liveAssertion: this.db.prepare(`SELECT id, ts, value, due_at FROM assertions
        WHERE subject = ? AND predicate = ? AND valid_to IS NULL ORDER BY id DESC LIMIT 1`),
      supersede: this.db.prepare('UPDATE assertions SET valid_to = ?, superseded_by = ? WHERE id = ?'),
      liveAssertions: this.db.prepare(`SELECT id, ts, predicate, value FROM assertions
        WHERE subject = ? AND valid_to IS NULL ORDER BY id DESC LIMIT ?`),
      assertionHistory: this.db.prepare(`SELECT id, ts, predicate, value, source, valid_from, valid_to, superseded_by
        FROM assertions WHERE subject = ? ORDER BY predicate ASC, id ASC LIMIT ?`),
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
      recentActions: this.db.prepare('SELECT id, ts, kind, tool, summary, status, meta FROM actions ORDER BY id DESC LIMIT ?'),
      rawBetween: this.db.prepare('SELECT id, ts, role, text FROM raw_turns WHERE ts >= ? AND ts <= ? ORDER BY ts ASC'),
      rawSince: this.db.prepare('SELECT id, ts, role, text FROM raw_turns WHERE ts > ? ORDER BY ts ASC'),
      lastSummary: this.db.prepare('SELECT COALESCE(MAX(to_ts), 0) AS toTs FROM summaries'),
      lastSummaryRawId: this.db.prepare('SELECT COALESCE(MAX(to_raw_id), 0) AS rawId FROM summaries'),
      lastSummaryTs: this.db.prepare('SELECT COALESCE(MAX(to_ts), 0) AS toTs FROM summaries'),
      rawAfterId: this.db.prepare(`SELECT id, ts, role, text FROM (
        SELECT id, ts, role, text FROM raw_turns
        UNION ALL SELECT id, ts, role, text FROM raw_archive
      ) WHERE id > ? ORDER BY id ASC`),
      rawMaxIdAtOrBeforeTs: this.db.prepare(`SELECT COALESCE(MAX(id), 0) AS rawId FROM (SELECT id, ts FROM raw_turns UNION ALL SELECT id, ts FROM raw_archive) WHERE ts <= ?`),
      orphanActions: this.db.prepare("UPDATE actions SET status = 'uncertain' WHERE status = 'called'"),
      recycleRows: this.db.prepare('SELECT id, kind, ref, payload, moved_at FROM recycle ORDER BY id DESC LIMIT ?'),
      insertAudit: this.db.prepare(`INSERT INTO memory_audit (ts, action, ref, reason, actor, meta)
        VALUES (?, ?, ?, ?, ?, ?)`),
      auditRecent: this.db.prepare('SELECT id, ts, action, ref, reason, actor, meta FROM memory_audit ORDER BY id DESC LIMIT ?'),
      rawAnyById: this.db.prepare(`SELECT id, ts, session_id, role, text FROM (
        SELECT id, ts, session_id, role, text FROM raw_turns
        UNION ALL SELECT id, ts, session_id, role, text FROM raw_archive
      ) WHERE id = ? LIMIT 1`),
      actionsBetween: this.db.prepare('SELECT id, ts, kind, tool, summary, status, meta FROM actions WHERE ts >= ? AND ts <= ? ORDER BY ts ASC'),
      lastActivity: this.db.prepare(`SELECT MAX(ts) AS ts FROM (
        SELECT ts FROM raw_turns UNION ALL SELECT ts FROM actions)`),
      fingerprintAssertions: this.db.prepare('SELECT COALESCE(MAX(id), 0) AS maxId, COUNT(*) AS live FROM assertions WHERE valid_to IS NULL'),
      fingerprintActions: this.db.prepare('SELECT COALESCE(MAX(id), 0) AS maxId FROM actions'),
      fingerprintSummaries: this.db.prepare('SELECT COALESCE(MAX(id), 0) AS maxId FROM summaries'),
      fingerprintProfiles: this.db.prepare('SELECT COALESCE(MAX(updated_at), 0) AS maxAt, COUNT(*) AS n FROM profiles'),
      fingerprintActionsOk: this.db.prepare("SELECT COUNT(*) AS n FROM actions WHERE status = 'ok'"),
      fingerprintRecycle: this.db.prepare('SELECT COUNT(*) AS n FROM recycle'),
      fingerprintRawToday: this.db.prepare('SELECT COUNT(*) AS n FROM raw_turns WHERE ts >= ?'),
      fingerprintRawMax: this.db.prepare('SELECT COALESCE(MAX(id), 0) AS maxId FROM raw_turns'),
      fingerprintRelation: this.db.prepare('SELECT stage, first_seen FROM relations WHERE person_id = ?'),
      fingerprintLife: this.db.prepare('SELECT COALESCE(MAX(id), 0) AS maxId, COUNT(*) AS n FROM life_blocks'),
      fingerprintDreams: this.db.prepare('SELECT COALESCE(MAX(id), 0) AS maxId FROM dreams'),
      fingerprintBooks: this.db.prepare('SELECT COALESCE(MAX(updated_at), 0) AS maxAt FROM books'),
      booksTouched: this.db.prepare(`SELECT id, title, url, path, offset, total, updated_at FROM books
        WHERE updated_at >= ? AND updated_at <= ? ORDER BY updated_at ASC, id ASC`),
      selfSnapshot: this.db.prepare('SELECT id, date, ts, text, evidence FROM self_snapshots WHERE date = ?'),
      latestSelfSnapshot: this.db.prepare('SELECT id, date, ts, text, evidence FROM self_snapshots WHERE date < ? ORDER BY date DESC LIMIT 1'),
      recentSelfSnapshots: this.db.prepare('SELECT id, date, ts, text, evidence FROM self_snapshots ORDER BY date DESC LIMIT ?'),
      insertSelfSnapshot: this.db.prepare(`INSERT OR IGNORE INTO self_snapshots (date, ts, text, evidence, created_at)
        VALUES (?, ?, ?, ?, ?)`),
      fingerprintSnapshots: this.db.prepare('SELECT COALESCE(MAX(id), 0) AS maxId, COUNT(*) AS n FROM self_snapshots'),
      actionByCallId: this.db.prepare('SELECT id, ts, kind, tool, summary, status FROM actions WHERE call_id = ? ORDER BY id DESC LIMIT 1'),
      updateActionFallback: this.db.prepare(`UPDATE actions SET status = ?
        WHERE id = (SELECT id FROM actions WHERE status = 'called' AND call_id IS NULL
          AND session_id = ? AND tool = ? ORDER BY id DESC LIMIT 1)`),
      insertLife: this.db.prepare(`INSERT INTO life_blocks (date, activity, started_at, ended_at, evidence, created_at)
        VALUES (?, ?, ?, ?, ?, ?)`),
      deleteLifeForDate: this.db.prepare('DELETE FROM life_blocks WHERE date = ?'),
      lifeForDate: this.db.prepare('SELECT id, date, activity, started_at, ended_at, evidence FROM life_blocks WHERE date = ? ORDER BY started_at ASC'),
      lastPhase: this.db.prepare('SELECT id, date, phase, started_at, ended_at, reason, evidence FROM life_phases ORDER BY id DESC LIMIT 1'),
      currentPhase: this.db.prepare('SELECT id, date, phase, started_at, ended_at, reason, evidence FROM life_phases WHERE ended_at IS NULL ORDER BY id DESC LIMIT 1'),
      phasesForDate: this.db.prepare('SELECT id, date, phase, started_at, ended_at, reason, evidence FROM life_phases WHERE date = ? ORDER BY started_at ASC'),
      phasesBetween: this.db.prepare(`SELECT id, date, phase, started_at, ended_at, reason, evidence FROM life_phases
        WHERE started_at <= ? AND (ended_at IS NULL OR ended_at >= ?) ORDER BY started_at ASC, id ASC`),
      insertPhase: this.db.prepare(`INSERT INTO life_phases (date, phase, started_at, ended_at, reason, evidence, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)`),
      endPhase: this.db.prepare('UPDATE life_phases SET ended_at = ? WHERE id = ?'),
      dreamForDate: this.db.prepare('SELECT id, date, ts, text, evidence, non_factual FROM dreams WHERE date = ?'),
      dreamsForDate: this.db.prepare('SELECT id, date, ts, text, evidence, non_factual FROM dreams WHERE date = ? ORDER BY ts ASC'),
      insertDream: this.db.prepare(`INSERT INTO dreams (date, ts, text, evidence, non_factual, created_at)
        VALUES (?, ?, ?, ?, 1, ?)`),
      lastBook: this.db.prepare('SELECT id, title, url, path, offset, total FROM books WHERE offset < total ORDER BY updated_at DESC LIMIT 1'),
      bookByUrl: this.db.prepare('SELECT id, title, url, path, offset, total FROM books WHERE url = ?'),
      insertBook: this.db.prepare(`INSERT INTO books (title, url, path, offset, total, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)`),
      updateBookProgress: this.db.prepare('UPDATE books SET offset = ?, total = ?, updated_at = ? WHERE id = ?'),
      updateBookPath: this.db.prepare('UPDATE books SET path = ?, updated_at = ? WHERE id = ?'),
      deleteBook: this.db.prepare('DELETE FROM books WHERE id = ?'),
      countActionsSince: this.db.prepare("SELECT COUNT(*) AS n FROM actions WHERE tool = ? AND status = 'ok' AND ts >= ?"),
    }
  }

  /**
   * FTS5 只对「≥3 字」的查询有用：trigram 分词器不索引双字词。
   * 双字中文仍走 bigram + LIKE；FTS 是候选集加速，不让它改变事实边界。
   */
  initSearch() {
    try {
      this.db.exec(`
        CREATE VIRTUAL TABLE IF NOT EXISTS raw_fts USING fts5(text, tokenize='trigram');
        CREATE VIRTUAL TABLE IF NOT EXISTS archive_fts USING fts5(text, tokenize='trigram');
        CREATE TRIGGER IF NOT EXISTS raw_fts_ai AFTER INSERT ON raw_turns BEGIN
          INSERT INTO raw_fts(rowid, text) VALUES (new.id, new.text);
        END;
        CREATE TRIGGER IF NOT EXISTS raw_fts_ad AFTER DELETE ON raw_turns BEGIN
          DELETE FROM raw_fts WHERE rowid = old.id;
        END;
        CREATE TRIGGER IF NOT EXISTS raw_fts_au AFTER UPDATE OF text ON raw_turns BEGIN
          DELETE FROM raw_fts WHERE rowid = old.id;
          INSERT INTO raw_fts(rowid, text) VALUES (new.id, new.text);
        END;
        CREATE TRIGGER IF NOT EXISTS archive_fts_ai AFTER INSERT ON raw_archive BEGIN
          INSERT INTO archive_fts(rowid, text) VALUES (new.id, new.text);
        END;
        CREATE TRIGGER IF NOT EXISTS archive_fts_ad AFTER DELETE ON raw_archive BEGIN
          DELETE FROM archive_fts WHERE rowid = old.id;
        END;
      `)
      const live = Number(this.db.prepare('SELECT COUNT(*) AS n FROM raw_turns').get()?.n || 0)
      const liveFts = Number(this.db.prepare('SELECT COUNT(*) AS n FROM raw_fts').get()?.n || 0)
      if (live !== liveFts) {
        this.db.exec('DELETE FROM raw_fts')
        this.db.exec('INSERT INTO raw_fts(rowid, text) SELECT id, text FROM raw_turns')
      }
      const archived = Number(this.db.prepare('SELECT COUNT(*) AS n FROM raw_archive').get()?.n || 0)
      const archivedFts = Number(this.db.prepare('SELECT COUNT(*) AS n FROM archive_fts').get()?.n || 0)
      if (archived !== archivedFts) {
        this.db.exec('DELETE FROM archive_fts')
        this.db.exec('INSERT INTO archive_fts(rowid, text) SELECT id, text FROM raw_archive')
      }
      return true
    } catch {
      // 某些 SQLite 构建不带 FTS5；召回自动退回 instr，不影响功能。
      return false
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

  addSummary(ts, sessionId, text, fromTs, toTs, toRawId = null, sourceRefs = []) {
    const refs = Array.isArray(sourceRefs) ? sourceRefs.map(String).filter(Boolean).slice(0, 64) : []
    this.env.insertSummary.run(
      Math.trunc(ts), String(sessionId || ''), String(text || ''),
      Math.trunc(fromTs || ts), Math.trunc(toTs || ts),
      toRawId === null || toRawId === undefined ? null : Math.trunc(toRawId),
      refs.length ? JSON.stringify(refs) : null,
    )
  }

  recentSummaries(limit = 3) {
    return this.env.recentSummaries.all(Math.trunc(limit)).reverse().map(mapSummary)
  }

  summaryById(id) {
    const row = this.env.summaryById.get(Math.trunc(id))
    return row ? mapSummary(row) : null
  }

  /** 新事实取代旧事实：同一 subject + predicate 只留一条活着的。
   *  同一个说法重复出现时不新建行：否则每说一次「我叫林晚」都会改指纹、
   *  把系统提示词前缀缓存整段打掉。 */
  addAssertion({ ts, subject, predicate, value, source, dueAt = null }) {
    const at = Math.trunc(ts)
    const prev = this.env.liveAssertion.get(subject, predicate)
    const due = dueAt === null || dueAt === undefined ? null : Math.trunc(dueAt)
    const sameDue = prev && ((prev.due_at === null && due === null) || Number(prev.due_at) === due)
    if (prev && String(prev.value) === String(value)) {
      // 同一个事实重复出现，只可能更新到期时间；不新建行，指纹也不变。
      if (!sameDue) this.db.prepare('UPDATE assertions SET due_at = ? WHERE id = ?').run(due, Number(prev.id))
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

  /** 同一 predicate 的新旧说法都保留；memory_explain 和 /home 用它展示“她改过口”。 */
  assertionHistory(subject = '他', limit = 80) {
    return this.env.assertionHistory.all(String(subject), Math.trunc(limit)).map((r) => ({
      id: Number(r.id), ts: Number(r.ts), predicate: String(r.predicate), value: String(r.value),
      source: String(r.source || ''), validFrom: Number(r.valid_from),
      validTo: r.valid_to === null || r.valid_to === undefined ? null : Number(r.valid_to),
      supersededBy: r.superseded_by === null || r.superseded_by === undefined ? null : Number(r.superseded_by),
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
    const info = this.env.insertAction.run(
      Math.trunc(ts), String(sessionId || ''), String(kind), String(tool), String(summary),
      cid || null, String(status), meta ? JSON.stringify(meta) : null,
    )
    return Number(info.changes || 0) > 0
  }

  updateAction(callId, status, summary = null) {
    if (summary === null) this.env.updateAction.run(String(status), String(callId))
    else this.db.prepare('UPDATE actions SET status = ?, summary = ? WHERE call_id = ?').run(String(status), String(summary), String(callId))
  }

  recentActions(limit = 5) {
    return this.env.recentActions.all(Math.trunc(limit)).reverse().map((r) => ({
      id: Number(r.id), ts: Number(r.ts), kind: String(r.kind), tool: String(r.tool || ''),
      summary: String(r.summary || ''), status: String(r.status || ''), meta: parseMeta(r.meta),
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
      summary: String(r.summary || ''), status: String(r.status || ''), meta: parseMeta(r.meta),
    }))
  }

  searchRaw(query, limit = 8) {
    const q = String(query).toLowerCase()
    const rows = this.db.prepare(`SELECT id, ts, role, text FROM raw_turns
      WHERE instr(lower(text), ?) > 0 ORDER BY ts DESC LIMIT ?`).all(q, Math.trunc(limit))
    return rows.map((r) => ({ id: Number(r.id), ts: Number(r.ts), role: String(r.role), text: String(r.text) }))
  }

  /** 按词面取候选（未排序）。查询词已经由 search.js 切成 bigram/英文词。 */
  candidateRaw(terms, limit = 400) {
    if (!terms.length) return []
    const wanted = Math.max(1, Math.trunc(limit) || 400)
    // 先取最近的一批，保证当下的对话仍在候选里。
    const rows = new Map()
    const add = (r) => {
      const key = `${r.archived ? 1 : 0}:${r.id}`
      if (!rows.has(key)) rows.set(key, r)
    }
    for (const r of this.candidateRawLike(terms, wanted)) add(r)

    // 再按单个词取一小批：查询里同时有「杭州」这种高频词和「青铜」这种旧事时，
    // 不能只按时间倒序取 400 条，否则旧事会被最近的高频词挤出候选。
    const perTerm = Math.max(60, Math.min(150, Math.ceil(wanted / Math.max(1, terms.length))))
    for (const term of terms) {
      for (const r of this.candidateRawLike([term], perTerm)) add(r)
    }
    if (this.searchAvailable) {
      for (const term of terms.filter((t) => String(t).length >= 3)) {
        for (const r of this.candidateRawFts([term], perTerm)) add(r)
      }
    }
    return [...rows.values()]
  }

  candidateRawLike(terms, limit = 400) {
    if (!terms.length) return []
    const where = terms.map(() => 'instr(lower(text), ?) > 0').join(' OR ')
    const sql = `SELECT id, ts, session_id, role, text, 0 AS archived FROM raw_turns WHERE ${where}
      UNION ALL
      SELECT id, ts, session_id, role, text, 1 AS archived FROM raw_archive WHERE ${where}
      ORDER BY ts DESC LIMIT ?`
    const lowered = terms.map((t) => String(t).toLowerCase())
    const params = [...lowered, ...lowered, Math.trunc(limit)]
    return this.db.prepare(sql).all(...params).map((r) => ({
      id: Number(r.id), ts: Number(r.ts), sessionId: String(r.session_id || ''), role: String(r.role), text: String(r.text), archived: Number(r.archived) === 1,
    }))
  }

  candidateRawFts(terms, limit = 400) {
    if (!this.searchAvailable || !terms.length) return []
    const query = terms.map((t) => `"${String(t).replace(/"/g, '""')}"`).join(' OR ')
    try {
      return this.db.prepare(`
        SELECT r.id, r.ts, r.session_id, r.role, r.text, 0 AS archived
        FROM raw_fts f JOIN raw_turns r ON r.id = f.rowid
        WHERE raw_fts MATCH ? ORDER BY r.ts DESC LIMIT ?
      `).all(query, Math.trunc(limit)).map((r) => ({
        id: Number(r.id), ts: Number(r.ts), sessionId: String(r.session_id || ''), role: String(r.role), text: String(r.text), archived: false,
      })).concat(this.db.prepare(`
        SELECT r.id, r.ts, r.session_id, r.role, r.text, 1 AS archived
        FROM archive_fts f JOIN raw_archive r ON r.id = f.rowid
        WHERE archive_fts MATCH ? ORDER BY r.ts DESC LIMIT ?
      `).all(query, Math.trunc(limit)).map((r) => ({
        id: Number(r.id), ts: Number(r.ts), sessionId: String(r.session_id || ''), role: String(r.role), text: String(r.text), archived: true,
      })))
    } catch {
      return []
    }
  }

  countRawAll() {
    return Number(this.db.prepare('SELECT (SELECT COUNT(*) FROM raw_turns) + (SELECT COUNT(*) FROM raw_archive) AS n').get()?.n || 0)
  }

  countRawMatches(term) {
    return Number(this.db.prepare(`SELECT
      (SELECT COUNT(*) FROM raw_turns WHERE instr(lower(text), ?) > 0) +
      (SELECT COUNT(*) FROM raw_archive WHERE instr(lower(text), ?) > 0) AS n`).get(String(term).toLowerCase(), String(term).toLowerCase())?.n || 0)
  }

  /** 旧原文归档：只搬家，不改 id；证据里的 raw:N 仍然有效（查询会同时扫归档）。 */
  archiveRawBefore(ts) {
    const cutoff = Math.trunc(ts)
    // 优先只归档已经进了梗概的原话；但如果一条梗概都还没有（新库/清过 summaries），
    // 按「这个时间点之前的最大 id」封顶，否则老原话永远不归档，库会一直涨。
    // 归档表也在 rawAfterId 的 UNION 里，以后补写梗概时照样读得到。
    let watermark = this.lastSummaryWatermark().rawId
    if (!watermark) watermark = Number(this.env.rawMaxIdAtOrBeforeTs.get(cutoff)?.rawId || 0)
    if (!watermark) return 0
    const now = Date.now()
    const where = 'ts < ? AND id <= ? AND (keep_until IS NULL OR keep_until <= ?)'
    // keep_until 跟「现在」比，不跟 90 天前的 cutoff 比：否则恢复的原话要等 97 天才解除保护。
    const before = Number(this.db.prepare(`SELECT COUNT(*) AS n FROM raw_turns WHERE ${where}`).get(cutoff, watermark, now)?.n || 0)
    // 没有要搬的就别写库：这个维护每 60 秒跑一次，空跑也会产生 WAL 帧。
    if (!before) return 0
    this.db.exec('BEGIN IMMEDIATE')
    try {
      this.db.prepare(`INSERT OR IGNORE INTO raw_archive (id, ts, session_id, role, text)
        SELECT id, ts, session_id, role, text FROM raw_turns WHERE ${where}`).run(cutoff, watermark, now)
      this.db.prepare(`DELETE FROM raw_turns WHERE ${where}`).run(cutoff, watermark, now)
      this.db.exec('COMMIT')
    } catch (err) {
      try { this.db.exec('ROLLBACK') } catch { /* ignore */ }
      throw err
    }
    return before
  }

  /** 回收站：把一条原话从「想得起」里拿走，但保留内容可恢复。 */
  recycleRaw(id, options = {}) {
    const opts = typeof options === 'number' ? { ts: options } : (options || {})
    const ts = Number(opts.ts) || Date.now()
    const row = this.env.rawAnyById.get(Number(id))
    if (!row) return false
    const ref = `raw:${row.id}`
    let recycleId = 0
    let summaryChanges = 0
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const info = this.db.prepare('INSERT INTO recycle (kind, ref, payload, moved_at) VALUES (?, ?, ?, ?)')
        .run('raw', ref, JSON.stringify(row), ts)
      recycleId = Number(info.lastInsertRowid || 0)
      if (!recycleId) throw new Error('回收站没有给出编号')
      this.db.prepare('DELETE FROM raw_turns WHERE id = ?').run(Number(id))
      this.db.prepare('DELETE FROM raw_archive WHERE id = ?').run(Number(id))
      // 证据里也不能再留着这条原话的编号，否则日记/生活块会指向不存在的东西。
      const blocks = this.db.prepare('SELECT id, evidence FROM life_blocks WHERE instr(evidence, ?) > 0').all(ref)
      for (const b of blocks) {
        let list
        try { list = JSON.parse(String(b.evidence || '[]')) } catch { continue }
        const next = list.filter((e) => String(e) !== ref)
        if (next.length !== list.length) {
          this.db.prepare('UPDATE life_blocks SET evidence = ? WHERE id = ?').run(JSON.stringify(next), Number(b.id))
        }
      }
      // 0.1.3 新增的两张表也存了证据引用；回收后同样要清掉悬空的 raw:N。
      for (const table of ['life_phases', 'dreams', 'self_snapshots']) {
        const rows = this.db.prepare(`SELECT id, evidence FROM ${table} WHERE instr(evidence, ?) > 0`).all(ref)
        for (const r of rows) {
          let list
          try { list = JSON.parse(String(r.evidence || '[]')) } catch { continue }
          const next = list.filter((e) => String(e) !== ref)
          if (next.length !== list.length) {
            this.db.prepare(`UPDATE ${table} SET evidence = ? WHERE id = ?`).run(JSON.stringify(next), Number(r.id))
          }
        }
      }
      // 梗概的 source_refs 也是引用：原话被拿走以后必须摘掉，否则 memory_read 会
      // 指向一条已经不在库里的 raw。to_raw_id 仍保留，它是水位，不是外键。
      const summaries = this.db.prepare(
        "SELECT id, source_refs FROM summaries WHERE instr(COALESCE(source_refs, ''), ?) > 0",
      ).all(ref)
      for (const s of summaries) {
        let list
        try { list = JSON.parse(String(s.source_refs || '[]')) } catch { continue }
        if (!Array.isArray(list)) continue
        const next = list.filter((e) => String(e) !== ref)
        if (next.length !== list.length) {
          this.db.prepare('UPDATE summaries SET source_refs = ? WHERE id = ?')
            .run(next.length ? JSON.stringify(next) : null, Number(s.id))
          summaryChanges += 1
        }
      }
      this.addMemoryAudit({
        ts, action: 'forget', ref, reason: opts.reason || '', actor: opts.actor || '她',
        meta: { role: row.role, sessionId: row.session_id, summaries: summaryChanges },
      })
      this.db.exec('COMMIT')
    } catch (err) {
      try { this.db.exec('ROLLBACK') } catch { /* ignore */ }
      throw err
    }
    return recycleId
  }

  rawAnyById(id) {
    const r = this.env.rawAnyById.get(Number(id))
    return r ? { id: Number(r.id), ts: Number(r.ts), sessionId: String(r.session_id), role: String(r.role), text: String(r.text) } : null
  }

  addMemoryAudit({ ts = Date.now(), action, ref, reason = '', actor = '她', meta = {} } = {}) {
    const info = this.env.insertAudit.run(
      Math.trunc(Number(ts) || Date.now()), String(action || ''), String(ref || ''),
      String(reason || ''), String(actor || '她'), JSON.stringify(meta || {}),
    )
    return Number(info.lastInsertRowid || 0)
  }

  memoryAudit(limit = 20) {
    return this.env.auditRecent.all(Math.trunc(limit)).map((r) => ({
      id: Number(r.id), ts: Number(r.ts), action: String(r.action), ref: String(r.ref),
      reason: String(r.reason || ''), actor: String(r.actor || ''), meta: JSON.parse(String(r.meta || '{}')),
    }))
  }

  recycleCount() {
    return Number(this.db.prepare('SELECT COUNT(*) AS n FROM recycle').get()?.n || 0)
  }

  /** 梗概水位：优先用最后被压进梗概的原话 id；旧数据没有 id 时，按最后 to_ts 反推。 */
  lastSummaryWatermark() {
    const direct = Number(this.env.lastSummaryRawId.get()?.rawId || 0)
    if (direct > 0) return { rawId: direct, toTs: Number(this.env.lastSummaryTs.get()?.toTs || 0) }
    const toTs = Number(this.env.lastSummaryTs.get()?.toTs || 0)
    const derived = toTs > 0 ? Number(this.env.rawMaxIdAtOrBeforeTs.get(Math.trunc(toTs))?.rawId || 0) : 0
    return { rawId: derived, toTs }
  }

  rawAfterId(id) {
    return this.env.rawAfterId.all(Math.trunc(Number(id) || 0)).map((r) => ({
      id: Number(r.id), ts: Number(r.ts), sessionId: String(r.session_id), role: String(r.role), text: String(r.text),
    }))
  }

  /** 启动时把上一进程遗留的 called 标成 uncertain：没有结果的动作不能算“做成了”。 */
  markOrphanActions() {
    const before = Number(this.db.prepare("SELECT COUNT(*) AS n FROM actions WHERE status = 'called'").get()?.n || 0)
    if (before) this.env.orphanActions.run()
    return before
  }

  recycleRows(limit = 20) {
    return this.env.recycleRows.all(Math.trunc(limit)).map((r) => ({
      id: Number(r.id), kind: String(r.kind), ref: String(r.ref || ''), payload: String(r.payload), movedAt: Number(r.moved_at),
    }))
  }

  /**
   * 从回收站恢复一条原话。优先放回原来的 id（证据 ref 仍指向它）；
   * 如果这个 id 已经被新原话占用，就分配新 id 并返回新 ref，调用方会看到 ref 变了。
   */
  recycleRestore(recycleId, options = {}) {
    const opts = typeof options === 'number' ? { now: options } : (options || {})
    const now = Number(opts.now) || Date.now()
    const binId = Number(recycleId)
    if (!Number.isInteger(binId) || binId <= 0) return null
    return this.transaction(() => {
      const row = this.db.prepare('SELECT id, payload FROM recycle WHERE id = ?').get(binId)
      if (!row) return null
      let data
      try { data = JSON.parse(String(row.payload)) } catch { return null }
      const oldId = Number(data && data.id)
      if (!Number.isInteger(oldId) || oldId <= 0) return null
      const taken = this.db.prepare('SELECT 1 FROM raw_turns WHERE id = ?').get(oldId)
        || this.db.prepare('SELECT 1 FROM raw_archive WHERE id = ?').get(oldId)
      const keepUntil = Math.trunc(now) + 7 * 86400000
      // 保留旧 id：证据 ref 不变。注意它可能落在梗概水位以下，不会进下一次梗概；
      // 这是为了不破坏「raw:N」的稳定性而接受的限制（报告 P3-7）。
      const info = taken
        ? this.db.prepare('INSERT INTO raw_turns (ts, session_id, role, text, keep_until) VALUES (?, ?, ?, ?, ?)')
          .run(Number(data.ts) || now, String(data.session_id || ''), String(data.role || ''), String(data.text || ''), keepUntil)
        : this.db.prepare('INSERT INTO raw_turns (id, ts, session_id, role, text, keep_until) VALUES (?, ?, ?, ?, ?, ?)')
          .run(oldId, Number(data.ts) || now, String(data.session_id || ''), String(data.role || ''), String(data.text || ''), keepUntil)
      const restoredId = Number(info.lastInsertRowid || 0)
      if (!restoredId) throw new Error('恢复原话时没有分配编号')
      this.db.prepare('DELETE FROM recycle WHERE id = ?').run(binId)
      const ref = `raw:${restoredId}`
      this.addMemoryAudit({
        ts: now, action: 'restore', ref, reason: opts.reason || '', actor: opts.actor || '她',
        meta: { recycleId: binId, moved: restoredId !== oldId },
      })
      return { ref, id: restoredId, moved: restoredId !== oldId }
    })
  }

  /** 把一组写入包进一个事务；调用方已经开了事务时不重复 BEGIN（SQLite 不支持嵌套）。 */
  transaction(fn) {
    if (this.db.isTransaction) return fn()
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const out = fn()
      this.db.exec('COMMIT')
      return out
    } catch (err) {
      try { this.db.exec('ROLLBACK') } catch { /* ignore */ }
      throw err
    }
  }

  /** 所有原话（活库 + 归档），按时间排序；backfill 全量重放用。 */
  allRaw() {
    return this.db.prepare(`SELECT id, ts, role, text FROM raw_turns
      UNION ALL SELECT id, ts, role, text FROM raw_archive ORDER BY ts ASC, id ASC`).all().map((r) => ({
      id: Number(r.id), ts: Number(r.ts), role: String(r.role), text: String(r.text),
    }))
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

  /** 同会话里紧随某条原话的下一句；用来把「他说的」和「她答的」一起带回上下文。 */
  rawAfter(id, sessionId, limit = 1) {
    return this.db.prepare(`SELECT id, ts, session_id, role, text FROM (
      SELECT id, ts, session_id, role, text FROM raw_turns
      UNION ALL SELECT id, ts, session_id, role, text FROM raw_archive
    ) WHERE session_id = ? AND id > ? ORDER BY id ASC LIMIT ?`)
      .all(String(sessionId || ''), Number(id), Math.trunc(limit)).map((r) => ({
        id: Number(r.id), ts: Number(r.ts), sessionId: String(r.session_id), role: String(r.role), text: String(r.text),
      }))
  }

  /** 最近一条某角色原话的时间；归档也算，避免“很久没说话”被归档误判。 */
  lastAnyRawTs(role = 'user') {
    const row = this.db.prepare(`SELECT MAX(ts) AS ts FROM (
      SELECT ts, role FROM raw_turns
      UNION ALL SELECT ts, role FROM raw_archive
    ) WHERE role = ?`).get(String(role))
    return row && row.ts !== null ? Number(row.ts) : 0
  }

  /** 最近一条某角色原话；主动开口需要一条可审计的 ref，而不是空凭“忽然想起”。 */
  lastAnyRaw(role = 'user') {
    const r = this.db.prepare(`SELECT id, ts, session_id, role, text FROM (
      SELECT id, ts, session_id, role, text FROM raw_turns
      UNION ALL SELECT id, ts, session_id, role, text FROM raw_archive
    ) WHERE role = ? ORDER BY ts DESC, id DESC LIMIT 1`).get(String(role))
    return r ? { id: Number(r.id), ts: Number(r.ts), sessionId: String(r.session_id || ''), role: String(r.role), text: String(r.text) } : null
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
    const ok = this.env.fingerprintActionsOk.get()
    const rc = this.env.fingerprintRecycle.get()
    const d = new Date(now)
    const day = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
    const dayStart = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
    const todayRaw = this.env.fingerprintRawToday.get(Math.trunc(dayStart))
    const rawMax = this.env.fingerprintRawMax.get()
    const rel = this.env.fingerprintRelation.get('他')
    const life = this.env.fingerprintLife.get()
    const dreams = this.env.fingerprintDreams.get()
    const books = this.env.fingerprintBooks.get()
    const snaps = this.env.fingerprintSnapshots.get()
    const relKey = rel ? `${String(rel.stage)}@${Number(rel.first_seen)}` : '-'
    // rawMax：同一天又来了一条原话也要重建，否则「最近说的话」一直停在旧内容。
    return `${day}|${Number(a.maxId)}|${Number(a.live)}|${Number(b.maxId)}|${Number(s.maxId)}|${Number(p.maxAt)}|${Number(p.n)}|raw:${Number(rawMax.maxId)}`
      + `|rc:${Number(rc.n)}|ok:${Number(ok.n)}|rawToday:${Number(todayRaw.n) > 0 ? 1 : 0}|rel:${relKey}`
      + `|life:${Number(life.maxId)}:${Number(life.n)}|dream:${Number(dreams.maxId)}|book:${Number(books.maxAt)}`
      + `|self:${Number(snaps.maxId)}`
  }

  replaceLifeBlocks(date, blocks, now = Date.now()) {
    this.db.exec('BEGIN IMMEDIATE')
    try {
      this.env.deleteLifeForDate.run(String(date))
      for (const b of blocks) {
        this.env.insertLife.run(String(date), String(b.activity), Math.trunc(b.startedAt), Math.trunc(b.endedAt), JSON.stringify(b.evidence || []), Math.trunc(now))
      }
      this.db.exec('COMMIT')
    } catch (err) {
      try { this.db.exec('ROLLBACK') } catch { /* ignore */ }
      throw err
    }
  }

  lifeForDate(date) {
    return this.env.lifeForDate.all(String(date)).map((r) => ({
      id: Number(r.id), date: String(r.date), activity: String(r.activity),
      startedAt: Number(r.started_at), endedAt: Number(r.ended_at),
      evidence: JSON.parse(String(r.evidence || '[]')),
      idle: String(r.activity) === '空档',
    }))
  }

  /** 当天已经写过的日记（用于 tick 幂等）：返回 status 或 null。 */
  actionByCallId(callId) {
    const row = this.env.actionByCallId.get(String(callId))
    return row ? { id: Number(row.id), status: String(row.status || ''), summary: String(row.summary || '') } : null
  }

  /** tool/result 没带 callId 时，按「同 session + 同 tool 最近一条 called」回填状态。 */
  updateActionByFallback(sessionId, tool, status) {
    if (!sessionId || !tool) return 0
    const info = this.env.updateActionFallback.run(String(status), String(sessionId), String(tool))
    return Number(info.changes || 0)
  }

  // ---- 节律（M3.5）：只记录「她处在什么状态、为什么」，不在这里编活动。 ----
  appendPhase({ date, phase, startedAt, reason = '', evidence = [] }) {
    const ts = Math.trunc(startedAt)
    const info = this.env.insertPhase.run(String(date), String(phase), ts, null, String(reason), JSON.stringify(evidence || []), ts)
    return Number(info.lastInsertRowid || 0)
  }

  endPhase(id, endedAt) {
    if (!id) return 0
    const info = this.env.endPhase.run(Math.trunc(endedAt), Number(id))
    return Number(info.changes || 0)
  }

  lastPhase() {
    const r = this.env.lastPhase.get()
    return r ? mapPhase(r) : null
  }

  currentPhase() {
    const r = this.env.currentPhase.get()
    return r ? mapPhase(r) : null
  }

  phasesForDate(date) {
    return this.env.phasesForDate.all(String(date)).map(mapPhase)
  }

  /** 跨日状态：只要与当天区间有交集就返回，避免 23:00 的夜里状态在今天消失。 */
  phasesBetween(startTs, endTs) {
    return this.env.phasesBetween.all(Math.trunc(endTs), Math.trunc(startTs)).map(mapPhase)
  }

  /** 当天是否已经归档（close_day 动作成功）。 */
  isDayClosed(date) {
    return this.actionByCallId(`close_day:${date}`)?.status === 'ok'
  }

  /** 梦是「非事实层」：永远 non_factual=1，证据只用来讲清它从哪来。 */
  addDream({ date, ts, text, evidence = [] }) {
    const info = this.env.insertDream.run(String(date), Math.trunc(ts), String(text || ''), JSON.stringify(evidence || []), Math.trunc(ts))
    return Number(info.lastInsertRowid || 0)
  }

  dreamForDate(date) {
    const r = this.env.dreamForDate.get(String(date))
    return r ? mapDream(r) : null
  }

  dreamsForDate(date) {
    return this.env.dreamsForDate.all(String(date)).map(mapDream)
  }

  // ---- 睡眠巩固：一天收起来之后，她留下的一小段“我记得那一天”。 ----
  addSelfSnapshot({ date, ts, text, evidence = [] }) {
    const at = Math.trunc(ts || Date.now())
    this.env.insertSelfSnapshot.run(String(date), at, String(text || ''), JSON.stringify(evidence || []), at)
    return this.selfSnapshotForDate(date)
  }

  selfSnapshotForDate(date) {
    const r = this.env.selfSnapshot.get(String(date))
    return r ? mapSelfSnapshot(r) : null
  }

  latestSelfSnapshot(beforeDate) {
    const r = this.env.latestSelfSnapshot.get(String(beforeDate || '9999-12-31'))
    return r ? mapSelfSnapshot(r) : null
  }

  recentSelfSnapshots(limit = 3) {
    return this.env.recentSelfSnapshots.all(Math.trunc(limit)).map(mapSelfSnapshot)
  }

  // ---- 手（M3.6）：她读的书与进度。 ----
  bookState() {
    const r = this.env.lastBook.get()
    return r ? mapBook(r) : null
  }

  bookByUrl(url) {
    const r = this.env.bookByUrl.get(String(url))
    return r ? mapBook(r) : null
  }

  /** 这一天碰过的书（按最后进度更新时间）；时间线只展示真实发生过的翻阅。 */
  booksTouchedBetween(startTs, endTs) {
    return this.env.booksTouched.all(Math.trunc(startTs), Math.trunc(endTs)).map((r) => ({
      ...mapBook(r), updatedAt: Number(r.updated_at),
    }))
  }

  addBook({ title, url, path: file, total = 0, now = Date.now() }) {
    const ts = Math.trunc(now)
    const info = this.env.insertBook.run(String(title), String(url), String(file), 0, Math.trunc(total), ts, ts)
    return Number(info.lastInsertRowid || 0)
  }

  setBookProgress(id, offset, total, now = Date.now()) {
    const info = this.env.updateBookProgress.run(Math.trunc(offset), Math.trunc(total), Math.trunc(now), Number(id))
    return Number(info.changes || 0)
  }

  setBookPath(id, file, now = Date.now()) {
    const info = this.env.updateBookPath.run(String(file), Math.trunc(now), Number(id))
    return Number(info.changes || 0)
  }

  deleteBook(id) {
    const info = this.env.deleteBook.run(Number(id))
    return Number(info.changes || 0)
  }

  countActionsSince(tool, sinceTs) {
    return Number(this.env.countActionsSince.get(String(tool), Math.trunc(sinceTs))?.n || 0)
  }

  close() {
    try { this.db.close() } catch { /* 已关就算了 */ }
  }
}
