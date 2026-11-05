// 家的位置：所有数据都从 home 推出来。
// 不写反斜杠字面量：用 CharCode 92，免得转义层层剥皮出错。
const BSLASH = String.fromCharCode(92)

export function normalizePath(value) {
  return String(value).split(BSLASH).join('/').replace(/\/+$/, '')
}

export function resolveHome(config = {}, env = process.env) {
  return normalizePath(config.home || env.JINGJING_HOME || 'D:/jingjing-home')
}

export function resolvePaths(config = {}, env = process.env) {
  const home = resolveHome(config, env)
  return {
    home,
    dbPath: normalizePath(config.dbPath || `${home}/state/jingjing.sqlite`),
    diaryDir: normalizePath(config.diary?.dir || `${home}/diary`),
  }
}
