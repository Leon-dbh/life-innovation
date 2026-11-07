import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import zlib from 'node:zlib'
import { MemoryStore } from '../lib/store.js'
import { createHands } from '../lib/hands.js'

const OPDS_SEARCH = `<?xml version="1.0"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title>Books: 双城</title>
  <entry>
    <id>https://www.gutenberg.org/ebooks/authors/search.opds/?query=双城</id>
    <title>Authors</title>
    <content type="text">作者导航</content>
  </entry>
  <entry>
    <id>https://www.gutenberg.org/ebooks/98.opds</id>
    <title>A Tale of Two Cities</title>
    <content type="text">Charles Dickens</content>
    <link rel="subsection" href="/ebooks/98.opds"/>
  </entry>
</feed>`

const OPDS_BOOK = `<?xml version="1.0"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title>A Tale of Two Cities by Charles Dickens</title>
</feed>`

const BOOK_TEXT = `*** START OF THE PROJECT GUTENBERG EBOOK A TALE OF TWO CITIES ***

第一章 风

${'风从窗缝里进来，桌上的纸翻了一页。'.repeat(120)}

*** END OF THE PROJECT GUTENBERG EBOOK A TALE OF TWO CITIES ***`

const fetched = []
const fakeFetch = async (url) => {
  fetched.push(url)
  let text
  if (url.includes('search.opds')) text = OPDS_SEARCH
  else if (url.includes('/ebooks/98.opds')) text = OPDS_BOOK
  else if (url.includes('/cache/epub/98/')) text = BOOK_TEXT
  else throw new Error(`unexpected url ${url}`)
  return { ok: true, status: 200, url, arrayBuffer: async () => Buffer.from(text) }
}

const crcTable = (() => {
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n += 1) {
    let c = n
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c >>> 0
  }
  return table
})()

function crc32(buf) {
  let c = 0xffffffff
  for (const byte of buf) c = crcTable[(c ^ byte) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

/** 测试用最小 ZIP：只写 store/deflate 两种条目，够验证 EPUB 读取器。 */
function makeZip(entries) {
  const locals = []
  const centrals = []
  let offset = 0
  for (const entry of entries) {
    const raw = Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(entry.data, 'utf8')
    const method = entry.compress ? 8 : 0
    const body = entry.compress ? zlib.deflateRawSync(raw) : raw
    const name = Buffer.from(entry.name, 'utf8')
    const crc = crc32(raw)
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(0x0800, 6)
    local.writeUInt16LE(method, 8)
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(body.length, 18)
    local.writeUInt32LE(raw.length, 22)
    local.writeUInt16LE(name.length, 26)
    local.writeUInt16LE(0, 28)
    const localPart = Buffer.concat([local, name, body])
    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE(20, 4)
    central.writeUInt16LE(20, 6)
    central.writeUInt16LE(0x0800, 8)
    central.writeUInt16LE(method, 10)
    central.writeUInt32LE(crc, 16)
    central.writeUInt32LE(body.length, 20)
    central.writeUInt32LE(raw.length, 24)
    central.writeUInt16LE(name.length, 28)
    central.writeUInt32LE(offset, 42)
    centrals.push(Buffer.concat([central, name]))
    locals.push(localPart)
    offset += localPart.length
  }
  const cd = Buffer.concat(centrals)
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0)
  eocd.writeUInt16LE(entries.length, 8)
  eocd.writeUInt16LE(entries.length, 10)
  eocd.writeUInt32LE(cd.length, 12)
  eocd.writeUInt32LE(offset, 16)
  return Buffer.concat([...locals, cd, eocd])
}

function epubFixture() {
  const container = `<?xml version="1.0"?>
<container xmlns="urn:oasis:names:tc:opendocument:xmlns:container" version="1.0">
  <rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles>
</container>`
  const opf = `<?xml version="1.0"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:title>夜航</dc:title>
    <dc:creator>圣埃克苏佩里</dc:creator>
  </metadata>
  <manifest><item id="ch1" href="ch1.xhtml" media-type="application/xhtml+xml"/></manifest>
  <spine><itemref idref="ch1"/></spine>
</package>`
  const chapter = `<html><body><h1>第一章</h1><p>${'风从海上来。'.repeat(60)}</p></body></html>`
  return makeZip([
    { name: 'mimetype', data: 'application/epub+zip' },
    { name: 'META-INF/container.xml', data: container },
    { name: 'OEBPS/content.opf', data: opf },
    { name: 'OEBPS/ch1.xhtml', data: chapter, compress: true },
  ])
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jingjing-books-'))
for (const sub of ['books', 'books/import']) fs.mkdirSync(path.join(dir, sub), { recursive: true })
const store = new MemoryStore(path.join(dir, 'books.sqlite'))
const hands = createHands({
  home: dir,
  store,
  fetchImpl: fakeFetch,
  dnsLookup: async () => [{ address: '93.184.216.34', family: 4 }],
})

try {
  const found = await hands.bookSearch({ query: '双城', limit: 5 })
  assert.equal(found.results.length, 1)
  assert.equal(found.results[0].id, 98)
  assert.equal(found.results[0].title, 'A Tale of Two Cities')
  assert.equal(found.results[0].author, 'Charles Dickens')
 assert.match(found.ref, /search\.opds/)
  assert.match(found.note, /资料/)

  const opened = await hands.bookOpen({ id: 98 })
  assert.equal(opened.book, 'A Tale of Two Cities')
  assert.equal(opened.author, 'Charles Dickens')
  assert.equal(opened.source, 'Project Gutenberg')
  assert.ok(opened.total > 200)
  assert.equal(opened.already, false)
  assert.ok(fs.existsSync(path.join(dir, opened.ref.slice(5).split('#')[0])))
  assert.equal(store.bookByUrl('https://www.gutenberg.org/cache/epub/98/pg98.txt').title, 'A Tale of Two Cities')

  const again = await hands.bookOpen({ id: 98 })
  assert.equal(again.already, true)
  assert.equal(again.total, opened.total)

  const read = await hands.bookNext()
  assert.equal(read.book, 'A Tale of Two Cities')
  assert.match(read.chunk, /风从窗缝/)

  fs.writeFileSync(path.join(dir, 'books', 'import', '夜航.txt'), '夜航。'.repeat(100), 'utf8')
  const txt = await hands.bookImport({ file: '夜航.txt' })
  assert.equal(txt.book, '夜航')
  assert.equal(txt.source, '本地文件')
  assert.equal(txt.already, false)
  assert.ok(fs.existsSync(path.join(dir, 'books', 'import', '夜航.txt')))
  assert.equal(store.bookByUrl('local:夜航.txt').title, '夜航')

  fs.writeFileSync(path.join(dir, 'books', 'import', '夜航.epub'), epubFixture())
  const epub = await hands.bookImport({ file: '夜航.epub' })
  assert.equal(epub.book, '夜航')
  assert.equal(epub.author, '圣埃克苏佩里')
  assert.match(epub.ref, /^file:books\/.*\.txt#0$/)
  assert.equal(store.bookByUrl('local:夜航.epub').title, '夜航')

  await assert.rejects(() => hands.bookImport({ file: '../secret.txt' }), /路径|只能|找不到/)
  await assert.rejects(() => hands.bookImport({ file: '书.pdf' }), /EPUB 或 TXT/)
  await assert.rejects(() => hands.bookSearch({ query: '' }), /想找什么书/)
  await assert.rejects(() => hands.bookOpen({ id: 0 }), /编号不对/)
  await assert.rejects(() => hands.bookImport({ file: '坏.epub' }), /找不到/)

  console.log('OK: 公版书搜索/打开、TXT/EPUB 导入、书架进度')
} finally {
  store.close()
  fs.rmSync(dir, { recursive: true, force: true })
}
