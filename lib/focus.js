/**
 * 每一轮的话题只能属于发起它的会话。
 *
 * 以前插件用一个全局 latestUserText，A 会话说完话、B 会话再开口时，
 * B 的相关旧事和意愿判断会读到 A 的最后一句话。这里按 session 分开存，
 * 并且只保留最近一小段，避免会话一多就把内存撑大。
 */
export function createFocusState(maxSessions = 200) {
  const sessions = new Map()
  const limit = Math.max(1, Math.trunc(Number(maxSessions) || 200))

  return {
    set(sessionId, text) {
      const id = String(sessionId || '')
      if (!id) return
      const value = String(text || '')
      if (!value) return
      // 重新插入，让最近用过的会话排到队尾。
      sessions.delete(id)
      sessions.set(id, value)
      while (sessions.size > limit) {
        const oldest = sessions.keys().next().value
        sessions.delete(oldest)
      }
    },
    get(sessionId) {
      const id = String(sessionId || '')
      return id ? (sessions.get(id) || '') : ''
    },
    clear() {
      sessions.clear()
    },
    get size() {
      return sessions.size
    },
  }
}
