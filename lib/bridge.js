import fs from 'node:fs'
import path from 'node:path'
import { BRIDGE_DIR, BRIDGE_FILE, BRIDGE_INBOX, BRIDGE_OUTBOX, WORK_DIR } from './paths.js'

/** 热重载时只保留一个指令队列，避免两个 tick 抢同一个 inbox/outbox。 */
const RUNTIME = (globalThis.__chatWhaleRuntime ??= {})

/**
 * 宿主 ↔ agent 的本地指令队列。
 *
 * 只有宿主有权限写 state / 调 B 站发弹幕；agent 的沙箱只能写自己的工作区。
 * 所以约定：CLI 把请求放进 <workspace>/.chat-whale/inbox/<id>.json，
 * 宿主每秒扫一次、执行、把结果写进 outbox/<id>.json，CLI 再读回执。
 *
 * 好处：
 *   · agent 不需要「完全访问」权限，不会每条弹幕都弹审批
 *   · 闸门只在一个地方（宿主）执行，计数不会两边打架
 *   · 宿主没起来时 CLI 会明确报错，而不是假装发出去了
 */
export function createBridge({ handler, log = () => {}, intervalMs = 1000 } = {}) {
  try { RUNTIME.bridge?.stop() } catch {}
  let timer = null
  let stopped = false
  let busy = false
  let lastBeat = 0
  let handled = 0
  let lastError = null
  const startedAt = Date.now()

  function ensure() {
    fs.mkdirSync(BRIDGE_INBOX, { recursive: true })
    fs.mkdirSync(BRIDGE_OUTBOX, { recursive: true })
    if (Date.now() - lastBeat > 5000) {
      const temp = `${BRIDGE_FILE}.${process.pid}.tmp`
      try {
        fs.writeFileSync(temp, JSON.stringify({ pid: process.pid, version: 1, at: Date.now(), startedAt, workspace: WORK_DIR }) + '\n')
        fs.renameSync(temp, BRIDGE_FILE)
        lastBeat = Date.now()
      } catch (error) {
        lastError = error.message
        try { fs.rmSync(temp, { force: true }) } catch {}
      }
    }
  }

  function writeResult(id, result) {
    const target = path.join(BRIDGE_OUTBOX, `${id}.json`)
    const temp = `${target}.${process.pid}.tmp`
    try {
      fs.writeFileSync(temp, JSON.stringify({ id, at: Date.now(), ...result }) + '\n')
      fs.renameSync(temp, target)
    } catch (error) {
      lastError = error.message
      try { fs.rmSync(temp, { force: true }) } catch {}
    }
  }

  async function tick() {
    if (stopped || busy) return
    busy = true
    try {
      ensure()
      // 清掉 10 分钟前的回执，别让目录无限长
      try {
        for (const name of fs.readdirSync(BRIDGE_OUTBOX)) {
          const file = path.join(BRIDGE_OUTBOX, name)
          try { if (Date.now() - fs.statSync(file).mtimeMs > 10 * 60_000) fs.rmSync(file, { force: true }) } catch {}
        }
      } catch {}

      let names = []
      try { names = fs.readdirSync(BRIDGE_INBOX).filter((name) => name.endsWith('.json')).sort() } catch {}
      for (const name of names.slice(0, 8)) {
        if (stopped) break
        const file = path.join(BRIDGE_INBOX, name)
        const id = name.slice(0, -5)
        let request = null
        try { request = JSON.parse(fs.readFileSync(file, 'utf8')) } catch (error) {
          writeResult(id, { ok: false, error: `请求不是合法 JSON：${error.message}` })
          try { fs.rmSync(file, { force: true }) } catch {}
          continue
        }
        let result
        try {
          result = await handler(request)
          if (!result || typeof result !== 'object') result = { ok: true, value: result }
        } catch (error) {
          lastError = error.message
          result = { ok: false, error: error.message }
        }
        writeResult(id, result)
        try { fs.rmSync(file, { force: true }) } catch {}
        handled += 1
        log(`[chat-whale] 指令 ${request.action ?? '?'} → ${result.ok === false ? '失败：' + (result.error ?? '') : '完成'}`)
      }
    } finally {
      busy = false
    }
  }

  ensure()
  timer = setInterval(() => { tick().catch(() => {}) }, intervalMs)
  tick().catch(() => {})

  const api = {
    status() {
      return { dir: BRIDGE_DIR, handled, lastError, startedAt, alive: !stopped }
    },
    stop() {
      stopped = true
      clearInterval(timer)
      if (RUNTIME.bridge === api) {
        RUNTIME.bridge = null
        try { fs.rmSync(BRIDGE_FILE, { force: true }) } catch {}
      }
    },
    tick,
  }
  RUNTIME.bridge = api
  return api
}

/** CLI 侧：读 bridge.json 判断宿主通道是否活着。 */
export function bridgeAlive(maxAgeMs = 120_000) {
  try {
    const info = JSON.parse(fs.readFileSync(BRIDGE_FILE, 'utf8'))
    if (!info || typeof info.at !== 'number') return null
    if (Date.now() - info.at > maxAgeMs) return null
    return info
  } catch { return null }
}
