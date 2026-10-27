import crypto from 'node:crypto'
import fs from 'node:fs'
import { BAN_PATH, CREDENTIALS_PATH } from './paths.js'
import { readJson, writeJson } from './store.js'

/**
 * B 站接口层（直播相关）。
 *
 * 只做四件事：签名、节流/熔断、读直播间、发弹幕。
 * 刻意不引第三方 SDK：B 站的 WBI 签名与直播接口都很稳定，自己维护反而可控。
 */

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
const MIXIN = [46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35, 27, 43, 5, 49, 33, 9, 42, 19, 29, 28, 14, 39, 12, 38, 41, 13, 37, 48, 7, 16, 24, 55, 40, 61, 26, 17, 0, 1, 60, 51, 30, 4, 22, 25, 54, 21, 56, 59, 6, 63, 57, 62, 11, 36, 20, 34, 44, 52]
const RISK_CODES = new Set([-412, -352, -799, -509, -10403])
const keyOf = (url) => String(url ?? '').split('/').at(-1).split('.')[0]

export class BiliError extends Error {
  constructor(message, { code = null, hint = null } = {}) {
    super(message)
    this.name = 'BiliError'
    this.code = code
    this.hint = hint
  }
}

export function readCredentials() {
  const raw = readJson(CREDENTIALS_PATH, null)
  if (!raw) return null
  for (const key of ['sessdata', 'bili_jct']) {
    if (!raw[key] || !String(raw[key]).trim()) return null
  }
  return {
    sessdata: String(raw.sessdata),
    bili_jct: String(raw.bili_jct),
    buvid3: String(raw.buvid3 ?? ''),
    buvid4: String(raw.buvid4 ?? ''),
  }
}

export function cookieHeader(cred) {
  if (!cred) return ''
  return [
    `SESSDATA=${cred.sessdata}`,
    `bili_jct=${cred.bili_jct}`,
    cred.buvid3 ? `buvid3=${cred.buvid3}` : '',
    cred.buvid4 ? `buvid4=${cred.buvid4}` : '',
  ].filter(Boolean).join('; ')
}

let buvidCache = { at: 0, b3: '', b4: '' }

/**
 * B 站登录接口常返回 SESSDATA/bili_jct，但不一定带 device fingerprint。
 * 只有 SESSDATA 没有 buvid3/buvid4 时，直播播放/弹幕接口很容易 -352。
 * 这里用公开的 finger/spi 补一对 buvid，缓存 6 小时。
 */
export async function ensureBuvid(cred) {
  if (!cred) return cred
  if (cred.buvid3 && cred.buvid4) return cred
  if (!buvidCache.b3 || Date.now() - buvidCache.at > 6 * 3600_000) {
    try {
      const response = await fetch('https://api.bilibili.com/x/frontend/finger/spi', {
        headers: { 'user-agent': UA, referer: 'https://www.bilibili.com/', accept: 'application/json' },
        signal: AbortSignal.timeout(8000),
      })
      const data = await response.json()
      if (Number(data?.code) === 0 && data?.data?.b_3) {
        buvidCache = { at: Date.now(), b3: String(data.data.b_3), b4: String(data.data.b_4 ?? '') }
      }
    } catch {}
  }
  return { ...cred, buvid3: cred.buvid3 || buvidCache.b3, buvid4: cred.buvid4 || buvidCache.b4 }
}

export function headersFor(cred, referer = 'https://live.bilibili.com/') {
  const headers = {
    'user-agent': UA,
    referer,
    accept: 'application/json, text/plain, */*',
    'accept-language': 'zh-CN,zh;q=0.9',
  }
  const cookie = cookieHeader(cred)
  if (cookie) headers.cookie = cookie
  return headers
}

// ── 节流与熔断 ──────────────────────────────────────────────────────────────

let lastRequestAt = 0
let queue = Promise.resolve()
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function throttle() {
  const turn = queue.then(async () => {
    const wait = 350 - (Date.now() - lastRequestAt)
    if (wait > 0) await sleep(wait)
    lastRequestAt = Date.now()
  })
  queue = turn.catch(() => {})
  return turn
}

export function banState(now = Date.now()) {
  const ban = readJson(BAN_PATH, {}) ?? {}
  const why = String(ban.why ?? '')
  // 旧版把 code=-352 也写成全局熔断，导致一个弹幕 token 失败连登录/播放都一起被挡。
  // 升级后忽略这类 code 级旧记录；只保留 HTTP 412/429 的 IP 级熔断。
  const legacyCodeBan = why.startsWith('code=')
  return {
    banned: !legacyCodeBan && Number(ban.until ?? 0) > now,
    minutesLeft: legacyCodeBan ? 0 : Math.max(0, Math.ceil((Number(ban.until ?? 0) - now) / 60000)),
    why: ban.why ?? null,
    streak: Number(ban.streak ?? 0),
  }
}

function setBan(ms, why, streak) {
  writeJson(BAN_PATH, { until: Date.now() + ms, why, streak, at: new Date().toISOString() })
}

function clearBanStreak() {
  const ban = readJson(BAN_PATH, {})
  if (ban?.streak) writeJson(BAN_PATH, { ...ban, streak: 0, until: 0 })
}

async function requestJson(url, { cred, referer, method = 'GET', body = null, signal, recordRisk = true } = {}) {
  const ban = banState()
  if (ban.banned) {
    throw new BiliError(`B 站限流中，约 ${ban.minutesLeft} 分钟后恢复（${ban.why ?? 'HTTP 412'}）`, { code: -412 })
  }
  const effectiveCred = await ensureBuvid(cred)
  await throttle()
  let response
  try {
    response = await fetch(url, {
      method,
      headers: {
        ...headersFor(effectiveCred, referer),
        ...(body ? { 'content-type': 'application/x-www-form-urlencoded' } : {}),
      },
      body,
      signal: signal ?? AbortSignal.timeout(20000),
    })
  } catch (error) {
    throw new BiliError(error?.name === 'TimeoutError' ? '请求 B 站超时（20 秒）' : '连不上 B 站接口，检查网络后重试')
  }
  if (response.status === 412 || response.status === 429) {
    const prev = Number(readJson(BAN_PATH, {})?.streak ?? 0)
    const streak = prev + 1
    const minutes = Math.min(30, 5 * 2 ** (streak - 1))
    setBan(minutes * 60_000, `HTTP ${response.status}`, streak)
    throw new BiliError(`B 站风控（HTTP ${response.status}），已暂停 ${minutes} 分钟`, { code: response.status })
  }
  const text = await response.text()
  let data
  try { data = JSON.parse(text) } catch {
    throw new BiliError(`B 站返回了非 JSON（HTTP ${response.status}），可能是风控页`, { code: -1 })
  }
  if (RISK_CODES.has(Number(data?.code))) {
    // code 级风控只影响当前接口；不要熔断整个插件（否则弹幕 token 失败会连播放/登录一起挡掉）
    throw new BiliError(`B 站接口风控（code ${data.code}），稍后重试`, { code: data.code })
  }
  if (Number(data?.code) === 0) clearBanStreak()
  return data
}

// ── WBI 签名 ────────────────────────────────────────────────────────────────

let wbiCache = { at: 0, img: null, sub: null, mid: null, uname: null }

export async function navInfo(cred, { force = false, recordRisk = true } = {}) {
  if (!force && wbiCache.img && Date.now() - wbiCache.at < 10 * 60_000) return wbiCache
  const data = await requestJson('https://api.bilibili.com/x/web-interface/nav', {
    cred,
    referer: 'https://www.bilibili.com/',
    recordRisk,
  })
  const img = data?.data?.wbi_img
  // 未登录时 nav 返回 code=-101，但 wbi 密钥仍然在 —— 搜索/弹幕服务器只需要密钥，不需要登录。
  if (!img?.img_url || !img?.sub_url) {
    throw new BiliError(`拿不到 WBI 签名密钥（code ${data?.code ?? '?'}）`, { code: data?.code })
  }
  wbiCache = {
    at: Date.now(),
    img: img.img_url,
    sub: img.sub_url,
    mid: data.data?.mid ? String(data.data.mid) : '',
    uname: data.data?.uname ?? '',
    isLogin: data.data?.isLogin === true,
  }
  return wbiCache
}

export function signWbi(params, keys, now = Date.now()) {
  const raw = keyOf(keys?.img) + keyOf(keys?.sub)
  if (raw.length !== 64) throw new BiliError('WBI 密钥长度不对，稍后重试')
  const mixin = MIXIN.map((i) => raw[i]).join('').slice(0, 32)
  const values = { ...params, wts: Math.floor(now / 1000) }
  const query = Object.keys(values).sort()
    .map((k) => `${encodeURIComponent(k)}=${encodeURIComponent(String(values[k]).replace(/[!'()*]/g, ''))}`)
    .join('&')
  const wRid = crypto.createHash('md5').update(query + mixin).digest('hex')
  return `${query}&w_rid=${wRid}`
}

// ── 直播发现 ────────────────────────────────────────────────────────────────

const stripTags = (value) => String(value ?? '').replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').trim()

/**
 * 按关键词搜直播间。这是「主动找房间」的主入口。
 * 返回项已经清洗成插件自己的形状，去掉 B 站原始字段里的噪音。
 */
export async function searchLive(keyword, page = 1, { cred = null, pages = 1 } = {}) {
  const keys = await navInfo(cred)
  const results = []
  for (let offset = 0; offset < Math.max(1, pages); offset += 1) {
    const query = signWbi({ search_type: 'live_room', keyword, page: page + offset }, keys)
    const data = await requestJson(`https://api.bilibili.com/x/web-interface/wbi/search/type?${query}`, {
      cred,
      referer: 'https://search.bilibili.com/',
    })
    if (Number(data?.code) !== 0) throw new BiliError(`搜直播间失败（code ${data?.code}）：${data?.message ?? ''}`, { code: data?.code })
    const rows = data?.data?.result ?? []
    for (const row of rows) {
      const roomId = String(row.roomid ?? row.room_id ?? '').replace(/\D/g, '')
      if (!roomId) continue
      results.push({
        roomId,
        title: stripTags(row.title),
        uname: stripTags(row.uname),
        uid: String(row.uid ?? ''),
        online: Number(row.online ?? 0) || 0,
        attentions: Number(row.attentions ?? 0) || 0,
        area: Number(row.area ?? 0) || 0,
        category: stripTags(row.cate_name),
        tags: String(row.tags ?? '').split(',').map((x) => x.trim()).filter(Boolean),
        cover: String(row.cover ?? '').startsWith('//') ? `https:${row.cover}` : String(row.cover ?? ''),
        liveTime: String(row.live_time ?? ''),
        match: stripTags(row.title) + ' ' + stripTags(row.cate_name) + ' ' + String(row.tags ?? ''),
        keyword,
      })
    }
  }
  return results
}

/** 推荐列表：搜索词枯竭时的补充来源（大多是热门房，用观众数过滤后剩不下几个，但偶尔有惊喜）。 */
export async function recommendRooms(page = 1, { cred = null } = {}) {
  const data = await requestJson(`https://api.live.bilibili.com/room/v1/room/get_user_recommend?page=${page}&page_size=20`, { cred })
  if (Number(data?.code) !== 0) throw new BiliError(`推荐列表失败（code ${data?.code}）`, { code: data?.code })
  return (data.data ?? []).map((row) => ({
    roomId: String(row.roomid ?? ''),
    title: stripTags(row.title),
    uname: stripTags(row.uname),
    uid: String(row.uid ?? ''),
    online: Number(row.online ?? 0) || 0,
    attentions: 0,
    area: Number(row.area ?? 0) || 0,
    category: stripTags(row.areaName),
    tags: [],
    cover: String(row.cover ?? row.user_cover ?? ''),
    liveTime: '',
    match: `${stripTags(row.title)} ${stripTags(row.areaName)}`,
    keyword: '推荐',
  })).filter((room) => room.roomId)
}

function normalizeLiveStatus(d, fallbackId) {
  return {
    roomId: String(d?.room_id ?? '').replace(/\D/g, ''),
    uid: String(d?.uid ?? fallbackId),
    uname: stripTags(d?.uname),
    title: stripTags(d?.title),
    liveStatus: Number(d?.live_status ?? 0) || 0,
    liveTime: Number(d?.live_time ?? 0) || 0,
    online: Number(d?.online ?? 0) || 0,
    area: String(d?.area_v2_name ?? d?.area_name ?? ''),
    parentArea: String(d?.area_v2_parent_name ?? ''),
  }
}

/** 批量查直播状态（关注列表巡查用；一次最多 50 个 UID）。 */
export async function liveStatusByUids(uids, { cred = null } = {}) {
  const ids = [...new Set((uids ?? []).map((id) => String(id).replace(/\D/g, '')).filter(Boolean))].slice(0, 50)
  if (!ids.length) return []
  const query = ids.map((id) => `uids[]=${id}`).join('&')
  const data = await requestJson(`https://api.live.bilibili.com/room/v1/Room/get_status_info_by_uids?${query}`, {
    cred,
    referer: 'https://live.bilibili.com/',
    recordRisk: false,
  })
  if (Number(data?.code) !== 0) throw new BiliError(`批量查直播状态失败（code ${data?.code}）`, { code: data?.code })
  return ids.map((id) => normalizeLiveStatus(data?.data?.[id] ?? {}, id)).filter((item) => item.roomId)
}

/** 按 UID 查直播状态（彩蛋/特别关注用）。 */
export async function liveStatusByUid(uid, { cred = null } = {}) {
  const id = String(uid).replace(/\D/g, '')
  if (!id) throw new BiliError('UID 是空的')
  const list = await liveStatusByUids([id], { cred })
  return list[0] ?? normalizeLiveStatus({}, id)
}

/** 当前账号的关注列表（最多 200 个，供巡逻候选使用）。 */
export async function followingList(vmid, { cred = null, pages = 2, pageSize = 50 } = {}) {
  const mid = String(vmid).replace(/\D/g, '')
  if (!mid) throw new BiliError('还没有登录账号，无法读取关注列表')
  const items = []
  let total = 0
  for (let page = 1; page <= Math.max(1, pages); page += 1) {
    const data = await requestJson(`https://api.bilibili.com/x/relation/followings?vmid=${mid}&pn=${page}&ps=${pageSize}&order=desc&order_type=attention`, {
      cred,
      referer: 'https://space.bilibili.com/',
      recordRisk: false,
    })
    if (Number(data?.code) !== 0) throw new BiliError(`读取关注列表失败（code ${data?.code}）`, { code: data?.code })
    const list = data?.data?.list ?? []
    total = Number(data?.data?.total ?? items.length + list.length)
    for (const row of list) {
      items.push({ mid: String(row.mid ?? ''), uname: stripTags(row.uname), face: String(row.face ?? '') })
    }
    if (items.length >= total || list.length < pageSize) break
  }
  return { items: items.filter((item) => item.mid).slice(0, 200), total }
}

/** 关注一个主播；22014 视为已经关注。 */
export async function followUser(uid, { cred = null } = {}) {
  if (!cred?.sessdata || !cred?.bili_jct) throw new BiliError('还没登录 B 站，先在设置页扫码', { code: -101 })
  const fid = String(uid).replace(/\D/g, '')
  if (!fid) throw new BiliError('主播 UID 是空的')
  const body = new URLSearchParams({ fid, act: '1', re_src: '11', csrf: cred.bili_jct, jsonp: 'jsonp' }).toString()
  const data = await requestJson('https://api.bilibili.com/x/relation/modify', {
    cred,
    method: 'POST',
    body,
    referer: 'https://space.bilibili.com/',
  })
  const code = Number(data?.code)
  if (code === 0 || code === 22014) return { ok: true, already: code === 22014 }
  throw new BiliError(`关注失败（code ${code}）${data?.message ? '：' + data.message : ''}`, { code })
}

export async function roomInfo(roomId, { cred = null } = {}) {
  const id = String(roomId).replace(/\D/g, '')
  const data = await requestJson(`https://api.live.bilibili.com/room/v1/Room/get_info?room_id=${id}`, { cred })
  if (Number(data?.code) !== 0) {
    throw new BiliError(`读直播间 ${id} 失败（code ${data?.code}）：${data?.message ?? ''}`, { code: data?.code })
  }
  const d = data.data ?? {}
  return {
    roomId: String(d.room_id ?? id),
    shortId: String(d.short_id ?? ''),
    uid: String(d.uid ?? ''),
    title: stripTags(d.title),
    online: Number(d.online ?? 0) || 0,
    attention: Number(d.attention ?? 0) || 0,
    liveStatus: Number(d.live_status ?? 0),
    liveTime: String(d.live_time ?? ''),
    area: String(d.area_name ?? ''),
    parentArea: String(d.parent_area_name ?? ''),
    description: stripTags(d.description).slice(0, 300),
    keyframe: String(d.keyframe ?? ''),
  }
}

export async function playUrl(roomId, { cred = null, qn = 150 } = {}) {
  const id = String(roomId).replace(/\D/g, '')
  let data = await requestJson(`https://api.live.bilibili.com/xlive/web-room/v1/playUrl/playUrl?cid=${id}&platform=web&qn=${qn}&https_url_req=1`, { cred })
  if (Number(data?.code) !== 0) {
    data = await requestJson(`https://api.live.bilibili.com/room/v1/Room/playUrl?cid=${id}&qn=${qn}&platform=web`, { cred })
  }
  const url = data?.data?.durl?.[0]?.url
  if (Number(data?.code) !== 0 || !url) {
    throw new BiliError(`拿不到直播流地址（code ${data?.code ?? '?'}）${Number(data?.code) === -400 ? '：可能未开播' : ''}`, { code: data?.code })
  }
  return { url: String(url), qn: Number(data?.data?.current_qn ?? qn) }
}

/** WS 握手用的弹幕服务器 token。新接口被风控时回退到旧的 getConf。 */
export async function danmuInfo(roomId, { cred = null } = {}) {
  const id = String(roomId).replace(/\D/g, '')
  const keys = await navInfo(cred, { force: true, recordRisk: false })
  let primaryError = null
  try {
    const query = signWbi({ id, type: 0 }, keys)
    const data = await requestJson(`https://api.live.bilibili.com/xlive/web-room/v1/index/getDanmuInfo?${query}`, {
      cred,
      recordRisk: false,
    })
    if (Number(data?.code) === 0 && data?.data?.token) {
      return {
        token: data.data.token,
        hosts: data.data.host_list ?? [],
        uid: keys.mid ?? '',
      }
    }
    primaryError = new BiliError(`拿不到弹幕服务器 token（code ${data?.code}）`, { code: data?.code })
  } catch (error) {
    primaryError = error
  }

  // 旧接口不需要 WBI，仍会下发 token/host；用来绕过新接口的 code -352
  try {
    const legacy = await requestJson(`https://api.live.bilibili.com/room/v1/Danmu/getConf?room_id=${id}&platform=pc&player=web`, {
      cred,
      recordRisk: false,
    })
    if (Number(legacy?.code) === 0 && legacy?.data?.token) {
      return {
        token: legacy.data.token,
        hosts: legacy.data.host_server_list ?? [],
        uid: keys.mid ?? '',
      }
    }
    throw new BiliError(`旧弹幕接口也没有 token（code ${legacy?.code}）`, { code: legacy?.code })
  } catch (fallbackError) {
    throw primaryError ?? fallbackError
  }
}

// ── 弹幕 ────────────────────────────────────────────────────────────────────

const SEND_HINTS = {
  0: '成功',
  '-101': '账号未登录',
  '-111': 'csrf 校验失败，重新登录',
  '-400': '请求错误（房间号或参数不对）',
  10030: '发送太频繁',
  10031: '发送太频繁，被 B 站限速了',
  1003212: '弹幕太长',
  1003: '你在这个直播间被禁言了',
  1004: '房间禁言',
  '-403': '没有发言权限',
}

export async function sendDanmaku({ roomId, text, cred, replyTo = null, replyName = '' }) {
  if (!cred) throw new BiliError('还没登录 B 站，先在设置页扫码', { code: -101 })
  const message = String(text ?? '').replace(/\s+/g, ' ').trim()
  if (!message) throw new BiliError('弹幕是空的')
  if ([...message].length > 20) throw new BiliError('弹幕超过 20 字，B 站发不出去')
  const info = await roomInfo(roomId, { cred })
  if (info.liveStatus !== 1) throw new BiliError('这个直播间现在没开播')
  const form = {
    csrf: cred.bili_jct,
    csrf_token: cred.bili_jct,
    roomid: info.roomId,
    msg: message,
    rnd: String(Math.round(Date.now() / 1000)),
    fontsize: '25',
    color: '16777215',
    mode: '1',
    bubble: '0',
    room_type: '0',
    jumpfrom: '0',
    statistics: JSON.stringify({ appId: 100, platform: 5 }),
  }
  if (replyTo) {
    form.replay_dmid = String(replyTo)
    if (replyName) form.reply_uname = String(replyName).slice(0, 30)
  }
  const data = await requestJson('https://api.live.bilibili.com/msg/send', {
    cred,
    method: 'POST',
    body: new URLSearchParams(form).toString(),
    referer: `https://live.bilibili.com/${info.shortId || info.roomId}`,
  })
  const code = Number(data?.code)
  const ok = code === 0
  return {
    ok,
    code,
    message: String(data?.message ?? data?.msg ?? ''),
    hint: SEND_HINTS[code] ?? (ok ? '成功' : '发送失败'),
    room: info,
  }
}

export async function danmakuHistory(roomId, { cred = null } = {}) {
  const info = await roomInfo(roomId, { cred })
  const data = await requestJson(`https://api.live.bilibili.com/xlive/web-room/v1/dM/gethistory?roomid=${info.roomId}&room_type=0`, { cred })
  if (Number(data?.code) !== 0) return []
  return (data?.data?.room ?? []).map((row) => ({
    uid: String(row.uid ?? ''),
    uname: String(row.nickname ?? ''),
    text: String(row.text ?? ''),
    timeline: String(row.timeline ?? ''),
  }))
}
