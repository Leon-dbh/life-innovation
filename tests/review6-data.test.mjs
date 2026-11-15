import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { MemoryStore } from '../lib/store.js'
import { maybeSummarize } from '../lib/summaries.js'
import { createHands, isPrivateHost } from '../lib/hands.js'

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jingjing-review6-data-'))
const dbFile = path.join(dir, 'data.sqlite')
const cleanup = () => fs.rmSync(dir, { recursive: true, force: true })
process.on('exit', cleanup)

try {
  // 只读打开：能读，但任何写操作都由 SQLite 拒绝。
  {
    const writable = new MemoryStore(dbFile)
    writable.addRaw(1000, 's1', 'user', '只读测试')
    writable.close()
    const readonly = new MemoryStore(dbFile, { readonly: true })
    assert.equal(readonly.countRaw(), 1)
    assert.throws(() => readonly.addRaw(2000, 's1', 'user', '不该写进去'), /readonly|read-only/i)
    readonly.close()
  }

  // 恢复的旧 id 落在梗概水位以下：进 backlog，下一次梗概仍能看到它。
  {
    const store = new MemoryStore(path.join(dir, 'backlog.sqlite'))
    for (let i = 1; i <= 3; i += 1) store.addRaw(1000 + i, 's1', i % 2 ? 'user' : 'her', `旧原话 ${i}`)
    store.addSummary(2000, 's1', '旧梗概', 1000, 1003, 3, ['raw:1', 'raw:2', 'raw:3'])
    const bin = store.recycleRaw(2, { reason: '测试恢复' })
    assert.ok(bin > 0)
    const restored = store.recycleRestore(bin)
    assert.equal(restored.id, 2)
    assert.deepEqual(store.summaryBacklogRows().map((r) => r.id), [2])

    for (let i = 4; i <= 9; i += 1) store.addRaw(1000 + i, 's1', i % 2 ? 'user' : 'her', `新原话 ${i}`)
    const out = maybeSummarize({ store, batch: 4, keepRecent: 1, ts: 3000 })
    assert.ok(out, '应该生成一条梗概')
    assert.ok(out.sourceRefs.includes('raw:2'), '恢复的原话必须进梗概')
    assert.deepEqual(store.summaryBacklogRows(), [], '消费后应清空 backlog')
    store.close()
  }

  // FTS 行数相同但内容漂移：重开库时要按 count+chars+maxId 指纹重建。
  {
    const driftFile = path.join(dir, 'drift.sqlite')
    const first = new MemoryStore(driftFile)
    if (first.searchAvailable) {
      first.addRaw(1000, 's1', 'user', '原始正文')
      first.db.prepare("UPDATE raw_fts SET text = '被篡改' WHERE rowid = 1").run()
      first.close()
      const second = new MemoryStore(driftFile)
      const row = second.db.prepare('SELECT text FROM raw_fts WHERE rowid = 1').get()
      assert.equal(row.text, '原始正文')
      second.close()
    } else {
      first.close()
    }
  }

  // 频率额度按尝试算：失败/取消也消耗次数。
  {
    const store = new MemoryStore(path.join(dir, 'quota.sqlite'))
    const now = Date.now()
    for (const [i, status] of ['ok', 'error', 'called'].entries()) {
      store.addAction({ ts: now, kind: 'tool', tool: 'notify', summary: status, callId: `q-${i}`, status })
    }
    assert.equal(store.countActionsSince('notify', now - 1), 1)
    assert.equal(store.countActionAttemptsSince('notify', now - 1), 3)
    store.close()
  }

  // IPv6 里藏私网：NAT64 / 6to4 都要拒绝。
  {
    const noDns = async () => { throw new Error('字面量 IP 不应解析') }
    for (const host of ['[64:ff9b::7f00:1]', '[2002:7f00:1::]']) {
      assert.equal(await isPrivateHost(host, noDns), true, `${host} 应判为内网`)
    }
    assert.equal(await isPrivateHost('[2606:4700:4700::1111]', noDns), false)
  }

  // 网页正文缺少 content-type：不能靠“看起来像 HTML”猜。
  {
    const store = new MemoryStore(path.join(dir, 'ctype.sqlite'))
    const hands = createHands({
      home: dir,
      store,
      dnsLookup: async () => [{ address: '93.184.216.34', family: 4 }],
      fetchImpl: async (url) => ({
        ok: true, status: 200, url,
        headers: { get: () => null },
        arrayBuffer: async () => Buffer.from('<html><body>正文</body></html>'),
      }),
    })
    await assert.rejects(
      () => hands.webRead({ url: 'https://example.com/no-type' }),
      /网页正文类型/,
    )
    store.close()
  }

  console.log('OK: review6 data（只读库/恢复 backlog/FTS 漂移/尝试额度/IPv6 私网/content-type）')
} finally {
  cleanup()
}
