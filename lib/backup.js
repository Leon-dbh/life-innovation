/**
 * 备份/恢复一个正在使用的 SQLite 库。
 *
 * 为什么不能 fs.copyFileSync：宿主开着 WAL，最新的事务可能还在 `-wal` 里，
 * 只拷主库会得到一个「看起来有文件、打开却是旧数据甚至空库」的备份。
 * 之前 import 校验失败时把这种空备份拷回去，会直接清空她的记忆。
 *
 * VACUUM INTO 会自己处理 WAL、拿一致快照，是这里唯一安全的做法。
 */
import fs from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'

function sqlString(file) {
  return `'${String(file).replaceAll("'", "''")}'`
}

/** 用 VACUUM INTO 生成一份一致快照；目标已存在会先删掉。 */
export function snapshotDatabase(dbPath, outPath) {
  if (!fs.existsSync(dbPath)) throw new Error(`记忆库不存在：${dbPath}`)
  fs.mkdirSync(path.dirname(outPath), { recursive: true })
  fs.rmSync(outPath, { force: true })
  const db = new DatabaseSync(dbPath, { readOnly: true })
  try {
    db.exec('PRAGMA busy_timeout = 5000')
    db.exec(`VACUUM INTO ${sqlString(outPath)}`)
  } finally {
    db.close()
  }
  return outPath
}

/** 主库必须和 -wal/-shm 一起删；只换主库会把旧日志留在原地。 */
export function removeDbFiles(file) {
  for (const f of [file, `${file}-wal`, `${file}-shm`]) fs.rmSync(f, { force: true })
}

/** 把备份换回主库位置，并清掉旧日志。 */
export function restoreDatabase(dbPath, backupPath) {
  removeDbFiles(dbPath)
  fs.mkdirSync(path.dirname(dbPath), { recursive: true })
  fs.copyFileSync(backupPath, dbPath)
}
