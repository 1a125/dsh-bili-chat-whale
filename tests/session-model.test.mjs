import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// lib/session.js 在 import 时就把 SESSION_PATH 定下来了 —— 必须先指到临时目录再动态导入，
// 否则测试会往真实的 ~/.dsh/chat-whale 里写东西。
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'chat-whale-session-'))
process.env.DSH_HOME = home
process.env.CHAT_WHALE_CONFIG = path.join(home, 'test.config.json')
const { createSessionDelivery } = await import('../lib/session.js')

const CONFIG = { session: { id: 'chat-whale-model-test' } }

function fakeController({ selectModel } = {}) {
  const calls = { create: 0, prompt: 0, selectModel: [] }
  const controller = {
    list: async () => ({ items: [] }),
    create: async () => { calls.create += 1 },
    prompt: async () => { calls.prompt += 1 },
  }
  if (selectModel !== false) {
    controller.selectModel = async (request) => {
      calls.selectModel.push(request)
      if (typeof selectModel === 'function') return selectModel(request)
      return { selected: { provider: request.provider, model: request.model } }
    }
  }
  return { controller, calls }
}

test('send selects the configured model before prompting', async () => {
  const { controller, calls } = fakeController()
  const logs = []
  const delivery = createSessionDelivery({ controller, config: CONFIG, cwd: home, log: (line) => logs.push(line) })
  await delivery.send('看看这间', { model: { provider: 'p1', model: 'm1', reasoningEffort: 'high' } })

  assert.equal(calls.selectModel.length, 1)
  assert.deepEqual(calls.selectModel[0], {
    sessionId: 'chat-whale-model-test',
    provider: 'p1',
    model: 'm1',
    reasoningEffort: 'high',
  })
  assert.equal(calls.prompt, 1)
})

test('send omits reasoningEffort when the config leaves it empty', async () => {
  const { controller, calls } = fakeController()
  const delivery = createSessionDelivery({ controller, config: CONFIG, cwd: home, log: () => {} })
  await delivery.send('你好', { model: { provider: 'p2', model: 'm2', reasoningEffort: '' } })
  assert.equal(calls.selectModel.length, 1)
  assert.equal('reasoningEffort' in calls.selectModel[0], false)
})

test('send does not call selectModel when no model is configured', async () => {
  const { controller, calls } = fakeController()
  const delivery = createSessionDelivery({ controller, config: CONFIG, cwd: home, log: () => {} })
  await delivery.send('随便看看', { model: { provider: '', model: '', reasoningEffort: '' } })
  await delivery.send('还是随便看看')
  assert.equal(calls.selectModel.length, 0)
  assert.equal(calls.prompt, 2)
})

test('selectModel is only called again after the route changes', async () => {
  const { controller, calls } = fakeController()
  const delivery = createSessionDelivery({ controller, config: CONFIG, cwd: home, log: () => {} })
  const model = { provider: 'p1', model: 'm1', reasoningEffort: '' }
  await delivery.send('第一条', { model })
  await delivery.send('第二条', { model })
  assert.equal(calls.selectModel.length, 1)
  await delivery.send('第三条', { model: { provider: 'p1', model: 'm1', reasoningEffort: 'low' } })
  assert.equal(calls.selectModel.length, 2)
  await delivery.send('第四条', { model: { provider: 'p9', model: 'm9', reasoningEffort: 'low' } })
  assert.equal(calls.selectModel.length, 3)
  assert.equal(calls.prompt, 4)
})

test('a failing selectModel still lets the prompt through', async () => {
  const { controller, calls } = fakeController({ selectModel: () => { throw new Error('模型不存在') } })
  const logs = []
  const delivery = createSessionDelivery({ controller, config: CONFIG, cwd: home, log: (line) => logs.push(line) })
  await delivery.send('照样叫醒', { model: { provider: 'bad', model: 'nope', reasoningEffort: '' } })
  assert.equal(calls.prompt, 1)
  assert.ok(logs.some((line) => line.includes('切换会话模型失败')), '失败要记日志')
})

test('a controller without selectModel keeps waking the agent', async () => {
  const { controller, calls } = fakeController({ selectModel: false })
  const logs = []
  const delivery = createSessionDelivery({ controller, config: CONFIG, cwd: home, log: (line) => logs.push(line) })
  await delivery.send('老宿主', { model: { provider: 'p1', model: 'm1', reasoningEffort: '' } })
  assert.equal(calls.prompt, 1)
  assert.ok(logs.some((line) => line.includes('没有 selectModel')))
})
