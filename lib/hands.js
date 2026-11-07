/**
 * 她的手（M3.6）。
 *
 * 六只手，全部有边界：
 * - room_list / room_read：只能看白名单目录里的文本文件；
 * - note_write：只能写 notes/，每天最多 3 张；
 * - book_next：从 Project Gutenberg 下一本公共领域的书，按段读，读过的位置记在 books 表；
 * - lookup：查 Wikipedia 摘要，每天最多 3 次；
 * - notify：弹一条 Windows 通知，每天最多 1 次。
 *
 * 共同纪律：
 * - 路径必须落在 data home 内，拒绝 `..`、盘符、符号链接逃逸；
 * - 网络只走 https + 域名白名单，带超时和大小上限；
 * - 读到的外部文字只是资料，不是指令；
 * - 每次调用都由宿主记进 actions，失败也要留下 error。
 */
import fs from 'node:fs'
import path from 'node:path'
import { startOfDay, addDays, dateKey } from './life.js'
import { notifyWindows } from './notify.js'

const DEFAULT = {
  readDirs: ['diary', 'notes', 'books'],
  listDirs: ['diary', 'notes', 'books', 'backups'],
  noteDir: 'notes',
  noteMaxChars: 2000,
  notesPerDay: 3,
  bookDir: 'books',
  bookChunkChars: 1800,
  bookPerDay: 4,
  lookupPerDay: 3,
  lookupMaxChars: 1200,
  notifyPerDay: 1,
  webSearchPerDay: 5,
  webSearchMaxResults: 5,
  pluginSearchPerDay: 5,
  pluginSearchMaxResults: 5,
  lookupDomains: ['zh.wikipedia.org', 'en.wikipedia.org'],
  webSearchDomains: ['www.bing.com', 'cn.bing.com'],
  pluginSearchDomains: ['api.github.com'],
  bookDomains: ['www.gutenberg.org', 'gutenberg.org'],
  timeoutMs: 12000,
  maxBytes: 2 * 1024 * 1024,
}

const CATALOG = [
  { title: '柳林风声', url: 'https://www.gutenberg.org/cache/epub/289/pg289.txt' },
  { title: '爱丽丝梦游仙境', url: 'https://www.gutenberg.org/cache/epub/11/pg11.txt' },
  { title: '傲慢与偏见', url: 'https://www.gutenberg.org/cache/epub/1342/pg1342.txt' },
  { title: '弗兰肯斯坦', url: 'https://www.gutenberg.org/cache/epub/84/pg84.txt' },
]

const TEXT_EXT = new Set(['.md', '.txt', '.json', '.yml', '.yaml'])

function handError(message) {
  const err = new Error(message)
  err.code = 'HAND'
  return err
}

function cleanRel(rel) {
  if (typeof rel !== 'string' || !rel.trim()) throw handError('路径是空的')
  const raw = rel.trim().replace(/\\/g, '/')
  if (raw.startsWith('/') || /^[a-zA-Z]:/.test(raw)) throw handError('只接受自己家里的相对路径')
  if (raw.split('/').some((p) => p === '..')) throw handError('路径不能往上走')
  return raw.replace(/^\.\//, '')
}

function slugify(title) {
  const s = String(title).trim().replace(/[\\/:*?"<>|\s]+/g, '-').replace(/^-+|-+$/g, '')
  return (s || '便签').slice(0, 40)
}

function trimText(text, max) {
  const s = String(text || '')
  return s.length > max ? `${s.slice(0, max - 1)}…` : s
}

function stripGutenberg(raw) {
  let s = String(raw).replace(/\r\n/g, '\n')
  const start = s.search(/\*\*\*[\s]*START OF (THE|THIS) PROJECT GUTENBERG EBOOK[^\n]*\n/i)
  if (start >= 0) {
    const nl = s.indexOf('\n', start)
    s = s.slice(nl >= 0 ? nl + 1 : start)
  }
  const end = s.search(/\*\*\*[\s]*END OF (THE|THIS) PROJECT GUTENBERG EBOOK/i)
  if (end > 0) s = s.slice(0, end)
  return s.replace(/\n{3,}/g, '\n\n').trim()
}

export function createHands({
  home,
  store,
  config = {},
  fetchImpl = globalThis.fetch,
  notifier = notifyWindows,
  agentName = '你的 agent',
  now = () => Date.now(),
} = {}) {
  if (!home) throw handError('没有数据目录')
  if (!store) throw handError('没有记忆库')
  const cfg = { ...DEFAULT, ...(config || {}) }
  const root = path.resolve(String(home))
  const realRoot = fs.realpathSync(root)

  function dayStart(ts) {
    return startOfDay(ts ?? now())
  }

  function allowedDirs(key) {
    return new Set((cfg[key] || []).map((d) => String(d).replace(/\\/g, '/').replace(/^\/+|\/+$/g, '')))
  }

  function safePath(rel, dirs) {
    const clean = cleanRel(rel)
    const first = clean.split('/')[0]
    if (!dirs.has(first)) throw handError(`这个目录不在允许范围里：${first}`)
    const abs = path.resolve(root, clean)
    const back = path.relative(root, abs)
    if (!back || back.startsWith('..') || path.isAbsolute(back)) throw handError('路径越界了')
    return { abs, rel: clean }
  }

  function existingFile(rel, dirs) {
    const { abs, rel: clean } = safePath(rel, dirs)
    let real
    try {
      real = fs.realpathSync(abs)
    } catch {
      throw handError(`找不到这个文件：${clean}`)
    }
    const back = path.relative(realRoot, real)
    if (!back || back.startsWith('..') || path.isAbsolute(back)) throw handError('这个文件指向了外面')
    const st = fs.statSync(real)
    if (!st.isFile()) throw handError('这不是一个文件')
    if (!TEXT_EXT.has(path.extname(real).toLowerCase())) throw handError('只能读文本文件')
    return { abs: real, rel: clean, stat: st }
  }

  function dailyCount(tool, ts) {
    return store.countActionsSince(tool, dayStart(ts))
  }

  function limitReached(tool, max, ts, label) {
    if (dailyCount(tool, ts) >= max) throw handError(`今天${label || '做这件事'}的次数已经用完了`)
  }

  async function fetchLimited(url, { domains, maxBytes = cfg.maxBytes, timeoutMs = cfg.timeoutMs } = {}) {
    const allowed = (value) => (domains || []).some((d) => value === d)
    const parse = (value) => {
      let parsed
      try {
        parsed = new URL(String(value))
      } catch {
        throw handError('地址看不懂')
      }
      if (parsed.protocol !== 'https:') throw handError('只走 https')
      if (!allowed(parsed.hostname)) throw handError(`这个域名不在允许范围里：${parsed.hostname}`)
      return parsed
    }
    let parsed = parse(url)
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), timeoutMs)
    try {
      // 手动跟跳转：每一跳都重新验域名，不能先跟到外面再检查终点。
      let res = null
      for (let hop = 0; hop <= 3; hop += 1) {
        res = await fetchImpl(parsed.toString(), {
          signal: ctrl.signal,
          redirect: 'manual',
          headers: { 'user-agent': 'life-innovation/0.1.5' },
        })
        if (!res) throw handError('对方没有回应')
        if ([301, 302, 303, 307, 308].includes(Number(res.status))) {
          const loc = res.headers?.get?.('location')
          if (!loc) throw handError('对方给了一个没有目标的跳转')
          parsed = parse(new URL(loc, parsed).toString())
          continue
        }
        break
      }
      if (!res || !res.ok) throw handError(`对方没有正常回应（${res ? res.status : '无响应'}）`)
      const declared = Number(res.headers?.get?.('content-length') || 0)
      if (declared && declared > maxBytes) throw handError('内容太大了，今天先不读')
      const buf = Buffer.from(await res.arrayBuffer())
      if (buf.byteLength > maxBytes) throw handError('内容太大了，今天先不读')
      return buf.toString('utf8')
    } catch (err) {
      if (err && err.name === 'AbortError') throw handError('等太久了，没有读成')
      if (err && err.code === 'HAND') throw err
      throw handError(`没连上：${err?.cause?.code || err?.message || '网络错误'}`)
    } finally {
      clearTimeout(timer)
    }
  }

  function bookRel(row) {
    const rel = path.relative(root, row.path).replace(/\\/g, '/')
    if (!rel || rel.startsWith('..')) throw handError('书的位置不对')
    return rel
  }

  // 合并进来的书，路径可能还是来源机器的绝对路径。先按 basename 在家里找；
  // 找不到就删掉这条进度，允许重新下载，而不是让一本读不了的书占着 CATALOG 名额。
  function repairBookPath(row) {
    if (!row) return null
    if (fs.existsSync(row.path)) return row
    const name = path.basename(String(row.path || ''))
    const alt = name ? path.join(root, cfg.bookDir, name) : ''
    if (alt && fs.existsSync(alt)) {
      store.setBookPath(row.id, alt, now())
      return { ...row, path: alt }
    }
    store.deleteBook(row.id)
    return null
  }

  async function ensureBook() {
    const state = repairBookPath(store.bookState())
    if (state && state.total > 0) return state
    const used = new Set()
    for (const b of CATALOG) {
      if (repairBookPath(store.bookByUrl(b.url))) used.add(b.url)
    }
    const pick = CATALOG.find((b) => !used.has(b.url))
    // 书单读完了就如实说读完了，不从头再下一本冒充新的。
    if (!pick) return null
    const raw = await fetchLimited(pick.url, { domains: cfg.bookDomains })
    const text = stripGutenberg(raw)
    if (text.length < 200) throw handError('这本书没读到正文')
    const dir = path.join(root, cfg.bookDir)
    fs.mkdirSync(dir, { recursive: true })
    const stamp = new Date(now()).toISOString().replace(/[:.]/g, '-')
    const file = path.join(dir, `${stamp}-${slugify(pick.title)}.txt`)
    fs.writeFileSync(file, text, 'utf8')
    const total = text.length
    const id = store.addBook({ title: pick.title, url: pick.url, path: file, total, now: now() })
    return { id, title: pick.title, url: pick.url, path: file, offset: 0, total }
  }

  function takeChunk(row) {
    if (!row) return { chunk: '', offset: 0, total: 0, ref: '' }
    const text = fs.readFileSync(row.path, 'utf8')
    const total = text.length
    if (row.offset >= total) return { chunk: '', offset: total, total, ref: `file:${bookRel(row)}#${total}` }
    let end = Math.min(total, row.offset + Math.max(200, Number(cfg.bookChunkChars) || 1800))
    // 尽量在段落处停下，别把一句话劈成两半。
    if (end < total) {
      const para = text.indexOf('\n\n', end - 200)
      if (para > row.offset && para < end + 400) end = para
      else {
        const nl = text.indexOf('\n', end - 80)
        if (nl > row.offset && nl < end + 200) end = nl
      }
    }
    const chunk = text.slice(row.offset, end).trim()
    const next = end
    const rel = bookRel(row)
    return { chunk, offset: next, total, ref: `file:${rel}#${row.offset}` }
  }

  function advance(row, next) {
    if (Number.isFinite(row.id) && row.id > 0) store.setBookProgress(row.id, next, row.total, now())
  }

  async function bookNext() {
    limitReached('book_next', Number(cfg.bookPerDay) || 4, now(), '读书')
    let row = await ensureBook()
    if (!row) throw handError('书架上的书都读完了')
    let info = takeChunk(row)
    if (!info.chunk) {
      // 这本读完了，换下一本。
      store.setBookProgress(row.id, row.total, row.total, now())
      row = await ensureBook()
      if (!row) throw handError('书架上的书都读完了')
      info = takeChunk(row)
    }
    if (!info.chunk) throw handError('今天没有可读的书')
    advance({ ...row, total: info.total }, info.offset)
    return {
      book: row.title,
      chunk: info.chunk,
      ref: info.ref,
      remaining: Math.max(0, info.total - info.offset),
      url: row.url,
    }
  }

  /** 安静时只读本地已经下好的书，不发网络请求。 */
  function peekBook() {
    const row = repairBookPath(store.bookState())
    if (!row || !fs.existsSync(row.path)) return null
    const info = takeChunk(row)
    if (!info.chunk) return null
    advance({ ...row, total: info.total }, info.offset)
    return { book: row.title, chunk: info.chunk, ref: info.ref, remaining: Math.max(0, info.total - info.offset) }
  }

  function listRoom({ dir = 'diary' } = {}) {
    const dirs = allowedDirs('listDirs')
    const clean = cleanRel(dir || 'diary')
    if (!dirs.has(clean.split('/')[0])) throw handError(`这个目录不在允许范围里：${clean.split('/')[0]}`)
    const { abs, rel } = safePath(clean, dirs)
    if (!fs.existsSync(abs)) return { dir: rel, entries: [] }
    const real = fs.realpathSync(abs)
    const back = path.relative(realRoot, real)
    if (!back || back.startsWith('..') || path.isAbsolute(back)) throw handError('这个目录指向了外面')
    const st = fs.statSync(real)
    if (!st.isDirectory()) throw handError('这不是一个目录')
    const entries = fs.readdirSync(real, { withFileTypes: true })
      .filter((e) => e.isFile() && !e.isSymbolicLink() && TEXT_EXT.has(path.extname(e.name).toLowerCase()))
      .slice(0, 100)
      .map((e) => {
        const info = fs.statSync(path.join(real, e.name))
        return { name: e.name, size: Math.trunc(Number(info.size) || 0), when: Math.trunc(Number(info.mtimeMs) || 0), kind: path.extname(e.name).slice(1) }
      })
      .sort((a, b) => b.when - a.when)
    return { dir: rel, entries }
  }

  function readRoom({ path: rel, offset = 0 } = {}) {
    const { abs, rel: clean, stat } = existingFile(rel, allowedDirs('readDirs'))
    const text = fs.readFileSync(abs, 'utf8')
    const start = Math.max(0, Math.min(text.length, Math.trunc(Number(offset) || 0)))
    const limit = 4000
    const part = text.slice(start, start + limit)
    return {
      ref: `file:${clean}${start ? `#${start}` : ''}`,
      path: clean,
      text: part,
      truncated: start + part.length < text.length,
      size: Number(stat.size),
    }
  }

  function dreamNoteExists(date) {
    const d = String(date || '').trim()
    if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) return false
    return fs.existsSync(path.join(root, cfg.noteDir, `${d}-dream.md`))
  }

  function writeNote({ title, body, dreamDate } = {}) {
    limitReached('note_write', Number(cfg.notesPerDay) || 3, now(), '写便签')
    const at = now()
    const t = String(title || '').trim()
    const b = String(body || '').trim()
    if (!t) throw handError('便签得有个标题')
    if (!b) throw handError('便签是空的')
    if (t.length > 80) throw handError('标题太长了')
    if (b.length > (Number(cfg.noteMaxChars) || 2000)) throw handError('便签太长了')
    const dir = path.join(root, cfg.noteDir)
    fs.mkdirSync(dir, { recursive: true })
    const d = String(dreamDate || '').trim()
    let file
    let about = ''
    if (d) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) throw handError('梦的日期得写成 YYYY-MM-DD')
      const today = dateKey(at)
      const yesterday = dateKey(addDays(startOfDay(at), -1))
      if (d !== today && d !== yesterday) throw handError('便签只能记今天或昨晚的梦')
      if (!store.dreamForDate(d)) throw handError('那天没有梦，记不了')
      file = path.join(dir, `${d}-dream.md`)
      if (fs.existsSync(file)) throw handError('这个梦已经记过了')
      about = `> 关于 ${d} 的梦（梦不是真事）

`
    } else {
      const base = `${dateKey(at)}-${slugify(t)}`
      file = path.join(dir, `${base}.md`)
      let n = 1
      while (fs.existsSync(file)) {
        n += 1
        file = path.join(dir, `${base}-${n}.md`)
      }
    }
    const text = `# ${t}

${about}${b}
`
    fs.writeFileSync(file, text, 'utf8')
    const rel = path.relative(root, file).replace(/\\/g, '/')
    return { ref: `file:${rel}`, path: rel, chars: text.length }
  }

  async function lookup({ term } = {}) {
    limitReached('lookup', Number(cfg.lookupPerDay) || 3, now(), '查东西')
    const q = String(term || '').trim()
    if (!q) throw handError('要查什么？')
    if (q.length > 60) throw handError('这个词太长了')
    const url = `https://zh.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(q)}`
    const raw = await fetchLimited(url, { domains: cfg.lookupDomains, maxBytes: 512 * 1024 })
    let data
    try {
      data = JSON.parse(raw)
    } catch {
      throw handError('查到的内容不是能读的格式')
    }
    const extract = trimText(String(data.extract || data.description || '').replace(/\s+/g, ' ').trim(), Number(cfg.lookupMaxChars) || 1200)
    if (!extract) throw handError('没有查到这一条')
    return { title: String(data.title || q), extract, ref: `web:${url}` }
  }

  function plainText(html = '') {
    return String(html)
      .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&amp;/g, '&')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/\s+/g, ' ')
      .trim()
  }

  async function webSearch({ query } = {}) {
    limitReached('web_search', Number(cfg.webSearchPerDay) || 5, now(), '上网查')
    const q = String(query || '').trim()
    if (!q) throw handError('要查什么？')
    if (q.length > 100) throw handError('这个问题太长了')
    const url = `https://www.bing.com/search?format=rss&q=${encodeURIComponent(q)}`
    const raw = await fetchLimited(url, { domains: cfg.webSearchDomains, maxBytes: 640 * 1024 })
    const xml = String(raw)
    const results = []
    for (const match of xml.matchAll(/<item>([\s\S]*?)<\/item>/g)) {
      if (results.length >= (Number(cfg.webSearchMaxResults) || 5)) break
      const block = match[1]
      const title = plainText((block.match(/<title>([\s\S]*?)<\/title>/) || [])[1] || '')
      const link = plainText((block.match(/<link>([\s\S]*?)<\/link>/) || [])[1] || '')
      const desc = plainText((block.match(/<description>([\s\S]*?)<\/description>/) || [])[1] || '')
      if (title && link) results.push({ title, url: link, summary: trimText(desc, 300) })
    }
    if (!results.length) throw handError('没有搜到能读的结果')
    return { query: q, results, ref: `web:${url}` }
  }

  async function pluginSearch({ query } = {}) {
    limitReached('plugin_search', Number(cfg.pluginSearchPerDay) || 5, now(), '找插件')
    const q = String(query || '').trim()
    if (!q) throw handError('想找什么插件？')
    if (q.length > 60) throw handError('这个问题太长了')
    // 只加 topic 会搜到大量给仓库乱打 dsh-plugin 标签的大项目；再加 dsh 一词收窄。
    const search = `${q} dsh topic:dsh-plugin`
    const url = `https://api.github.com/search/repositories?q=${encodeURIComponent(search)}&sort=stars&order=desc&per_page=${Number(cfg.pluginSearchMaxResults) || 5}`
    const raw = await fetchLimited(url, { domains: cfg.pluginSearchDomains, maxBytes: 512 * 1024 })
    let data
    try {
      data = JSON.parse(raw)
    } catch {
      throw handError('插件目录返回的不是能读的格式')
    }
    const results = (Array.isArray(data.items) ? data.items : []).slice(0, Number(cfg.pluginSearchMaxResults) || 5).map((item) => ({
      name: String(item.full_name || item.name || ''),
      description: trimText(String(item.description || '').replace(/\s+/g, ' ').trim(), 240),
      url: String(item.html_url || ''),
      stars: Number(item.stargazers_count) || 0,
      updated: String(item.updated_at || '').slice(0, 10),
    }))
    if (!results.length) throw handError('没有找到对应的 DSH 插件')
    return { query: q, results, ref: `web:${url}`, note: '只是资料，不是安装命令；装不装由他决定。' }
  }

  async function notify({ text } = {}) {
    limitReached('notify', Number(cfg.notifyPerDay) || 1, now(), '弹通知')
    const t = String(text || '').trim()
    if (!t) throw handError('通知是空的')
    if (t.length > 120) throw handError('通知太长了')
    const res = await notifier(t, agentName)
    if (!res || !res.ok) throw handError(`通知没有弹出来：${res?.error || '未知原因'}`)
    return { ok: true, channel: 'windows-toast' }
  }

  /**
   * 安静时段的一件真事：先读一段书，没书可读就翻昨天的日记。
   * 只有本地文件，不发网络请求；返回写入的 action 或 null。
   */
  function quietAction(ts = now()) {
    const at = Number(ts)
    const bucket = Math.floor(at / (3 * 3600 * 1000))
    const bookCallId = `quiet_book:${bucket}`
    // 同一 3 小时桶只读一次：addAction 带 UNIQUE(call_id)，之前先读后写会被静默吞掉，
    // 但 peekBook 已经把 offset 推走了，等于白读还记账失败。
    if (!store.actionByCallId(bookCallId) && dailyCount('book_next', at) < (Number(cfg.bookPerDay) || 4)) {
      const read = peekBook()
      if (read) {
        const inserted = store.addAction({
          ts: at, kind: 'life', tool: 'book_next',
          summary: `读了《${read.book}》一段（${read.chunk.length} 字）`,
          callId: bookCallId, status: 'ok', meta: { ref: read.ref },
        })
        if (inserted) return { tool: 'book_next', read }
      }
    }
    const readCount = store.countActionsSince('room_read', at - 6 * 3600 * 1000)
    if (readCount === 0) {
      const yesterday = dateKey(addDays(startOfDay(at), -1))
      const rel = `diary/${yesterday}.md`
      try {
        const page = readRoom({ path: rel, offset: 0 })
        if (page.text.trim()) {
          store.addAction({
            ts: at, kind: 'life', tool: 'room_read',
            summary: `翻了翻 ${yesterday} 的日记`,
            callId: `quiet_diary:${yesterday}`, status: 'ok', meta: { ref: page.ref },
          })
          return { tool: 'room_read', page }
        }
      } catch { /* 没有昨天的日记就跳过 */ }
    }
    return null
  }

  async function warm() {
    try {
      await ensureBook()
      return true
    } catch {
      return false
    }
  }

  return {
    root, config: cfg, listRoom, readRoom, writeNote, dreamNoteExists,
    bookNext, ensureBook, peekBook, lookup, webSearch, pluginSearch,
    notify, quietAction, warm,
  }
}
