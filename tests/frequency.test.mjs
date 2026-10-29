import test from 'node:test'
import assert from 'node:assert/strict'
import { effectiveInteraction, applyFrequencyPreset, normalizeFrequency, FREQUENCY_PRESETS } from '../lib/frequency.js'

test('frequency presets go from conservative low to faster high', () => {
  assert.equal(normalizeFrequency('bogus'), 'low')
  assert.ok(FREQUENCY_PRESETS.medium.maxPerRoom > FREQUENCY_PRESETS.low.maxPerRoom)
  assert.ok(FREQUENCY_PRESETS.high.minGapSec < FREQUENCY_PRESETS.medium.minGapSec)
  assert.ok(FREQUENCY_PRESETS.high.speakIntervalSec < FREQUENCY_PRESETS.low.speakIntervalSec)
})

test('effectiveInteraction keeps hand-tuned limits while normalizing the preset name', () => {
  const tuned = effectiveInteraction({ frequency: 'high', maxPerRoom: 3, minGapSec: 120 })
  assert.equal(tuned.frequency, 'high')
  assert.equal(tuned.maxPerRoom, 3)
  assert.equal(tuned.minGapSec, 120)
})

test('applyFrequencyPreset fills the preset defaults, then the user can tune them', () => {
  const high = applyFrequencyPreset({ dryRun: false }, 'high')
  assert.equal(high.maxPerRoom, FREQUENCY_PRESETS.high.maxPerRoom)
  assert.equal(high.minGapSec, FREQUENCY_PRESETS.high.minGapSec)
  assert.equal(high.dryRun, false)
})
