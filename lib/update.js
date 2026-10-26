import fs from 'node:fs'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { PLUGIN_ROOT } from './paths.js'

const REPO = '1a125/dsh-bili-chat-whale'
const API_URL = `https://api.github.com/repos/${REPO}/releases/latest`
const RELEASE_URL = `https://github.com/${REPO}/releases`
const CACHE_MS = 30 * 60_000

let cache = { at: 0, value: null }

export function readCurrentVersion() {
  try {
    return String(JSON.parse(fs.readFileSync(path.join(PLUGIN_ROOT, 'package.json'), 'utf8')).version ?? '0.0.0')
  } catch {
    return '0.0.0'
  }
}

export function parseVersion(value) {
  const match = String(value ?? '').trim().replace(/^v/i, '').match(/^(\d+)\.(\d+)\.(\d+)/)
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null
}

export function compareVersions(a, b) {
  const left = parseVersion(a)
  const right = parseVersion(b)
  if (!left || !right) return 0
  for (let i = 0; i < 3; i += 1) {
    if (left[i] > right[i]) return 1
    if (left[i] < right[i]) return -1
  }
  return 0
}

export async function checkForUpdate({ force = false, fetchImpl = globalThis.fetch, timeoutMs = 10_000 } = {}) {
  if (!force && cache.value && Date.now() - cache.at < CACHE_MS) return cache.value
  const current = readCurrentVersion()
  try {
    const data = await fetchLatestJson(fetchImpl, timeoutMs)
    const latest = String(data.tag_name ?? '').replace(/^v/i, '')
    if (!parseVersion(latest)) throw new Error('云端版本号格式不对')
    const value = {
      ok: true,
      current,
      latest,
      updateAvailable: compareVersions(latest, current) > 0,
      name: String(data.name ?? ''),
      notes: String(data.body ?? '').slice(0, 1200),
      publishedAt: data.published_at ?? null,
      releaseUrl: String(data.html_url ?? RELEASE_URL),
      checkedAt: Date.now(),
    }
    cache = { at: Date.now(), value }
    return value
  } catch (error) {
    const value = {
      ok: false,
      current,
      latest: null,
      updateAvailable: false,
      error: error?.name === 'TimeoutError' ? '检查更新超时' : String(error?.message ?? '检查更新失败'),
      releaseUrl: RELEASE_URL,
      checkedAt: Date.now(),
    }
    cache = { at: Date.now(), value }
    return value
  }
}

/** Node 自带 CA 在部分 Windows 机器上验不过 GitHub 证书；回退到系统 curl。 */
function curlLatestJson(timeoutMs) {
  return new Promise((resolve, reject) => {
    const bin = process.platform === 'win32' ? 'curl.exe' : 'curl'
    const args = [
      '-fsSL', '--max-time', String(Math.max(5, Math.round(timeoutMs / 1000))),
      ...(process.platform === 'win32' ? ['--ssl-no-revoke'] : []),
      '-H', 'Accept: application/vnd.github+json',
      '-H', 'User-Agent: dsh-bili-chat-whale',
      API_URL,
    ]
    execFile(bin, args, { windowsHide: true, timeout: timeoutMs + 3000 }, (error, stdout, stderr) => {
      if (error) return reject(new Error(String(stderr || error.message).trim().slice(0, 300)))
      try { resolve(JSON.parse(String(stdout).replace(/^\uFEFF/, '').trim())) } catch (parseError) { reject(new Error(`curl 返回的不是 JSON：${parseError.message}`)) }
    })
  })
}

async function fetchLatestJson(fetchImpl, timeoutMs) {
  try {
    if (typeof fetchImpl !== 'function') throw new Error('当前 Node 没有 fetch')
    const response = await fetchImpl(API_URL, {
      headers: {
        Accept: 'application/vnd.github+json',
        'User-Agent': 'dsh-bili-chat-whale',
      },
      signal: AbortSignal.timeout(timeoutMs),
    })
    if (!response.ok) throw new Error(`GitHub API HTTP ${response.status}`)
    return await response.json()
  } catch (fetchError) {
    try {
      return await curlLatestJson(timeoutMs)
    } catch (curlError) {
      throw new Error(`${fetchError.message}；curl 回退失败：${curlError.message}`)
    }
  }
}

function git(args) {
  return new Promise((resolve, reject) => {
    execFile('git', args, {
      cwd: PLUGIN_ROOT,
      windowsHide: true,
      timeout: 30_000,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
    }, (error, stdout, stderr) => {
      if (error) reject(new Error(String(stderr || error.message).trim().slice(0, 500)))
      else resolve(String(stdout ?? ''))
    })
  })
}

/** 只支持「git clone 下来的官方仓库」；npm/复制安装返回 manual 提示。 */
export async function applyUpdate({ log = () => {} } = {}) {
  const info = await checkForUpdate({ force: true })
  if (!info.ok) return { ...info, applied: false }
  if (!info.updateAvailable) return { ...info, ok: true, applied: false, detail: `已经是最新版本 v${info.current}` }
  if (!fs.existsSync(path.join(PLUGIN_ROOT, '.git'))) {
    return {
      ...info,
      ok: false,
      applied: false,
      manual: true,
      error: '当前安装不是 git 仓库，无法一键更新；请按 Release 页面手动更新',
    }
  }
  try {
    const dirty = (await git(['status', '--porcelain'])).trim()
    if (dirty) throw new Error('插件目录有未提交改动，先处理后再更新')
    const remote = (await git(['remote', 'get-url', 'origin'])).trim()
    if (!/1a125\/dsh-bili-chat-whale(?:\.git)?$/i.test(remote)) {
      throw new Error('origin 不是官方仓库，拒绝自动更新')
    }
    const branch = (await git(['rev-parse', '--abbrev-ref', 'HEAD'])).trim()
    if (branch !== 'main') throw new Error(`当前分支是 ${branch}，请先切回 main`)
    log('[chat-whale] 开始从 GitHub 更新…')
    await git(['pull', '--ff-only', 'origin', 'main'])
    const updatedTo = readCurrentVersion()
    const value = {
      ok: true,
      applied: true,
      current: updatedTo,
      previous: info.current,
      latest: info.latest,
      updateAvailable: false,
      restartRequired: true,
      releaseUrl: info.releaseUrl,
      detail: `已更新到 v${updatedTo}，重启 DSH 后生效`,
    }
    cache = { at: Date.now(), value: { ...info, ...value } }
    log(`[chat-whale] 更新完成：v${info.current} → v${updatedTo}`)
    return value
  } catch (error) {
    return { ...info, ok: false, applied: false, error: `更新失败：${error.message}` }
  }
}
