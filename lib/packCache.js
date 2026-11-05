/**
 * 记忆包缓存：指纹不变就复用同一段文字。
 *
 * 借 dsh-world 的一条经验：系统提示词每变一个字，provider 的前缀缓存就整段失效。
 * 所以记忆块只在「记忆真的变了」时重建：
 * - 日期变了（今天的日子/昨天/今天的标签会变）
 * - 有新的 live 断言（新事实或旧事实被取代）、新的梗概、画像更新
 * - 有新的动作（她真的做了事）
 * 每次命中/重建都会记一条可观测事件（见 observe.js），供 jingjing_status 看。
 */
import { buildPackDetailed } from './pack.js'
import { recordPack } from './observe.js'

export function createPackCache({ store, maxChars = 1200, subject = '他' }) {
  let text = ''
  let fingerprint = ''
  let builtAt = 0
  let builds = 0
  let sections = []

  return {
    get(now = Date.now()) {
      const next = store.fingerprint(now)
      if (text && next === fingerprint) {
        recordPack({ cache: 'hit', chars: text.length, sections, fingerprint, now })
        return text
      }
      const built = buildPackDetailed({ store, now, maxChars, subject })
      text = built.text
      sections = built.sections
      fingerprint = next
      builtAt = now
      builds += 1
      recordPack({ cache: 'build', chars: text.length, sections, fingerprint, now })
      return text
    },
    stats() {
      return { builds, builtAt, fingerprint, sections }
    },
  }
}
