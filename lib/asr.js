import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { spawn } from 'node:child_process'
import { ASR_MODEL_DIR, ASR_WORKER_PATH, PLUGIN_ROOT, DSH_HOME } from './paths.js'

/**
 * 语音识别（听懂主播在说什么）。
 *
 * 两条路，优先级从高到低：
 *   1. DSH 自带的 speechToText 服务（如果 profile 启用了语音输入，并且 provider 已就绪）——
 *      什么都不用下载，直接借它的 SenseVoice。
 *   2. 插件自带的常驻 worker：sherpa-onnx + SenseVoiceSmall int8 模型（约 240MB），
 *      模型从 HF-Mirror / HuggingFace 下载到 <DSH_HOME>/chat-whale/asr。
 *
 * 两条都不通时明确报「识别器不可用」，绝不让 agent 以为自己在听。
 */

export const MODEL_FILES = [
  {
    name: 'model.int8.onnx',
    url: 'https://hf-mirror.com/csukuangfj/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17/resolve/2365baeacb507f821a0c8120fcee3d484dba7a07/model.int8.onnx',
    alt: 'https://huggingface.co/csukuangfj/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17/resolve/2365baeacb507f821a0c8120fcee3d484dba7a07/model.int8.onnx',
    bytes: 239233841,
    sha256: 'c71f0ce00bec95b07744e116345e33d8cbbe08cef896382cf907bf4b51a2cd51',
  },
  {
    name: 'tokens.txt',
    url: 'https://hf-mirror.com/csukuangfj/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17/resolve/2365baeacb507f821a0c8120fcee3d484dba7a07/tokens.txt',
    alt: 'https://huggingface.co/csukuangfj/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17/resolve/2365baeacb507f821a0c8120fcee3d484dba7a07/tokens.txt',
    bytes: 315894,
    sha256: 'f449eb28dc567533d7fa59be34e2abca8784f771850c78a47fb731a31429a1dc',
  },
  {
    name: 'silero_vad.onnx',
    url: 'https://hf-mirror.com/csukuangfj/vad/resolve/fba88cd2e921609e7675c3aaf51e0b9b295da4bc/silero_vad.onnx',
    alt: 'https://huggingface.co/csukuangfj/vad/resolve/fba88cd2e921609e7675c3aaf51e0b9b295da4bc/silero_vad.onnx',
    bytes: 1807522,
    sha256: 'a35ebf52fd3ce5f1469b2a36158dba761bc47b973ea3382b3186ca15b1f5af28',
  },
]

export function modelDir(config = {}) {
  const custom = String(config.voice?.modelDir ?? '').trim()
  return custom || ASR_MODEL_DIR
}

export function modelStatus(config = {}) {
  const dir = modelDir(config)
  const files = MODEL_FILES.map((file) => {
    const target = path.join(dir, file.name)
    let size = 0
    try { size = fs.statSync(target).size } catch {}
    return { name: file.name, path: target, present: size === file.bytes, size, expected: file.bytes }
  })
  return {
    dir,
    ready: files.every((file) => file.present),
    files,
    missing: files.filter((file) => !file.present).map((file) => file.name),
  }
}

// ── node / sherpa 定位 ──────────────────────────────────────────────────────

function findOnPath(exe) {
  const exts = process.platform === 'win32' ? ['.exe', '.cmd', ''] : ['']
  for (const dir of String(process.env.PATH ?? '').split(path.delimiter)) {
    if (!dir) continue
    for (const ext of exts) {
      const file = path.join(dir, exe + ext)
      try { if (fs.statSync(file).isFile()) return file } catch {}
    }
  }
  return null
}

/** 宿主在 Electron 里时 process.execPath 不是 node；这里找真正的 node。 */
export function nodeRuntime() {
  const candidates = [process.env.CHAT_WHALE_NODE, process.env.DSH_NODE]
  const exec = process.execPath
  if (exec && /node(\.exe)?$/i.test(exec)) candidates.push(exec)
  candidates.push(path.join(DSH_HOME, 'bin', 'node.exe'), findOnPath('node'))
  for (const file of candidates) {
    try { if (file && fs.statSync(file).isFile()) return { file, env: process.env } } catch {}
  }
  return { file: findOnPath('node') ?? 'node', env: process.env }
}

export function sherpaRootCandidates(config = {}) {
  const out = []
  const push = (value) => { if (value && !out.includes(value)) out.push(value) }
  push(config.asr?.sherpaRoot)
  push(process.env.CHAT_WHALE_SHERPA)
  push(process.env.DSH_SHERPA_ROOT)
  const argv = process.argv[1] ?? ''
  const dshRoot = path.resolve(path.dirname(argv), '..')
  push(dshRoot)
  const appData = process.env.APPDATA ?? ''
  push(path.join(appData, 'npm', 'node_modules', '@deepseek-ai', 'dsh'))
  push(path.join(process.env.ProgramFiles ?? 'C:\\Program Files', 'nodejs', 'node_modules', '@deepseek-ai', 'dsh'))
  push(path.join(PLUGIN_ROOT, 'node_modules'))
  return out.filter(Boolean)
}

export function resolveSherpaRoot(config = {}) {
  const candidates = []
  for (const base of sherpaRootCandidates(config)) {
    if (!base) continue
    candidates.push(base, path.join(base, 'node_modules', 'sherpa-onnx-node'))
  }
  for (const candidate of candidates) {
    try {
      const pkg = JSON.parse(fs.readFileSync(path.join(candidate, 'package.json'), 'utf8'))
      if (pkg?.name === 'sherpa-onnx-node') return candidate
    } catch {}
  }
  return null
}

// ── 模型下载 ────────────────────────────────────────────────────────────────

async function sha256File(file) {
  const hash = crypto.createHash('sha256')
  await new Promise((resolve, reject) => {
    const stream = fs.createReadStream(file)
    stream.on('data', (chunk) => hash.update(chunk))
    stream.on('end', resolve)
    stream.on('error', reject)
  })
  return hash.digest('hex')
}

async function downloadFile(file, target, { onProgress, signal }) {
  const temp = target + '.part'
  let lastError = null
  for (const url of [file.url, file.alt].filter(Boolean)) {
    try {
      const response = await fetch(url, {
        redirect: 'follow',
        signal: AbortSignal.any([AbortSignal.timeout(20 * 60_000), ...(signal ? [signal] : [])]),
      })
      if (!response.ok || !response.body) throw new Error(`HTTP ${response.status}`)
      const total = Number(response.headers.get('content-length') ?? file.bytes) || file.bytes
      const out = fs.createWriteStream(temp)
      let received = 0
      let lastReport = 0
      try {
        for await (const chunk of response.body) {
          received += chunk.length
          if (!out.write(Buffer.from(chunk))) await new Promise((resolve) => out.once('drain', resolve))
          if (Date.now() - lastReport > 500) {
            lastReport = Date.now()
            onProgress?.({ file: file.name, received, total })
          }
        }
      } finally {
        await new Promise((resolve) => out.end(resolve))
      }
      if (received !== file.bytes) throw new Error(`大小不对：${received} / ${file.bytes}`)
      const digest = await sha256File(temp)
      if (digest !== file.sha256) throw new Error('SHA-256 校验失败')
      fs.renameSync(temp, target)
      onProgress?.({ file: file.name, received, total, done: true })
      return
    } catch (error) {
      lastError = error
      try { fs.rmSync(temp, { force: true }) } catch {}
      if (signal?.aborted) throw new Error('已取消')
    }
  }
  throw new Error(`下载 ${file.name} 失败：${lastError?.message ?? '未知错误'}`)
}

export async function prepareModels({ config = {}, onProgress = () => {}, signal } = {}) {
  const dir = modelDir(config)
  fs.mkdirSync(dir, { recursive: true })
  const status = modelStatus(config)
  const pending = MODEL_FILES.filter((file) => !status.files.find((f) => f.name === file.name)?.present)
  if (!pending.length) return { ok: true, dir, already: true }
  for (let index = 0; index < pending.length; index += 1) {
    const file = pending[index]
    onProgress({ phase: 'start', file: file.name, index, count: pending.length })
    await downloadFile(file, path.join(dir, file.name), { onProgress, signal })
  }
  return { ok: true, dir, files: modelStatus(config).files }
}

// ── 常驻识别 worker ─────────────────────────────────────────────────────────

export class AsrEngine {
  constructor({ ctx = null, config = {}, log = () => {} } = {}) {
    this.ctx = ctx
    this.config = config
    this.log = log
    this.child = null
    this.buffer = ''
    this.pending = new Map()
    this.nextId = 1
    this.ready = false
    this.error = null
    this.starting = null
    this.lastInference = null
    this.sherpaRoot = null
    this.lastActive = null
  }

  updateConfig(config) { this.config = config }

  /** DSH 语音服务里已就绪的识别器（没有服务/没就绪就是空数组）。 */
  serviceProviders() {
    const adapter = speechServiceAdapter(this.ctx)
    if (!adapter) return { available: false, providers: [] }
    try {
      const snapshot = adapter.service.snapshot()
      const providers = (snapshot?.providers ?? []).map((provider) => ({
        id: provider.id,
        name: provider.name,
        phase: provider.preparation?.phase ?? 'unknown',
        languages: provider.languages ?? [],
      }))
      return { available: true, providers, selection: snapshot?.selection ?? null }
    } catch (error) {
      return { available: true, providers: [], error: error.message }
    }
  }

  dshReady() {
    return this.serviceProviders().providers.some((provider) => provider.phase === 'ready' || provider.phase === 'standby')
  }

  status() {
    const models = modelStatus(this.config)
    const service = this.serviceProviders()
    const configured = this.config.voice?.engine ?? 'auto'
    const serviceReady = service.providers.some((provider) => provider.phase === 'ready' || provider.phase === 'standby')
    const sherpa = this.sherpaRoot ?? resolveSherpaRoot(this.config)
    const localReady = models.ready && !!sherpa && configured !== 'dsh' && configured !== 'off'
    return {
      configured,
      active: this.lastActive ?? (serviceReady && configured !== 'local' ? 'dsh' : 'sensevoice-local'),
      ready: this.ready || (serviceReady && configured !== 'local') || localReady,
      error: this.error,
      model: models.ready ? 'ready' : models.missing.length ? `缺少 ${models.missing.join(', ')}` : '未准备',
      dir: models.dir,
      sherpa,
      service,
      lastInference: this.lastInference,
    }
  }

  async ensure() {
    if (this.ready) return true
    if (this.starting) return this.starting
    this.starting = this.start().finally(() => { this.starting = null })
    return this.starting
  }

  async start() {
    this.error = null
    const models = modelStatus(this.config)
    if (!models.ready) {
      this.error = `语音模型未就绪（缺少 ${models.missing.join('、') || '模型文件'}），在设置里点「下载模型」`
      return false
    }
    const sherpa = resolveSherpaRoot(this.config)
    if (!sherpa) {
      this.error = '找不到 sherpa-onnx-node（DSH 安装目录里应该有）。可在设置里填 sherpa 目录。'
      return false
    }
    this.sherpaRoot = sherpa
    const runtime = nodeRuntime()
    const threads = Number(this.config.asr?.threads ?? 0) || Math.min(4, Math.max(1, Math.floor((globalThis.navigator?.hardwareConcurrency ?? 4) / 2)))
    const args = [
      ASR_WORKER_PATH,
      '--model-dir', models.dir,
      '--sherpa', sherpa,
      '--threads', String(threads),
    ]
    this.log(`[chat-whale] 启动语音识别 worker（${threads} 线程）…`)
    const child = spawn(runtime.file, args, {
      windowsHide: true,
      env: { ...runtime.env, CHAT_WHALE_SHERPA: sherpa },
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    this.child = child
    let stderr = ''
    const started = Date.now()
    child.stderr.on('data', (chunk) => { stderr += chunk })
    child.on('exit', (code) => {
      this.ready = false
      this.child = null
      for (const [, entry] of this.pending) entry.reject(new Error('语音识别进程已退出'))
      this.pending.clear()
      if (code !== 0 && !this.error) this.error = `语音识别进程退出（code ${code}）：${stderr.split('\n').filter(Boolean).slice(-1)[0] ?? ''}`
    })
    child.stdout.on('data', (chunk) => this.#onData(chunk))

    return await new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.error = '语音识别进程 45 秒内没有就绪（模型太大或内存不足）'
        try { child.kill() } catch {}
        resolve(false)
      }, 45_000)
      const check = () => {
        if (this.ready) { clearTimeout(timer); resolve(true); return }
        if (!this.child && !this.ready) { clearTimeout(timer); resolve(false); return }
        if (Date.now() - started > 45_000) return
        setTimeout(check, 100)
      }
      check()
    })
  }

  #onData(chunk) {
    this.buffer += chunk.toString('utf8')
    let index
    while ((index = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, index).trim()
      this.buffer = this.buffer.slice(index + 1)
      if (!line) continue
      let message
      try { message = JSON.parse(line) } catch { continue }
      if (message.ready) { this.ready = true; this.error = null; continue }
      const entry = this.pending.get(message.id)
      if (!entry) continue
      this.pending.delete(message.id)
      clearTimeout(entry.timer)
      if (message.ok) entry.resolve(message)
      else entry.reject(new Error(message.error || '识别失败'))
    }
  }

  async transcribe(wavPath, { language = 'zh', signal, timeout = 120_000 } = {}) {
    const mode = this.config.voice?.engine ?? 'auto'
    if (mode === 'off') throw new Error('语音识别已关闭（设置里 engine=off）')

    // 优先借 DSH 自带的语音服务（如果 profile 启用了语音输入并且模型已准备）
    if (mode === 'dsh' || (mode === 'auto' && this.dshReady())) {
      const adapter = speechServiceAdapter(this.ctx)
      if (adapter) {
        try {
          const result = await adapter.transcribe(wavPath, { language, signal })
          this.lastActive = 'dsh'
          this.lastInference = Date.now()
          this.error = null
          return result
        } catch (error) {
          if (mode === 'dsh') throw new Error(`DSH 语音服务不可用：${error.message}`)
          this.log(`[chat-whale] DSH 语音服务失败，改用本地 SenseVoice：${error.message}`)
        }
      } else if (mode === 'dsh') {
        throw new Error('DSH 没有 speechToText 服务。要么启用语音输入 bundle，要么把引擎改成 local/auto')
      }
    }

    const ok = await this.ensure()
    if (!ok) throw new Error(this.error || '语音识别不可用')
    if (signal?.aborted) throw new Error('已取消')
    this.lastActive = 'sensevoice-local'
    const id = this.nextId++
    return await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error('语音识别超时'))
      }, timeout)
      this.pending.set(id, { resolve, reject, timer })
      signal?.addEventListener('abort', () => {
        this.pending.delete(id)
        clearTimeout(timer)
        reject(new Error('已取消'))
      }, { once: true })
      this.child.stdin.write(JSON.stringify({ id, wav: wavPath, language }) + '\n')
    }).then((result) => {
      this.lastInference = Date.now()
      return { text: result.text ?? '', audioSeconds: result.audioSeconds ?? 0, inferenceSeconds: result.inferenceSeconds ?? 0 }
    })
  }

  stop() {
    this.ready = false
    if (this.child) { try { this.child.kill() } catch {} }
    this.child = null
  }
}

/** DSH 自带 speechToText 服务的适配层（可选）。 */
export function speechServiceAdapter(ctx) {
  const service = ctx?.get?.('speechToText') ?? ctx?.speechToText
  if (!service) return null
  return {
    service,
    async transcribe(wavPath, { language = 'zh', signal } = {}) {
      const snapshot = service.snapshot()
      const providers = snapshot?.providers ?? []
      const usable = providers.filter((p) => p.preparation?.phase === 'ready' || p.preparation?.phase === 'standby')
      const provider = usable.find((p) => /sensevoice|whisper/i.test(String(p.id))) ?? usable[0]
      if (!provider) throw new Error('DSH 语音服务里没有已就绪的识别器')
      const audio = new Uint8Array(fs.readFileSync(wavPath))
      const spec = service.resolve({ audio, providerId: provider.id, language })
      const result = await service.transcribe(spec, signal ?? new AbortController().signal)
      return { text: result.text ?? '', audioSeconds: result.audioSeconds ?? 0, inferenceSeconds: result.inferenceSeconds ?? 0 }
    },
  }
}
