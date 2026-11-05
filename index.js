/**
 * 鲸鲸的宿主插件：把「她记得的事」在她说话前放回系统提示词。
 *
 * M1 的边界：
 * - 记忆是全局的（按人），不是按会话；换一个窗口，她还是她。
 * - 写记忆只在本地做（node:sqlite），抽取是确定性规则，不为此调模型。
 * - 每轮注入走 ctx.systemPrompt.context（动态上下文），不写死进历史。
 */
import { MemoryStore } from './lib/store.js'
import { extractAssertions } from './lib/extract.js'
import { maybeSummarize } from './lib/summaries.js'
import { createPackCache } from './lib/packCache.js'
import { syncDay, tick } from './lib/life.js'
import { reconcileOnStart, syncPhase, tickRhythm, rhythmText } from './lib/rhythm.js'
import { registerMemoryTools } from './lib/tools.js'
import { resolvePaths } from './lib/paths.js'
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
  const { dbPath, diaryDir } = resolvePaths(config)
  const maxChars = Number(config.memory?.maxChars || 1200)
  const tickMs = Number(config.diary?.tickMs || 60000)

  let store
  try {
    store = new MemoryStore(dbPath)
  } catch (error) {
    console.error('[jingjing] 记忆库打不开，先不记忆：', error)
    ctx.logger?.warn?.(`[jingjing] 记忆库打不开，先不记忆：${error?.message || error}`)
    return
  }

  // 每个 effect 都单独兜住：宿主对工具 schema 等有校验，注册失败如果直接抛，
  // 同一个 apply 里后面的记忆段也会一起丢掉，而且错误会被吞掉（看起来像插件没加载）。
  const guarded = (label, fn) => ctx.effect(() => {
    try {
      return fn()
    } catch (error) {
      console.error(`[jingjing] ${label} 注册失败：`, error)
      ctx.logger?.warn?.(`[jingjing] ${label} 注册失败：${error?.message || error}`)
      return () => {}
    }
  })

  ctx.effect(() => () => store.close())

  // 启动时上一进程遗留的「called」永远等不到结果了：标成 uncertain，不能算她做成了。
  const orphans = store.markOrphanActions()
  if (orphans) ctx.logger?.warn?.(`[jingjing] 有 ${orphans} 条动作停在 called，已标记 uncertain`)

  // 启动时对账节律：上一个进程关掉之后的时间记成 offline，不补写她在干嘛。
  try {
    reconcileOnStart({ store, now: Date.now() })
  } catch (error) {
    ctx.logger?.warn?.(`[jingjing] 节律对账失败：${error?.message || error}`)
  }

  // 给她三个只读工具：按关键词找原话、按 ref 读全文、看自己现在的状态。
  guarded('记忆工具', () => registerMemoryTools({ ctx, store, observe }))

  // 记忆块按指纹缓存：只有记忆真的变了才重建，保住系统提示词的前缀缓存。
  const packCache = createPackCache({ store, maxChars, subject: SUBJECT })
  guarded('记忆注入', () => ctx.systemPrompt.context({
    name: 'jingjing:memory',
    order: 900,
    required: true,
    interpolate: false,
    text: () => {
      try {
        return packCache.get(Date.now())
      } catch (error) {
        ctx.logger?.warn?.(`[jingjing] 记忆包组装失败：${error?.message || error}`)
        return ''
      }
    },
  }))

  // 真实的时间：日期与钟点不写死进 persona，按小时替换；不然她会以为自己还停在某一天。
  guarded('时间注入', () => ctx.systemPrompt.context({
    name: 'jingjing:now',
    order: 800,
    required: true,
    interpolate: false,
    text: () => nowText(),
  }))

  // 当前节律：醒着/安静/夜里/今天已归档/没在运行。只由时钟和真实事件推导。
  guarded('节律注入', () => ctx.systemPrompt.context({
    name: 'jingjing:rhythm',
    order: 850,
    required: true,
    interpolate: false,
    text: () => {
      try {
        return rhythmText({ store, now: Date.now() })
      } catch (error) {
        ctx.logger?.warn?.(`[jingjing] 节律文本失败：${error?.message || error}`)
        return ''
      }
    },
  }))

  const summarizeIfDue = (sessionId, ts) => {
    try {
      maybeSummarize({ store, sessionId, ts })
    } catch (error) {
      ctx.logger?.warn?.(`[jingjing] 写梗概失败：${error?.message || error}`)
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
        store.addAction({
          ts: Number(event?.time) || Date.now(),
          sessionId: eventSessionId,
          kind: 'tool',
          tool: String(call.name || ''),
          summary: args,
          callId: String(call.callId || ''),
          status: 'called',
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
        return
      }
      if (type !== 'user/message' && type !== 'assistant/message') return
      // 事件形状不一样：user/message 的 data 就是消息本身，assistant/message 在 data.message 里。
      const message = type === 'user/message' ? event?.data : event?.data?.message
      const text = contentText(message)
      if (!text) return
      const ts = Number(event?.time) || Date.now()
      const sessionId = String(session?.id || '')

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
    } catch (error) {
      ctx.logger?.warn?.(`[jingjing] 记这一轮失败：${error?.message || error}`)
    }
  })

  // 每 60 秒看一眼：安静够久，她就真的把今天记成日记（落 actions，可审计）。
  // 顺手做一次很轻的归档维护：90 天前的原话搬到 raw_archive（id 不变，证据仍有效）。
  const timer = setInterval(() => {
    try {
      const now = Date.now()
      store.archiveRawBefore(now - 90 * 86400000)
      const rhythm = tickRhythm({ store, now, dir: diaryDir })
      if (rhythm.closed) ctx.logger?.info?.(`[jingjing] 归档了 ${rhythm.closed.date}（${rhythm.closed.count} 件事）`)
      if (rhythm.dream) ctx.logger?.info?.(`[jingjing] 做了个梦（非事实层）`)
      const done = tick({ store, now, dir: diaryDir })
      if (done) ctx.logger?.info?.(`[jingjing] 写了日记 ${done.file}`)
    } catch (error) {
      ctx.logger?.warn?.(`[jingjing] 节律/日记失败：${error?.message || error}`)
    }
  }, tickMs)
  timer.unref?.()
  ctx.effect(() => () => clearInterval(timer))

  ctx.logger?.info?.(`[jingjing] 记忆已开：${dbPath}`)
}
