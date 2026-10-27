import test from 'node:test'
import assert from 'node:assert/strict'
import { summarizeActivity, fallbackReport } from '../lib/report.js'

const today = '2026-10-27'
const activity = [
  { at: `${today}T10:00:00.000Z`, kind: 'enter', title: '安静自习室', detail: '人气 12' },
  { at: `${today}T10:01:00.000Z`, kind: 'observe', title: '安静自习室', detail: '语音 今天写了三页' },
  { at: `${today}T10:02:00.000Z`, kind: 'say', title: '安静自习室', text: '我也在写' },
  { at: `${today}T10:10:00.000Z`, kind: 'follow', title: '安静自习室', detail: '关注了主播 小岸' },
]

test('summarizeActivity keeps only the requested day and extracts the useful bits', () => {
  const summary = summarizeActivity([
    ...activity,
    { at: '2026-10-26T10:00:00.000Z', kind: 'enter', title: '昨天的房间' },
  ], today)
  assert.deepEqual(summary.rooms, ['安静自习室'])
  assert.deepEqual(summary.says, ['我也在写'])
  assert.equal(summary.follows.length, 1)
  assert.equal(summary.entered, 1)
})

test('fallbackReport is a human diary, not a raw dump', () => {
  const summary = summarizeActivity(activity, today)
  const report = fallbackReport(summary, { date: today, persona: { name: '小鲸' } })
  assert.ok(report.title.length > 0)
  assert.match(report.text, /安静自习室/)
  assert.match(report.text, /我也在写/)
  assert.match(report.text, /关注了/)
})
