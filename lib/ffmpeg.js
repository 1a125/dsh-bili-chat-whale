import fs from 'node:fs'
import path from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import { DATA_DIR, PLUGIN_ROOT, TMP_DIR } from './paths.js'
import { playUrl, headersFor } from './bili.js'

/**
 * 直播片段采集：先把直播流抓成一小段本地 FLV，再让 ffmpeg 在本地切音频/抽帧。
 *
 * 为什么不直接把直播 URL 交给 ffmpeg：
 *   实测本机的 ffmpeg 4.1 直接连 B 站直播 CDN 会卡死在握手（TLS/长连接都不可控）；
 *   而用 Node 抓 N 秒再本地处理，稳定得多，还能精确控制「这一轮只听 20 秒」。
 */

const EXE = process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg'
let cached = null

function exists(file) {
  try { return fs.statSync(file).isFile() } catch { return false }
}

function onPath() {
  for (const dir of String(process.env.PATH ?? '').split(path.delimiter)) {
    if (!dir) continue
    const file = path.join(dir, EXE)
    if (exists(file)) return file
  }
  return null
}

function jianying() {
  if (process.platform !== 'win32') return null
  const base = path.join(process.env.LOCALAPPDATA || '', 'JianyingPro', 'Apps')
  try {
    for (const version of fs.readdirSync(base)) {
      const file = path.join(base, version, EXE)
      if (exists(file)) return file
    }
  } catch {}
  return null
}

export function ffmpegPath() {
  if (cached) return cached
  const candidates = [
    process.env.CHAT_WHALE_FFMPEG,
    process.env.FFMPEG,
    path.join(PLUGIN_ROOT, 'bin', EXE),
    path.join(PLUGIN_ROOT, 'node_modules', '@ffmpeg-installer', 'win32-x64', EXE),
    path.join(DATA_DIR, 'bin', EXE),
    onPath(),
    jianying(),
  ]
  cached = candidates.find(exists) ?? null
  return cached
}

export function ffmpegStatus() {
  const file = ffmpegPath()
  return file ? { ok: true, path: file, detail: file } : {
    ok: false,
    path: null,
    detail: '没有 ffmpeg。点「下载 ffmpeg」自动安装，或把 ffmpeg 放进 PATH / 插件 bin/ 目录。',
    hint: '没有 ffmpeg。点「下载 ffmpeg」自动安装，或把 ffmpeg 放进 PATH / 插件 bin/ 目录。',
  }
}

/**
 * Windows 一键装 ffmpeg：从 npm 镜像取 @ffmpeg-installer/win32-x64 的包，解出 ffmpeg.exe。
 * 不走 GitHub（国内经常超时），也不依赖系统包管理器。
 */
export async function installFfmpeg({ onProgress = () => {}, signal } = {}) {
  if (process.platform !== 'win32') {
    throw new Error('自动安装只支持 Windows。macOS 用 brew install ffmpeg，Linux 用 apt/dnf 安装。')
  }
  const existing = ffmpegPath()
  if (existing) return { ok: true, already: true, path: existing }

  const metaRes = await fetch('https://registry.npmmirror.com/@ffmpeg-installer/win32-x64/latest', {
    signal: AbortSignal.any([AbortSignal.timeout(20_000), ...(signal ? [signal] : [])]),
  })
  if (!metaRes.ok) throw new Error(`查询 ffmpeg 包失败 HTTP ${metaRes.status}`)
  const meta = await metaRes.json()
  const url = meta?.dist?.tarball
  if (!url) throw new Error('镜像没有返回 ffmpeg 包地址')

  fs.mkdirSync(TMP_DIR, { recursive: true })
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`
  const tgz = path.join(TMP_DIR, `ffmpeg-${stamp}.tgz`)
  const extractDir = path.join(TMP_DIR, `ffmpeg-${stamp}`)
  fs.mkdirSync(extractDir, { recursive: true })
  try {
    const response = await fetch(url, {
      signal: AbortSignal.any([AbortSignal.timeout(5 * 60_000), ...(signal ? [signal] : [])]),
    })
    if (!response.ok || !response.body) throw new Error(`下载 ffmpeg 失败 HTTP ${response.status}`)
    const total = Number(response.headers.get('content-length') ?? 0) || 0
    const out = fs.createWriteStream(tgz)
    let received = 0
    let last = 0
    for await (const chunk of response.body) {
      received += chunk.length
      if (!out.write(Buffer.from(chunk))) await new Promise((resolve) => out.once('drain', resolve))
      if (Date.now() - last > 500) { last = Date.now(); onProgress({ received, total }) }
    }
    await new Promise((resolve) => out.end(resolve))

    const tarCandidates = [path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe'), 'tar']
    let extracted = false
    let lastError = null
    for (const tar of tarCandidates) {
      try {
        const result = spawnSync(tar, ['-xzf', tgz, '-C', extractDir], { windowsHide: true, timeout: 120_000 })
        if (result.status === 0) { extracted = true; break }
        lastError = String(result.stderr ?? '').slice(0, 200)
      } catch (error) { lastError = error.message }
    }
    if (!extracted) throw new Error(`解压 ffmpeg 失败：${lastError ?? '找不到 tar'}`)

    const source = path.join(extractDir, 'package', EXE)
    if (!fs.existsSync(source)) throw new Error('压缩包里没有 package/ffmpeg.exe')
    const targetDir = path.join(DATA_DIR, 'bin')
    fs.mkdirSync(targetDir, { recursive: true })
    const target = path.join(targetDir, EXE)
    fs.copyFileSync(source, target)
    cached = null
    const check = spawnSync(target, ['-hide_banner', '-version'], { encoding: 'utf8', windowsHide: true, timeout: 30_000 })
    if (check.status !== 0) throw new Error(`装好的 ffmpeg 跑不起来：${String(check.stderr ?? '').slice(0, 200)}`)
    return { ok: true, path: target, bytes: received, version: String(check.stdout ?? '').split('\n')[0] }
  } finally {
    try { fs.rmSync(tgz, { force: true }) } catch {}
    try { fs.rmSync(extractDir, { recursive: true, force: true }) } catch {}
  }
}

function run(file, args, { timeout = 120_000, signal } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    const timer = setTimeout(() => {
      try { child.kill('SIGKILL') } catch {}
      reject(new Error(`ffmpeg 超时（${Math.round(timeout / 1000)} 秒）`))
    }, timeout)
    const onAbort = () => { try { child.kill('SIGKILL') } catch {} }
    signal?.addEventListener('abort', onAbort, { once: true })
    child.stdout.on('data', (chunk) => { stdout += chunk })
    child.stderr.on('data', (chunk) => { stderr += chunk })
    child.on('error', (error) => { clearTimeout(timer); reject(error) })
    child.on('close', (code) => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      if (signal?.aborted) return reject(new Error('已取消'))
      if (code !== 0) return reject(new Error(`ffmpeg 失败（code ${code}）：${stderr.trim().split('\n').slice(-2).join(' | ').slice(0, 300)}`))
      resolve({ stdout, stderr })
    })
  })
}

/** 抓 N 秒直播流到本地文件。到时间就停，不依赖 Content-Length（直播没有长度）。 */
async function downloadClip(url, output, { seconds, cred, signal, maxBytes = 96 * 1024 * 1024 }) {
  const response = await fetch(url, {
    headers: { ...headersFor(cred), range: 'bytes=0-' },
    signal: AbortSignal.any([AbortSignal.timeout((seconds + 15) * 1000), ...(signal ? [signal] : [])]),
  })
  if (!response.ok) throw new Error(`下载直播流失败 HTTP ${response.status}`)
  if (!response.body) throw new Error('直播流没有响应体')
  const reader = response.body.getReader()
  const out = fs.createWriteStream(output)
  const started = Date.now()
  let bytes = 0
  try {
    while (Date.now() - started < seconds * 1000) {
      const remaining = Math.max(150, seconds * 1000 - (Date.now() - started))
      const chunk = await Promise.race([
        reader.read(),
        new Promise((resolve) => setTimeout(() => resolve({ timeout: true }), remaining)),
      ])
      if (chunk.timeout) break
      if (chunk.done) break
      bytes += chunk.value.length
      if (bytes > maxBytes) break
      if (!out.write(Buffer.from(chunk.value))) {
        await new Promise((resolve) => out.once('drain', resolve))
      }
    }
  } finally {
    try { await reader.cancel() } catch {}
    await new Promise((resolve) => out.end(resolve))
  }
  if (bytes < 20_000) throw new Error(`这一轮只抓到 ${(bytes / 1024).toFixed(0)} KB 直播流，可能刚好断流`)
  return { bytes, durationMs: Date.now() - started }
}

export async function captureRoom({ roomId, cred = null, seconds = 20, frames = 2, signal, keepDir = null }) {
  const ffmpeg = ffmpegPath()
  if (!ffmpeg) throw new Error(ffmpegStatus().hint)
  const stream = await playUrl(roomId, { cred })
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`
  const dir = keepDir ? path.join(keepDir) : path.join(TMP_DIR, `${roomId}-${stamp}`)
  fs.mkdirSync(dir, { recursive: true })
  const clip = path.join(dir, 'clip.flv')
  const wav = path.join(dir, 'audio.wav')
  const framePattern = path.join(dir, 'frame_%02d.jpg')
  const sheet = path.join(dir, 'sheet.jpg')
  try {
    const download = await downloadClip(stream.url, clip, { seconds, cred, signal })
    await run(ffmpeg, ['-y', '-hide_banner', '-loglevel', 'error', '-i', clip, '-t', String(seconds),
      '-vn', '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', wav], { timeout: 90_000, signal })
    const interval = Math.max(1, Math.floor(seconds / Math.max(1, frames)))
    await run(ffmpeg, ['-y', '-hide_banner', '-loglevel', 'error', '-i', clip,
      '-frames:v', String(frames), '-vf', `fps=1/${interval},scale=880:-2`, '-q:v', '4', framePattern], { timeout: 90_000, signal })
    const frameFiles = fs.readdirSync(dir).filter((name) => /^frame_\d+\.jpg$/.test(name)).sort()
    if (frameFiles.length) {
      await run(ffmpeg, ['-y', '-hide_banner', '-loglevel', 'error',
        '-i', framePattern, '-vf', `tile=${frameFiles.length}x1`, '-frames:v', '1', '-q:v', '4', sheet],
      { timeout: 60_000, signal }).catch(() => {})
    }
    return {
      dir,
      clip,
      wav,
      frames: frameFiles.map((name) => path.join(dir, name)),
      sheet: exists(sheet) ? sheet : frameFiles[0] ? path.join(dir, frameFiles[0]) : null,
      bytes: download.bytes,
      seconds: Math.min(seconds, download.durationMs / 1000),
      qn: stream.qn,
      tmp: !keepDir,
    }
  } catch (error) {
    fs.rmSync(dir, { recursive: true, force: true })
    throw error
  }
}

export function cleanupCapture(capture) {
  if (!capture?.tmp) return
  try { fs.rmSync(capture.dir, { recursive: true, force: true }) } catch {}
}
