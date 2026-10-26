#!/usr/bin/env node
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { readConfig } from '../lib/config.js'
import { discoverRooms } from '../lib/discovery.js'
import { sendDanmaku, readCredentials, roomInfo } from '../lib/bili.js'
import { evaluateSpeakPolicy, logActivity, pushControl, readActivity, readState, recordSpeak, roomDir, withStateLock } from '../lib/store.js'
import { ffmpegStatus } from '../lib/ffmpeg.js'
import { modelStatus, prepareModels, resolveSherpaRoot, AsrEngine, nodeRuntime } from '../lib/asr.js'
import { ocrAvailable } from '../lib/ocr.js'
import { VisionEngine } from '../lib/vision.js'
import { captureRoom } from '../lib/ffmpeg.js'
import { CLI_PATH, DATA_DIR, CONFIG_PATH, CREDENTIALS_PATH, STATE_PATH, BRIDGE_INBOX, BRIDGE_OUTBOX, WORK_DIR } from '../lib/paths.js'
import { bridgeAlive } from '../lib/bridge.js'

/**
 * 聊天鲸的命令行 —— 宿主叫醒 agent 之后，agent 用它做决定。
 *
 * 最重要的两条：
 *   say        发一条弹幕（默认演练；--go 才真发，且必须过闸门）
 *   next       换一间（写控制意图，宿主 10 秒内执行）
 *
 * 不用 HTTP：宿主可能正忙着抓流，CLI 直接读写同一份配置/状态，再用 B 站接口发送。
 * 这样即使宿主在重启，agent 也能完成一次发言。
 */

const argv = process.argv.slice(2)
const command = argv[0]
const flags = new Map()
for (let i = 1; i < argv.length; i += 1) {
  const key = argv[i]
  if (!key.startsWith('--')) continue
  const value = argv[i + 1]?.startsWith('--') ? true : argv[++i] ?? true
  flags.set(key.slice(2), value)
}
const str = (name, fallback = '') => String(flags.get(name) ?? fallback)
const bool = (name) => flags.has(name) && flags.get(name) !== 'false'
const json = bool('json')
const print = (value) => console.log(json ? JSON.stringify(value, null, 2) : value)

function fail(message, code = 2) {
  if (json) console.log(JSON.stringify({ ok: false, error: message, code }))
  else console.error(message)
  process.exit(code)
}

/**
 * 把请求交给宿主执行。
 *
 * 为什么不直接发：agent 的 pwsh 跑在 workspace-write 沙箱里，写不了宿主的状态目录；
 * 直接发会 EPERM，然后 agent 去申请「完全访问」，每条弹幕都要主人点一次批准。
 * 这里只往工作区里的 .chat-whale/inbox 放一个 JSON，宿主每秒处理并回执。
 */
async function sendHost(request, { timeout = 25_000 } = {}) {
  const info = bridgeAlive()
  if (!info) {
    throw new Error('宿主的指令通道不在（.chat-whale/bridge.json 不存在或心跳过期）。确认 DSH 里「聊天鲸」插件正在运行。')
  }
  fs.mkdirSync(BRIDGE_INBOX, { recursive: true })
  fs.mkdirSync(BRIDGE_OUTBOX, { recursive: true })
  const id = `${Date.now()}-${process.pid}-${crypto.randomBytes(3).toString('hex')}`
  const target = path.join(BRIDGE_INBOX, `${id}.json`)
  const temp = `${target}.${process.pid}.tmp`
  fs.writeFileSync(temp, JSON.stringify({ id, at: Date.now(), ...request }))
  fs.renameSync(temp, target)
  const resultFile = path.join(BRIDGE_OUTBOX, `${id}.json`)
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    if (fs.existsSync(resultFile)) {
      let result
      try { result = JSON.parse(fs.readFileSync(resultFile, 'utf8')) } catch { result = { ok: false, error: '回执不是合法 JSON' } }
      try { fs.rmSync(resultFile, { force: true }) } catch {}
      return result
    }
    await new Promise((resolve) => setTimeout(resolve, 150))
  }
  throw new Error('宿主 25 秒内没有处理这条指令（可能正忙或卡住）。这次不算发出去了。')
}

function humanStatus() {
  const config = readConfig()
  const state = readState()
  const lines = [
    `模式：${config.mode}${config.interaction?.dryRun !== false ? '（演练，不真发）' : ''}`,
    `阶段：${state.phase}`,
    state.room
      ? `当前房间：${state.room.roomId}「${state.room.title}」主播 ${state.room.uname || '?'} · ${state.room.online ?? '?'} 人在线 · 已待 ${Math.round((Date.now() - Number(state.room.enteredAt ?? 0)) / 60000)} 分钟`
      : '当前房间：无',
    state.room
      ? `已发：${state.room.spoken ?? 0} 条；上一条：${state.room.lastSpokeAt ? Math.round((Date.now() - state.room.lastSpokeAt) / 1000) + ' 秒前' : '还没发'}`
      : '',
    `今天：${state.counters?.dayCount ?? 0} 条（上限 ${config.interaction?.maxPerDay ?? 40}）`,
    state.lastError ? `最近错误：${state.lastError}` : '',
  ].filter(Boolean)
  return lines.join('\n')
}

async function main() {
  if (!command || command === 'help' || command === '--help') {
    console.log(`聊天鲸 CLI

  node "${CLI_PATH}" status [--json]
  node "${CLI_PATH}" discover [--keyword 词] [--json]
  node "${CLI_PATH}" enter --room <房间号>
  node "${CLI_PATH}" leave [--reason 原因]
  node "${CLI_PATH}" next [--reason 原因]
  node "${CLI_PATH}" say --text "..." [--go] [--json]
  node "${CLI_PATH}" observe [--seconds 15] [--json]
  node "${CLI_PATH}" cancel [--session bili-chat-whale]
  node "${CLI_PATH}" log [--limit 20]
  node "${CLI_PATH}" deps [--json]
  node "${CLI_PATH}" asr-prepare

说明：
  · say 默认只演练；配置里 dryRun=false 且带 --go 才会真的发。
  · say / next / leave / enter / observe 都交给宿主执行（agent 的沙箱写不了宿主的数据目录）。
  · 宿主不在时这些命令会明确报错，不会假装发出去了。
  · 只有手动调试才用 --direct（需要直接读写宿主数据目录的权限）。`)
    return
  }

  const config = readConfig()

  if (command === 'status') {
    const state = readState()
    if (json) {
      return print({
        ok: true,
        config: { mode: config.mode, dryRun: config.interaction?.dryRun !== false },
        state: {
          phase: state.phase, room: state.room, cooldownUntil: state.cooldownUntil,
          candidates: state.candidates, lastError: state.lastError,
          counters: state.counters, stats: state.stats,
        },
      })
    }
    return print(humanStatus())
  }

  if (command === 'discover') {
    const state = readState()
    const result = await discoverRooms({
      config,
      cred: readCredentials(),
      state,
      limit: Number(flags.get('limit') ?? 6),
      keyword: str('keyword') || null,
      log: (line) => { if (!json) console.error(line) },
    })
    if (json) return print({ ok: true, ...result })
    if (!result.candidates.length) {
      console.log('没找到合适的直播间。')
      if (result.errors.length) console.log('失败：' + result.errors.join('；'))
      return
    }
    for (const room of result.candidates) {
      console.log(`\n[${room.roomId}] ${room.title}`)
      console.log(`  主播 ${room.uname || '?'} · ${room.online} 人在线 · ${room.area || '?'} · 评分 ${room.score}`)
      console.log(`  命中兴趣：${room.hits?.join('、') || '（无）'} · 关键词「${room.keyword}」`)
    }
    return
  }

  if (command === 'enter') {
    const roomId = str('room').replace(/\D/g, '')
    if (!roomId) fail('需要 --room <房间号>')
    try {
      const result = await sendHost({ action: 'enter', roomId })
      if (!result.ok) fail(result.error || '宿主没能进入这个房间', 3)
      if (json) return print(result)
      console.log(`已请求进入 ${roomId}${result.room?.title ? `「${result.room.title}」` : ''}`)
      return
    } catch (error) {
      fail(error.message, 3)
    }
  }

  if (command === 'leave' || command === 'next') {
    const reason = str('reason') || (command === 'next' ? 'agent 决定换一间' : 'agent 决定离开')
    try {
      const result = await sendHost({ action: command, reason })
      if (!result.ok) fail(result.error || '宿主没能执行', 3)
      if (json) return print(result)
      console.log(result.detail || '已请求宿主处理')
      return
    } catch (error) {
      fail(error.message, 3)
    }
  }

  if (command === 'say') {
    const text = str('text')
    const state = readState()
    const roomId = str('room') || state.room?.roomId
    if (!roomId) fail('现在不在任何直播间里')
    if (!bool('direct')) {
      try {
        const result = await sendHost({ action: 'say', text, roomId, dry: !bool('go') })
        if (!result.ok) {
          if (json) { print(result); process.exit(2) }
          return fail(`不发：${result.error}`, 2)
        }
        if (json) return print(result)
        console.log(result.dryRun ? `[演练] 本来要发：${result.text}` : `已发送：${result.text}`)
        return
      } catch (error) {
        if (json) return print({ ok: false, error: error.message })
        return fail(`不发：${error.message}`, 3)
      }
    }
    const policy = evaluateSpeakPolicy(state, config, { roomId, text })
    if (!policy.ok) {
      logActivity({ kind: 'say-blocked', roomId, detail: policy.reason, text: text.slice(0, 60) })
      if (json) return print({ ok: false, error: policy.reason, blocked: true })
      return fail(`不发：${policy.reason}`, 2)
    }
    const wantGo = bool('go')
    const dryRun = config.interaction?.dryRun !== false || !wantGo
    if (dryRun) {
      const note = config.interaction?.dryRun !== false ? '配置里开着演练模式' : '没加 --go'
      await withStateLock((state) => recordSpeak(state, { roomId, text: policy.text, dryRun: true }))
      logActivity({ kind: 'say-dry', roomId, text: policy.text, detail: note })
      if (json) return print({ ok: true, dryRun: true, text: policy.text, detail: `演练：没有真的发送（${note}）` })
      console.log(`[演练] 本来要发：${policy.text}`)
      console.log(`（没有真的发送：${note}）`)
      return
    }
    const cred = readCredentials()
    if (!cred) fail('还没登录 B 站。请主人在「设置 → 聊天鲸」里扫码。', 3)
    try {
      const result = await sendDanmaku({ roomId, text: policy.text, cred })
      if (!result.ok) {
        logActivity({ kind: 'say-failed', roomId, text: policy.text, detail: `${result.code} ${result.hint}` })
        if (json) return print({ ok: false, error: `${result.hint}（code ${result.code}）`, code: result.code })
        console.error(`没发出去：${result.hint}（code ${result.code}）`)
        process.exit(4)
      }
      await withStateLock((state) => recordSpeak(state, { roomId, text: policy.text, dryRun: false }))
      logActivity({ kind: 'say', roomId, text: policy.text, detail: `已发送到「${result.room.title}」` })
      return print({ ok: true, sent: true, text: policy.text, room: { roomId: result.room.roomId, title: result.room.title } })
    } catch (error) {
      logActivity({ kind: 'say-failed', roomId, text: policy.text, detail: error.message })
      fail(error.message, 3)
    }
  }

  if (command === 'observe') {
    const state = readState()
    const roomId = str('room') || state.room?.roomId
    if (!roomId) fail('现在不在任何直播间里；可加 --room <房间号>')
    if (!bool('direct')) {
      try {
        const result = await sendHost({ action: 'observe' }, { timeout: 60_000 })
        if (!result.ok) fail(result.error || '观察失败', 3)
        if (json) return print(result)
        console.log(`听：${result.speech || '（没听到清楚的人声）'}`)
        console.log(`看：${result.vision || `（没有画面描述${result.visionError ? '：' + result.visionError : ''}）`}`)
        return
      } catch (error) {
        fail(`观察失败：${error.message}`, 3)
      }
    }
    const seconds = Math.max(6, Math.min(40, Number(flags.get('seconds') ?? 15) || 15))
    const capDir = path.join(roomDir(roomId), 'cli-caps', String(Date.now()))
    const capture = await captureRoom({ roomId, cred: readCredentials(), seconds, frames: 2, keepDir: capDir })
    let speech = ''
    let asrError = null
    if (config.voice?.enabled !== false) {
      try {
        const engine = new AsrEngine({ config, log: (line) => { if (!json) console.error(line) } })
        speech = (await engine.transcribe(capture.wav, { language: config.voice?.language ?? 'zh' })).text
        engine.stop()
      } catch (error) { asrError = error.message }
    }
    const vision = new VisionEngine({ ctx: null, config })
    const described = await vision.describe(capture.sheet, { title: state.room?.title ?? '', uname: state.room?.uname ?? '' })
    try { fs.rmSync(capture.clip, { force: true }); fs.rmSync(capture.wav, { force: true }) } catch {}
    const result = {
      ok: true,
      roomId,
      seconds,
      speech,
      vision: described.text,
      visionMode: described.mode,
      visionError: described.ok ? null : described.error,
      asrError,
      sheet: capture.sheet,
    }
    if (json) return print(result)
    console.log(`听：${speech || `（没听到人声${asrError ? '：' + asrError : ''}）`}`)
    console.log(`看：${described.ok ? `[${described.mode}] ${described.text}` : `（不可用：${described.error}）`}`)
    return
  }

  if (command === 'cancel') {
    const sessionId = str('session') || config.session?.id
    try {
      const result = await sendHost({ action: 'cancel', sessionId })
      if (!result.ok) fail(result.error || '取消失败', 3)
      return print(result)
    } catch (error) {
      fail(error.message, 3)
    }
  }

  if (command === 'log') {
    const items = readActivity(Number(flags.get('limit') ?? 20))
    if (json) return print({ ok: true, items })
    for (const item of items) {
      console.log(`${String(item.at ?? '').slice(11, 19)} ${item.kind}  ${item.title ? `「${item.title}」` : ''}${item.text ?? ''} ${item.detail ?? ''}`)
    }
    return
  }

  if (command === 'deps') {
    const cred = readCredentials()
    const models = modelStatus(config)
    const deps = [
      { name: 'B 站登录', ok: !!cred, detail: cred ? '已保存登录态' : `缺少 ${CREDENTIALS_PATH}` },
      { name: 'ffmpeg', ...ffmpegStatus() },
      { name: '语音模型', ok: models.ready, detail: models.ready ? models.dir : `缺少 ${models.missing.join('、')}` },
      { name: 'sherpa-onnx', ok: !!resolveSherpaRoot(config), detail: resolveSherpaRoot(config) ?? '找不到（DSH 安装目录里应有）' },
      { name: '本机 OCR', ok: ocrAvailable(), detail: ocrAvailable() ? 'Windows.Media.Ocr 可用' : '不可用（非 Windows 或未装语言包）' },
      { name: 'node', ok: !!nodeRuntime().file, detail: nodeRuntime().file },
      { name: '指令通道', ok: !!bridgeAlive(), detail: bridgeAlive() ? `${BRIDGE_INBOX}` : '宿主没运行（bridge 心跳过期）' },
      { name: '配置目录', ok: fs.existsSync(DATA_DIR), detail: DATA_DIR },
    ]
    if (json) return print({ ok: deps.every((item) => item.ok), items: deps, config: CONFIG_PATH, state: STATE_PATH })
    for (const item of deps) console.log(`${item.ok ? '✓' : '✗'} ${item.name} — ${item.detail}`)
    return
  }

  if (command === 'asr-prepare') {
    if (!json) console.log('开始下载 SenseVoice 模型（约 240MB，第一次会慢）…')
    const result = await prepareModels({
      config: { ...config, voice: { ...config.voice, modelDir: str('dir') || config.voice?.modelDir } },
      onProgress: (progress) => {
        if (json) return
        if (progress.done) console.log(`✓ ${progress.file}`)
        else if (progress.received) process.stdout.write(`\r${progress.file}: ${Math.round(progress.received / 1024 / 1024)} / ${Math.round((progress.total ?? 0) / 1024 / 1024)} MB   `)
      },
    })
    if (!json) console.log(`\n完成：${result.dir}`)
    return print({ ok: true, ...result })
  }

  fail(`未知命令：${command}（node ${CLI_PATH} help 看用法）`)
}

main().catch((error) => {
  if (json) console.log(JSON.stringify({ ok: false, error: error.message }))
  else console.error(`出错：${error.message}`)
  process.exit(1)
})
