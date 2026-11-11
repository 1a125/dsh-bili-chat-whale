import test from 'node:test'
import assert from 'node:assert/strict'
import { resolveRoutes, callTextRoute, collectText, isUnsupportedEffort, resetRouteCache } from '../lib/llm.js'

function fakeCtx(models, calls = []) {
  const llm = {
    listProviders: async () => [...new Set(models.map((m) => m.provider))].map((id) => ({ id, name: id })),
    listModels: async (provider) => models.filter((m) => m.provider === provider),
    resolveModelInfo: async (provider, model) => ({
      provider,
      id: model,
      name: model,
      reasoning: { efforts: [{ id: 'low', name: '低' }, { id: 'high', name: '高' }], defaultEffort: 'low' },
    }),
    stream: (options) => {
      calls.push(options)
      return (async function* () {
        if (options.reasoningEffort === 'high' && options.model === 'strict') {
          yield { type: 'finish', reason: { kind: 'error', failure: { message: 'unsupported reasoning effort' } } }
          return
        }
        yield { type: 'text-delta', index: 0, text: `来自 ${options.provider}/${options.model}` }
        yield { type: 'finish', reason: { kind: 'stop' } }
      })()
    },
  }
  return { ctx: { get: (name) => (name === 'llm' ? llm : null) }, calls }
}

const MODELS = [
  { provider: 'acct', id: 'deepseek-flash', inputModalities: ['text', 'image'] },
  { provider: 'acct', id: 'deepseek-v4-pro', inputModalities: ['text'] },
  { provider: 'other', id: 'gpt-6', inputModalities: ['text'] },
]

test('an explicit provider/model in settings wins over auto discovery', async () => {
  resetRouteCache()
  const { ctx } = fakeCtx(MODELS)
  const routes = await resolveRoutes(ctx, { provider: 'other', model: 'gpt-6', reasoningEffort: 'high' })
  assert.equal(routes[0].provider, 'other')
  assert.equal(routes[0].model, 'gpt-6')
  assert.equal(routes[0].reasoningEffort, 'high')
  assert.equal(routes[0].source, 'config')
})

test('a chosen model that fails falls back to the auto routes, not to a bare fallback draft', async () => {
  resetRouteCache()
  const { ctx } = fakeCtx(MODELS)
  const routes = await resolveRoutes(ctx, { provider: 'other', model: 'gpt-6' })
  assert.equal(routes[0].model, 'gpt-6')
  assert.ok(routes.length > 1)
  assert.ok(routes.slice(1).every((item) => !(item.provider === 'other' && item.model === 'gpt-6')))
})

test('auto discovery returns more than one candidate and honors needImage', async () => {
  resetRouteCache()
  const { ctx } = fakeCtx(MODELS)
  const text = await resolveRoutes(ctx, {})
  assert.ok(text.length >= 2)
  resetRouteCache()
  const image = await resolveRoutes(ctx, { needImage: true })
  assert.deepEqual(image.map((item) => item.model), ['deepseek-flash'])
})

test('the chosen reasoning effort is sent, and dropped when the model rejects it', async () => {
  resetRouteCache()
  const { ctx, calls } = fakeCtx([{ provider: 'p', id: 'strict', inputModalities: ['text'] }])
  const routes = await resolveRoutes(ctx, { provider: 'p', model: 'strict', reasoningEffort: 'high' })
  const result = await callTextRoute({ get: (n) => (n === 'llm' ? ctx.get('llm') : null) }.get('llm'), routes, 'hi', {})
  assert.match(result.text, /来自 p\/strict/)
  assert.equal(calls.length, 2)
  assert.equal(calls[0].reasoningEffort, 'high')
  assert.equal(calls[1].reasoningEffort, undefined)
})

test('isUnsupportedEffort only matches reasoning-related failures', () => {
  assert.equal(isUnsupportedEffort(new Error('unsupported reasoning effort')), true)
  assert.equal(isUnsupportedEffort(new Error('HTTP 500')), false)
})

test('collectText reads block-end when an adapter never sends deltas', async () => {
  const llm = {
    stream: () => (async function* () {
      yield { type: 'block-end', index: 0, block: { type: 'text', text: '只发 block-end' } }
      yield { type: 'finish', reason: { kind: 'stop' } }
    })(),
  }
  const text = await collectText(llm, { provider: 'p', model: 'm' }, 'hi')
  assert.equal(text, '只发 block-end')
})
