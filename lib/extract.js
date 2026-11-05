/**
 * 机械抽取：不调模型，只认确定的句式。
 * 认错了顶多记错一条；后面有新说法会取代旧的（见 store.addAssertion）。
 */

const RULES = [
  { key: '名字', re: /我叫([\u4e00-\u9fa5A-Za-z0-9]{1,10})/, value: (m) => m[1] },
    { key: '住在', re: /(?<![他她它])我?(?:住在|搬(?:到|去))([一-龥A-Za-z0-9]{2,12})/, value: (m) => m[1] },
  { key: '工作', re: /(?<![他她它])我?在([\u4e00-\u9fa5A-Za-z0-9]{2,16})(?:上班|工作|实习)/, value: (m) => m[1] },
  { key: '年龄', re: /我今年(\d{1,3})岁/, value: (m) => `${m[1]} 岁` },
  { key: '生日', re: /我(?:的)?生日(?:是|在)([^，。！？\s]{1,12})/, value: (m) => m[1] },
  { key: '养了', re: /我?养了?(?:一只|一个)?([一-龥]{1,8})/, value: (m) => { const animal = m[1].match(/^(猫|狗|兔|仓鼠|鸟|鱼|龟)/); return animal ? animal[1] : m[1] } },
  { key: '宠物', re: /(猫|狗|兔|仓鼠|鸟|鱼|龟)(?:叫|名叫)([一-龥]{1,6})/, value: (m) => `${m[1]}叫${m[2]}` },
  { key: '喜欢', re: /我(不)?喜欢([^，。！？\s]{1,12})/, value: (m) => `${m[1] ? '不' : ''}喜欢${m[2]}` },
]

const PLAN = /我(明天|后天|下周[一二三四五六日天]?|今晚|今天下午)(?:要|得|准备|打算)([^，。！？\s]{1,20})/

const WEEKDAY = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 日: 7, 天: 7 }

/** 把「明天/后天/下周X/今晚/今天下午」落成一个具体时刻（本地时间）。 */
export function planDue(label, now = Date.now()) {
  const d = new Date(now)
  const at = (dayOffset, hour, minute = 0) => {
    const x = new Date(d.getFullYear(), d.getMonth(), d.getDate() + dayOffset, hour, minute, 0, 0)
    return x.getTime()
  }
  if (label === '明天') return at(1, 10)
  if (label === '后天') return at(2, 10)
  if (label === '今晚') return at(0, 23)
  if (label === '今天下午') return at(0, 18)
  const m = String(label).match(/^下周([一二三四五六日天])?$/)
  if (m) {
    const target = m[1] ? WEEKDAY[m[1]] : 1
    const today = ((d.getDay() + 6) % 7) + 1
    let delta = ((target - today + 7) % 7) || 7
    return at(delta, 10)
  }
  return null
}

const trimTail = (value) => String(value || '').replace(/[了呀啊呢吧哦嘛。！？，、]+$/u, '').trim()

const QUESTION = /[？?]|吗\s*[。！!]?$|什么|哪(?:里|儿|个)|谁|几岁|干嘛/g

export function extractAssertions(text) {
  const body = String(text || '')
  // 问句不产事实：「我叫什么」不该记成名字叫「什么」。
  if (QUESTION.test(body)) return []
  const out = []
  for (const rule of RULES) {
    const m = body.match(rule.re)
    if (m) out.push({ predicate: rule.key, value: trimTail(rule.value(m)) })
  }
  const plan = body.match(PLAN)
  if (plan) out.push({ predicate: `计划:${plan[1]}`, value: trimTail(plan[2]), dueAt: planDue(plan[1]) })
  return out.filter((item) => item.value && !/[什么谁哪几啥]/.test(item.value))
}

/** 把较早的原话压成一段梗概：只做截断与去重，不编内容。 */
export function summarizeTurns(rows, limit = 240) {
  const seen = new Set()
  const parts = []
  for (const row of rows) {
    const who = row.role === 'user' ? '他说' : '你说'
    const clean = String(row.text || '').replace(/\s+/g, ' ').trim()
    if (!clean) continue
    const brief = clean.length > 30 ? `${clean.slice(0, 30)}…` : clean
    const line = `${who}：${brief}`
    if (seen.has(line)) continue
    seen.add(line)
    parts.push(line)
  }
  let text = parts.join('；')
  if (text.length > limit) {
    text = `${text.slice(0, limit - 1)}…`
  }
  return text
}
