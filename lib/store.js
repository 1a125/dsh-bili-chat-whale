import fs from 'node:fs'
import path from 'node:path'
import {
  ACTIVITY_PATH, CONTROL_PATH, DATA_DIR, ROOMS_DIR, STATE_PATH,
} from './paths.js'

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

export function readJson(file, fallback = null) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')) } catch { return fallback }
}

export function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const temp = `${file}.${process.pid}.${Date.now()}.tmp`
  try {
    fs.writeFileSync(temp, JSON.stringify(value, null, 2) + '\n')
    fs.renameSync(temp, file)
  } finally {
    try { fs.rmSync(temp, { force: true }) } catch {}
  }
}

export const todayKey = (now = Date.now()) => new Date(now).toLocaleDateString('sv-SE')

/** 状态文件很小；宿主和 CLI 都会改它。用一把短锁避免「最后一写覆盖」把计数吃掉。 */
export async function withStateLock(fn) {
  fs.mkdirSync(DATA_DIR, { recursive: true })
  const lock = STATE_PATH + '.lock'
  const deadline = Date.now() + 5000
  let fd
  while (fd === undefined) {
    try {
      fd = fs.openSync(lock, 'wx')
      fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, at: Date.now() }))
    } catch (error) {
      if (error.code !== 'EEXIST') throw error
      try {
        const age = Date.now() - fs.statSync(lock).mtimeMs
        let owner = 0
        try { owner = Number(JSON.parse(fs.readFileSync(lock, 'utf8')).pid) || 0 } catch {}
        let dead = false
        if (owner > 0) { try { process.kill(owner, 0) } catch (e) { dead = e.code === 'ESRCH' } }
        if (dead || age > 8000) { fs.rmSync(lock, { force: true }); continue }
      } catch {}
      if (Date.now() > deadline) throw new Error('状态锁繁忙，请稍后重试')
      await sleep(30)
    }
  }
  try {
    const state = readState()
    const result = await fn(state)
    writeState(state)
    return result
  } finally {
    try { fs.closeSync(fd) } catch {}
    try { fs.rmSync(lock, { force: true }) } catch {}
  }
}

export function defaultState() {
  const day = todayKey()
  return {
    version: 1,
    phase: 'idle',
    room: null,
    cooldownUntil: 0,
    lastSearchAt: 0,
    lastTickAt: 0,
    lastError: null,
    counters: { day, dayCount: 0, hourAt: 0, hourCount: 0 },
    stats: { roomsVisited: 0, danmakuSent: 0, observations: 0, lastWakeAt: 0 },
    visited: {},
    candidates: [],
    engines: { asr: null, vision: null },
  }
}

export function readState() {
  const state = readJson(STATE_PATH, null)
  if (!state || typeof state !== 'object') return defaultState()
  return { ...defaultState(), ...state }
}

export function writeState(state) {
  writeJson(STATE_PATH, state)
}

export function updateState(mutate) {
  const state = readState()
  const result = mutate(state)
  writeState(state)
  return result
}

// ── 记录 ────────────────────────────────────────────────────────────────────

export function logActivity(entry) {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true })
    const line = JSON.stringify({ at: new Date().toISOString(), ...entry })
    fs.appendFileSync(ACTIVITY_PATH, line + '\n')
    // 日志不该无限长：超过 2MB 时只保留最近 1500 行
    const size = fs.statSync(ACTIVITY_PATH).size
    if (size > 2 * 1024 * 1024) {
      const lines = fs.readFileSync(ACTIVITY_PATH, 'utf8').split('\n').filter(Boolean).slice(-1500)
      fs.writeFileSync(ACTIVITY_PATH, lines.join('\n') + '\n')
    }
  } catch {}
}

export function readActivity(limit = 60) {
  try {
    const lines = fs.readFileSync(ACTIVITY_PATH, 'utf8').split('\n').filter(Boolean)
    return lines.slice(-Math.max(1, Math.min(500, limit))).map((line) => {
      try { return JSON.parse(line) } catch { return { at: null, kind: 'bad-line', detail: line.slice(0, 120) } }
    }).reverse()
  } catch { return [] }
}

// ── 发言闸门（CLI 和宿主共用；真正的发送方是 CLI） ─────────────────────────

export function evaluateSpeakPolicy(state, config, { roomId, text, now = Date.now() }) {
  const textValue = String(text ?? '').replace(/\s+/g, ' ').trim()
  const maxChars = config.safety?.maxDanmakuChars ?? 20
  if (!textValue) return { ok: false, reason: '弹幕不能是空的' }
  if ([...textValue].length > maxChars) return { ok: false, reason: `弹幕超过 ${maxChars} 字（B 站限制），删短一点再来` }
  for (const word of config.safety?.blockedWords ?? []) {
    if (word && textValue.includes(word)) return { ok: false, reason: `撞到禁用词「${word}」` }
  }
  if (config.mode === 'off') return { ok: false, reason: '总开关是关的' }
  if (config.mode === 'watch') return { ok: false, reason: '现在是「只看不说」模式' }

  const interaction = config.interaction ?? {}
  const room = state.room
  if (roomId && String(roomId) !== String(room?.roomId ?? '')) return { ok: false, reason: `当前不在房间 ${roomId}` }
  if (!room) return { ok: false, reason: '还没进任何直播间' }

  const c = state.counters ?? {}
  const day = todayKey(now)
  const dayCount = c.day === day ? Number(c.dayCount ?? 0) : 0
  const hourCount = now - Number(c.hourAt ?? 0) < 3600_000 ? Number(c.hourCount ?? 0) : 0
  if (dayCount >= (interaction.maxPerDay ?? 40)) return { ok: false, reason: `今天已经发了 ${dayCount} 条，到上限了` }
  if (hourCount >= (interaction.maxPerHour ?? 15)) return { ok: false, reason: `这一小时已经发了 ${hourCount} 条，到上限了` }
  if (Number(room.spoken ?? 0) >= (interaction.maxPerRoom ?? 5)) return { ok: false, reason: `这个房间已经发了 ${room.spoken} 条，到上限了` }
  const gap = (interaction.minGapSec ?? 75) * 1000
  if (room.lastSpokeAt && now - Number(room.lastSpokeAt) < gap) {
    const left = Math.ceil((gap - (now - Number(room.lastSpokeAt))) / 1000)
    return { ok: false, reason: `离上一条才 ${Math.round((now - room.lastSpokeAt) / 1000)} 秒，再等 ${left} 秒` }
  }
  const history = Array.isArray(room.sentTexts) ? room.sentTexts : []
  if (history.some((item) => item && String(item.text) === textValue)) return { ok: false, reason: '这句话在这个房间已经发过了' }
  const recent = (room.recentTexts ?? []).slice(-6)
  if (recent.some((t) => similarity(String(t), textValue) > 0.82)) return { ok: false, reason: '和最近说过的太像了，换个说法' }

  return { ok: true, text: textValue, dryRun: interaction.dryRun !== false }
}

function similarity(a, b) {
  if (!a || !b) return 0
  const grams = (s) => {
    const set = new Set()
    for (let i = 0; i < s.length - 1; i += 1) set.add(s.slice(i, i + 2))
    return set
  }
  const A = grams(a); const B = grams(b)
  if (!A.size || !B.size) return a === b ? 1 : 0
  let hit = 0
  for (const g of A) if (B.has(g)) hit += 1
  return (2 * hit) / (A.size + B.size)
}

/** 记一条发言（真发和 dry-run 都记，但计数分开）。 */
export function recordSpeak(state, { roomId, text, dryRun, dmid = null, code = null }) {
  const now = Date.now()
  const day = todayKey(now)
  const c = state.counters ?? {}
  state.counters = {
    day,
    dayCount: c.day === day ? Number(c.dayCount ?? 0) : 0,
    hourAt: now - Number(c.hourAt ?? 0) < 3600_000 ? Number(c.hourAt ?? now) : now,
    hourCount: now - Number(c.hourAt ?? 0) < 3600_000 ? Number(c.hourCount ?? 0) : 0,
  }
  if (state.room && String(state.room.roomId) === String(roomId)) {
    state.room.lastSpokeAt = now
    state.room.spoken = Number(state.room.spoken ?? 0) + 1
    state.room.sentTexts = [...(state.room.sentTexts ?? []), { text, at: now, dryRun, dmid }].slice(-30)
    state.room.recentTexts = [...(state.room.recentTexts ?? []), text].slice(-12)
  }
  if (!dryRun) {
    state.counters.dayCount += 1
    state.counters.hourCount += 1
    state.stats = { ...(state.stats ?? {}), danmakuSent: Number(state.stats?.danmakuSent ?? 0) + 1 }
  }
  writeState(state)
}

// ── 控制意图（CLI → 宿主） ─────────────────────────────────────────────────

export function pushControl(intent) {
  writeJson(CONTROL_PATH, { at: Date.now(), ...intent })
}

export function takeControl() {
  const value = readJson(CONTROL_PATH, null)
  if (!value) return null
  try { fs.rmSync(CONTROL_PATH, { force: true }) } catch {}
  return value
}

// ── 房间现场（观察记录 / 弹幕 / 事件） ───────────────────────────────────────

export function roomDir(roomId) {
  const dir = path.join(ROOMS_DIR, String(roomId).replace(/[^\d]/g, ''))
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

export function appendRoomRecord(roomId, record) {
  try {
    const dir = roomDir(roomId)
    const file = path.join(dir, 'session.jsonl')
    fs.appendFileSync(file, JSON.stringify({ at: Date.now(), ...record }) + '\n')
    const size = fs.statSync(file).size
    if (size > 4 * 1024 * 1024) {
      const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).slice(-1200)
      fs.writeFileSync(file, lines.join('\n') + '\n')
    }
  } catch {}
}

export function readRoomRecords(roomId, limit = 40) {
  try {
    const file = path.join(roomDir(roomId), 'session.jsonl')
    const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean)
    return lines.slice(-limit).map((line) => {
      try { return JSON.parse(line) } catch { return null }
    }).filter(Boolean)
  } catch { return [] }
}

/** 读取事件文件末尾（WS 子进程写的 JSONL）。 */
export function readEventTail(roomId, maxLines = 80) {
  try {
    const file = path.join(roomDir(roomId), 'events.jsonl')
    const stat = fs.statSync(file)
    if (stat.size > 2 * 1024 * 1024) {
      // 轮转：只留最后 1MB，避免无限增长
      const text = fs.readFileSync(file, 'utf8')
      const cut = text.slice(-1024 * 1024)
      const firstNewline = cut.indexOf('\n')
      fs.writeFileSync(file, firstNewline >= 0 ? cut.slice(firstNewline + 1) : cut)
    }
    const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean)
    return lines.slice(-maxLines).map((line) => {
      try { return JSON.parse(line) } catch { return null }
    }).filter(Boolean)
  } catch { return [] }
}

/** 清理 7 天以前的房间现场，别把用户磁盘塞满。 */
export function pruneRoomData(maxAgeDays = 7) {
  try {
    const cutoff = Date.now() - maxAgeDays * 86400_000
    for (const name of fs.readdirSync(ROOMS_DIR)) {
      const dir = path.join(ROOMS_DIR, name)
      try {
        const stat = fs.statSync(dir)
        if (stat.isDirectory() && stat.mtimeMs < cutoff) fs.rmSync(dir, { recursive: true, force: true })
      } catch {}
    }
  } catch {}
}
