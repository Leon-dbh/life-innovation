/**
 * life-innovation 的宿主插件：把「她记得的事」在她说话前放回系统提示词。
 *
 * M1 的边界：
 * - 记忆是全局的（按人），不是按会话；换一个窗口，她还是她。
 * - 写记忆只在本地做（node:sqlite），抽取是确定性规则，不为此调模型。
 * - 每轮注入走 ctx.systemPrompt.context（动态上下文），不写死进历史。
 */
import fs from 'node:fs'
import path from 'node:path'
import { MemoryStore } from './lib/store.js'
import { extractAssertions } from './lib/extract.js'
import { maybeSummarize } from './lib/summaries.js'
import { createPackCache } from './lib/packCache.js'
import { syncDay, tick } from './lib/life.js'
import { reconcileOnStart, syncPhase, tickRhythm, rhythmText } from './lib/rhythm.js'
import { registerMemoryTools } from './lib/tools.js'
import { createHands } from './lib/hands.js'
import { resolvePaths } from './lib/paths.js'
import { homeDbHintFile, renderHome, renderHomeError } from './install/home.mjs'
import * as observe from './lib/observe.js'

export const name = 'life-innovation'

export const inject = ['systemPrompt', 'tools']

const SUBJECT = '他'

const WEEKDAYS = ['日', '一', '二', '三', '四', '五', '六']

/** 现在的时间。按小时取整，避免每分钟都变、把前缀缓存打掉。 */
function nowText(now = new Date()) {
  return `现在是 ${now.getFullYear()} 年 ${now.getMonth() + 1} 月 ${now.getDate()} 日 星期${WEEKDAYS[now.getDay()]}，${now.getHours()} 点。`
}


function contentText(message) {
  const blocks = message?.content
  if (!Array.isArray(blocks)) return ''
  return blocks
    .filter((b) => b && b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text)
    .join('\n')
    .trim()
}

// 只把真正由人发来的消息记成「他说的话」。运行时的上下文快照（runtime-context）、
// 她自己触发的提醒（schedule）都不是他说的；未知来源一律不记，宁可漏记也不污染记忆。
function humanSource(message) {
  const kind = message?.source?.kind
  return kind === 'user' || kind === 'prompt'
}

export function apply(ctx, config = {}) {
  const { home, dbPath, diaryDir } = resolvePaths(config)
  const agentName = String(config.agentName || '').trim()
  const maxChars = Number(config.memory?.maxChars || 1200)
  const tickMs = Number(config.diary?.tickMs || 60000)

  let store
  try {
    store = new MemoryStore(dbPath)
  } catch (error) {
    console.error('[life-innovation] 记忆库打不开，先不记忆：', error)
    ctx.logger?.warn?.(`[life-innovation] 记忆库打不开，先不记忆：${error?.message || error}`)
    return
  }

  // 每个 effect 都单独兜住：宿主对工具 schema 等有校验，注册失败如果直接抛，
  // 同一个 apply 里后面的记忆段也会一起丢掉，而且错误会被吞掉（看起来像插件没加载）。
  const guarded = (label, fn) => ctx.effect(() => {
    try {
      return fn()
    } catch (error) {
      console.error(`[life-innovation] ${label} 注册失败：`, error)
      ctx.logger?.warn?.(`[life-innovation] ${label} 注册失败：${error?.message || error}`)
      return () => {}
    }
  })

  ctx.effect(() => () => store.close())

  // 固定入口是另一个进程，拿不到插件 config。把这次实际打开的库写成一个提示文件，
  // entry 每次请求 /home 时读它；手改 config.dbPath 后即使没重跑安装，页面也不会读旧库。
  try {
    fs.mkdirSync(path.dirname(homeDbHintFile(home)), { recursive: true })
    fs.writeFileSync(homeDbHintFile(home), dbPath, 'utf8')
  } catch (error) {
    ctx.logger?.warn?.(`[life-innovation] 写家页面库提示失败：${error?.message || error}`)
  }

  // 启动时上一进程遗留的「called」永远等不到结果了：标成 uncertain，不能算她做成了。
  const orphans = store.markOrphanActions()
  if (orphans) ctx.logger?.warn?.(`[life-innovation] 有 ${orphans} 条动作停在 called，已标记 uncertain`)

  // 启动时对账节律：上一个进程关掉之后的时间记成 offline，不补写她在干嘛。
  try {
    reconcileOnStart({ store, now: Date.now() })
  } catch (error) {
    ctx.logger?.warn?.(`[life-innovation] 节律对账失败：${error?.message || error}`)
  }

  // 六只手：读家里 / 写便签 / 读书 / 查资料 / 弹通知。建不起来就只少这几只手，
  // 不影响记忆和节律。
  let hands = null
  try {
    hands = createHands({ home, store, config: { ...(config.hand || {}), agentName } })
  } catch (error) {
    ctx.logger?.warn?.(`[life-innovation] 手没接上：${error?.message || error}`)
  }

  // 四个只读工具（回忆/读全文/状态/日子）+ 六只手。
  guarded('记忆工具', () => registerMemoryTools({ ctx, store, observe, hands }))

  // 家页面也挂在 DSH 自己的 webServer 上（同源），所以客户端按钮不用猜 60080：
  // 端口、token、反代全都跟着当前这个 DSH 走。
  guarded('家页面路由', () => {
    ctx.inject(['webServer'], (webCtx) => {
      webCtx.effect(() => webCtx.webServer.register({
        kind: 'exact',
        path: '/life-innovation/home',
        handler: (req, res) => {
          if (req.method !== 'GET' && req.method !== 'HEAD') {
            res.writeHead(405, { 'content-type': 'text/plain; charset=utf-8' })
            res.end('只支持 GET')
            return
          }
          const requestUrl = new URL(req.url || '/life-innovation/home', 'http://127.0.0.1')
          let html
          try {
            html = renderHome({ home, dbPath, now: Date.now(), chatUrl: '/', agentName, days: requestUrl.searchParams.get('days') || 1 })
          } catch (error) {
            html = renderHomeError(error, agentName)
            res.writeHead(503, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
            res.end(html)
            return
          }
          res.writeHead(200, {
            'content-type': 'text/html; charset=utf-8',
            'cache-control': 'no-store',
            'referrer-policy': 'no-referrer',
            'x-content-type-options': 'nosniff',
          })
          res.end(req.method === 'HEAD' ? undefined : html)
        },
      }), 'life-innovation: home route')
    })
  })

  // 记忆块按指纹缓存：只有记忆真的变了才重建，保住系统提示词的前缀缓存。
  const packCache = createPackCache({ store, maxChars, subject: SUBJECT })
  guarded('记忆注入', () => ctx.systemPrompt.context({
    name: 'life:memory',
    order: 900,
    required: true,
    interpolate: false,
    text: () => {
      try {
        return packCache.get(Date.now())
      } catch (error) {
        ctx.logger?.warn?.(`[life-innovation] 记忆包组装失败：${error?.message || error}`)
        return ''
      }
    },
  }))

  // 名字不是插件给的：config.agentName 有值就注入；没有就明确说没有预设名字，
  // 让用户自己决定怎么叫她，避免她凭空编一个。
  guarded('名字注入', () => ctx.systemPrompt.context({
    name: 'life:name',
    order: 810,
    required: true,
    interpolate: false,
    text: () => agentName ? `你叫${agentName}。` : '你没有预设的名字；别人叫你什么，由对方决定。',
  }))

  // 真实的时间：日期与钟点不写死进 persona，按小时替换；不然她会以为自己还停在某一天。
  guarded('时间注入', () => ctx.systemPrompt.context({
    name: 'life:now',
    order: 800,
    required: true,
    interpolate: false,
    text: () => nowText(),
  }))

  // 当前节律：醒着/安静/夜里/今天已归档/没在运行。只由时钟和真实事件推导。
  guarded('节律注入', () => ctx.systemPrompt.context({
    name: 'life:rhythm',
    order: 850,
    required: true,
    interpolate: false,
    text: () => {
      try {
        return rhythmText({ store, now: Date.now(), hasDreamNote: (d) => Boolean(hands && hands.dreamNoteExists(d)) })
      } catch (error) {
        ctx.logger?.warn?.(`[life-innovation] 节律文本失败：${error?.message || error}`)
        return ''
      }
    },
  }))

  const summarizeIfDue = (sessionId, ts) => {
    try {
      maybeSummarize({ store, sessionId, ts })
    } catch (error) {
      ctx.logger?.warn?.(`[life-innovation] 写梗概失败：${error?.message || error}`)
    }
  }

  ctx.on('session/event', (session, event) => {
    try {
      const type = event?.type
      const eventSessionId = String(session?.id || session?.sessionId || '')
      if (type === 'tool/call') {
        const call = event?.data || {}
        const rawArgs = call.arguments
        const argsText = typeof rawArgs === 'string' ? rawArgs : (rawArgs ? JSON.stringify(rawArgs) : '')
        const args = argsText.replace(/\s+/g, ' ').slice(0, 120)
        let parsedArgs = null
        if (rawArgs && typeof rawArgs === 'object') parsedArgs = rawArgs
        else if (typeof rawArgs === 'string') {
          try { parsedArgs = JSON.parse(rawArgs) } catch { parsedArgs = null }
        }
        const dreamDate = String(parsedArgs?.dream_date || '').trim()
        const isDreamNote = String(call.name || '') === 'note_write' && /^\d{4}-\d{2}-\d{2}$/.test(dreamDate)
        store.addAction({
          ts: Number(event?.time) || Date.now(),
          sessionId: eventSessionId,
          kind: isDreamNote ? 'life' : 'tool',
          tool: String(call.name || ''),
          summary: isDreamNote ? `把 ${dreamDate} 的梦记成一张便签` : args,
          callId: String(call.callId || ''),
          status: 'called',
          meta: isDreamNote ? { dreamDate } : null,
        })
        return
      }
      if (type === 'tool/result') {
        const data = event?.data || {}
        // 真实事件形状：data 只有 {turn, step, message}，callId 在 message.toolCallId
        // （以及 message.source.callId）。以前读 data.callId 恒为空，动作永远停在 called。
        const callId = String(
          data.callId
          || data.message?.toolCallId
          || data.message?.source?.callId
          || '',
        )
        const status = data?.message?.isError || data?.error ? 'error' : 'ok'
        if (callId) {
          store.updateAction(callId, status)
        } else {
          // 少数路径不带 callId：按「同 session + 同 tool 最近一条 called」兜底，
          // 至少别让她做过的工具永远停在 called。
          const tool = String(data.message?.name || data.tool || data.message?.source?.tool || data.message?.toolName || '')
          store.updateActionByFallback(eventSessionId, tool, status)
        }
        // 工具刚完成时，assistant/message 的那次 syncDay 已经跑过了；不补一次，
        // 读者要等到「安静 20 分钟」才会在生活线里看见这次动作。
        try {
          syncDay({ store, now: Number(event?.time) || Date.now() })
        } catch (error) {
          ctx.logger?.warn?.(`[life-innovation] 同步生活线失败：${error?.message || error}`)
        }
        return
      }
      if (type !== 'user/message' && type !== 'assistant/message') return
      // 事件形状不一样：user/message 的 data 就是消息本身，assistant/message 在 data.message 里。
      const message = type === 'user/message' ? event?.data : event?.data?.message
      const text = contentText(message)
      if (!text) return
      const ts = Number(event?.time) || Date.now()
      const sessionId = String(session?.id || '')

      // 原话、断言、画像、日子块必须一起落：中途崩了不能留下「话记住了、事实没记住」。
      store.transaction(() => {
        if (type === 'user/message') {
          if (!humanSource(message)) return
          store.addRaw(ts, sessionId, 'user', text)
          store.touchRelation(SUBJECT, ts)
          store.expirePlans(ts, SUBJECT)
          for (const item of extractAssertions(text, ts)) {
            const res = store.addAssertion({ ts, subject: SUBJECT, predicate: item.predicate, value: item.value, source: text, dueAt: item.dueAt || null })
            // 同一个说法重复出现时 addAssertion 不新建行；画像也不必重写，
            // 否则 profiles.updated_at 每轮都变、指纹失效、记忆包每轮重建。
            if (!item.predicate.startsWith('计划:') && res.id && !res.unchanged) {
              store.setProfile(SUBJECT, item.predicate, item.value, text.slice(0, 120), ts)
            }
          }
          summarizeIfDue(sessionId, ts)
        } else {
          store.addRaw(ts, sessionId, 'her', text)
        }
        // 无论谁的句子，都重算今天的日子（幂等；只由真实原话/动作聚合）。
        syncDay({ store, now: ts })
        // 有人说话、或她刚回完，状态立刻切到醒着；其余状态由 60 秒 tick 推进。
        syncPhase({ store, now: ts })
      })
    } catch (error) {
      ctx.logger?.warn?.(`[life-innovation] 记这一轮失败：${error?.message || error}`)
    }
  })

  // 每 60 秒看一眼：安静够久，她就真的把今天记成日记（落 actions，可审计）。
  // 顺手做一次很轻的归档维护：90 天前的原话搬到 raw_archive（id 不变，证据仍有效）。
  let lastWarm = 0
  const timer = setInterval(async () => {
    try {
      const now = Date.now()
      store.archiveRawBefore(now - 90 * 86400000)
      // 书只下一次：没有书时每 10 分钟试一次，下好了就只读本地。
      if (hands && now - lastWarm > 10 * 60 * 1000) {
        lastWarm = now
        try { await hands.warm() } catch { /* 网络不好就下次再试 */ }
      }
      const rhythm = tickRhythm({
        store, now, dir: diaryDir,
        quietAction: hands ? () => hands.quietAction(now) : null,
      })
      const closedList = Array.isArray(rhythm.closed) ? rhythm.closed : (rhythm.closed?.closed || [])
      for (const c of closedList) ctx.logger?.info?.(`[life-innovation] 归档了 ${c.date}（${c.count} 件事）`)
      if (rhythm.dream) ctx.logger?.info?.(`[life-innovation] 做了个梦（非事实层）`)
      const done = tick({ store, now, dir: diaryDir })
      if (done) ctx.logger?.info?.(`[life-innovation] 写了日记 ${done.file}`)
    } catch (error) {
      ctx.logger?.warn?.(`[life-innovation] 节律/日记失败：${error?.message || error}`)
    }
  }, tickMs)
  timer.unref?.()
  ctx.effect(() => () => clearInterval(timer))

  ctx.logger?.info?.(`[life-innovation] 记忆已开：${dbPath}`)
}
