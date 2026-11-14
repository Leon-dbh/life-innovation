import assert from 'node:assert/strict'
import { termsOf } from '../lib/search.js'

// 长问句的 bigram 会占满 16 个名额；同义词不能被自己的长度截掉。
{
  const terms = termsOf('你还记得我上次跟你说的那个工作单位的事情吗')
  assert.ok(terms.includes('上班'))
  assert.ok(terms.includes('公司'))
  assert.ok(terms.includes('单位'))
  assert.ok(terms.includes('工作'))
  assert.equal(new Set(terms).size, terms.length)
  assert.ok(terms.length <= 16)
}

// 短问句仍然保留原有的词面 + 单字 + 同义词。
{
  const terms = termsOf('你还记得我养的那只猫吗')
  assert.ok(terms.includes('猫'))
  assert.ok(terms.includes('记得'))
  assert.ok(terms.length <= 16)
}

console.log('OK: search 词面/同义词扩展')
