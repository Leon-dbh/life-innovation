/**
 * 提示词纪律：插件的 persona 只能介绍处境/能力/记忆边界，
 * 不能写性格、语气、台词、关系或行为脚本——这一层不能靠人记得，得进 CI。
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'

const file = new URL('../cordis.patch.yml', import.meta.url)
const source = fs.readFileSync(file, 'utf8')

// 取 persona 的 prefix 块（`prefix: |` 之后缩进更深的部分），去公共缩进。
const match = /prefix:\s*\|\n([\s\S]*?)(?=\n {12}\S|\n {0,10}-\s|\s*$)/.exec(source)
assert.ok(match, 'cordis.patch.yml 里应能找到 persona.prefix 块')
const indent = Math.min(...match[1].split('\n').filter((l) => l.trim()).map((l) => l.match(/^ */)[0].length))
const prefix = match[1].split('\n').map((l) => l.slice(indent)).join('\n').trim()

assert.ok(prefix.includes('你叫鲸鲸'), '名字是唯一允许的事实种子')
assert.equal((prefix.match(/你叫鲸鲸/g) || []).length, 1, '名字只出现一次，不算重复强调')

const forbidden = [
  '你是一个', '你不是', '性格', '脾气', '语气', '说话习惯', '句末', '台词',
  '对方：', '扮演', '人设', '喜欢', '爱你', '想你', '关系', '女朋友', '女朋友',
]
for (const word of forbidden) assert.ok(!prefix.includes(word), `persona 里不能出现「${word}」：这是人设，不是处境`)

// 只允许三段事实（名字/处境能力/记忆方式），不许多出「你应该怎么说话」。
assert.ok(prefix.includes('你能做的事'), '应说明能力边界')
assert.ok(prefix.includes('想不起来'), '应说明记忆边界')

console.log('OK: prompt policy（只有事实，没有角色扮演）')
