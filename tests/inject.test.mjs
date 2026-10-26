import test from 'node:test'
import assert from 'node:assert/strict'
import { AsrEngine } from '../lib/asr.js'
import { VisionEngine } from '../lib/vision.js'
import { readConfig } from '../lib/config.js'

// 模拟 Cordis 的 inject 栅栏：除 ctx.get() 外，任何属性访问都抛错。
// 这个回归测试锁住「可选服务必须用 ctx.get 读」——曾经导致设置页整页读取失败。
const strictCtx = new Proxy({}, {
  get(_target, prop) {
    if (prop === 'get') return () => undefined
    throw new Error(`cannot get property "${String(prop)}" without inject`)
  },
})

test('AsrEngine.status never reads optional services without ctx.get', () => {
  const engine = new AsrEngine({ ctx: strictCtx, config: readConfig() })
  assert.doesNotThrow(() => engine.status())
  assert.equal(engine.status().service.available, false)
  assert.equal(engine.status().service.providers.length, 0)
})

test('VisionEngine key/routes use ctx.get and degrade without services', async () => {
  const vision = new VisionEngine({ ctx: strictCtx, config: readConfig() })
  const key = await vision.keyConfigured()
  assert.equal(key.configured, false)
  const routes = await vision.listLlmRoutes()
  assert.equal(routes.ok, false)
  assert.deepEqual(routes.routes, [])
})
