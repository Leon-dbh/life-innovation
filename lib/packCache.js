/**
 * 记忆包缓存：指纹不变就复用同一段文字。
 *
 * 借 dsh-world 的一条经验：系统提示词每变一个字，provider 的前缀缓存就整段失效。
 * 所以记忆块只在「记忆真的变了」时重建：
 * - 日期变了（今天的日子/昨天/今天的标签会变）
 * - 有新的 live 断言（新事实或旧事实被取代）
 * - 有新的动作（她真的做了事）
 * 会话内「最近说的话」会随对话变化，这部分交给历史本身，不进每轮重算。
 */
import { buildPack } from './pack.js'

export function createPackCache({ store, maxChars = 1200, subject = '他' }) {
  let text = ''
  let fingerprint = ''
  let builtAt = 0
  let builds = 0

  return {
    get(now = Date.now()) {
      const next = store.fingerprint(now)
      if (text && next === fingerprint) return text
      text = buildPack({ store, now, maxChars, subject })
      fingerprint = next
      builtAt = now
      builds += 1
      return text
    },
    stats() {
      return { builds, builtAt, fingerprint }
    },
  }
}
