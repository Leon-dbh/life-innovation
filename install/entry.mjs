#!/usr/bin/env node
/**
 * 鲸鲸的固定入口：http://127.0.0.1:60080/
 *
 * 为什么需要它：dsh web 每次启动都会生成一个新的进程 token，带 token 的入口
 * 每次都不一样。这里只做一件事——把固定入口 302 到当前那次启动的入口，
 * 这样桌面书签不用跟着换。token 仍然由 dsh 自己校验，代理不碰任何会话内容。
 *
 * 环境变量：
 *   JINGJING_ENTRY_PORT  固定入口端口（默认 60080）
 *   JINGJING_URL_FILE    守护进程写下的当前入口文件（默认 <home>\state\web-url.txt）
 */
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { renderHome, renderHomeError, homeFilePath } from './home.mjs'

const port = Number(process.env.JINGJING_ENTRY_PORT || 60080)
const urlFile = process.env.JINGJING_URL_FILE
  || path.join(process.env.JINGJING_HOME || 'D:/jingjing-home', 'state', 'web-url.txt')
// 家的位置优先看环境变量，其次从 state/web-url.txt 的上一级反推，
// 这样即使 DataHome 不是默认目录，/home 也能找到同一套数据。
const dataHome = process.env.JINGJING_HOME || path.dirname(path.dirname(urlFile))

function currentUrl() {
  try {
    // 守护进程用 Set-Content 写，可能带 CR/LF；多行或夹换行会让 location
    // 头触发 ERR_INVALID_CHAR，把整个代理打崩。先剥掉所有换行再校验协议。
    const text = fs.readFileSync(urlFile, 'utf8').replace(/[\r\n]+/g, '').trim()
    if (!/^https?:\/\//.test(text)) return ''
    try {
      const parsed = new URL(text)
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return ''
      return parsed.href
    } catch {
      return ''
    }
  } catch {
    return ''
  }
}

const server = http.createServer((req, res) => {
  const method = req.method || 'GET'
  if (method !== 'GET' && method !== 'HEAD') {
    res.writeHead(405, { 'content-type': 'text/plain; charset=utf-8' })
    res.end('只接受 GET')
    return
  }
  const pathname = new URL(req.url || '/', 'http://127.0.0.1').pathname

  if (pathname === '/health') {
    const url = currentUrl()
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
    res.end(JSON.stringify({ ok: true, ready: Boolean(url), exists: fs.existsSync(urlFile) }))
    return
  }

  if (pathname === '/home' || pathname === '/home/') {
    try {
      const html = renderHome({
        home: dataHome,
        dbPath: homeFilePath(dataHome),
        now: Date.now(),
        chatUrl: currentUrl(),
      })
      res.writeHead(200, {
        'content-type': 'text/html; charset=utf-8',
        'cache-control': 'no-store',
        'referrer-policy': 'no-referrer',
        'x-content-type-options': 'nosniff',
      })
      res.end(html)
    } catch (error) {
      res.writeHead(503, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
      res.end(renderHomeError(error && error.message ? error.message : String(error)))
    }
    return
  }

  if (pathname === '/' || pathname === '/index.html') {
    const url = currentUrl()
    if (!url) {
      res.writeHead(503, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' })
      res.end('鲸鲸还没开灯：她这会儿没在运行。\n等守护进程把她拉起来，再刷新一下。\n')
      return
    }
    res.writeHead(302, { location: url, 'cache-control': 'no-store' })
    res.end()
    return
  }

  res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
  res.end('没有这个页面。回 / 是她的房间，/home 是她的家。\n')
})

server.on('error', (error) => {
  console.error(`固定入口监听失败：${error.message}`)
  process.exit(1)
})

server.listen(port, '127.0.0.1', () => {
  console.log(`jingjing entry: http://127.0.0.1:${port}/ -> ${urlFile}`)
})

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => server.close(() => process.exit(0)))
}
