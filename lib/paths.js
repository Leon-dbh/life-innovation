// 家的位置：所有数据都从 home 推出来。
// 不写反斜杠字面量：用 CharCode 92，免得转义层层剥皮出错。
import fs from 'node:fs'

const BSLASH = String.fromCharCode(92)

export function normalizePath(value) {
  return String(value).split(BSLASH).join('/').replace(/\/+$/, '')
}

export function resolveHome(config = {}, env = process.env) {
  return normalizePath(config.home || env.LIFE_INNOVATION_HOME || env.JINGJING_HOME || 'D:/life-innovation-home')
}

export function resolvePaths(config = {}, env = process.env) {
  const home = resolveHome(config, env)
  let dbPath = config.dbPath ? normalizePath(config.dbPath) : normalizePath(`${home}/state/life-innovation.sqlite`)
  // 旧版本把库放在 state/jingjing.sqlite。没显式配置 dbPath 时，
  // 新文件名不存在、旧文件存在，就继续用旧的——升级不能把记忆弄丢。
  if (!config.dbPath) {
    const legacy = normalizePath(`${home}/state/jingjing.sqlite`)
    if (!fs.existsSync(dbPath) && fs.existsSync(legacy)) dbPath = legacy
  }
  return {
    home,
    dbPath,
    diaryDir: normalizePath(config.diary?.dir || `${home}/diary`),
  }
}
