import assert from 'node:assert/strict'
import { normalizePath, resolveHome, resolvePaths } from '../lib/paths.js'

const BS = String.fromCharCode(92)

// Windows 分隔符统一成 /；结尾斜杠去掉
assert.equal(normalizePath('D:' + BS + 'jingjing-home' + BS), 'D:/jingjing-home')
assert.equal(normalizePath('D:/jingjing-home///'), 'D:/jingjing-home')

// home 优先 config，其次环境变量，最后默认
assert.equal(resolveHome({ home: 'E:' + BS + 'jj' }), 'E:/jj')
assert.equal(resolveHome({}, { JINGJING_HOME: 'F:' + BS + 'x' }), 'F:/x')
assert.equal(resolveHome({}, {}), 'D:/life-innovation-home')
assert.equal(resolveHome({}, { JINGJING_HOME: 'D:/legacy-home' }), 'D:/legacy-home')
assert.equal(resolveHome({}, { LIFE_INNOVATION_HOME: 'D:/new-home' }), 'D:/new-home')

// 记忆库与日记跟着家走；显式 dbPath 仍然优先
const p = resolvePaths({ home: 'E:' + BS + 'jj' }, {})
assert.equal(p.dbPath, 'E:/jj/state/life-innovation.sqlite')
assert.equal(p.diaryDir, 'E:/jj/diary')
assert.equal(resolvePaths({ dbPath: 'X:/a/b.sqlite' }, {}).dbPath, 'X:/a/b.sqlite')
assert.equal(resolvePaths({ diary: { dir: 'Y:' + BS + 'd' } }, {}).diaryDir, 'Y:/d')

console.log('OK: paths（home/环境变量/分隔符/优先级）')
