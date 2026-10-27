import test from 'node:test'
import assert from 'node:assert/strict'
import { scheduleState } from '../lib/schedule.js'

const at = (y, m, d, h, min = 0) => new Date(y, m - 1, d, h, min, 0, 0).getTime()

test('schedule supports an overnight window and keeps one work day', () => {
  const schedule = { enabled: true, start: '20:00', end: '02:00', reportLeadMinutes: 10 }
  const evening = scheduleState(schedule, at(2026, 10, 27, 21))
  assert.equal(evening.active, true)
  assert.equal(evening.workDay, '2026-10-27')
  assert.equal(evening.overnight, true)

  const afterMidnight = scheduleState(schedule, at(2026, 10, 28, 1))
  assert.equal(afterMidnight.active, true)
  assert.equal(afterMidnight.workDay, '2026-10-27')
  assert.equal(afterMidnight.endAt, at(2026, 10, 28, 2))

  const afternoon = scheduleState(schedule, at(2026, 10, 27, 15))
  assert.equal(afternoon.active, false)
  assert.equal(afternoon.nextStartAt, at(2026, 10, 27, 20))
})

test('schedule supports a same-day window', () => {
  const schedule = { enabled: true, start: '09:00', end: '18:00' }
  assert.equal(scheduleState(schedule, at(2026, 10, 27, 10)).active, true)
  assert.equal(scheduleState(schedule, at(2026, 10, 27, 8)).active, false)
  assert.equal(scheduleState(schedule, at(2026, 10, 27, 19)).active, false)
})

test('disabled schedule is always active', () => {
  const state = scheduleState({ enabled: false }, at(2026, 10, 27, 3))
  assert.equal(state.active, true)
  assert.equal(state.enabled, false)
})
