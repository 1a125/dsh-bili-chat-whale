import test from 'node:test'
import assert from 'node:assert/strict'
import { speechLooksUnclear } from '../lib/clarify.js'

test('speechLooksUnclear flags very short, repeated, garbled, and run-on transcripts', () => {
  assert.equal(speechLooksUnclear('嗯嗯'), true)
  assert.equal(speechLooksUnclear('好好好好好好'), true)
  assert.equal(speechLooksUnclear('%%%%'), true)
  assert.equal(speechLooksUnclear('今天我们来聊一聊这个游戏到底应该怎么玩才比较好上分'), true)
})

test('speechLooksUnclear leaves normal short sentences alone', () => {
  assert.equal(speechLooksUnclear('今天我们来聊一聊这个游戏。'), false)
  assert.equal(speechLooksUnclear('一键长草'), false)
  assert.equal(speechLooksUnclear(''), false)
})
