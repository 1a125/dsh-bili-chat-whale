import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { DATA_DIR, DSH_HOME, SESSION_PATH, WORK_DIR } from './paths.js'
import { readJson, writeJson } from './store.js'

/**
 * 把「叫醒 agent」这件事收在一个地方。
 *
 * 与养鱼插件的会话投递同源的经验：
 *   · 固定 sessionId → 跨天保留上下文，而不是每次开新会话
 *   · 专用小工作目录（~/.dsh/chat-whale-work）—— 不拿用户主目录当工作区
 *   · 先看会话文件最近有没有动静：她还在忙就别再塞一条（会互相顶掉）
 *   · 交付失败要能重试，不能悄悄丢掉
 */
export function createSessionDelivery({ controller, config, cwd, log = () => {} }) {
  const state = readJson(SESSION_PATH, null) ?? { id: null, startedAt: Date.now(), deliveredAt: 0 }
  const configuredId = config.session?.id ?? 'bili-chat-whale'
  // 配置里换了会话 id（比如上一轮卡在审批里）→ 换一个新会话，别继续往旧会话里塞
  if (state.id !== configuredId) {
    state.id = configuredId
    state.startedAt = Date.now()
    state.deliveredAt = 0
  }
  let ready = false
  let tail = Promise.resolve()
  let sessionFile = null
  let lastSessionScan = 0

  function save() {
    try { writeJson(SESSION_PATH, state) } catch {}
  }

  function findSessionFile(sessionId) {
    if (Date.now() - lastSessionScan < 30_000 && sessionFile) return sessionFile
    lastSessionScan = Date.now()
    const root = path.join(DSH_HOME, 'sessions')
    const stack = [root]
    let best = null
    let guard = 0
    while (stack.length && guard < 6000) {
      guard += 1
      const dir = stack.pop()
      let entries = []
      try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { continue }
      for (const entry of entries) {
        const full = path.join(dir, entry.name)
        if (entry.isDirectory()) stack.push(full)
        else if (entry.name === 'session.v4.jsonl.zstd' && full.includes(sessionId)) {
          try {
            const mtime = fs.statSync(full).mtimeMs
            if (!best || mtime > best.mtime) best = { file: full, mtime }
          } catch {}
        }
      }
    }
    sessionFile = best
    return best
  }

  return {
    get sessionId() { return state.id },

    /** agent 是不是还在上一轮里干活（会话文件 90 秒内动过就算）。 */
    busy() {
      const found = findSessionFile(state.id)
      if (!found) return false
      try { return Date.now() - fs.statSync(found.file).mtimeMs < 90_000 } catch { return false }
    },

    async send(text, { signal } = {}) {
      // sessionController.prompt 需要一个真实的 AbortSignal（传 undefined 时内部会直接调用
      // signal.throwIfAborted()）—— 所以这里兜底成一个永不过期的 controller。
      const effective = signal ?? new AbortController().signal
      const job = tail.then(async () => {
        effective.throwIfAborted()
        if (!ready) {
          try { await controller.create({ sessionId: state.id, cwd }) } catch { /* 已存在就沿用它 */ }
          ready = true
        }
        await controller.prompt({
          requestId: `chat-whale-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`,
          sessionId: state.id,
          mode: 'queue',
          content: [{ type: 'text', text }],
        }, effective)
        state.deliveredAt = Date.now()
        save()
        log(`[chat-whale] 已叫醒 agent（${text.length} 字）`)
      })
      tail = job.catch(() => {})
      return job
    },

    reset() { ready = false },
  }
}

export function workDir() {
  fs.mkdirSync(WORK_DIR, { recursive: true })
  return WORK_DIR
}

export const SESSION_STATE_PATH = SESSION_PATH
export const STATE_DIR = DATA_DIR
