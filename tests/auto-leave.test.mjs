import test from 'node:test'
import assert from 'node:assert/strict'
import { autoLeaveReason } from '../lib/scheduler.js'

test('autoLeaveReason respects the master switch and thresholds', () => {
  assert.equal(autoLeaveReason({ autoLeaveBoring: false, boringEmptyStreak: 2, boringFailStreak: 2 }, 99, 99), null)
  assert.equal(autoLeaveReason({ autoLeaveBoring: true, boringEmptyStreak: 3, boringFailStreak: 2 }, 1, 1), null)
  assert.match(autoLeaveReason({ autoLeaveBoring: true, boringEmptyStreak: 3, boringFailStreak: 2 }, 3, 0), /3 轮/)
  assert.match(autoLeaveReason({ autoLeaveBoring: true, boringEmptyStreak: 3, boringFailStreak: 2 }, 0, 2), /2 次抓流失败/)
})

test('autoLeaveReason clamps silly thresholds to at least 2', () => {
  assert.match(autoLeaveReason({ autoLeaveBoring: true, boringEmptyStreak: 0, boringFailStreak: 0 }, 2, 0), /2 轮/)
  assert.match(autoLeaveReason({ autoLeaveBoring: true, boringEmptyStreak: 0, boringFailStreak: 0 }, 0, 2), /2 次/)
})
