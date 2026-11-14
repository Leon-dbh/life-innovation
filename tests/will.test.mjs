import assert from 'node:assert/strict'
import { assessWill, currentWill, willText } from '../lib/will.js'

// 安全/紧急永远优先，哪怕她夜里低电量。
const safe = assessWill({ phase: 'night', energy: 0.05, social: 30, text: '我胸口疼，帮我叫急救' })
assert.equal(safe.decision, 'allow')
assert.equal(safe.safe, true)
assert.match(safe.reason, /安全|紧急/)

const explicitSafety = assessWill({ phase: 'night', energy: 0.1, requestType: 'safety' })
assert.equal(explicitSafety.decision, 'allow')

// 夜里低电量：不硬聊，但也不是系统拦截。
const night = assessWill({ phase: 'night', energy: 0.2, text: '在吗' })
assert.equal(night.decision, 'defer')
assert.match(night.reason, /夜里/)

// 很累：可以直接说不想接。
const tired = assessWill({ phase: 'quiet', energy: 0.2, text: '陪我聊会儿' })
assert.equal(tired.decision, 'refuse')

// 刚说过太多：缓一缓。
const social = assessWill({ phase: 'awake', energy: 0.8, social: 15, text: '再来一局' })
assert.equal(social.decision, 'defer')
assert.match(social.reason, /说了很多|社交/)

// 手上有没做完的事：先接住，但说明晚点。
const loops = assessWill({ phase: 'quiet', energy: 0.5, openLoops: 1, text: '你在干嘛' })
assert.equal(loops.decision, 'defer')
assert.match(loops.reason, /没做完/)

// 普通状态：愿意说话。
const ok = assessWill({ phase: 'awake', energy: 0.8, social: 1, text: '今天过得怎么样' })
assert.equal(ok.decision, 'allow')

// 明确的承诺/决定要认真接住，不拿“忙”敷衍。
const durable = assessWill({ phase: 'quiet', energy: 0.5, openLoops: 2, social: 0, text: '我答应你明天去医院' })
assert.equal(durable.decision, 'allow')

// 承诺优先于夜里低电量/社交电量：不能因为累或刚聊过很多就把答应的事推掉。
const durableAtNight = assessWill({ phase: 'night', energy: 0.1, social: 15, openLoops: 2, text: '我答应你明天去医院' })
assert.equal(durableAtNight.decision, 'allow')
assert.match(durableAtNight.reason, /认真接住|需要认真/)

// 提示词只给基调，不暴露分数；安全底线写死。
const text = willText({ now: Date.now(), text: '我有点难受' })
assert.match(text, /安全|急救|隐私|额度/)
assert.match(text, /不能.*推掉|永远优先/)
assert.doesNotMatch(text, /energy|social|0\.\d/)

// currentWill 从 store 读节律/关系/最近原话；没有这些方法时也能退回安静。
const store = {
  currentPhase: () => ({ phase: 'awake' }),
  relation: () => ({ stage: '熟悉' }),
  rawBetween: () => [{ role: 'user' }, { role: 'her' }],
  livePlans: () => [],
}
const state = currentWill({ store, now: Date.now(), text: '在吗' })
assert.equal(state.decision, 'allow')
assert.equal(state.safe, false)

console.log('OK: 意愿层（安全底线、夜里/低电量、社交电量、未完成计划、提示词基调）')
