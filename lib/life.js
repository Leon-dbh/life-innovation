/**
 * 生活线：她的一天只能由真实动作拼出来。
 * - 原料：raw_turns（她和他真的说过的话）+ actions（她真的调用过的工具/做过的事）。
 * - 没有动作的时间记成「空档」，不写任何编出来的活动。
 * - 日记是这些块的摘要，每条带证据 id（raw:12 / act:7），点得开。
 */
import fs from 'node:fs'
import path from 'node:path'

export const GAP_MS = 45 * 60 * 1000
const CHAT_GAP = 10 * 60 * 1000

export function startOfDay(now) {
  const d = new Date(now)
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
}

/** 按本地日历加天数（跨 DST 也落在本地同一钟点，不用 24h 毫秒硬加）。 */
export function addDays(now, days) {
  const d = new Date(now)
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + Number(days || 0)).getTime()
}

export function dateKey(now) {
  const d = new Date(now)
  const mm = String(d.getMonth() + 1).padStart(2, '0')
  const dd = String(d.getDate()).padStart(2, '0')
  return `${d.getFullYear()}-${mm}-${dd}`
}

function clock(ts) {
  const d = new Date(ts)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

export function toolActivity(tool) {
  if (!tool) return '做了点事'
  if (tool === 'write_diary') return '写日记'
  if (tool === 'close_day') return '把这一天收起来'
  if (tool === 'read_file') return '看了点东西'
  if (tool === 'web_fetch' || tool === 'web_search') return '查了点东西'
  if (tool === 'memory_find' || tool === 'memory_read') return '翻了翻自己的记忆'
  if (tool === 'life_days') return '看了看自己的日子'
  if (tool === 'room_list') return '看了看自己的东西'
  if (tool === 'room_read') return '翻了翻自己的东西'
  if (tool === 'note_write') return '写了张便签'
  if (tool === 'book_next') return '读了一段书'
  if (tool === 'lookup') return '查了点东西'
  if (tool === 'notify') return '给他弹了条通知'
  return `用「${tool}」做事`
}

/** 把一天的原话与动作聚成块；返回 [{activity, startedAt, endedAt, evidence[]}]。 */
export function aggregateDay({ store, now = Date.now() }) {
  const start = startOfDay(now)
  // 用本地日历的下一天零点减 1ms，不用 +24h：夏令时切换日不会多/少一小时。
  const end = Math.min(Math.trunc(now), addDays(start, 1) - 1)
  const turns = store.rawBetween(start, end)
  // 没做成的事不算「她做过」：pending 是还没动手，error 是失败了。
  // 只有 ok 才算真的做过：called 还没结果、uncertain 不知道成没成，都不能写成活动。
  const acts = store.actionsBetween(start, end).filter((a) => a.status === 'ok')
  const events = [
    ...turns.map((t) => ({ ts: t.ts, kind: t.role === 'user' ? '他' : '她', text: t.text, evidence: `raw:${t.id}` })),
    ...acts.map((a) => ({ ts: a.ts, kind: 'tool', tool: a.tool, text: a.summary, evidence: `act:${a.id}` })),
  ].sort((a, b) => a.ts - b.ts)

  const blocks = []
  let chat = null
  for (const ev of events) {
    if (ev.kind === 'tool') {
      if (chat) { blocks.push(chat); chat = null }
      blocks.push({ activity: toolActivity(ev.tool), startedAt: ev.ts, endedAt: ev.ts, evidence: [ev.evidence] })
      continue
    }
    if (!chat || ev.ts - chat.endedAt > CHAT_GAP) {
      if (chat) blocks.push(chat)
      chat = { activity: '和他说说话', startedAt: ev.ts, endedAt: ev.ts, evidence: [ev.evidence] }
    } else {
      chat.endedAt = ev.ts
      chat.evidence.push(ev.evidence)
    }
  }
  if (chat) blocks.push(chat)

  const filled = []
  const ordered = blocks.sort((a, b) => a.startedAt - b.startedAt)
  // 她还没「出现」之前不算空档：从当天第一件真实动作起算。
  let cursor = ordered.length ? ordered[0].startedAt : end + 1
  for (const b of ordered) {
    if (b.startedAt - cursor >= GAP_MS) {
      filled.push({ activity: '空档', startedAt: cursor, endedAt: b.startedAt, evidence: [], idle: true })
    }
    filled.push(b)
    cursor = Math.max(cursor, b.endedAt)
  }
  if (end - cursor >= GAP_MS) {
    filled.push({ activity: '空档', startedAt: cursor, endedAt: end, evidence: [], idle: true })
  }
  return filled
}

/** 重算今天并写回 life_blocks（幂等：先删当天再插）。 */
export function syncDay({ store, now = Date.now() }) {
  const day = dateKey(now)
  // 归档之后这一天就冻结了：之后发生的事属于下一天，不能改写已收起来的日记。
  if (store.isDayClosed(day)) return store.lifeForDate(day)
  const blocks = aggregateDay({ store, now })
  store.replaceLifeBlocks(day, blocks, now)
  return blocks
}

export function evidenceLabel(ids) {
  const groups = new Map()
  for (const id of ids) {
    const [kind, num] = String(id).split(':')
    const n = Number(num)
    if (!Number.isFinite(n)) continue
    if (!groups.has(kind)) groups.set(kind, [])
    groups.get(kind).push(n)
  }
  const parts = []
  for (const [kind, nums] of groups) {
    nums.sort((a, b) => a - b)
    let i = 0
    while (i < nums.length) {
      let j = i
      while (j + 1 < nums.length && nums[j + 1] === nums[j] + 1) j += 1
      parts.push(j - i >= 2 ? `${kind}:${nums[i]}–${nums[j]}` : nums.slice(i, j + 1).map((n) => `${kind}:${n}`).join('、'))
      i = j + 1
    }
  }
  return parts.join('、')
}

export function renderDiary(blocks, now = Date.now()) {
  const day = dateKey(now)
  const real = blocks.filter((b) => !b.idle)
  const idle = blocks.filter((b) => b.idle)
  const lines = [`# ${day}`, '', '这一天里，实际留下的动作：', '']
  if (!real.length) {
    lines.push('- （没有动作。这一天就是空的。）')
  }
  for (const b of real) {
    const ev = b.evidence.length ? `（证据：${evidenceLabel(b.evidence)}）` : '（证据：无）'
    const span = b.endedAt > b.startedAt ? `${clock(b.startedAt)}–${clock(b.endedAt)}` : clock(b.startedAt)
    lines.push(`- ${span} ${b.activity} ${ev}`)
  }
  if (idle.length) {
    lines.push('', '空着的时间（没有动作，不是活动）：')
    for (const b of idle) lines.push(`- ${clock(b.startedAt)}–${clock(b.endedAt)} 空档`)
  }
  lines.push('', `> 本文件由 life_blocks 生成；每条都对应 actions/raw_turns 里的记录。`)
  return lines.join('\n') + '\n'
}

export function writeDiaryFile({ store, now = Date.now(), dir = 'D:/life-innovation-home/diary' }) {
  const blocks = syncDay({ store, now })
  const md = renderDiary(blocks, now)
  fs.mkdirSync(dir, { recursive: true })
  const file = path.join(dir, `${dateKey(now)}.md`)
  fs.writeFileSync(file, md, 'utf8')
  return { file, md, blocks }
}

/**
 * 一个「她真的干了一件事」的 tick：安静够久、白天（或凌晨补写前一天），就把那天记成日记。
 * 幂等靠账本里的 diary:<date> 动作，而不是时间窗口——写入时间被冻结，
 * 用「30 分钟内没写过」判断会让空闲时每半小时重写一次同一天。
 * 返回 null 表示这次不动（没到条件，或已经写过）。
 */
export function tick({ store, now = Date.now(), quietMs = 20 * 60 * 1000, dir = 'D:/life-innovation-home/diary' }) {
  const hour = new Date(now).getHours()
  // 0–8 点补写前一天：23 点之后还在活动的话，当天的日记要等过了零点才写得完。
  // 9 点开机也不能只盯着今天：昨天若有真实动作但还没写日记，先把它补上。
  let target = hour < 8 ? addDays(startOfDay(now), -1) : now
  if (hour >= 8) {
    const yesterday = addDays(startOfDay(now), -1)
    if (!store.isDayClosed(dateKey(yesterday))) {
      const yEnd = addDays(startOfDay(now), 0) - 1
      const yBlocks = syncDay({ store, now: yEnd })
      if (yBlocks.some((b) => !b.idle)) target = yesterday
    }
  }
  // 归档之后这一天就冻结了；tick 不能再拿「空档」重写已收起来的日记。
  if (store.isDayClosed(dateKey(target))) return null
  const callId = `diary:${dateKey(target)}`
  const prev = store.actionByCallId(callId)
  if (prev && prev.status === 'ok') return null

  const last = store.lastActivityTs()
  if (!last || now - last < quietMs) return null

  const blocks = syncDay({ store, now: target })
  const real = blocks.filter((b) => !b.idle)
  // 那天一件事都没有就不写：否则一个没人说话的日子也会因为「写日记」这个动作
  // 变成有内容的一天，等于替她制造生活。空日子就让它空着。
  if (!real.length) return null

  // 至少一次（借 dsh-world 的 PendingWake）：先落账本再动手。
  // 哪怕写到一半进程没了，下一次 tick 看到的是一条 pending/uncertain，会重试而不是当已做过。
  store.addAction({
    ts: now, sessionId: '', kind: 'file', tool: 'write_diary',
    summary: '写今天的日记', callId, status: 'pending',
  })
  const { file, blocks: first } = writeDiaryFile({ store, now: target, dir })
  const count = first.filter((b) => !b.idle).length
  store.updateAction(callId, 'ok', `把今天记成日记（${count} 件事）`)
  // 再写一次，让「写日记」这件事本身也出现在她今天的日子里（带 act 证据）。
  const again = writeDiaryFile({ store, now: target, dir })
  return { file: again.file, date: dateKey(target), count }
}
