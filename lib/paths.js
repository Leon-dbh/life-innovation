// 家的位置：所有数据都从 home 推出来。
// 不写反斜杠字面量：用 CharCode 92，免得转义层层剥皮出错。
import fs from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'

const BSLASH = String.fromCharCode(92)

export function normalizePath(value) {
  return String(value).split(BSLASH).join('/').replace(/\/+$/, '')
}

const NEW_DEFAULT_HOME = 'D:/life-innovation-home'
const LEGACY_DEFAULT_HOME = 'D:/jingjing-home'

export function databaseUsable(file) {
  try {
    if (!fs.existsSync(file) || !fs.statSync(file).isFile()) return false
    const db = new DatabaseSync(file, { readOnly: true })
    try {
      for (const table of ['raw_turns', 'raw_archive', 'summaries', 'assertions', 'profiles', 'actions']) {
        try {
          const row = db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()
          if (Number(row?.n) > 0) return true
        } catch {
          // 老库可能缺表；继续看下一张。
        }
      }
      return false
    } finally {
      db.close()
    }
  } catch {
    return false
  }
}

/**
 * 没显式配置 home 时选一个默认家。
 * 0.1.x 的默认家是 D:/jingjing-home；0.2.x 改成了 D:/life-innovation-home。
 * 只升级插件、不重跑安装器时，如果新家还没有、旧家里确实有旧库，
 * 就继续用旧家——不能因为改了个默认路径就让旧记忆「消失」。
 * 新库存在但为空（比如跑 backfill 时被 MemoryStore 建出来）也不能顶掉有数据的旧库。
 */
export function defaultHome(exists = fs.existsSync, usable = databaseUsable) {
  const newDb = `${NEW_DEFAULT_HOME}/state/life-innovation.sqlite`
  const legacyDb = `${LEGACY_DEFAULT_HOME}/state/jingjing.sqlite`
  if (usable(newDb)) return NEW_DEFAULT_HOME
  if (exists(legacyDb) && usable(legacyDb)) return LEGACY_DEFAULT_HOME
  if (!exists(newDb) && exists(legacyDb)) return LEGACY_DEFAULT_HOME
  return NEW_DEFAULT_HOME
}

export function resolveHome(config = {}, env = process.env, exists = fs.existsSync, usable = databaseUsable) {
  const explicit = config.home || env.LIFE_INNOVATION_HOME || env.JINGJING_HOME
  return normalizePath(explicit || defaultHome(exists, usable))
}

// 显式 dbPath 可能是 Windows 盘符、POSIX 绝对路径或相对路径。
// 在 Linux CI 里不能把 E:/... 当成相对路径再 path.resolve，否则会变成 /cwd/E:/...
function resolveDbPath(value) {
  const raw = normalizePath(String(value))
  if (/^[A-Za-z]:\//.test(raw) || raw.startsWith('/') || raw.startsWith('//')) return raw
  return normalizePath(path.resolve(raw))
}

export function resolvePaths(config = {}, env = process.env, deps = {}) {
  const exists = deps.exists || fs.existsSync
  const usable = deps.usable || databaseUsable
  const home = resolveHome(config, env, exists, usable)
  let dbPath = config.dbPath ? resolveDbPath(config.dbPath) : normalizePath(`${home}/state/life-innovation.sqlite`)
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
