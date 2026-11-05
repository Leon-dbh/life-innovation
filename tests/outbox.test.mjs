import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { Outbox, OUTBOX_STATES, recordDelivery } from '../lib/outbox.js'

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jingjing-outbox-'))
const db = new DatabaseSync(path.join(dir, 'outbox.sqlite'))
const outbox = new Outbox(db)
const now = Date.now()

const a = outbox.create({ channel: 'web', target: '他', text: '喝口水', now })
assert.equal(a.state, 'pending')
assert.equal(a.attempts, 0)

assert.equal(outbox.markSent(a.id, now + 1), true)
assert.equal(outbox.get(a.id).state, 'sent')
assert.equal(outbox.get(a.id).attempts, 1)

// sent 是终点：不能再退回 pending
assert.equal(outbox.retry(a.id, now + 2), false)
assert.equal(outbox.get(a.id).state, 'sent')

const b = outbox.create({ channel: 'web', target: '他', text: '到点了', now })
assert.equal(outbox.markUncertain(b.id, 'timeout', now + 1), true)
assert.equal(outbox.get(b.id).state, 'uncertain')
assert.equal(outbox.markSent(b.id, now + 2), true, 'uncertain 可以补成 sent')
assert.equal(outbox.get(b.id).attempts, 2)

const c = outbox.create({ channel: 'web', target: '他', text: '算了', now })
assert.equal(outbox.markFailed(c.id, 'rejected', now + 1), true)
assert.equal(outbox.retry(c.id, now + 2), true, 'failed 允许重试')
assert.equal(outbox.get(c.id).state, 'pending')

assert.equal(outbox.transition(a.id, 'nope'), false, '非法状态拒绝迁移')
assert.deepEqual(OUTBOX_STATES, ['pending', 'sent', 'uncertain', 'failed'])

const recordedWithoutAck = recordDelivery(outbox, { channel: 'web', target: '他', text: '没确认', outcome: 'unknown', error: 'timeout', now: now + 5 })
assert.equal(recordedWithoutAck.state, 'uncertain', '没确认不许写成 sent')

const recordedSent = recordDelivery(outbox, { channel: 'web', target: '他', text: '确认了', outcome: 'sent', now: now + 6 })
assert.equal(recordedSent.state, 'sent')
assert.equal(outbox.recent(3).length, 3)

db.close()
fs.rmSync(dir, { recursive: true, force: true })
console.log('OK: outbox pending/sent/uncertain/failed')
