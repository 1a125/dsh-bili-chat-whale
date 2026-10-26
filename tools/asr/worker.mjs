import { createRequire } from 'node:module'
import fs from 'node:fs'
import path from 'node:path'
import readline from 'node:readline'

/**
 * 本地语音识别 worker（SenseVoiceSmall + Silero VAD，跑在 CPU 上）。
 *
 * 为什么是独立进程：
 *   · sherpa-onnx 是同步原生调用，放在宿主进程里会把 DSH 卡住；
 *   · 模型加载一次要几百毫秒到几秒，所以常驻 + 用 stdin/stdout 收发请求，避免每段都重新加载。
 *
 * 协议（每行一个 JSON）：
 *   输入  {"id":1,"wav":"C:\\...\\clip.wav","language":"zh"}
 *   输出  {"id":1,"ok":true,"text":"...","audioSeconds":19.8,"inferenceSeconds":1.2}
 *        {"id":1,"ok":false,"error":"..."}
 * 启动完成后先输出 {"ready":true,...}。
 *
 * sherpa-onnx-node 从哪里来：优先 --sherpa（可以给 dsh 根目录，也可以给 sherpa-onnx-node 包目录），
 * 其次从本机 DSH 安装目录推断。找不到就退出并说明原因 —— 不要静默假装能识别。
 */

function parseArgs(argv) {
  const out = new Map()
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i]
    if (!key.startsWith('--')) continue
    const value = argv[i + 1]?.startsWith('--') ? true : argv[++i] ?? true
    out.set(key.slice(2), value)
  }
  return out
}

function resolveSherpa(arg) {
  const candidates = []
  if (arg) {
    candidates.push(arg)
    candidates.push(path.join(arg, 'node_modules', 'sherpa-onnx-node'))
    candidates.push(path.join(arg, 'sherpa-onnx-node'))
  }
  // 从本进程路径反推 DSH 安装目录：.../<dsh>/node_modules/... 之类都试一遍
  const here = path.resolve(process.argv[1] ?? '.')
  let dir = path.dirname(here)
  for (let i = 0; i < 8; i += 1) {
    candidates.push(path.join(dir, 'node_modules', 'sherpa-onnx-node'))
    candidates.push(path.join(dir, 'sherpa-onnx-node'))
    dir = path.dirname(dir)
  }
  for (const candidate of candidates) {
    try {
      if (!candidate) continue
      const pkg = fs.statSync(path.join(candidate, 'package.json'))
      if (pkg.isFile()) return candidate
    } catch {}
  }
  return null
}

function readWav(file) {
  const buffer = fs.readFileSync(file)
  if (buffer.length < 44 || buffer.toString('ascii', 0, 4) !== 'RIFF' || buffer.toString('ascii', 8, 12) !== 'WAVE') {
    throw new Error('不是合法的 WAV 文件')
  }
  let offset = 12
  let fmt = null
  let data = null
  while (offset + 8 <= buffer.length) {
    const id = buffer.toString('ascii', offset, offset + 4)
    const size = buffer.readUInt32LE(offset + 4)
    const start = offset + 8
    if (id === 'fmt ') {
      fmt = {
        audioFormat: buffer.readUInt16LE(start),
        channels: buffer.readUInt16LE(start + 2),
        sampleRate: buffer.readUInt32LE(start + 4),
        bitsPerSample: buffer.readUInt16LE(start + 14),
      }
    } else if (id === 'data') {
      data = buffer.subarray(start, Math.min(buffer.length, start + size))
      break
    }
    offset = start + size + (size % 2)
  }
  if (!fmt || !data) throw new Error('WAV 缺少 fmt/data 块')
  if (fmt.audioFormat !== 1 || fmt.channels !== 1 || fmt.sampleRate !== 16000 || fmt.bitsPerSample !== 16) {
    throw new Error(`WAV 必须是 16kHz 单声道 PCM16（现在是 ${fmt.sampleRate}Hz/${fmt.channels}ch/${fmt.bitsPerSample}bit）`)
  }
  const samples = new Float32Array(Math.floor(data.length / 2))
  for (let i = 0; i < samples.length; i += 1) samples[i] = data.readInt16LE(i * 2) / 32768
  return samples
}

const args = parseArgs(process.argv.slice(2))
const modelDir = String(args.get('model-dir') ?? '')
const model = String(args.get('model') ?? path.join(modelDir, 'model.int8.onnx'))
const tokens = String(args.get('tokens') ?? path.join(modelDir, 'tokens.txt'))
const vad = String(args.get('vad') ?? path.join(modelDir, 'silero_vad.onnx'))
const threads = Math.max(1, Math.min(16, Number(args.get('threads') ?? 2) || 2))
const sherpaDir = resolveSherpa(args.get('sherpa') ? String(args.get('sherpa')) : '')

function fail(message) {
  process.stderr.write(String(message) + '\n')
  process.exit(1)
}

if (!sherpaDir) fail('找不到 sherpa-onnx-node。它通常随 DSH 一起安装；可在设置里填「sherpa 目录」，或设置 DSH_NODE_SHERPA。')
for (const [name, file] of [['模型', model], ['词表', tokens], ['VAD', vad]]) {
  if (!fs.existsSync(file)) fail(`缺少 SenseVoice ${name}：${file}`)
}

let sherpa
try {
  const requireFromDsh = createRequire(path.join(sherpaDir, 'package.json'))
  sherpa = requireFromDsh('sherpa-onnx-node')
} catch (error) {
  fail(`加载 sherpa-onnx-node 失败：${error.message}`)
}

let recognizer
let detector
try {
  const nativeConfig = {
    featConfig: { sampleRate: 16000, featureDim: 80 },
    modelConfig: {
      senseVoice: { model, language: 'auto', useInverseTextNormalization: 1 },
      tokens,
      numThreads: threads,
      provider: 'cpu',
      debug: 0,
    },
  }
  recognizer = new sherpa.OfflineRecognizer(nativeConfig)
  detector = new sherpa.Vad({
    sileroVad: {
      model: vad,
      threshold: 0.5,
      minSilenceDuration: 0.4,
      minSpeechDuration: 0.25,
      maxSpeechDuration: 30,
      windowSize: 512,
    },
    sampleRate: 16000,
    numThreads: threads,
    provider: 'cpu',
    debug: 0,
  }, 32)
} catch (error) {
  fail(`加载 SenseVoice 模型失败：${error.message}`)
}

/** 用 VAD 切句，逐段识别；没有语音就返回空串。 */
function transcribe(samples, language) {
  const started = performance.now()
  const texts = []
  detector.reset()
  recognizer.setConfig({
    featConfig: coreConfig.featConfig,
    modelConfig: { ...coreConfig.modelConfig, senseVoice: { model, language, useInverseTextNormalization: 1 } },
  })
  const drain = () => {
    while (!detector.isEmpty()) {
      const segment = detector.front(false)
      const stream = recognizer.createStream()
      stream.acceptWaveform({ sampleRate: 16000, samples: segment.samples })
      recognizer.decode(stream)
      const text = String(recognizer.getResult(stream).text ?? '').trim()
      if (text) texts.push(text)
      detector.pop()
    }
  }
  for (let offset = 0; offset < samples.length; offset += 512) {
    detector.acceptWaveform(samples.subarray(offset, offset + 512))
    drain()
  }
  detector.flush()
  drain()
  return {
    text: texts.join(' ').trim(),
    audioSeconds: samples.length / 16000,
    inferenceSeconds: (performance.now() - started) / 1000,
  }
}

const coreConfig = {
  featConfig: { sampleRate: 16000, featureDim: 80 },
  modelConfig: {
    senseVoice: { model, language: 'auto', useInverseTextNormalization: 1 },
    tokens,
    numThreads: threads,
    provider: 'cpu',
    debug: 0,
  },
}

process.stdout.write(JSON.stringify({ ready: true, sherpa: sherpaDir, threads, model }) + '\n')

// 空闲 10 分钟自动退出，避免插件热重载/异常时留下吃内存的孤儿进程。
// 宿主下一次 transcribe 会重新拉起（模型加载很快）。
let idleTimer = null
function resetIdle() {
  if (idleTimer) clearTimeout(idleTimer)
  idleTimer = setTimeout(() => { process.stderr.write('idle timeout\n'); process.exit(0) }, 10 * 60_000)
}
resetIdle()

const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity })
let busy = false
rl.on('line', (line) => {
  const clean = String(line).replace(/^\uFEFF/, '').trim()
  if (!clean) return
  let request
  try { request = JSON.parse(clean) } catch {
    process.stdout.write(JSON.stringify({ id: null, ok: false, error: '请求不是 JSON' }) + '\n')
    return
  }
  if (busy) {
    process.stdout.write(JSON.stringify({ id: request.id ?? null, ok: false, error: 'worker 还在处理上一条' }) + '\n')
    return
  }
  busy = true
  try {
    const samples = readWav(String(request.wav ?? ''))
    const result = transcribe(samples, String(request.language ?? 'zh'))
    process.stdout.write(JSON.stringify({ id: request.id ?? null, ok: true, ...result }) + '\n')
  } catch (error) {
    process.stdout.write(JSON.stringify({ id: request.id ?? null, ok: false, error: String(error.message ?? error) }) + '\n')
  } finally {
    busy = false
    resetIdle()
  }
})
rl.on('close', () => process.exit(0))
