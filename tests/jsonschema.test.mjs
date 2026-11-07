import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { MemoryStore } from '../lib/store.js'
import { registerMemoryTools } from '../lib/tools.js'

/**
 * 宿主的 JSON Schema 是受限子集（dsh-tools/lib/index.js 的 checkSchemaNode）：
 * - additionalProperties 必须是布尔，不能是 schema；
 * - type 只能是一个字符串，不能是数组；
 * - oneOf 至少两个分支，且旁边不能有 properties/required/additionalProperties/items/enum/const；
 * - required 里的名字必须在 properties 里；
 * - 嵌套对象只能逐字段声明。
 * 一旦违反，ctx.tools.register 会在 apply 里抛错，宿主只往 .err 写一句
 * “entry did not activate”，主日志看不到——M3.2 就是这么被坑的。
 * 这个测试只校验我们自己的工具定义，不依赖宿主安装路径。
 */

const ANNOTATION = new Set(['description', 'title', 'default', 'examples'])
const CONSTRAINT = new Set([
  'type', 'properties', 'required', 'additionalProperties', 'items',
  'enum', 'const', 'oneOf', 'minimum', 'maximum', 'minLength', 'maxLength', 'pattern',
])
const TYPES = new Set(['object', 'array', 'string', 'number', 'integer', 'boolean', 'null'])

function walk(node, at, errors) {
  if (Array.isArray(node)) {
    errors.push(`${at} must be a schema object, got array`)
    return
  }
  if (!node || typeof node !== 'object') {
    errors.push(`${at} must be a schema object`)
    return
  }
  for (const key of Object.keys(node)) {
    if (!ANNOTATION.has(key) && !CONSTRAINT.has(key)) errors.push(`${at}.${key} 不在宿主允许的关键字里`)
  }
  if ('type' in node) {
    if (typeof node.type !== 'string') errors.push(`${at}.type 必须是单个字符串`)
    else if (!TYPES.has(node.type)) errors.push(`${at}.type 未知：${node.type}`)
  }
  if ('additionalProperties' in node && typeof node.additionalProperties !== 'boolean') {
    errors.push(`${at}.additionalProperties 必须是布尔`)
  }
  if ('oneOf' in node) {
    if (!Array.isArray(node.oneOf) || node.oneOf.length < 2) errors.push(`${at}.oneOf 至少两个分支`)
    for (const sibling of ['properties', 'required', 'additionalProperties', 'items', 'enum', 'const']) {
      if (sibling in node) errors.push(`${at}.${sibling} 不能和 oneOf 并列`)
    }
    node.oneOf.forEach((branch, i) => walk(branch, `${at}.oneOf[${i}]`, errors))
  }
  if ('properties' in node) {
    if (!node.properties || typeof node.properties !== 'object' || Array.isArray(node.properties)) {
      errors.push(`${at}.properties 必须是对象`)
    } else {
      for (const [name, child] of Object.entries(node.properties)) walk(child, `${at}.properties.${name}`, errors)
    }
  }
  if ('required' in node) {
    if (!Array.isArray(node.required) || node.required.some((x) => typeof x !== 'string')) {
      errors.push(`${at}.required 必须是字符串数组`)
    } else if (node.properties) {
      for (const name of node.required) {
        if (!Object.hasOwn(node.properties, name)) errors.push(`${at}.required 引用了未声明的 ${name}`)
      }
    }
  }
  if ('items' in node) walk(node.items, `${at}.items`, errors)
  if ('enum' in node && (!Array.isArray(node.enum) || node.enum.length === 0)) errors.push(`${at}.enum 不能为空`)
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jingjing-schema-'))
const store = new MemoryStore(path.join(dir, 'schema.sqlite'))
const registry = new Map()
const ctx = { tools: { register: (def) => { registry.set(def.name, def); return () => registry.delete(def.name) } } }
const dispose = registerMemoryTools({ ctx, store, hands: {} })
assert.equal(registry.size, 13, '十三个工具都要注册')

for (const [name, def] of registry) {
  assert.equal(typeof def.description, 'string')
  const errors = []
  walk(def.parameters, `${name}.parameters`, errors)
  walk(def.output.schema, `${name}.output.schema`, errors)
  assert.deepEqual(errors, [], `${name} 的 schema 不符合宿主子集：\n${errors.join('\n')}`)
  assert.equal(typeof def.execute, 'function')
  assert.equal(typeof def.output.render, 'function')
}

// 真实地跑一遍输出校验的「形状」：status 的 null 字段必须能被 oneOf 接受。
const status = registry.get('life_status')
const out = await status.execute({})
assert.ok(out.stats && typeof out.stats.raw === 'number')
for (const key of ['lastPack', 'lastRecall', 'relation']) {
  assert.ok(out[key] === null || typeof out[key] === 'object', `${key} 只能是 object 或 null`)
}

dispose()
store.close()
fs.rmSync(dir, { recursive: true, force: true })
console.log('OK: 工具 schema 符合宿主受限子集（additionalProperties 布尔 / oneOf / required 一致）')
