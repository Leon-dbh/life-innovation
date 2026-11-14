/**
 * 上下文价值判断：原文一条都不删，只决定「这一轮值不值得占提示词预算」。
 *
 * 原则：
 * - 工具汇报、路径/URL/命令、纯过程叙述，默认不进上下文；
 * - 决定、承诺、情绪、偏好、未完成的事，优先；
 * - 用户的短句也可能是重要的（「我叫林晚」），所以不按长度一刀切；
 * - 判断只影响注入，不影响 raw_turns 的完整保留。
 */

const ACK = /^(?:在吗|嗯+|哦+|噢+|好的?|好呀|晚安|早安|午安|哈哈+|嘿嘿|没事|谢谢|谢谢你|你好|嗨|hi|hello|收到|ok|okay)[。！？!?~～…\s]*$/i
const TOOLISH = /https?:\/\/|```|`[^`]{2,}`|(?:^|\s)[A-Za-z]:\\|\/(?:usr|home|tmp|var)\/|\b(?:npm|pnpm|git|curl|node|powershell|python)\b/i
const TOOL_WORDS = /工具|接口|调用|参数|日志|端口|进程|命令|返回值|超时|安装包|配置文件|数据库文件|文件路径/
const TOOL_DONE = /^(?:已|刚刚|刚才|我)?[^。！？!?]{0,24}(?:完成|处理|更新|安装|下载|保存|写好|改好|查好|设置好)[^。！？!?]{0,40}$/
const DURABLE = /决定|打算|计划|准备|以后|下次|约好|答应|承诺|不再|必须|想要|希望|害怕|担心|难过|开心|生气|焦虑|喜欢|讨厌|习惯|生日|住在|工作|名字|叫我|记住/
const OPEN = /[?？]|还没有|没做完|待办|回头|明天|下周|之后|等我|到时候/

/** 按码点截断，避免把 emoji 劈成两半。 */
export function clipText(text, max = 160) {
  const clean = String(text || '').replace(/\s+/g, ' ').trim()
  const chars = Array.from(clean)
  return chars.length > max ? `${chars.slice(0, Math.max(1, max - 1)).join('')}…` : clean
}

export function isAck(text) {
  return ACK.test(String(text || '').trim())
}

/**
 * 只认“明显是工具/过程汇报”的文本，宁可漏杀，不误杀她真实的生活叙述。
 */
export function isToolReport(text) {
  const t = String(text || '').replace(/\s+/g, ' ').trim()
  if (!t) return false
  if (TOOLISH.test(t)) return true
  // “我用了某工具/接口，返回……”本身就是过程汇报，不必等到 70 字。
  if (/(工具|接口|调用|返回值)/.test(t) && /(用了|返回|调用|参数|日志)/.test(t)) return true
  if (t.length >= 70 && TOOL_WORDS.test(t)) return true
  if (t.length >= 70 && TOOL_DONE.test(t)) return true
  return false
}

export function hasDurable(text) {
  return DURABLE.test(String(text || ''))
}

export function isOpenLoop(text) {
  return OPEN.test(String(text || ''))
}

/**
 * 粗排价值：只用于同一条记忆在预算里“先放谁”，不是事实判断。
 * 负数表示默认不放进上下文；原文仍然在库里。
 */
export function contextValue(text, role = 'her') {
  const t = String(text || '').trim()
  if (!t) return -100
  if (isToolReport(t)) return -50
  if (t.length < 4) return -8
  if (isAck(t)) return -6
  let score = role === 'user' ? 2 : 0
  if (hasDurable(t)) score += 3
  if (isOpenLoop(t)) score += 1
  if (/(难过|伤心|害怕|怕|累|生气|烦|想念|想你|开心|高兴|焦虑|紧张|哭|喜欢|讨厌)/.test(t)) score += 2
  // 太长且没有可记住的信息，排后面；但不是删除。
  if (t.length > 320 && !hasDurable(t) && !isOpenLoop(t)) score -= 2
  return score
}

/**
 * 选最近的话：角色平衡、先过滤工具汇报，再按时间正序返回。
 * 不修改原始行；返回的是注入用的短文本。
 */
export function selectRecent(items, { max = 4, perRole = 2, userMax = 120, herMax = 160 } = {}) {
  const rows = Array.isArray(items) ? items : []
  const seen = new Set()
  const picked = []
  const byRole = new Map()
  const rank = (r) => contextValue(r.text, r.role)

  // 先看“值不值得记”，同一个角色里再让新的优先；不能只按时间把长回复塞满。
  for (const r of [...rows].sort((a, b) => rank(b) - rank(a) || Number(b.ts) - Number(a.ts) || Number(b.id) - Number(a.id))) {
    if (picked.length >= max) break
    if (isToolReport(r.text)) continue
    const key = String(r.text || '').replace(/\s+/g, ' ').trim()
    if (!key || seen.has(key)) continue
    const role = r.role === 'user' ? 'user' : 'her'
    const count = byRole.get(role) || 0
    if (count >= perRole) continue
    // 寒暄只有在不够人时才补；有价值的话优先。
    if (isAck(key) && rows.length > max) continue
    seen.add(key)
    byRole.set(role, count + 1)
    picked.push({ ...r, role, injectText: clipText(key, role === 'user' ? userMax : herMax), value: rank(r) })
  }

  // 角色不够时，用剩下的非工具原话补齐；仍然保持时间正序。
  if (picked.length < max) {
    for (const r of [...rows].sort((a, b) => Number(b.ts) - Number(a.ts))) {
      if (picked.length >= max) break
      if (isToolReport(r.text)) continue
      const key = String(r.text || '').replace(/\s+/g, ' ').trim()
      if (!key || seen.has(key)) continue
      seen.add(key)
      const role = r.role === 'user' ? 'user' : 'her'
      picked.push({ ...r, role, injectText: clipText(key, role === 'user' ? userMax : herMax), value: rank(r) })
    }
  }

  return picked.sort((a, b) => Number(a.ts) - Number(b.ts) || Number(a.id) - Number(b.id))
}
