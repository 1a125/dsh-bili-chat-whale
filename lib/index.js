import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { execFile } from 'node:child_process'
import { AuthError, createCredentialStore } from './credentials.js'
import { QrAuth, verifyAccount } from './auth.js'
import { normalizeConfig, readConfig, writeConfig, ensureDirs } from './config.js'
import { AsrEngine, modelStatus, prepareModels, resolveSherpaRoot } from './asr.js'
import { VisionEngine } from './vision.js'
import { ffmpegStatus, captureRoom, installFfmpeg } from './ffmpeg.js'
import { ocrAvailable } from './ocr.js'
import { startScheduler } from './scheduler.js'
import { createBridge } from './bridge.js'
import { checkForUpdate, applyUpdate } from './update.js'
import { discoverRooms } from './discovery.js'
import { readCredentials, sendDanmaku, ensureBuvid } from './bili.js'
import {
  evaluateSpeakPolicy, logActivity, readActivity, readState, recordSpeak, roomDir, withStateLock,
} from './store.js'
import {
  ASR_MODEL_DIR, CONFIG_PATH, CREDENTIALS_PATH, DATA_DIR, DSH_HOME, GENERATION_PATH, HOST_LOG_PATH, LOG_DIR, ROOMS_DIR, TMP_DIR,
} from './paths.js'

/**
 * dsh-bili-chat-whale —— 宿主侧插件。
 *
 * 四件事：
 *   1. 设置页（lib/client.js）与 /dsh-chat-whale/api/* 路由
 *   2. 配置读写（<DSH_HOME>/bili-chat-whale.config.json）
 *   3. 语音 / 视觉引擎的生命周期与体检
 *   4. 自主巡航（lib/scheduler.js）—— 找房间、蹲房间、叫醒 agent
 *
 * 凭据仍写 ~/.bili-ai/credentials.json（与「养鱼」共用同一个 B 站账号），永远不回显。
 */

let PREPARE = { running: false, phase: null, file: null, received: 0, total: 0, error: null, done: false, at: null }
let FFMPEG_INSTALL = { running: false, received: 0, total: 0, error: null, done: false, path: null }

const json = (res, code, value) => {
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(JSON.stringify(value))
}

function readBody(req, limit = 64 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks = []
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > limit) { reject(new Error('body too large')); req.destroy(); return }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

function latestSheet(roomId) {
  try {
    const base = path.join(roomDir(roomId), 'caps')
    const dirs = fs.readdirSync(base).map((name) => ({ name, at: Number(name) || 0 })).sort((a, b) => b.at - a.at)
    for (const dir of dirs) {
      for (const file of ['sheet.jpg', 'frame_01.jpg']) {
        const target = path.join(base, dir.name, file)
        if (fs.existsSync(target)) return target
      }
    }
  } catch {}
  return null
}

function credState() {
  try {
    const raw = JSON.parse(fs.readFileSync(CREDENTIALS_PATH, 'utf8'))
    return { present: true, hasSess: !!raw.sessdata, hasJct: !!raw.bili_jct }
  } catch {
    return { present: false, hasSess: false, hasJct: false }
  }
}

export default {
  name: 'dsh-bili-chat-whale',
  inject: ['sessionController', 'webServer', 'connection'],
  apply(ctx) {
    ensureDirs()
    fs.mkdirSync(TMP_DIR, { recursive: true })
    fs.mkdirSync(LOG_DIR, { recursive: true })

    // 每次插件实例启动换一个代际；旧实例的语音/弹幕子进程会在 30 秒内自行退出。
    // 热重载多了以后不能靠 idle timeout 才回收 —— 每个 SenseVoice 进程要几百 MB。
    const generation = randomUUID()
    try { fs.writeFileSync(GENERATION_PATH, JSON.stringify({ id: generation, pid: process.pid, at: Date.now() }) + '\n') } catch {}

    /** 同时写控制台和 host.log —— 出问题时用户能直接从设置页/文件里看到原因。 */
    function hostLog(line) {
      const text = String(line)
      try { console.log(text) } catch {}
      try {
        fs.appendFileSync(HOST_LOG_PATH, `${new Date().toISOString()} ${text}\n`)
        if (fs.statSync(HOST_LOG_PATH).size > 2 * 1024 * 1024) {
          const lines = fs.readFileSync(HOST_LOG_PATH, 'utf8').split('\n').filter(Boolean).slice(-2000)
          fs.writeFileSync(HOST_LOG_PATH, lines.join('\n') + '\n')
        }
      } catch {}
    }

    // 兜底：任何漏网的 rejection / 异常都不应该把整个 DSH 宿主带走。
    // 正常路径都在各自函数里 catch；这里只负责记录并让进程活下去（否则用户只能重启）。
    const onUnhandled = (reason) => hostLog(`[chat-whale] unhandledRejection（已拦截，进程继续）：${reason?.stack ?? reason}`)
    const onUncaught = (error) => hostLog(`[chat-whale] uncaughtException（已拦截，进程继续）：${error?.stack ?? error}`)
    process.on('unhandledRejection', onUnhandled)
    process.on('uncaughtException', onUncaught)
    ctx.effect(() => () => {
      process.off('unhandledRejection', onUnhandled)
      process.off('uncaughtException', onUncaught)
    })

    let lagLast = Date.now()
    const lagTimer = setInterval(() => {
      const now = Date.now()
      const lag = now - lagLast - 5000
      lagLast = now
      if (lag > 1200) hostLog(`[chat-whale] 事件循环卡顿 ${lag}ms（已记录，供排查）`)
    }, 5000)
    ctx.effect(() => () => clearInterval(lagTimer))

    // ── 信任栅栏（与养鱼同款：回环直通，其余交给 connection 判定；失败即拒绝） ──
    function isLoopback(req) {
      const host = String(req.headers?.host ?? '').toLowerCase()
      const head = host.startsWith('[') ? host.slice(0, host.indexOf(']') + 1) : host.split(':')[0]
      return head === '127.0.0.1' || head === 'localhost' || head === '[::1]' || head === '::1'
    }
    function isTrusted(req) {
      if (isLoopback(req)) return true
      try {
        const conn = ctx.get('connection') || ctx.connection
        if (conn && typeof conn.isTrusted === 'function') return conn.isTrusted(req) === true
      } catch {}
      return false
    }
    function rejected(req, res) {
      if (!isTrusted(req)) { json(res, 403, { ok: false, error: '不受信任的访问来源' }); return true }
      try {
        const conn = ctx.get('connection') || ctx.connection
        if (!conn || typeof conn.requestRejection !== 'function') {
          json(res, 503, { ok: false, error: '信任栅栏不可用，拒绝访问' }); return true
        }
        const code = conn.requestRejection(req)
        if (code === undefined || code === null || code === false) return false
        res.statusCode = typeof code === 'number' ? code : 403
        res.end()
        return true
      } catch {
        json(res, 503, { ok: false, error: '信任栅栏异常，拒绝访问' }); return true
      }
    }

    const disposers = []
    function route(kind, pathname, handler) {
      disposers.push(ctx.webServer.register({
        kind,
        path: pathname,
        handler: async (req, res) => {
          if (rejected(req, res)) return
          try { await handler(req, res) } catch (error) {
            try { json(res, 500, { ok: false, error: String(error?.message ?? error) }) } catch {}
          }
        },
      }))
    }

    // ── 引擎 ──────────────────────────────────────────────────────────────
    const asr = new AsrEngine({ ctx, generation, config: readConfig(), log: (line) => hostLog(line) })
    const vision = new VisionEngine({ ctx, config: readConfig(), log: (line) => hostLog(line) })
    const log = (line) => hostLog(line)

    let scheduler = null
    try {
      scheduler = startScheduler({ ctx, readConfig, asr, vision, log, generation })
    } catch (error) {
      console.warn(`[chat-whale] 巡航启动失败：${error.message}`)
    }

    const refreshConfig = () => {
      const config = readConfig()
      asr.updateConfig(config)
      vision.updateConfig(config)
      return config
    }

    // ── 宿主 ↔ agent 的指令通道（agent 的沙箱只能写自己的工作区） ──────────────
    const bridge = createBridge({
      log,
      handler: async (request) => {
        const action = String(request?.action ?? '')
        const config = refreshConfig()
        if (action === 'say') {
          const state = readState()
          const roomId = String(request.roomId ?? state.room?.roomId ?? '').replace(/\D/g, '')
          const verdict = evaluateSpeakPolicy(state, config, { roomId, text: request.text })
          if (!verdict.ok) return { ok: false, error: verdict.reason, blocked: true }
          if (verdict.dryRun) {
            await withStateLock((s) => recordSpeak(s, { roomId, text: verdict.text, dryRun: true }))
            logActivity({ kind: 'say-dry', roomId, text: verdict.text, detail: '演练：没有真的发送' })
            return { ok: true, dryRun: true, text: verdict.text, detail: '演练：没有真的发送' }
          }
          const cred = readCredentials()
          if (!cred) return { ok: false, error: '还没登录 B 站：请主人在设置里扫码' }
          let result
          try {
            result = await sendDanmaku({ roomId, text: verdict.text, cred })
          } catch (error) {
            logActivity({ kind: 'say-failed', roomId, text: verdict.text, detail: error.message })
            return { ok: false, error: error.message }
          }
          if (!result.ok) {
            logActivity({ kind: 'say-failed', roomId, text: verdict.text, detail: `${result.code} ${result.hint}` })
            return { ok: false, error: `${result.hint}（code ${result.code}）`, code: result.code }
          }
          await withStateLock((s) => recordSpeak(s, { roomId, text: verdict.text, dryRun: false }))
          logActivity({ kind: 'say', roomId, text: verdict.text, detail: `已发送到「${result.room.title}」` })
          return { ok: true, sent: true, text: verdict.text, room: { roomId: result.room.roomId, title: result.room.title } }
        }
        if (action === 'leave' || action === 'next') {
          if (!scheduler) return { ok: false, error: '巡航未启动' }
          await scheduler.leaveNow(String(request.reason ?? (action === 'next' ? '换一间' : '离开')))
          if (action === 'next') await withStateLock((s) => { s.cooldownUntil = 0 })
          return { ok: true, action, detail: action === 'next' ? '已离开，下一轮重新找' : '已离开' }
        }
        if (action === 'enter') {
          if (!scheduler) return { ok: false, error: '巡航未启动' }
          const roomId = String(request.roomId ?? '').replace(/\D/g, '')
          if (!roomId) return { ok: false, error: '需要房间号' }
          const room = await scheduler.enterNow(roomId)
          return { ok: true, room }
        }
        if (action === 'observe') {
          if (!scheduler) return { ok: false, error: '巡航未启动' }
          return { ok: true, ...(await scheduler.observeNow()) }
        }
        if (action === 'status') {
          return { ok: true, state: readState(), scheduler: scheduler?.status ?? null }
        }
        if (action === 'next-priority') {
          if (!scheduler) return { ok: false, error: '巡航未启动' }
          return await scheduler.nextNow()
        }
        if (action === 'settings-save') {
          const current = readConfig()
          const started = Date.now()
          const next = normalizeConfig(request.config && typeof request.config === 'object' ? request.config : {}, current)
          writeConfig(next)
          asr.updateConfig(next)
          vision.updateConfig(next)
          const ms = Date.now() - started
          if (ms > 300) hostLog(`[chat-whale] 设置保存耗时 ${ms}ms（配置写入偏慢）`)
          logActivity({ kind: 'settings-save', detail: `模式 ${next.mode}；演练 ${next.interaction.dryRun ? '开' : '关'}；${ms}ms` })
          return { ok: true, config: next, ms }
        }
        if (action === 'cancel') {
          const sessionId = String(request.sessionId ?? '')
          if (!sessionId) return { ok: false, error: '需要 sessionId' }
          const result = ctx.sessionController.cancel({ sessionId })
          logActivity({ kind: 'cancel', detail: `取消会话 ${sessionId} 的活动回合` })
          return { ok: true, sessionId, ...result }
        }
        return { ok: false, error: `未知指令：${action || '(空)'}` }
      },
    })
    ctx.effect(() => () => bridge.stop())

    // ── 设置 ──────────────────────────────────────────────────────────────
    route('exact', '/dsh-chat-whale/api/settings', async (req, res) => {
      if (req.method === 'GET') {
        const config = refreshConfig()
        return json(res, 200, {
          ok: true,
          config,
          state: readState(),
          engines: { asr: asr.status(), vision: vision.status(), ffmpeg: ffmpegStatus(), ocr: ocrAvailable() },
          credentials: credState(),
          paths: { config: CONFIG_PATH, data: DATA_DIR, credentials: CREDENTIALS_PATH, models: ASR_MODEL_DIR },
          scheduler: scheduler?.status ?? { phase: 'init', mode: config.mode, lastError: '巡航未启动' },
        })
      }
      if (req.method !== 'POST') return json(res, 405, { ok: false })
      let body = {}
      try { body = JSON.parse((await readBody(req)) || '{}') } catch { return json(res, 400, { ok: false, error: '提交的内容不是合法 JSON' }) }
      const incoming = (body && typeof body.config === 'object' && body.config) || body || {}
      const current = readConfig()
      const started = Date.now()
      const next = normalizeConfig(incoming, current)
      writeConfig(next)
      asr.updateConfig(next)
      vision.updateConfig(next)
      const ms = Date.now() - started
      if (ms > 300) hostLog(`[chat-whale] 设置保存耗时 ${ms}ms（配置写入偏慢）`)
      logActivity({ kind: 'settings-save', detail: `模式 ${next.mode}；演练 ${next.interaction.dryRun ? '开' : '关'}${ms > 300 ? `；耗时 ${ms}ms` : ''}` })
      return json(res, 200, { ok: true, config: next, scheduler: scheduler?.status ?? null })
    })

    // ── 状态（设置页每 3 秒轮询） ─────────────────────────────────────────
    route('exact', '/dsh-chat-whale/api/status', async (req, res) => {
      const config = refreshConfig()
      const state = readState()
      json(res, 200, {
        ok: true,
        at: Date.now(),
        mode: config.mode,
        dryRun: config.interaction?.dryRun !== false,
        state: {
          phase: state.phase,
          room: state.room,
          candidates: state.candidates ?? [],
          lastError: state.lastError,
          counters: state.counters,
          stats: state.stats,
          cooldownUntil: state.cooldownUntil,
        },
        scheduler: scheduler?.status ?? { phase: 'init', lastError: '巡航未启动' },
        engine: { asr: asr.status(), vision: vision.status(), ffmpeg: ffmpegStatus() },
        models: modelStatus(config),
        prepare: PREPARE,
        ffmpegInstall: FFMPEG_INSTALL,
        activity: readActivity(30),
        bridge: bridge.status(),
        credentials: credState(),
      })
    })

    route('exact', '/dsh-chat-whale/api/activity', async (req, res) => {
      const url = new URL(req.url, 'http://localhost')
      json(res, 200, { ok: true, items: readActivity(Number(url.searchParams.get('limit') ?? 40)) })
    })

    // ── 手动动作 ──────────────────────────────────────────────────────────
    route('exact', '/dsh-chat-whale/api/discover', async (req, res) => {
      if (req.method !== 'POST') return json(res, 405, { ok: false })
      if (!scheduler) return json(res, 503, { ok: false, error: '巡航未启动' })
      const result = await scheduler.discoverNow()
      json(res, 200, { ok: true, ...result })
    })

    route('exact', '/dsh-chat-whale/api/enter', async (req, res) => {
      if (req.method !== 'POST') return json(res, 405, { ok: false })
      if (!scheduler) return json(res, 503, { ok: false, error: '巡航未启动' })
      const body = JSON.parse((await readBody(req)) || '{}')
      const roomId = String(body.roomId ?? '').replace(/\D/g, '')
      if (!roomId) return json(res, 400, { ok: false, error: '需要 roomId' })
      const room = await scheduler.enterNow(roomId)
      json(res, 200, { ok: true, room })
    })

    // 「下一间」= 重新发现 + 进入当前评分最高的候选（不是只刷新列表）
    route('exact', '/dsh-chat-whale/api/next', async (req, res) => {
      if (req.method !== 'POST') return json(res, 405, { ok: false })
      if (!scheduler) return json(res, 503, { ok: false, error: '巡航未启动' })
      const result = await scheduler.nextNow()
      json(res, 200, result)
    })

    route('exact', '/dsh-chat-whale/api/leave', async (req, res) => {
      if (req.method !== 'POST') return json(res, 405, { ok: false })
      if (!scheduler) return json(res, 503, { ok: false, error: '巡航未启动' })
      const body = JSON.parse((await readBody(req)) || '{}')
      await scheduler.leaveNow(String(body.reason ?? '设置页手动离开'))
      json(res, 200, { ok: true })
    })

    route('exact', '/dsh-chat-whale/api/observe', async (req, res) => {
      if (req.method !== 'POST') return json(res, 405, { ok: false })
      if (!scheduler) return json(res, 503, { ok: false, error: '巡航未启动' })
      const result = await scheduler.observeNow()
      json(res, 200, { ok: true, ...result })
    })

    route('exact', '/dsh-chat-whale/api/say-test', async (req, res) => {
      if (req.method !== 'POST') return json(res, 405, { ok: false })
      const body = JSON.parse((await readBody(req)) || '{}')
      const config = refreshConfig()
      const state = readState()
      const roomId = String(body.roomId ?? state.room?.roomId ?? '')
      const text = String(body.text ?? '')
      const { evaluateSpeakPolicy } = await import('./store.js')
      const verdict = evaluateSpeakPolicy(state, config, { roomId, text })
      json(res, 200, { ok: true, verdict, dryRun: true, detail: '这是演练：没有真的发出去' })
    })

    // ── 画面 ─────────────────────────────────────────────────────────────
    route('exact', '/dsh-chat-whale/api/vision/routes', async (req, res) => {
      refreshConfig()
      const listed = await vision.listLlmRoutes()
      json(res, 200, {
        ok: true,
        ...listed,
        key: await vision.keyConfigured(),
        ocr: ocrAvailable(),
        http: { configured: !!(vision.config.vision?.baseURL && (vision.config.vision?.httpModel || vision.config.vision?.model)), ...vision.config.vision },
      })
    })

    route('exact', '/dsh-chat-whale/api/vision/key', async (req, res) => {
      refreshConfig()
      try {
        if (req.method === 'GET') return json(res, 200, { ok: true, key: await vision.keyConfigured() })
        if (req.method === 'DELETE') {
          await vision.clearKey()
          return json(res, 200, { ok: true, configured: false })
        }
        if (req.method !== 'POST') return json(res, 405, { ok: false })
        const body = JSON.parse((await readBody(req)) || '{}')
        await vision.saveKey(body.key)
        logActivity({ kind: 'vision-key', detail: '已保存视觉接口密钥（不回显）' })
        return json(res, 200, { ok: true, configured: true, detail: '密钥已保存到 DSH 凭据服务（不会回显）' })
      } catch (error) {
        json(res, 400, { ok: false, error: error.message })
      }
    })

    route('exact', '/dsh-chat-whale/api/tools/ffmpeg/install', async (req, res) => {
      if (req.method !== 'POST') return json(res, 405, { ok: false })
      if (FFMPEG_INSTALL.running) return json(res, 200, { ok: true, started: false, state: FFMPEG_INSTALL })
      FFMPEG_INSTALL = { running: true, received: 0, total: 0, error: null, done: false, path: null }
      installFfmpeg({
        onProgress: (progress) => { FFMPEG_INSTALL = { ...FFMPEG_INSTALL, received: progress.received, total: progress.total } },
      }).then((result) => {
        FFMPEG_INSTALL = { running: false, received: result.bytes ?? 0, total: result.bytes ?? 0, error: null, done: true, path: result.path, already: result.already === true }
        logActivity({ kind: 'ffmpeg', detail: result.already ? `已有 ffmpeg：${result.path}` : `已安装 ffmpeg：${result.path}` })
      }).catch((error) => {
        FFMPEG_INSTALL = { ...FFMPEG_INSTALL, running: false, error: error.message }
        logActivity({ kind: 'ffmpeg', detail: `安装失败：${error.message}` })
      })
      json(res, 200, { ok: true, started: true, state: FFMPEG_INSTALL })
    })

    route('exact', '/dsh-chat-whale/api/vision/test', async (req, res) => {
      if (req.method !== 'POST') return json(res, 405, { ok: false })
      refreshConfig()
      const state = readState()
      const roomId = String(state.room?.roomId ?? '')
      const sheet = roomId ? latestSheet(roomId) : null
      if (!sheet) return json(res, 200, { ok: false, error: '还没有画面截图：先进一间直播间，等一轮观察' })
      const started = Date.now()
      const result = await vision.describe(sheet, {
        title: state.room?.title, uname: state.room?.uname, area: state.room?.area, online: state.room?.online,
      })
      json(res, 200, { ...result, ms: Date.now() - started, image: `/dsh-chat-whale/api/room-sheet?roomId=${roomId}&t=${Date.now()}` })
    })

    route('exact', '/dsh-chat-whale/api/room-sheet', async (req, res) => {
      const url = new URL(req.url, 'http://localhost')
      const roomId = String(url.searchParams.get('roomId') ?? '').replace(/\D/g, '')
      if (!roomId) return json(res, 400, { ok: false, error: '需要 roomId' })
      const file = latestSheet(roomId)
      if (!file) return json(res, 404, { ok: false, error: '没有截图' })
      const resolved = path.resolve(file)
      if (!resolved.startsWith(path.resolve(ROOMS_DIR) + path.sep)) return json(res, 403, { ok: false })
      const data = fs.readFileSync(resolved)
      res.writeHead(200, { 'content-type': 'image/jpeg', 'cache-control': 'no-store', 'content-length': data.length })
      res.end(data)
    })

    // ── 语音 ─────────────────────────────────────────────────────────────
    route('exact', '/dsh-chat-whale/api/asr/status', async (req, res) => {
      const config = refreshConfig()
      json(res, 200, { ok: true, models: modelStatus(config), engine: asr.status(), prepare: PREPARE, sherpa: resolveSherpaRoot(config) })
    })

    route('exact', '/dsh-chat-whale/api/asr/prepare', async (req, res) => {
      if (req.method !== 'POST') return json(res, 405, { ok: false })
      if (PREPARE.running) return json(res, 200, { ok: true, started: false, prepare: PREPARE })
      const config = refreshConfig()
      PREPARE = { running: true, phase: 'start', file: null, received: 0, total: 0, error: null, done: false, at: Date.now() }
      prepareModels({
        config,
        onProgress: (progress) => {
          if (progress.phase === 'start') PREPARE = { ...PREPARE, phase: 'download', file: progress.file }
          else if (progress.done) PREPARE = { ...PREPARE, file: progress.file, received: progress.received, total: progress.total }
          else PREPARE = { ...PREPARE, file: progress.file, received: progress.received, total: progress.total }
        },
      }).then(() => {
        PREPARE = { ...PREPARE, running: false, done: true, phase: 'done' }
        logActivity({ kind: 'asr-model', detail: 'SenseVoice 模型下载完成' })
        asr.error = null
      }).catch((error) => {
        PREPARE = { ...PREPARE, running: false, phase: 'error', error: error.message }
        logActivity({ kind: 'asr-model', detail: `模型下载失败：${error.message}` })
      })
      json(res, 200, { ok: true, started: true, prepare: PREPARE })
    })

    route('exact', '/dsh-chat-whale/api/asr/test', async (req, res) => {
      if (req.method !== 'POST') return json(res, 405, { ok: false })
      const body = JSON.parse((await readBody(req)) || '{}')
      const config = refreshConfig()
      const state = readState()
      const roomId = String(body.roomId ?? state.room?.roomId ?? '').replace(/\D/g, '')
      if (!roomId) return json(res, 200, { ok: false, error: '先进一间直播间，或用参数指定 roomId' })
      const seconds = Math.max(6, Math.min(20, Number(body.seconds ?? 8) || 8))
      let capture = null
      try {
        capture = await captureRoom({ roomId, cred: readCredentials(), seconds, frames: 1, keepDir: path.join(TMP_DIR, `asr-test-${Date.now()}`) })
        const result = await asr.transcribe(capture.wav, { language: config.voice?.language ?? 'zh' })
        json(res, 200, { ok: true, text: result.text, audioSeconds: result.audioSeconds, inferenceSeconds: result.inferenceSeconds, roomId })
      } finally {
        if (capture) { try { fs.rmSync(capture.dir, { recursive: true, force: true }) } catch {} }
      }
    })

    // ── 登录 ─────────────────────────────────────────────────────────────
    const credentialStore = createCredentialStore({
      file: CREDENTIALS_PATH,
      pending: path.join(DATA_DIR, 'pending-replies.json'),
      verify: verifyAccount,
    })
    const saveLogin = async (credentials, options) => {
      // 登录接口不一定下发 buvid3/buvid4；缺了它们，直播播放/弹幕接口很容易 -352
      const prepared = await ensureBuvid(credentials)
      const account = await credentialStore.save(prepared, options)
      try {
        const current = readConfig()
        writeConfig(normalizeConfig({ ...current, self: { mid: account.mid, name: account.name } }, current))
      } catch {}
      logActivity({ kind: 'login', detail: `B 站账号 ${account.name}（${account.mid}）` })
      return account
    }
    const qrAuth = new QrAuth({ save: saveLogin })
    ctx.effect(() => () => qrAuth.dispose())

    const authRoute = (name, action) => route('exact', `/dsh-chat-whale/api/auth/qr/${name}`, async (req, res) => {
      if (req.method !== 'POST') return json(res, 405, { ok: false })
      try {
        const body = JSON.parse((await readBody(req)) || '{}')
        const result = await action(body)
        json(res, 200, { ok: true, ...result })
      } catch (error) {
        json(res, error instanceof AuthError ? 400 : 503, {
          ok: false,
          error: error instanceof AuthError ? error.message : '登录操作失败，请稍后重试。',
        })
      }
    })
    authRoute('start', () => qrAuth.start())
    authRoute('poll', (body) => qrAuth.poll(String(body.id ?? '')))
    authRoute('cancel', (body) => qrAuth.cancel(String(body.id ?? '')))

    route('exact', '/dsh-chat-whale/api/cookie', async (req, res) => {
      if (req.method !== 'POST') return json(res, 405, { ok: false })
      try {
        const body = JSON.parse((await readBody(req)) || '{}')
        const { parseManualCookie } = await import('./credentials.js')
        const credentials = parseManualCookie(body)
        qrAuth.cancel()
        const account = await saveLogin(credentials)
        json(res, 200, { ok: true, self: { mid: account.mid, name: account.name }, detail: `已登录：${account.name}（mid ${account.mid}）` })
      } catch (error) {
        json(res, 400, { ok: false, error: error instanceof AuthError ? error.message : '登录未保存，请检查输入后重试。' })
      }
    })

    // ── 体检 ─────────────────────────────────────────────────────────────
    route('exact', '/dsh-chat-whale/api/deps', async (req, res) => {
      const config = refreshConfig()
      const cred = readCredentials()
      const models = modelStatus(config)
      const items = [
        { name: 'B 站登录', ok: !!cred, detail: cred ? '已保存登录态（可发弹幕）' : '未登录：只能看，不能发' },
        { name: 'ffmpeg', ...ffmpegStatus() },
        { name: '语音模型', ok: models.ready, detail: models.ready ? models.dir : `缺少 ${models.missing.join('、')}（约 240MB）` },
        { name: 'sherpa-onnx', ok: !!resolveSherpaRoot(config), detail: resolveSherpaRoot(config) ?? '找不到（DSH 安装目录里应有）' },
        { name: '本机 OCR', ok: ocrAvailable(), detail: ocrAvailable() ? 'Windows.Media.Ocr 可用' : '不可用' },
        { name: '巡航', ok: !!scheduler, detail: scheduler ? `${scheduler.status.phase} · ${scheduler.status.mode}` : '未启动' },
        { name: '指令通道', ok: bridge.status().alive, detail: bridge.status().alive ? `${bridge.status().dir}（已处理 ${bridge.status().handled} 条）` : bridge.status().lastError ?? '未启动' },
        { name: '视觉模型', ok: vision.status().llm != null || !!(config.vision?.baseURL && (config.vision?.httpModel || config.vision?.model)), detail: vision.status().lastError ?? (vision.status().llm ? `${vision.status().llm.provider}/${vision.status().llm.model}` : '未配置（会退回本机 OCR）') },
      ]
      json(res, 200, { ok: items.every((item) => item.ok), items, config: CONFIG_PATH, data: DATA_DIR, node: process.execPath })
    })

    // 检查云端仓库版本 / 一键 git pull（仅官方 git 安装支持自动更新）
    route('exact', '/dsh-chat-whale/api/update', async (req, res) => {
      if (req.method === 'GET') return json(res, 200, await checkForUpdate())
      if (req.method !== 'POST') return json(res, 405, { ok: false })
      json(res, 200, await applyUpdate({ log: hostLog }))
    })

    route('exact', '/dsh-chat-whale/api/whoami', async (req, res) => {
      if (req.method !== 'POST') return json(res, 405, { ok: false })
      try {
        const { navInfo } = await import('./bili.js')
        const nav = await navInfo(readCredentials(), { force: true })
        const self = { mid: nav.mid ?? '', name: nav.uname ?? '' }
        if (self.mid) {
          const current = readConfig()
          writeConfig(normalizeConfig({ ...current, self }, current))
        }
        json(res, 200, { ok: nav.isLogin === true, self, retryable: false })
      } catch (error) {
        // 网络/风控失败 ≠ 登录失效；客户端不能因为一次 412/-352 就把账号显示成未登录
        json(res, 200, { ok: false, error: error.message, retryable: true })
      }
    })

    ctx.effect(() => () => {
      try { scheduler?.stop() } catch {}
      try { asr.stop() } catch {}
      // 只有当前代际还是自己时才标记停止，避免把刚启动的新实例的子进程带走
      try {
        const current = JSON.parse(fs.readFileSync(GENERATION_PATH, 'utf8'))
        if (current?.id === generation) {
          fs.writeFileSync(GENERATION_PATH, JSON.stringify({ id: 'stopped', at: Date.now() }) + '\n')
        }
      } catch {}
      for (const dispose of disposers) { try { dispose() } catch {} }
    })

    log(`[chat-whale] 设置页已挂载：/dsh-chat-whale/ · 配置 ${CONFIG_PATH}`)
    log(`[chat-whale] 数据目录 ${DATA_DIR} · 巡航 ${scheduler ? '已启动' : '未启动'}`)
  },
}
