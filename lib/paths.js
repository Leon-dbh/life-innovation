// 家的位置：所有数据都从 home 推出来。
// 不写反斜杠字面量：用 CharCode 92，免得转义层层剥皮出错。
import fs from 'node:fs'

const BSLASH = String.fromCharCode(92)

export function normalizePath(value) {
  return String(value).split(BSLASH).join('/').replace(/\/+$/, '')
}

const NEW_DEFAULT_HOME = 'D:/life-innovation-home'
const LEGACY_DEFAULT_HOME = 'D:/jingjing-home'

/**
 * 没显式配置 home 时选一个默认家。
 * 0.1.x 的默认家是 D:/jingjing-home；0.2.x 改成了 D:/life-innovation-home。
 * 只升级插件、不重跑安装器时，如果新家还没有、旧家里确实有旧库，
 * 就继续用旧家——不能因为改了个默认路径就让旧记忆「消失」。
 */
export function defaultHome(exists = fs.existsSync) {
  const newDb = `${NEW_DEFAULT_HOME}/state/life-innovation.sqlite`
  const legacyDb = `${LEGACY_DEFAULT_HOME}/state/jingjing.sqlite`
  // 只看新库里有没有东西；新目录可能已经建了，但 state 还是空的。
  if (!exists(newDb) && exists(legacyDb)) return LEGACY_DEFAULT_HOME
  return NEW_DEFAULT_HOME
}

export function resolveHome(config = {}, env = process.env, exists = fs.existsSync) {
  const explicit = config.home || env.LIFE_INNOVATION_HOME || env.JINGJING_HOME
  return normalizePath(explicit || defaultHome(exists))
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
