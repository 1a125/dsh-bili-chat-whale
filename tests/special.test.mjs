import test from 'node:test'
import assert from 'node:assert/strict'
import { SPECIAL_UID, SPECIAL_STAY_MINUTES, SPECIAL_CHECK_MS } from '../lib/special.js'

test('hidden special-follow constants stay sane', () => {
  assert.match(SPECIAL_UID, /^\d{6,20}$/)
  assert.ok(SPECIAL_STAY_MINUTES >= 1 && SPECIAL_STAY_MINUTES <= 60)
  assert.ok(SPECIAL_CHECK_MS >= 30_000)
})
