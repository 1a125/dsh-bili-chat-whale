import test from 'node:test'
import assert from 'node:assert/strict'
import { compareVersions, parseVersion } from '../lib/update.js'

test('version comparison handles v-prefix and patch bumps', () => {
  assert.equal(parseVersion('v0.1.7').join('.'), '0.1.7')
  assert.equal(compareVersions('0.1.7', '0.1.6'), 1)
  assert.equal(compareVersions('0.1.7', '0.1.7'), 0)
  assert.equal(compareVersions('0.1.7', '0.2.0'), -1)
  assert.equal(compareVersions('1.0.0', '0.99.99'), 1)
})
