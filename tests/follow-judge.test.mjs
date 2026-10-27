import test from 'node:test'
import assert from 'node:assert/strict'
import { parseFollowDecision, judgeFollow } from '../lib/follow-judge.js'

test('parseFollowDecision reads a clear JSON decision', () => {
  assert.deepEqual(
    (({ follow, reason }) => ({ follow, reason }))(parseFollowDecision('{"follow":true,"reason":"想下次再来","confidence":0.8}')),
    { follow: true, reason: '想下次再来' },
  )
  assert.equal(parseFollowDecision('```json\n{"follow":false,"reason":"不感兴趣"}\n```').follow, false)
})

test('parseFollowDecision is conservative when the model rambles or fails', () => {
  assert.equal(parseFollowDecision('我觉得这个主播挺好的，可以关注一下').follow, false)
  assert.equal(parseFollowDecision('是，关注').follow, true)
  assert.equal(parseFollowDecision('').follow, false)
})

test('judgeFollow asks the model and honors a negative decision', async () => {
  const llm = {
    listProviders: async () => [{ id: 'fake' }],
    listModels: async () => [{ id: 'fake-text', inputModalities: ['text'] }],
    stream: async function* () {
      yield { type: 'text-delta', text: '{"follow":false,"reason":"没感觉","confidence":0.9}' }
      yield { type: 'finish', reason: { kind: 'stop' } }
    },
  }
  const ctx = { get: (name) => name === 'llm' ? llm : null }
  const config = {
    persona: { name: '大肥鱼', tone: '松弛', bio: '' },
    follow: { enabled: true },
    interaction: { dryRun: false },
    self: { mid: '1' },
  }
  const room = { meta: { title: '测试房间', uname: '主播', area: '聊天' }, enteredAt: Date.now() - 7 * 60_000 }
  const roomState = { spoken: 4, sentTexts: [{ text: '你好', at: Date.now() - 5 * 60_000 }] }
  const decision = await judgeFollow({ ctx, config, room, roomState, danmaku: [], observations: [] })
  assert.equal(decision.follow, false)
  assert.match(decision.reason, /没感觉/)
})

