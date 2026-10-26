import test from 'node:test'
import assert from 'node:assert/strict'
import { matchesInterests, scoreRoom } from '../lib/discovery.js'
import { DEFAULTS, normalizeConfig } from '../lib/config.js'
import { defaultState, todayKey } from '../lib/store.js'

const config = normalizeConfig({
  interests: { keywords: ['聊天', '编程'], avoidKeywords: ['带货'], maxPopularity: 3000 },
}, DEFAULTS)
const state = { ...defaultState(), visited: {} }

const room = (over = {}) => ({
  roomId: '777', title: '随便聊聊天', uname: '小主播', online: 5, attentions: 80,
  category: '聊天电台', tags: ['日常'], liveTime: new Date().toISOString().slice(0, 19).replace('T', ' '),
  liveStatus: 1, ...over,
})

test('matchesInterests finds keyword hits and avoid hits', () => {
  assert.deepEqual(matchesInterests(room(), config).hits, ['聊天'])
  assert.deepEqual(matchesInterests(room({ title: '带货直播间' }), config).blocked, ['带货'])
})

test('scoreRoom prefers quiet fresh rooms and rejects blocked ones', () => {
  const quiet = scoreRoom(room(), config, state)
  const loud = scoreRoom(room({ online: 2500 }), config, state)
  assert.ok(quiet.score > loud.score, `${quiet.score} > ${loud.score}`)
  assert.equal(scoreRoom(room({ title: '带货清仓' }), config, state).score, -Infinity)
  assert.equal(scoreRoom(room({ online: 99 }), config, state).score > 0, true)
  assert.equal(scoreRoom(room({ online: 9999 }), config, state).score, -Infinity)
  assert.equal(scoreRoom(room({ online: 0 }), config, state).score > 0, true)
})

test('scoreRoom rejects rooms visited in the last 7 days and offline rooms', () => {
  const recent = { ...state, visited: { 777: { at: Date.now() - 3600_000 } } }
  assert.equal(scoreRoom(room(), config, recent).score, -Infinity)
  const old = { ...state, visited: { 777: { at: Date.now() - 8 * 86400_000 } } }
  assert.ok(scoreRoom(room(), config, old).score > 0)
  assert.equal(scoreRoom(room({ liveStatus: 0 }), config, state).score, -Infinity)
})

test('multi-keyword rooms outrank single-keyword rooms', () => {
  const multiConfig = normalizeConfig({ interests: { keywords: ['聊天', '编程'], avoidKeywords: [] } }, DEFAULTS)
  const one = scoreRoom(room({ title: '编程直播', category: '学习', tags: [] }), multiConfig, state)
  const two = scoreRoom(room({ title: '编程聊天', category: '学习', tags: [] }), multiConfig, state)
  assert.deepEqual(one.hits, ['编程'])
  assert.deepEqual(two.hits, ['聊天', '编程'])
  assert.ok(two.score > one.score + 15, `${two.score} should clearly beat ${one.score}`)
})

test('include/exclude partitions filter after room info, and avoid false rejects during search', () => {
  const areaConfig = normalizeConfig({
    interests: { keywords: ['聊天'], includeAreas: ['娱乐'], excludeAreas: ['手游'] },
  }, DEFAULTS)
  // 复核后拿到 parentArea
  assert.ok(scoreRoom(room({ parentArea: '娱乐', area: '聊天电台' }), areaConfig, state).score > 0)
  assert.equal(scoreRoom(room({ parentArea: '手游', area: '王者荣耀' }), areaConfig, state).score, -Infinity)
  assert.equal(scoreRoom(room({ parentArea: '娱乐', area: '手游' }), areaConfig, state).score, -Infinity)
  // 搜索阶段没有 parentArea：排除词仍可按 cate_name 命中；只进条件先放过
  assert.equal(scoreRoom(room({ parentArea: undefined, area: 6, category: '手游' }), areaConfig, state).score, -Infinity)
  assert.ok(scoreRoom(room({ parentArea: undefined, area: 6, category: '聊天电台' }), areaConfig, state).score > 0)
})

test('day key is a local YYYY-MM-DD', () => {
  assert.match(todayKey(), /^\d{4}-\d{2}-\d{2}$/)
})
