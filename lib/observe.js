/**
 * 可观测性：她这一轮「想起了什么、为什么」，以及记忆包是怎么拼出来的。
 *
 * 只放内存（环形缓冲），不写库：这是给调试/状态工具看的，不是记忆本身。
 * 进程重启就清空——状态页看的是「现在」，不是历史审计。
 */
const MAX_PACKS = 8
const MAX_RECALLS = 12

const state = {
  packs: [],
  recalls: [],
  startedAt: Date.now(),
}

export function recordPack(entry) {
  state.packs.push({ at: Date.now(), ...entry })
  if (state.packs.length > MAX_PACKS) state.packs.splice(0, state.packs.length - MAX_PACKS)
}

export function recordRecall(entry) {
  state.recalls.push({ at: Date.now(), ...entry })
  if (state.recalls.length > MAX_RECALLS) state.recalls.splice(0, state.recalls.length - MAX_RECALLS)
}

export function snapshot() {
  return {
    startedAt: state.startedAt,
    packs: state.packs.slice(),
    recalls: state.recalls.slice(),
  }
}

/** 只给测试用：清空环形缓冲。 */
export function resetObserve() {
  state.packs.length = 0
  state.recalls.length = 0
}
