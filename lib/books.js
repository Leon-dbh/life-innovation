/**
 * 书源与电子书解析。
 *
 * 只做两件事：
 * - 把 Project Gutenberg 的 OPDS 搜索结果读成「书名 / 作者 / 编号」；
 * - 把本地 EPUB 或 TXT 拆成纯文本，交给 hands.js 存进 books/。
 *
 * 不下载、不联网、不碰数据库；网络边界仍在 hands.js 的 fetchLimited 里。
 * EPUB 只用 Node 自带的 zlib 读 ZIP，不引第三方依赖；PDF、DRM、加密正文都不支持。
 */
import path from 'node:path'
import zlib from 'node:zlib'

const MAX_ZIP_ENTRIES = 2000
const MAX_UNCOMPRESSED = 32 * 1024 * 1024

function bookError(message) {
  const err = new Error(message)
  err.code = 'BOOK'
  return err
}

function namedEntity(name) {
  return {
    amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
    mdash: '—', ndash: '–', hellip: '…',
    lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”',
  }[String(name).toLowerCase()]
}

export function decodeEntities(text = '') {
  return String(text).replace(/&(#x?[0-9a-f]+|[a-z][a-z0-9]+);/gi, (all, body) => {
    if (body[0] === '#') {
      const hex = body[1] && body[1].toLowerCase() === 'x'
      const value = Number.parseInt(body.slice(hex ? 2 : 1), hex ? 16 : 10)
      if (!Number.isFinite(value) || value < 1 || value > 0x10ffff) return all
      try { return String.fromCodePoint(value) } catch { return all }
    }
    return namedEntity(body) ?? all
  })
}

/** 把 XHTML/HTML 正文压成可读纯文本；只用于本地导入，不负责抓网页。 */
export function htmlToText(html = '') {
  let s = String(html).replace(/\r\n?/g, '\n')
  s = s.replace(/<!--[\s\S]*?-->/g, '')
  s = s.replace(/<(script|style|noscript|head)\b[^>]*>[\s\S]*?<\/\1>/gi, '')
  s = s.replace(/<br\s*\/?>/gi, '\n')
  s = s.replace(/<\/(p|div|section|article|li|tr|h[1-6]|blockquote|pre)>/gi, '\n')
  s = s.replace(/<li\b[^>]*>/gi, '- ')
  s = s.replace(/<[^>]+>/g, '')
  s = decodeEntities(s)
  s = s.replace(/[ \t\f\v]+/g, ' ')
  s = s.replace(/ *\n */g, '\n')
  s = s.replace(/\n{3,}/g, '\n\n')
  return s.trim()
}

function xmlText(xml, tag) {
  const m = String(xml).match(new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i'))
  return m ? decodeEntities(m[1]).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim() : ''
}

/** 解析 Project Gutenberg 搜索 OPDS；只收有数字 id 的书，跳过作者/主题导航。 */
export function parseOpdsSearch(xml = '', { limit = 8 } = {}) {
  const max = Math.max(1, Math.min(10, Number(limit) || 8))
  const out = []
  const seen = new Set()
  for (const match of String(xml).matchAll(/<entry\b[^>]*>([\s\S]*?)<\/entry>/gi)) {
    const body = match[1]
    const idMatch = body.match(/<id>\s*https?:\/\/www\.gutenberg\.org\/ebooks\/(\d+)\.opds\s*<\/id>/i)
    if (!idMatch) continue
    const id = Number(idMatch[1])
    if (!Number.isInteger(id) || id <= 0 || seen.has(id)) continue
    const title = xmlText(body, 'title')
    if (!title) continue
    seen.add(id)
    const author = xmlText(body, 'content') || '未知作者'
    out.push({
      id,
      title,
      author,
      url: `https://www.gutenberg.org/ebooks/${id}`,
    })
    if (out.length >= max) break
  }
  return out
}

/** 解析单本书的 OPDS，拿到「书名 by 作者」；拿不到就返回空标题。 */
export function parseOpdsBook(xml = '') {
  const raw = xmlText(xml, 'title')
  if (!raw) return { title: '', author: '' }
  const at = raw.lastIndexOf(' by ')
  if (at > 0) {
    return { title: raw.slice(0, at).trim(), author: raw.slice(at + 4).trim() }
  }
  return { title: raw, author: '' }
}

export function gutenbergTextUrl(id) {
  const n = Number(id)
  if (!Number.isInteger(n) || n <= 0 || n > 1000000) throw bookError('书的编号不对')
  return `https://www.gutenberg.org/cache/epub/${n}/pg${n}.txt`
}

function findEocd(buf) {
  const floor = Math.max(0, buf.length - 65557)
  for (let i = buf.length - 22; i >= floor; i -= 1) {
    if (buf.readUInt32LE(i) === 0x06054b50) return i
  }
  throw bookError('这个 EPUB 的 ZIP 目录找不到')
}

/** 极简 ZIP 读取器：只支持 store/deflate，够读 EPUB；不写文件、不解压到磁盘。 */
export function readZip(buffer, { maxEntries = MAX_ZIP_ENTRIES, maxUncompressed = MAX_UNCOMPRESSED } = {}) {
  const buf = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer)
  if (!buf.length) throw bookError('这个 EPUB 是空的')
  const eocd = findEocd(buf)
  const count = buf.readUInt16LE(eocd + 10)
  const cdOffset = buf.readUInt32LE(eocd + 16)
  if (count > maxEntries) throw bookError('这个 EPUB 里的文件太多了')
  const entries = new Map()
  let p = cdOffset
  let total = 0
  for (let i = 0; i < count; i += 1) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== 0x02014b50) throw bookError('这个 EPUB 的 ZIP 目录坏了')
    const method = buf.readUInt16LE(p + 10)
    const compSize = buf.readUInt32LE(p + 20)
    const uncompSize = buf.readUInt32LE(p + 24)
    const nameLen = buf.readUInt16LE(p + 28)
    const extraLen = buf.readUInt16LE(p + 30)
    const commentLen = buf.readUInt16LE(p + 32)
    const localOffset = buf.readUInt32LE(p + 42)
    if (compSize === 0xffffffff || uncompSize === 0xffffffff || localOffset === 0xffffffff) {
      throw bookError('暂不支持 ZIP64 的 EPUB')
    }
    if (p + 46 + nameLen + extraLen + commentLen > buf.length) throw bookError('这个 EPUB 的 ZIP 目录坏了')
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen).replace(/^\.\//, '')
    if (localOffset + 30 > buf.length || buf.readUInt32LE(localOffset) !== 0x04034b50) {
      throw bookError('这个 EPUB 的 ZIP 文件头坏了')
    }
    const localNameLen = buf.readUInt16LE(localOffset + 26)
    const localExtraLen = buf.readUInt16LE(localOffset + 28)
    const dataStart = localOffset + 30 + localNameLen + localExtraLen
    if (dataStart + compSize > buf.length) throw bookError('这个 EPUB 的文件被截断了')
    const compressed = buf.subarray(dataStart, dataStart + compSize)
    let data
    if (method === 0) {
      data = compressed
    } else if (method === 8) {
      try {
        const limit = Math.max(1, Math.min(uncompSize || maxUncompressed, maxUncompressed))
        data = zlib.inflateRawSync(compressed, { maxOutputLength: limit })
      } catch {
        throw bookError('这个 EPUB 里有解不开的压缩内容')
      }
    } else {
      throw bookError(`这个 EPUB 用了不支持的压缩方式（${method}）`)
    }
    total += data.length
    if (total > maxUncompressed) throw bookError('这本书解压后太大了')
    entries.set(name, data)
    p += 46 + nameLen + extraLen + commentLen
  }
  return entries
}

function xmlAttr(tag, name) {
  const m = String(tag).match(new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, 'i'))
  return m ? decodeEntities(m[1] ?? m[2] ?? '').trim() : ''
}

function resolveZipPath(base, href) {
  let clean = String(href || '').split('#')[0]
  try { clean = decodeURIComponent(clean) } catch { /* 保持原样 */ }
  const joined = path.posix.normalize(path.posix.join(path.posix.dirname(base), clean))
  if (joined.startsWith('../') || joined.startsWith('/')) throw bookError('这本 EPUB 的章节路径越界了')
  return joined
}

function chapterText(entries, name) {
  const raw = entries.get(name)
  if (!raw) return ''
  const html = raw.toString('utf8')
  const body = html.match(/<body\b[^>]*>([\s\S]*?)<\/body>/i)
  return htmlToText(body ? body[1] : html)
}

function encryptedChapters(entries, docs) {
  const enc = entries.get('META-INF/encryption.xml')
  if (!enc) return false
  const xml = enc.toString('utf8')
  const uris = [...xml.matchAll(/<CipherReference\b[^>]*URI\s*=\s*(?:"([^"]+)"|'([^']+)')/gi)]
    .map((m) => m[1] ?? m[2])
  if (!uris.length) return false
  return docs.some((doc) => uris.some((uri) => {
    try { return resolveZipPath(doc, uri) === doc } catch { return false }
  }))
}

/** 解析 EPUB 的 container.xml → OPF → spine，返回纯文本与元数据。 */
export function parseEpub(buffer, { maxChars = 8_000_000 } = {}) {
  const entries = readZip(buffer)
  const container = entries.get('META-INF/container.xml')
  if (!container) throw bookError('这个 EPUB 缺少 META-INF/container.xml')
  const rootfile = container.toString('utf8').match(/<rootfile\b[^>]*>/i)
  const opfPath = rootfile ? xmlAttr(rootfile[0], 'full-path') : ''
  if (!opfPath || !entries.has(opfPath)) throw bookError('这个 EPUB 找不到 OPF 目录')
  const opf = entries.get(opfPath).toString('utf8')
  const title = xmlText(opf, 'dc:title') || '未命名'
  const author = xmlText(opf, 'dc:creator') || '未知作者'

  const manifest = new Map()
  for (const tag of opf.match(/<item\b[^>]*>/gi) || []) {
    const id = xmlAttr(tag, 'id')
    const href = xmlAttr(tag, 'href')
    if (!id || !href) continue
    manifest.set(id, {
      href,
      type: xmlAttr(tag, 'media-type').toLowerCase(),
    })
  }
  const docs = []
  for (const tag of opf.match(/<itemref\b[^>]*>/gi) || []) {
    const idref = xmlAttr(tag, 'idref')
    const item = manifest.get(idref)
    if (!item) continue
    const name = resolveZipPath(opfPath, item.href)
    if (!entries.has(name)) continue
    if (!/xhtml|html/.test(item.type) && !/\.x?html?$/i.test(name)) continue
    if (!docs.includes(name)) docs.push(name)
  }
  if (!docs.length) {
    for (const item of manifest.values()) {
      if (!/xhtml|html/.test(item.type) && !/\.x?html?$/i.test(item.href)) continue
      const name = resolveZipPath(opfPath, item.href)
      if (entries.has(name) && !docs.includes(name)) docs.push(name)
    }
    docs.sort()
  }
  if (!docs.length) throw bookError('这个 EPUB 没有可读的章节')
  if (encryptedChapters(entries, docs)) throw bookError('这本书的正文有 DRM/加密，读不了')

  const chapters = docs.map((name) => chapterText(entries, name)).filter(Boolean)
  if (!chapters.length) throw bookError('这个 EPUB 的章节是空的')
  let text = chapters.join('\n\n')
  if (text.length < 200) throw bookError('这本书的正文太短了，可能不是一本完整的书')
  if (text.length > maxChars) text = text.slice(0, maxChars)
  return { title, author, text }
}

/** 本地 TXT：识别 UTF-8 BOM 与 UTF-16 LE/BE，避免中文 txt 变乱码。 */
export function decodeTextBuffer(buffer) {
  const buf = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer)
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) return buf.toString('utf8', 3)
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) return buf.toString('utf16le', 2)
  if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) {
    const copy = Buffer.from(buf.subarray(2))
    for (let i = 0; i + 1 < copy.length; i += 2) {
      const t = copy[i]
      copy[i] = copy[i + 1]
      copy[i + 1] = t
    }
    return copy.toString('utf16le')
  }
  return buf.toString('utf8')
}
