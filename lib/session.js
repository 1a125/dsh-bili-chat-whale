import fs from 'node:fs'
import crypto from 'node:crypto'
import { DATA_DIR, SESSION_PATH, WORK_DIR } from './paths.js'
import { readJson, writeJson } from './store.js'

/**
 * 把「叫醒 agent」这件事收在一个地方。
 *
 * 与养鱼插件的会话投递同源的经验：
 *   · 固定 sessionId → 跨天保留上下文，而不是每次开新会话
 *   · 专用小工作目录（~/.dsh/chat-whale-work）—— 不拿用户主目录当工作区
 *   · 先看会话文件最近有没有动静：她还在忙就别再塞一条（会互相顶掉）
 *   · 交付失败要能重试，不能悄悄丢掉
 *   · 叫醒后的那一轮也要用插件选定的模型，不能落回宿主默认
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
  let cachedBusy = false
  let lastBusyAt = 0
  /** 上一次成功下发的模型路由；没变就不再打一次 selectModel */
  let lastRoute = ''
  let lastSessionId = null

  function save() {
    try { writeJson(SESSION_PATH, state) } catch {}
  }

  /** 把配置里的模型选择对齐到会话；失败只记日志，不挡叫醒。 */
  async function applyModel(model) {
    const provider = String(model?.provider ?? '').trim()
    const name = String(model?.model ?? '').trim()
    if (!provider || !name) return
    const effort = String(model?.reasoningEffort ?? '').trim()
    const route = `${provider}/${name}/${effort}`
    if (route === lastRoute && state.id === lastSessionId) return
    if (typeof controller.selectModel !== 'function') {
      log('[chat-whale] 宿主没有 selectModel，叫醒仍用宿主默认模型')
      return
    }
    try {
      await controller.selectModel({
        sessionId: state.id,
        provider,
        model: name,
        ...(effort ? { reasoningEffort: effort } : {}),
      })
      lastRoute = route
      lastSessionId = state.id
      log(`[chat-whale] 已把会话模型切到 ${provider}/${name}${effort ? ` · ${effort}` : ''}`)
    } catch (error) {
      log(`[chat-whale] 切换会话模型失败（继续用宿主默认）：${error.message}`)
    }
  }

  return {
    get sessionId() { return state.id },

    /**
     * agent 是不是还在上一轮里干活。
     *
     * 以前是递归扫 <DSH_HOME>/sessions 找会话文件 —— 同步 readdir/stat，会话一多就会
     * 把宿主事件循环卡住（设置页显示「重新连接中」）。现在改问 sessionController.list,
     * 异步且只读摘要；5 秒内复用结果。
     */
    async busy() {
      if (Date.now() - lastBusyAt < 20_000) return cachedBusy
      lastBusyAt = Date.now()
      const started = Date.now()
      try {
        const value = await controller.list({}, AbortSignal.timeout(5000))
        const row = (value?.items ?? []).find((item) => String(item.sessionId) === String(state.id))
        cachedBusy = !!row?.running
      } catch {
        cachedBusy = false
      }
      const ms = Date.now() - started
      if (ms > 400) log(`[chat-whale] 查询会话状态耗时 ${ms}ms`)
      return cachedBusy
    },

    async send(text, { signal, model } = {}) {
      // sessionController.prompt 需要一个真实的 AbortSignal（传 undefined 时内部会直接调用
      // signal.throwIfAborted()）—— 所以这里兜底成一个永不过期的 controller。
      const effective = signal ?? new AbortController().signal
      const job = tail.then(async () => {
        effective.throwIfAborted()
        if (!ready) {
          try { await controller.create({ sessionId: state.id, cwd }) } catch { /* 已存在就沿用它 */ }
          ready = true
        }
        await applyModel(model)
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

    reset() {
      ready = false
      lastRoute = ''
      lastSessionId = null
    },
  }
}

export function workDir() {
  fs.mkdirSync(WORK_DIR, { recursive: true })
  return WORK_DIR
}

export const SESSION_STATE_PATH = SESSION_PATH
export const STATE_DIR = DATA_DIR
