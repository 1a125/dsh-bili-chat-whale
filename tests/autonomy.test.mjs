import test from 'node:test'
import assert from 'node:assert/strict'
import { DEFAULTS, effectiveMode, normalizeConfig } from '../lib/config.js'

test('effectiveMode treats a closed autonomy switch as off', () => {
  assert.equal(effectiveMode({ autonomy: { enabled: false }, mode: 'interact' }), 'off')
  assert.equal(effectiveMode({ autonomy: { enabled: false }, mode: 'watch' }), 'off')
  assert.equal(effectiveMode({ mode: 'interact' }), 'off')
  assert.equal(effectiveMode(undefined), 'off')
})

test('effectiveMode passes the mode through when autonomy is on', () => {
  assert.equal(effectiveMode({ autonomy: { enabled: true }, mode: 'interact' }), 'interact')
  assert.equal(effectiveMode({ autonomy: { enabled: true }, mode: 'watch' }), 'watch')
  assert.equal(effectiveMode({ autonomy: { enabled: true }, mode: 'off' }), 'off')
  assert.equal(effectiveMode({ autonomy: { enabled: true }, mode: 'nonsense' }), 'off')
})

test('normalizeConfig collapses autonomy.enabled to a boolean', () => {
  assert.equal(normalizeConfig({ autonomy: { enabled: 'yes' } }, DEFAULTS).autonomy.enabled, false)
  assert.equal(normalizeConfig({ autonomy: { enabled: 1 } }, DEFAULTS).autonomy.enabled, false)
  assert.equal(normalizeConfig({ autonomy: { enabled: true } }, DEFAULTS).autonomy.enabled, true)
  assert.equal(normalizeConfig({}, DEFAULTS).autonomy.enabled, false)
  assert.deepEqual(normalizeConfig({ autonomy: 'on' }, DEFAULTS).autonomy, { enabled: false })
})

test('autonomy defaults to off and never disables dry-run', () => {
  assert.equal(DEFAULTS.autonomy.enabled, false)
  const next = normalizeConfig({ autonomy: { enabled: true }, mode: 'interact' }, DEFAULTS)
  assert.equal(effectiveMode(next), 'interact')
  assert.equal(next.interaction.dryRun, true)
})
