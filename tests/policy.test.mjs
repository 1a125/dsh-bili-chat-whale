import test from 'node:test'
import assert from 'node:assert/strict'
import { defaultState, evaluateSpeakPolicy, todayKey } from '../lib/store.js'
import { DEFAULTS, normalizeConfig } from '../lib/config.js'

function makeConfig(over = {}) {
  return normalizeConfig({
    mode: 'interact',
    interaction: { dryRun: false, maxPerRoom: 2, minGapSec: 60, maxPerHour: 2, maxPerDay: 3 },
    ...over,
  }, DEFAULTS)
}

function makeState(over = {}) {
  const now = Date.now()
  return {
    ...defaultState(),
    room: { roomId: '123', spoken: 0, lastSpokeAt: 0, sentTexts: [], recentTexts: [], ...over.room },
    counters: { day: todayKey(), dayCount: 0, hourAt: now, hourCount: 0, ...over.counters },
  }
}

test('allows a short fresh danmaku', () => {
  const verdict = evaluateSpeakPolicy(makeState(), makeConfig(), { roomId: '123', text: '第一次来，主播声音好听' })
  assert.equal(verdict.ok, true)
  assert.equal(verdict.dryRun, false)
})

test('blocks empty, too long, and blocked words', () => {
  assert.equal(evaluateSpeakPolicy(makeState(), makeConfig(), { roomId: '123', text: '   ' }).ok, false)
  assert.match(evaluateSpeakPolicy(makeState(), makeConfig(), { roomId: '123', text: '一'.repeat(21) }).reason, /20/)
  const word = evaluateSpeakPolicy(makeState(), makeConfig({ safety: { blockedWords: ['加群'] } }), { roomId: '123', text: '加群聊' })
  assert.equal(word.ok, false)
  assert.match(word.reason, /禁用词/)
})

test('blocks when not in the room, or the wrong room', () => {
  assert.equal(evaluateSpeakPolicy({ ...defaultState(), room: null }, makeConfig(), { roomId: '123', text: '你好' }).ok, false)
  assert.equal(evaluateSpeakPolicy(makeState(), makeConfig(), { roomId: '456', text: '你好' }).ok, false)
})

test('enforces gap, per-room, hourly and daily caps', () => {
  const config = makeConfig()
  const gap = evaluateSpeakPolicy(makeState({ room: { lastSpokeAt: Date.now() - 10_000 } }), config, { roomId: '123', text: '你好' })
  assert.equal(gap.ok, false)
  assert.match(gap.reason, /再等/)

  const room = evaluateSpeakPolicy(makeState({ room: { spoken: 5 } }), config, { roomId: '123', text: '你好' })
  assert.equal(room.ok, false)

  const hour = evaluateSpeakPolicy(makeState({ counters: { hourCount: 15 } }), config, { roomId: '123', text: '你好' })
  assert.equal(hour.ok, false)

  const day = evaluateSpeakPolicy(makeState({ counters: { dayCount: 40 } }), config, { roomId: '123', text: '你好' })
  assert.equal(day.ok, false)
})

test('blocks exact and near duplicates', () => {
  const exact = evaluateSpeakPolicy(makeState({ room: { sentTexts: [{ text: '你好呀' }] } }), makeConfig(), { roomId: '123', text: '你好呀' })
  assert.equal(exact.ok, false)
  const near = evaluateSpeakPolicy(makeState({ room: { recentTexts: ['今天这个游戏好难啊'] } }), makeConfig(), { roomId: '123', text: '今天这个游戏好难' })
  assert.equal(near.ok, false)
})

test('watch and off modes never speak', () => {
  assert.equal(evaluateSpeakPolicy(makeState(), makeConfig({ mode: 'watch' }), { roomId: '123', text: '你好' }).ok, false)
  assert.equal(evaluateSpeakPolicy(makeState(), makeConfig({ mode: 'off' }), { roomId: '123', text: '你好' }).ok, false)
})

test('dry-run is carried from config, not decided by the policy', () => {
  const verdict = evaluateSpeakPolicy(makeState(), makeConfig({ interaction: { dryRun: true } }), { roomId: '123', text: '你好' })
  assert.equal(verdict.ok, true)
  assert.equal(verdict.dryRun, true)
})
