/** 从原话重建要点与画像（抽取规则改了以后用；只按时间顺序重放 user 原话）。 */
import { MemoryStore } from '../lib/store.js'
import { extractAssertions } from '../lib/extract.js'

const file = process.argv[2] || 'D:/jingjing-home/state/jingjing.sqlite'
const store = new MemoryStore(file)
store.db.exec('DELETE FROM assertions')
store.db.exec('DELETE FROM profiles')

let facts = 0
for (const row of store.recentRaw(1000)) {
  if (row.role !== 'user') continue
  for (const item of extractAssertions(row.text)) {
    store.addAssertion({ ts: row.ts, subject: '他', predicate: item.predicate, value: item.value, source: row.text })
    if (!item.predicate.startsWith('计划:')) {
      store.setProfile('他', item.predicate, item.value, row.text.slice(0, 120), row.ts)
    }
    facts += 1
  }
}
console.log(`rebuild done, ${facts} facts`)
store.close()
