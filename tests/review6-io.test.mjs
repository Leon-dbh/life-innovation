/**
 * 0.6.2 复审 review6：I/O 边界回归。
 *
 * 覆盖：
 * - 固定入口的 Host 校验（DNS rebinding）与 /home 不泄露 token；
 * - Windows 通知脚本 SCRIPT(message, title) 不再引用未定义 title；
 * - paths 的空壳新库不挡住有数据的旧库，且 exists/usable 可注入；
 * - home 渲染的「回她的房间」固定为 /；
 * - package/doctor/install 的版本与 node:sqlite 静态契约。
 */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import http from 'node:http'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { renderHome } from '../install/home.mjs'
import { SCRIPT } from '../lib/notify.js'
import { resolvePaths } from '../lib/paths.js'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const TOKEN = 'review6-secret-token-7f3a'

function tempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix))
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port
      server.close(() => resolve(port))
    })
  })
}

function request(port, pathname, host) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port, path: pathname, method: 'GET', headers: { host } },
      (res) => {
        let body = ''
        res.setEncoding('utf8')
        res.on('data', (chunk) => { body += chunk })
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }))
      },
    )
    req.on('error', reject)
    req.end()
  })
}

async function waitForHealth(port) {
  let lastError
  for (let i = 0; i < 60; i += 1) {
    try {
      const res = await request(port, '/health', `127.0.0.1:${port}`)
      if (res.status === 200) return
    } catch (error) {
      lastError = error
    }
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error(`entry did not become healthy: ${lastError ? lastError.message : 'timeout'}`)
}

// P1-3：Host 只认 127.0.0.1 / localhost（端口可选）；/home 里不能出现 token。
{
  const dir = tempDir('jingjing-review6-entry-')
  const state = path.join(dir, 'state')
  fs.mkdirSync(state, { recursive: true })
  const urlFile = path.join(state, 'web-url.txt')
  const backend = `http://127.0.0.1:59999/?token=${TOKEN}`
  fs.writeFileSync(urlFile, backend, 'utf8')
  const port = await freePort()
  const child = spawn(process.execPath, [path.join(root, 'install', 'entry.mjs')], {
    cwd: root,
    env: {
      ...process.env,
      LIFE_INNOVATION_ENTRY_PORT: String(port),
      LIFE_INNOVATION_HOME: dir,
      LIFE_INNOVATION_URL_FILE: urlFile,
      LIFE_INNOVATION_AGENT_NAME: '复核鲸',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let stderr = ''
  child.stderr.setEncoding('utf8')
  child.stderr.on('data', (chunk) => { stderr += chunk })
  try {
    await waitForHealth(port)

    const local = await request(port, '/home', `127.0.0.1:${port}`)
    assert.equal(local.status, 200, '127.0.0.1 Host 应放行 /home')
    assert.ok(!local.body.includes(TOKEN), '/home 不能出现 token')
    assert.ok(!local.body.includes('token='), '/home 不能出现带 token 的链接')
    assert.ok(local.body.includes('href="/"'), '「回她的房间」必须指回 /')

    const named = await request(port, '/home', `localhost:${port}`)
    assert.equal(named.status, 200, 'localhost Host 应放行 /home')

    const evil = await request(port, '/home', `evil.example:${port}`)
    assert.equal(evil.status, 403, '非本机 Host 必须 403')
    assert.ok(!evil.body.includes(TOKEN), '403 响应不能夹带 token')

    const rootAllowed = await request(port, '/', `127.0.0.1:${port}`)
    assert.equal(rootAllowed.status, 302, '/ 仍然 302 到带 token 的入口')
    assert.equal(rootAllowed.headers.location, backend, '/ 的 location 是 web-url.txt 里的地址')

    const post = await new Promise((resolve, reject) => {
      const req = http.request(
        { host: '127.0.0.1', port, path: '/home', method: 'POST', headers: { host: `127.0.0.1:${port}` } },
        (res) => { res.resume(); res.on('end', () => resolve(res.statusCode)) },
      )
      req.on('error', reject)
      req.end()
    })
    assert.equal(post, 405, '非 GET/HEAD 在 Host 校验之后仍然 405')
  } finally {
    child.kill('SIGTERM')
    await new Promise((resolve) => {
      const timer = setTimeout(resolve, 2000)
      child.once('exit', () => { clearTimeout(timer); resolve() })
    })
    fs.rmSync(dir, { recursive: true, force: true })
    assert.ok(!/ReferenceError/.test(stderr), `entry 不能有 ReferenceError：${stderr}`)
  }
}

// P2-1：SCRIPT 必须接收 title，调用时不能 ReferenceError。
{
  assert.equal(typeof SCRIPT, 'function')
  const withTitle = SCRIPT('备份完成', '生活线')
  assert.ok(withTitle.includes('备份完成'))
  assert.ok(withTitle.includes('生活线'))
  const withoutTitle = SCRIPT('没有标题')
  assert.ok(withoutTitle.includes('没有标题'))
  assert.ok(withoutTitle.includes('你的 agent'))
}

// P2-2/P3-12：空壳新库不能挡住有数据的旧库；exists/usable 走注入。
{
  const home = 'C:/review6-home'
  const newDb = 'C:/review6-home/state/life-innovation.sqlite'
  const legacyDb = 'C:/review6-home/state/jingjing.sqlite'
  const existsBoth = (file) => file === newDb || file === legacyDb
  const onlyLegacyUsable = (file) => file === legacyDb
  assert.equal(
    resolvePaths({ home }, {}, { exists: existsBoth, usable: onlyLegacyUsable }).dbPath,
    legacyDb,
    '新库存但为空壳时回退有数据的旧库',
  )
  assert.equal(
    resolvePaths({ home }, {}, { exists: existsBoth, usable: (file) => file === newDb }).dbPath,
    newDb,
    '新库有数据时不能回退',
  )
  assert.equal(
    resolvePaths({ home }, {}, { exists: existsBoth, usable: () => false }).dbPath,
    newDb,
    '两边都不可用时不乱切库',
  )
}

// P1-3 页面层：即使调用方还传了 chatUrl，渲染结果也不能把 token 带进 HTML。
{
  const dir = tempDir('jingjing-review6-home-')
  try {
    const html = renderHome({
      home: dir,
      dbPath: path.join(dir, 'state', 'life-innovation.sqlite'),
      now: Date.now(),
      chatUrl: `http://127.0.0.1:59999/?token=${TOKEN}`,
      agentName: '复核鲸',
      days: 1,
      memoryQuery: '',
      view: 'today',
    })
    assert.ok(!html.includes(TOKEN), 'renderHome 不能渲染 token')
    assert.ok(!html.includes('token='), 'renderHome 不能渲染 token 链接')
    assert.ok(html.includes('href="/"'), '「回她的房间」链接固定为 /')
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
}

// P2-3/P2-4/P3-15/P3-16：脚本内容与版本契约。
{
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))
  assert.equal(pkg.version, '0.6.3', 'version matches release')
  assert.equal(pkg.engines.node, '>=22.13')

  const install = fs.readFileSync(path.join(root, 'install', 'install.ps1'), 'utf8')
  const bytes = fs.readFileSync(path.join(root, 'install', 'install.ps1'))
  assert.ok(bytes[0] === 0xEF && bytes[1] === 0xBB && bytes[2] === 0xBF, 'install.ps1 必须 UTF-8 BOM')
  assert.ok(install.includes('function Get-DatabaseState'), '有数据库三态探测')
  assert.ok(install.includes("return 'unknown'"), '读不了时返回 unknown')
  assert.ok(install.includes('if(!ok)process.exit(2)'), '六表全读不了时必须 exit(2) → unknown，不能当空库')
  assert.ok(install.includes('function Test-DatabaseHasRows'), '保留旧函数名给静态契约')
  assert.ok(install.includes('$nodeMinor -ge 13'), 'Step 0 校验 22.13')
  assert.ok(install.includes("require('node:sqlite')"), 'Step 0 校验 node:sqlite 可用')
  assert.ok(install.includes('Stop-OldService -Home $LegacyDataHome'), 'ForceNewInstance 时也停旧家服务')
  assert.ok(install.includes('dependencies'), 'profile bundles 迁移同时处理 dependencies')
  const step0 = install.indexOf('Step "0. 环境检查"')
  const legacyHome = install.indexOf('$LegacyDataHome =')
  assert.ok(step0 >= 0 && legacyHome > step0, 'Step 0 必须在旧家探测之前')

  const doctor = fs.readFileSync(path.join(root, 'tools', 'doctor.mjs'), 'utf8')
  assert.ok(!/^\s*import\s+\{[^}]*DatabaseSync[^}]*\}\s+from\s+['"]node:sqlite['"]/m.test(doctor),
    'doctor 不能顶层 import node:sqlite')
  assert.ok(doctor.includes("await import('node:sqlite')"), 'doctor 必须动态 import node:sqlite')
  assert.ok(doctor.includes("'22.13'"), 'doctor 版本门槛是 22.13')
  assert.ok(doctor.includes('没有任何可读的表'), '全部表都读不到时必须报 unreadable，而不是当成缺表')
}

console.log('OK: review6 I/O（Host/token、notify、paths、home、版本契约）')
