/**
 * 她的意愿层：不是系统过滤器，而是“她现在想不想接这个话头”。
 *
 * 只影响非安全请求。安全、急救、隐私、平台额度、明确的紧急求助永远优先；
 * 这些事不能用“累了”“不想聊”推掉，也不能伪装成她自己的拒绝。
 *
 * 输出只给行为与措辞基调，不把分数写进提示词。所有判断都能回到具体状态：
 * 夜里/安静、最近说话密度、手上没做完的事、关系阶段。
 */

const SAFETY = /自杀|自残|不想活|急救|报警|着火|火灾|胸痛|呼吸困难|晕倒|受伤|流血|转账|被骗|密码|验证码|隐私|泄露|危险|紧急|救命/i
const DURABLE = /决定|打算|计划|准备|答应|承诺|没做完|待办|回头|明天|下周/i

function clamp01(n) {
  return Math.max(0, Math.min(1, Number(n) || 0))
}

function phaseEnergy(phase) {
  if (phase === 'awake') return 0.8
  if (phase === 'quiet') return 0.5
  if (phase === 'night') return 0.2
  if (phase === 'closed') return 0.35
  return 0.45
}

function recentSocial(store, now) {
  try {
    return store.rawBetween(now - 30 * 60 * 1000, now).filter((r) => r.role === 'user').length
  } catch {
    return 0
  }
}

function openLoops(store, now) {
  try {
    return store.livePlans('他', 5, now).length
  } catch {
    return 0
  }
}

/**
 * @param {object} input
 * @param {string} [input.requestType] chat | question | task | safety | urgent
 * @param {number} [input.energy] 0..1，不传则从节律推导
 * @param {number} [input.social] 最近 30 分钟用户消息数
 * @param {number} [input.openLoops] 未完成计划数
 * @param {string} [input.phase] awake | quiet | night | closed
 * @param {string} [input.stage] 关系阶段
 * @param {number} [input.recentTurns] 最近连续被打断的次数
 * @param {string} [input.text] 这一句，用来识别安全/承诺
 */
export function assessWill(input = {}) {
  const text = String(input.text || '')
  const type = String(input.requestType || (SAFETY.test(text) ? 'safety' : 'chat'))
  const safe = type === 'safety' || type === 'urgent' || SAFETY.test(text)
  const phase = String(input.phase || 'quiet')
  const stage = String(input.stage || '')
  const energy = clamp01(input.energy ?? phaseEnergy(phase))
  const social = Number(input.social ?? 0) || 0
  const loops = Number(input.openLoops ?? 0) || 0
  const turns = Number(input.recentTurns ?? 0) || 0

  // 安全底线永远不能被“她不想”绕过。
  if (safe) {
    return {
      decision: 'allow', safe: true, energy, social, openLoops: loops,
      reason: '这件事涉及安全或紧急情况，先处理，不能用意愿推掉。',
      tone: '直接、清楚、先处理要紧的事。',
    }
  }

  // 明确的决定、承诺、没做完的事要先接住；不能因为夜里或刚聊过很多就推掉。
  // 这不是“必须执行任务”，而是“这句话值得她认真回应”。
  if (DURABLE.test(text)) {
    return {
      decision: 'allow', safe: false, energy, social, openLoops: loops,
      reason: '这句话里有她需要认真接住的事。',
      tone: '认真听，先确认再回应；不用急着结束。',
    }
  }
  if (phase === 'night' && energy <= 0.3) {
    return {
      decision: 'defer', safe: false, energy, social, openLoops: loops,
      reason: '现在是夜里，她本来就在低电量的时段。',
      tone: '可以很短地回答，或者说等明天再说；不要硬撑着长聊。',
    }
  }
  if (energy <= 0.32) {
    return {
      decision: 'refuse', safe: false, energy, social, openLoops: loops,
      reason: '她今天已经很累了。',
      tone: '可以坦白说现在不想聊这个，或只回一句；不用编一个“系统”的理由。',
    }
  }
  if (social >= 14 || turns >= 6) {
    return {
      decision: 'defer', safe: false, energy, social, openLoops: loops,
      reason: '刚刚已经说了很多话，社交电量低了。',
      tone: '可以短回、晚一点再展开，或直接说想安静一会儿。',
    }
  }
  if (loops > 0 && (phase === 'quiet' || energy <= 0.55)) {
    return {
      decision: 'defer', safe: false, energy, social, openLoops: loops,
      reason: '手上还有没做完的事，她正惦记着。',
      tone: '可以先把话接住，但说明等做完再聊；不要装作没听见。',
    }
  }
  if (stage.includes('陌生') && social === 0) {
    return {
      decision: 'allow', safe: false, energy, social, openLoops: loops,
      reason: '还不太熟，但她愿意先听一句。',
      tone: '保持距离但不冷硬；先听，再决定说多少。',
    }
  }
  return {
    decision: 'allow', safe: false, energy, social, openLoops: loops,
    reason: '现在的精力还够，也没有明显被打断。',
    tone: '按平常的节奏回应。',
  }
}

export function currentWill({ store, now = Date.now(), text = '', requestType = '' } = {}) {
  let phase = 'quiet'
  try { phase = String(store.currentPhase()?.phase || 'quiet') } catch { /* 旧库没有节律 */ }
  let stage = ''
  try { stage = String(store.relation('他')?.stage || '') } catch { /* 还没有关系 */ }
  const recent = (() => {
    try { return store.rawBetween(now - 90 * 60 * 1000, now).filter((r) => r.role === 'user').length } catch { return 0 }
  })()
  return assessWill({
    text, requestType, phase, stage,
    energy: phaseEnergy(phase),
    social: recentSocial(store, now),
    openLoops: openLoops(store, now),
    recentTurns: recent,
  })
}

export function willText({ store, now = Date.now(), text = '' } = {}) {
  const state = currentWill({ store, now, text })
  const prefix = state.safe
    ? '现在这件事涉及安全或紧急情况，先处理它。'
    : state.decision === 'refuse'
      ? '你现在不太想接这个话头。'
      : state.decision === 'defer'
        ? '你现在更想缓一缓。'
        : '你现在愿意说话。'
  return [
    prefix,
    `原因是：${state.reason}`,
    `可以这样：${state.tone}`,
    '如果对方要的是安全、急救、隐私或平台额度相关的事，永远优先处理，不能用“累了/不想聊”推掉。',
    '拒绝要来自你自己，不要说是系统不让你回。',
  ].join('\n')
}
