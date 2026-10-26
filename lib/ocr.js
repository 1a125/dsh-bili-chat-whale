import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { TOOLS_ROOT } from './paths.js'

/**
 * 本机 OCR 兜底：用 Windows 自带的 Windows.Media.Ocr 读画面上的字。
 *
 * 它不"理解"画面，但能读到：主播贴的字幕、歌名歌词、游戏 UI、公告、聊天区 ——
 * 对「这个直播间在干嘛」已经是很强的线索，而且完全离线、不花钱。
 */

const SCRIPT = path.join(TOOLS_ROOT, 'ocr.ps1')
const PS = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')

export function ocrAvailable() {
  if (process.platform !== 'win32') return false
  try { return fs.statSync(SCRIPT).isFile() && fs.statSync(PS).isFile() } catch { return false }
}

function cleanLines(raw) {
  const out = []
  const seen = new Set()
  for (const line of raw) {
    let text = String(line ?? '')
      // Windows OCR 会把中文逐字加空格，这里补回来
      .replace(/([\u3400-\u9fff])\s+(?=[\u3400-\u9fff])/g, '$1')
      .replace(/\s{2,}/g, ' ')
      .trim()
    if ([...text].length < 2) continue
    if (/^[\p{P}\p{S}\s]+$/u.test(text)) continue
    if (seen.has(text)) continue
    seen.add(text)
    out.push(text)
  }
  return out.slice(0, 40)
}

export function ocrImage(file, { timeout = 25_000 } = {}) {
  if (!ocrAvailable()) return Promise.resolve({ ok: false, error: '本机 OCR 不可用（需要 Windows 10/11）' })
  const outFile = path.join(os.tmpdir(), `chat-whale-ocr-${process.pid}-${Date.now()}.json`)
  return new Promise((resolve) => {
    const child = spawn(PS, ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', SCRIPT], {
      windowsHide: true,
      env: { ...process.env, OCR_IMAGE: path.resolve(file), OCR_OUT: outFile },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stderr = ''
    const finish = (value) => {
      try { child.kill() } catch {}
      try { fs.rmSync(outFile, { force: true }) } catch {}
      resolve(value)
    }
    const timer = setTimeout(() => finish({ ok: false, error: 'OCR 超时' }), timeout)
    child.stderr.on('data', (chunk) => { stderr += chunk.toString('utf8') })
    child.on('close', () => {
      clearTimeout(timer)
      try {
        const parsed = JSON.parse(fs.readFileSync(outFile, 'utf8').replace(/^\uFEFF/, ''))
        if (!parsed.ok) return finish({ ok: false, error: parsed.error || 'OCR 失败' })
        finish({ ok: true, lang: parsed.lang, lines: cleanLines(parsed.lines ?? []) })
      } catch {
        finish({ ok: false, error: stderr.trim().slice(0, 200) || 'OCR 返回无法解析' })
      }
    })
    child.on('error', (error) => {
      clearTimeout(timer)
      finish({ ok: false, error: error.message })
    })
  })
}
