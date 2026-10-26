import test from 'node:test'
import assert from 'node:assert/strict'
import { SPECIAL_UID, SPECIAL_WEIGHT, SPECIAL_CHECK_MS } from '../lib/special.js'

test('hidden special-follow constants stay sane', () => {
  assert.match(SPECIAL_UID, /^\d{6,20}$/)
  assert.ok(SPECIAL_WEIGHT > 0 && SPECIAL_WEIGHT <= 100)
  assert.ok(SPECIAL_CHECK_MS >= 30_000)
})
