import test from 'node:test'
import assert from 'node:assert/strict'
import { DEFAULTS, normalizeConfig } from '../lib/config.js'

test('normalizeConfig keeps safe defaults and clamps numbers', () => {
  const next = normalizeConfig({
    mode: 'interact',
    interests: { maxViewers: 999999, minViewers: -5, stayMinutes: 0, roomsPerHour: 999 },
    interaction: { maxPerRoom: 99, minGapSec: 1, maxPerHour: 999, maxPerDay: 999 },
    voice: { clipSeconds: 999, language: 'klingon' },
    vision: { frames: 99, mode: 'nonsense' },
    safety: { maxDanmakuChars: 99, blockedWords: '加群,微信, 加群' },
  }, DEFAULTS)

  assert.equal(next.mode, 'interact')
  assert.equal(next.interests.maxViewers, 100000)
  assert.equal(next.interests.minViewers, 0)
  assert.equal(next.interests.stayMinutes, 1)
  assert.equal(next.interests.roomsPerHour, 30)
  assert.equal(next.interaction.maxPerRoom, 30)
  assert.equal(next.interaction.minGapSec, 20)
  assert.equal(next.interaction.maxPerDay, 500)
  assert.equal(next.interaction.maxPerHour, 120, 'hour cap clamps to 120')
  assert.equal(next.voice.clipSeconds, 60)
  assert.equal(next.voice.language, 'zh')
  assert.equal(next.vision.frames, 4)
  assert.equal(next.vision.mode, 'auto')
  assert.equal(next.safety.maxDanmakuChars, 20)
  assert.deepEqual(next.safety.blockedWords, ['加群', '微信'])
})

test('normalizeConfig rejects an unknown mode and only the literal false disables dry-run', () => {
  const next = normalizeConfig({ mode: 'attack', interaction: { dryRun: 'yes' } }, DEFAULTS)
  assert.equal(next.mode, 'off')
  assert.equal(next.interaction.dryRun, true)
  assert.equal(normalizeConfig({ interaction: { dryRun: false } }, DEFAULTS).interaction.dryRun, false)
})

test('defaults keep dry-run and a modest speaking budget', () => {
  assert.equal(DEFAULTS.interaction.dryRun, true)
  assert.equal(DEFAULTS.interests.maxViewers, 30)
  assert.equal(DEFAULTS.interests.autoLeaveBoring, true)
  assert.equal(DEFAULTS.interests.boringEmptyStreak, 4)
  assert.equal(DEFAULTS.interests.boringFailStreak, 3)
  assert.equal(DEFAULTS.interests.maxPopularity, 3000)
  assert.equal(DEFAULTS.interests.revisitMinutes, 360)
  assert.deepEqual(DEFAULTS.interests.includeAreas, [])
  assert.deepEqual(DEFAULTS.interests.excludeAreas, [])
  assert.equal(DEFAULTS.vision.mode, 'auto')
  assert.equal(DEFAULTS.mode, 'off')
})

test('patrol and speech clarification defaults are safe', () => {
  assert.equal(DEFAULTS.patrol.enabled, true)
  assert.equal(DEFAULTS.patrol.intervalSec, 30)
  assert.equal(DEFAULTS.voice.clarify, true)
  const next = normalizeConfig({ patrol: { intervalSec: 1 }, voice: { clarify: false } }, DEFAULTS)
  assert.equal(next.patrol.intervalSec, 5)
  assert.equal(next.voice.clarify, false)
  assert.equal(normalizeConfig({ patrol: { intervalSec: 99999 } }, DEFAULTS).patrol.intervalSec, 3600)
})

test('revisit cooldown accepts legacy hours and new minutes', () => {
  assert.equal(normalizeConfig({ interests: { revisitHours: 2 } }, DEFAULTS).interests.revisitMinutes, 120)
  assert.equal(normalizeConfig({ interests: { revisitMinutes: 45 } }, DEFAULTS).interests.revisitMinutes, 45)
  assert.equal(normalizeConfig({ interests: { revisitMinutes: 0 } }, DEFAULTS).interests.revisitMinutes, 1)
})

test('partition and boring filters normalize lists and clamp thresholds', () => {
  const next = normalizeConfig({
    interests: {
      includeAreas: '娱乐，网游, 娱乐',
      excludeAreas: ['手游', '手游'],
      autoLeaveBoring: false,
      boringEmptyStreak: 1,
      boringFailStreak: 99,
    },
  }, DEFAULTS)
  assert.deepEqual(next.interests.includeAreas, ['娱乐', '网游'])
  assert.deepEqual(next.interests.excludeAreas, ['手游'])
  assert.equal(next.interests.autoLeaveBoring, false)
  assert.equal(next.interests.boringEmptyStreak, 2)
  assert.equal(next.interests.boringFailStreak, 10)
})
