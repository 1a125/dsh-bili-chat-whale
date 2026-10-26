import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'
import { danmuInfo, roomInfo, readCredentials } from '../lib/bili.js'

/**
 * 直播弹幕监听子进程。
 *
 * 宿主把它挂在一个房间里；它把「谁说了什么、谁进来了、送了什么、直播间下没下播」
 * 一行行写进 events.jsonl，宿主再读最后几十行拼给 agent 看。
 * 断开自动重连；主播下播就退出（宿主据此换房间）。
 *
 * 用法：
 *   node tools/live-ws.mjs --room 12345 --out <绝对路径>/events.jsonl [--minutes 180]
 */

const args = new Map()
for (let i = 2; i < process.argv.length; i += 1) {
  const key = process.argv[i]
  if (!key.startsWith('--')) continue
  const value = process.argv[i + 1]?.startsWith('--') ? true : process.argv[++i] ?? true
  args.set(key.slice(2), value)
}
const roomId = String(args.get('room') ?? '').replace(/\D/g, '')
const outFile = String(args.get('out') ?? '')
const maxMinutes = Math.max(1, Math.min(720, Number(args.get('minutes') ?? 180) || 180))
const generation = String(args.get('generation') ?? '')
const generationFile = String(args.get('generation-file') ?? '')
if (!roomId || !outFile) {
  console.error('用法: node live-ws.mjs --room <房间号> --out <events.jsonl>')
  process.exit(2)
}

fs.mkdirSync(path.dirname(outFile), { recursive: true })

// 插件热重载后旧实例的弹幕监听自行退出，避免残留连接和进程
if (generation && generationFile) {
  const timer = setInterval(() => {
    try {
      const current = JSON.parse(fs.readFileSync(generationFile, 'utf8'))
      if (current?.id !== generation) {
        console.error('插件实例已更换，弹幕监听退出')
        process.exit(0)
      }
    } catch {
      process.exit(0)
    }
  }, 30_000)
  timer.unref?.()
}

function emit(event) {
  try { fs.appendFileSync(outFile, JSON.stringify({ t: Date.now(), ...event }) + '\n') } catch (error) {
    console.error(`写事件失败：${error.message}`)
  }
}

const cred = readCredentials()
const startedAt = Date.now()
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function packet(op, payload) {
  const body = new TextEncoder().encode(payload)
  const buffer = Buffer.alloc(16 + body.length)
  buffer.writeUInt32BE(16 + body.length, 0)
  buffer.writeUInt16BE(16, 4)
  buffer.writeUInt16BE(1, 6)
  buffer.writeUInt32BE(op, 8)
  buffer.writeUInt32BE(1, 12)
  buffer.set(body, 16)
  return buffer
}

const seen = new Set()
function handlePacket(buffer) {
  let offset = 0
  while (offset + 16 <= buffer.length) {
    const total = buffer.readUInt32BE(offset)
    if (total < 16 || offset + total > buffer.length) break
    const headerLength = buffer.readUInt16BE(offset + 4)
    const version = buffer.readUInt16BE(offset + 6)
    const op = buffer.readUInt32BE(offset + 8)
    const body = buffer.subarray(offset + headerLength, offset + total)
    if (version === 3) {
      try { handlePacket(zlib.brotliDecompressSync(body)) } catch {}
    } else if (version === 2) {
      try { handlePacket(zlib.inflateSync(body)) } catch {}
    } else if (op === 5) {
      try { handleMessage(JSON.parse(body.toString('utf8'))) } catch {}
    }
    offset += total
  }
}

function text(value, limit = 300) {
  return String(value ?? '').slice(0, limit)
}

function handleMessage(message) {
  const cmd = String(message?.cmd ?? '')
  if (cmd.startsWith('DANMU_MSG')) {
    const info = message.info ?? []
    const dmid = String(info?.[0]?.[5] ?? '')
    if (dmid && seen.has(dmid)) return
    if (dmid) { seen.add(dmid); if (seen.size > 2000) seen.clear() }
    emit({
      type: 'danmaku',
      dmid,
      text: text(info?.[1], 200),
      uid: String(info?.[2]?.[0] ?? ''),
      uname: text(info?.[2]?.[1], 60),
      medal: String(info?.[3]?.[1] ?? ''),
      medalLevel: Number(info?.[3]?.[0] ?? 0) || 0,
    })
    return
  }
  if (cmd === 'SUPER_CHAT_MESSAGE') {
    emit({
      type: 'superchat',
      text: text(message.data?.message, 300),
      uname: text(message.data?.user_info?.uname, 60),
      price: Number(message.data?.price ?? 0) || 0,
    })
    return
  }
  if (cmd === 'SEND_GIFT') {
    emit({
      type: 'gift',
      uname: text(message.data?.uname, 60),
      gift: text(message.data?.giftName, 40),
      num: Number(message.data?.num ?? 0) || 0,
    })
    return
  }
  if (cmd.startsWith('INTERACT_WORD')) {
    const data = message.data ?? {}
    emit({ type: 'enter', uname: text(data.uname, 60), uid: String(data.uid ?? '') })
    return
  }
  if (cmd === 'WATCHED_CHANGE') {
    emit({ type: 'viewers', num: Number(message.data?.num ?? 0) || 0 })
    return
  }
  if (cmd === 'ONLINE_RANK_COUNT') {
    emit({ type: 'viewers', num: Number(message.data?.count ?? 0) || 0 })
    return
  }
  if (cmd === 'NOTICE_MSG') {
    emit({ type: 'notice', text: text(message.msg_common ?? message.message ?? '', 200) })
    return
  }
  if (cmd === 'ROOM_REAL_TIME_MESSAGE_UPDATE') {
    emit({ type: 'fans', fans: Number(message.data?.fans ?? 0) || 0, fansClub: Number(message.data?.fans_club ?? 0) || 0 })
    return
  }
  if (cmd === 'LIVE') {
    emit({ type: 'live', text: text(message.live_time ?? '', 40) })
    return
  }
  if (cmd === 'PREPARING') {
    emit({ type: 'end', reason: '主播下播了' })
    console.log('ROOM_END')
    process.exit(0)
  }
  if (cmd === 'WARNING') {
    emit({ type: 'warning', text: text(message.msg ?? '', 200) })
    return
  }
  if (cmd === 'CUT_OFF') {
    emit({ type: 'warning', text: text(message.msg ?? '被系统切断', 200) })
    return
  }
}

let socket = null
let heartbeat = null
let stopping = false

async function connect() {
  const info = await roomInfo(roomId, { cred })
  if (info.liveStatus !== 1) {
    emit({ type: 'end', reason: '未开播或已下播' })
    console.log('ROOM_END')
    process.exit(0)
  }
  emit({ type: 'room', roomId: info.roomId, title: info.title, uid: info.uid, online: info.online })
  const danmu = await danmuInfo(info.roomId, { cred })
  const host = danmu.hosts?.[0]
  if (!host) throw new Error('没有可用的弹幕服务器')
  const url = `wss://${host.host}:${host.wss_port}/sub`
  console.error(`连接 ${url}（房间 ${info.roomId}）`)
  const ws = new WebSocket(url)
  socket = ws
  ws.binaryType = 'arraybuffer'
  // 常驻 error 监听：open 阶段的 once 监听只负责拒绝 promise，后续错误不能没人管
  ws.addEventListener('error', (event) => {
    console.error(`WS 错误：${event?.message ?? event?.type ?? ''}`)
  })

  const opened = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('WebSocket 连接超时')), 20_000)
    ws.addEventListener('open', () => {
      clearTimeout(timer)
      // uid 必须是数字：未登录时 0；登录后 nav 返回的是字符串，直接塞进去 B 站会立刻断开
      ws.send(packet(7, JSON.stringify({ uid: Number(danmu.uid) || 0, roomid: Number(info.roomId), protover: 3, platform: 'web', type: 2, key: danmu.token })))
      console.log('WS_READY')
      attempts = 0
      reconnecting = false
      resolve()
    }, { once: true })
    ws.addEventListener('error', (event) => {
      clearTimeout(timer)
      reject(new Error(`WebSocket 错误：${event?.message ?? event?.type ?? ''}`))
    }, { once: true })
  })
  await opened
  heartbeat = setInterval(() => {
    try { ws.send(packet(2, '[object Object]')) } catch {}
  }, 30_000)

  ws.addEventListener('message', async (event) => {
    try {
      const arrayBuffer = event.data instanceof ArrayBuffer ? event.data : await event.data?.arrayBuffer?.()
      if (arrayBuffer) handlePacket(Buffer.from(arrayBuffer))
    } catch {}
  })
  ws.addEventListener('close', () => {
    clearInterval(heartbeat)
    if (!stopping) reconnect('连接断开')
  })
}

let attempts = 0
let reconnecting = false
function reconnect(reason) {
  if (stopping || reconnecting) return
  reconnecting = true
  attempts += 1
  if (attempts > 6) {
    console.error(`重连失败太多次：${reason}`)
    process.exit(3)
  }
  const wait = Math.min(30_000, 2000 * attempts)
  console.error(`WS 断开（${reason}），${Math.round(wait / 1000)} 秒后重连（第 ${attempts} 次）`)
  setTimeout(() => {
    connect().catch((error) => {
      console.error(`重连失败：${error.message}`)
      reconnecting = false
      reconnect(error.message)
    })
  }, wait)
}

// 看门狗：到点/主播下播就收工
const watchdog = setInterval(async () => {
  if (Date.now() - startedAt > maxMinutes * 60_000) {
    console.error('到达最长监听时间，退出')
    stopping = true
    try { socket?.close() } catch {}
    process.exit(0)
  }
  try {
    const info = await roomInfo(roomId, { cred })
    if (info.liveStatus !== 1) {
      emit({ type: 'end', reason: '主播下播了' })
      console.log('ROOM_END')
      stopping = true
      try { socket?.close() } catch {}
      process.exit(0)
    }
  } catch {}
}, 60_000)

process.on('SIGTERM', () => { stopping = true; clearInterval(heartbeat); clearInterval(watchdog); try { socket?.close() } catch {}; process.exit(0) })
process.on('SIGINT', () => { stopping = true; clearInterval(heartbeat); clearInterval(watchdog); try { socket?.close() } catch {}; process.exit(0) })

connect().catch((error) => {
  console.error(`监听启动失败：${error.message}`)
  process.exit(4)
})
