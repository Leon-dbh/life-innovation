/** 改了抽取规则之后，把历史原话重新过一遍，补上漏掉的要点（幂等）。 */
import { MemoryStore } from '../lib/store.js'
import { extractAssertions } from '../lib/extract.js'

const file = process.argv[2] || 'D:/jingjing-home/state/jingjing.sqlite'
const store = new MemoryStore(file)
let added = 0
for (const row of store.recentRaw(1000)) {
  if (row.role !== 'user') continue
  for (const item of extractAssertions(row.text)) {
    const live = store.liveAssertions('他', 100).find((a) => a.predicate === item.predicate)
    if (live && live.value === item.value) continue
    store.addAssertion({ ts: row.ts, subject: '他', predicate: item.predicate, value: item.value, source: row.text })
    if (!item.predicate.startsWith('计划:')) {
      store.setProfile('他', item.predicate, item.value, row.text.slice(0, 120), row.ts)
    }
    added += 1
  }
}
console.log(`backfill done, added ${added}`)
store.close()
