import test from 'node:test'
import assert from 'node:assert/strict'
import { createSessionDelivery } from '../lib/session.js'

function makeDelivery(running) {
  return createSessionDelivery({
    controller: { list: async () => ({ items: [{ sessionId: 'chat-whale-test', running }] }) },
    config: { session: { id: 'chat-whale-test' } },
    cwd: process.cwd(),
    log: () => {},
  })
}

test('busy asks sessionController.list instead of scanning the session filesystem', async () => {
  assert.equal(await makeDelivery(true).busy(), true)
  assert.equal(await makeDelivery(false).busy(), false)
})

test('busy degrades to false when list fails', async () => {
  const delivery = createSessionDelivery({
    controller: { list: async () => { throw new Error('boom') } },
    config: { session: { id: 'chat-whale-test' } },
    cwd: process.cwd(),
    log: () => {},
  })
  assert.equal(await delivery.busy(), false)
})
