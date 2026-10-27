import test from 'node:test'
import assert from 'node:assert/strict'
import { cookieHeader, headersFor, signWbi } from '../lib/bili.js'
import { modelStatus, resolveSherpaRoot } from '../lib/asr.js'
import { DEFAULTS, normalizeConfig } from '../lib/config.js'

test('signWbi produces a deterministic sorted query with w_rid', () => {
  const keys = { img: 'https://i0.hdslb.com/bfs/wbi/' + 'a'.repeat(36), sub: 'https://i0.hdslb.com/bfs/wbi/' + 'b'.repeat(28) }
  const first = signWbi({ keyword: '聊天', page: 1 }, keys, 1_700_000_000_000)
  const second = signWbi({ page: 1, keyword: '聊天' }, keys, 1_700_000_000_000)
  assert.equal(first, second)
  assert.match(first, /^keyword=%E8%81%8A%E5%A4%A9&page=1&wts=1700000000&w_rid=[a-f0-9]{32}$/)
})

test('signWbi rejects a short key', () => {
  assert.throws(() => signWbi({}, { img: 'a/b.png', sub: 'c/d.png' }), /WBI/)
})

test('headersFor includes the cookie only when credentials exist', () => {
  assert.equal(headersFor(null).cookie, undefined)
  const headers = headersFor({ sessdata: 's', bili_jct: 'j', buvid3: '' })
  assert.equal(headers.cookie, 'SESSDATA=s; bili_jct=j')
  assert.equal(cookieHeader({ sessdata: 's', bili_jct: 'j', buvid3: 'b3', buvid4: 'b4' }), 'SESSDATA=s; bili_jct=j; buvid3=b3; buvid4=b4')
  assert.equal(cookieHeader(null), '')
})

test('modelStatus reports missing files for a fresh directory', () => {
  const config = normalizeConfig({ voice: { modelDir: 'Z:\\definitely-missing-chat-whale-models' } }, DEFAULTS)
  const status = modelStatus(config)
  assert.equal(status.ready, false)
  assert.equal(status.files.length, 3)
  assert.equal(status.missing.length, 3)
})

test('resolveSherpaRoot never throws and accepts a configured package directory', () => {
  const fake = 'Z:\\definitely-missing-sherpa-onnx-node'
  const config = normalizeConfig({ asr: { sherpaRoot: fake } }, DEFAULTS)
  const resolved = resolveSherpaRoot(config)
  // 这台机器上 DSH 自带 sherpa 时可能解析到真实包；换机器时必须安静地返回 null。
  assert.ok(resolved === null || resolved.endsWith('sherpa-onnx-node'))
})
