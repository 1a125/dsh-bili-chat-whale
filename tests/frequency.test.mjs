import test from 'node:test'
import assert from 'node:assert/strict'
import { effectiveInteraction, normalizeFrequency, FREQUENCY_PRESETS } from '../lib/frequency.js'

test('frequency presets go from conservative low to faster high', () => {
  assert.equal(normalizeFrequency('bogus'), 'low')
  assert.ok(FREQUENCY_PRESETS.medium.maxPerRoom > FREQUENCY_PRESETS.low.maxPerRoom)
  assert.ok(FREQUENCY_PRESETS.high.minGapSec < FREQUENCY_PRESETS.medium.minGapSec)
  assert.ok(FREQUENCY_PRESETS.high.speakIntervalSec < FREQUENCY_PRESETS.low.speakIntervalSec)
})

test('effectiveInteraction overrides old numeric fields with the selected preset', () => {
  const low = effectiveInteraction({ frequency: 'low', maxPerRoom: 99 })
  assert.equal(low.maxPerRoom, FREQUENCY_PRESETS.low.maxPerRoom)
  const high = effectiveInteraction({ frequency: 'high' })
  assert.equal(high.maxPerRoom, FREQUENCY_PRESETS.high.maxPerRoom)
  assert.equal(high.minGapSec, FREQUENCY_PRESETS.high.minGapSec)
})
