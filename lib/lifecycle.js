/**
 * 记忆的生命周期：不删除，但会「变淡」。
 *
 * 借 dsh-fish-memory 的双半衰期：普通原话 30 天半衰、情绪句 7 天；
 * 长期事实（画像里的名字/住处/工作等）不参与衰减，每轮都在。
 *
 * 半衰期的意思：过了 30 天，这条原话在召回里的「新鲜度」剩一半；
 * 不是删掉，也不是说她想不起来——只是越来越难被排到前面。
 */
export const HALF_LIFE_DAYS = 30
export const EMOTION_HALF_LIFE_DAYS = 7
const DAY = 86400000
const EMOTION = /(难过|伤心|害怕|怕|累|生气|烦|想念|想你|开心|高兴|焦虑|紧张|哭|喜欢|讨厌)/

export function ageDays(ts, now = Date.now()) {
  return Math.max(0, (now - Number(ts || 0)) / DAY)
}

export function halfLifeDays(text) {
  return EMOTION.test(String(text || '')) ? EMOTION_HALF_LIFE_DAYS : HALF_LIFE_DAYS
}

/** 0..1 之间；刚说的话接近 1，越旧越接近 0。 */
export function vitalityOf(ts, now = Date.now(), text = '') {
  const age = ageDays(ts, now)
  return Math.pow(0.5, age / halfLifeDays(text))
}

/** 给状态页用：把生命力翻译成人话。 */
export function vitalityLabel(value) {
  if (value >= 0.7) return '新'
  if (value >= 0.3) return '还记得'
  if (value >= 0.1) return '有点淡了'
  return '很旧了'
}
