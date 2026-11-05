/**
 * 鲸鲸的宿主插件：把「她记得的事」在她说话前放回系统提示词。
 *
 * M1 的边界：
 * - 记忆是全局的（按人），不是按会话；换一个窗口，她还是她。
 * - 写记忆只在本地做（node:sqlite），抽取是确定性规则，不为此调模型。
 * - 每轮注入走 ctx.systemPrompt.context（动态上下文），不写死进历史。
 */
import { MemoryStore } from './lib/store.js'
import { extractAssertions, summarizeTurns } from './lib/extract.js'
import { createPackCache } from './lib/packCache.js'
import { syncDay, tick } from './lib/life.js'
import { registerMemoryTools } from './lib/tools.js'
import { resolvePaths } from './lib/paths.js'
import * as observe from './lib/observe.js'

export const name = 'dsh-jingjing'

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

function humanSource(message) {
  const kind = message?.source?.kind
  return kind === undefined || kind === null || kind === 'user' || kind === 'prompt'
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

  const summarizeIfDue = (sessionId, ts) => {
    try {
      const total = store.countRaw()
      if (total === 0 || total % 12 !== 0) return
      // 只摘「上次梗概之后、最近 8 条之外」的新原话；否则每次都会把旧原话重摘一遍，
      // 梗概越滚越长、还互相覆盖。
      const fresh = store.rawSince(store.lastSummaryTo())
      const rows = fresh.length > 8 ? fresh.slice(0, -8) : []
      if (rows.length < 4) return
      const text = summarizeTurns(rows)
      if (!text) return
      store.addSummary(ts, sessionId, text, rows[0].ts, rows[rows.length - 1].ts)
    } catch (error) {
      ctx.logger?.warn?.(`[jingjing] 写梗概失败：${error?.message || error}`)
    }
  }

  ctx.on('session/event', (session, event) => {
    try {
      const type = event?.type
      if (type === 'tool/call') {
        const call = event?.data || {}
        const rawArgs = call.arguments
        const argsText = typeof rawArgs === 'string' ? rawArgs : (rawArgs ? JSON.stringify(rawArgs) : '')
        const args = argsText.replace(/\s+/g, ' ').slice(0, 120)
        store.addAction({
          ts: Number(event?.time) || Date.now(),
          sessionId: String(session?.id || ''),
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
        const callId = String(data.callId || '')
        if (callId) store.updateAction(callId, data?.message?.isError ? 'error' : 'ok')
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
    } catch (error) {
      ctx.logger?.warn?.(`[jingjing] 记这一轮失败：${error?.message || error}`)
    }
  })

  // 每 60 秒看一眼：安静够久，她就真的把今天记成日记（落 actions，可审计）。
  // 顺手做一次很轻的归档维护：90 天前的原话搬到 raw_archive（id 不变，证据仍有效）。
  const timer = setInterval(() => {
    try {
      store.archiveRawBefore(Date.now() - 90 * 86400000)
      const done = tick({ store, now: Date.now(), dir: diaryDir })
      if (done) ctx.logger?.info?.(`[jingjing] 写了日记 ${done.file}`)
    } catch (error) {
      ctx.logger?.warn?.(`[jingjing] 写日记失败：${error?.message || error}`)
    }
  }, tickMs)
  timer.unref?.()
  ctx.effect(() => () => clearInterval(timer))

  ctx.logger?.info?.(`[jingjing] 记忆已开：${dbPath}`)
}
