import fs from 'node:fs'
import path from 'node:path'
import { CONFIG_PATH, DATA_DIR } from './paths.js'

/**
 * 配置默认值。
 *
 * 设计原则（借了养鱼插件的经验）：
 *   · 所有会影响「对外说话」的值都有保守默认（dryRun 默认开、条数默认小）
 *   · 所有值都在设置页里可改；宿主每次 tick 现读文件 —— 改完立刻生效，不用重启
 */
export const DEFAULTS = {
  /** off = 不巡航；watch = 只看不说；interact = 会开口 */
  mode: 'off',
  persona: {
    name: '小鲸',
    tone: '松弛、有梗、像直播间里一个常来的观众；一句话说完，不端着、不油腻',
    bio: '',
  },
  owner: { mid: '', name: '' },
  self: { mid: '', name: '' },
  interests: {
    keywords: ['聊天', '自习', '刚开播', '画画', '深夜', '编程', '学习', '新人', '唱歌', '手工', '游戏'],
    avoidKeywords: ['带货', '擦边', '抽奖', '广告', '录播', '代练', '博彩', '私域'],
    /** 只进这些分区（父分区/子分区名都匹配；留空 = 不限） */
    includeAreas: [],
    /** 不进这些分区 */
    excludeAreas: [],
    maxViewers: 30,
    minViewers: 0,
    /** B 站公开接口的 online 是「人气」，不是精确在线人数；默认上限按人气算。0 = 不限 */
    maxPopularity: 3000,
    /** 同一间房多少分钟内不重复进 */
    revisitMinutes: 360,
    stayMinutes: 8,
    roomsPerHour: 4,
    /** 连续几轮既没声音也没画面就换台 */
    autoLeaveBoring: true,
    boringEmptyStreak: 4,
    boringFailStreak: 3,
  },
  interaction: {
    dryRun: true,
    maxPerRoom: 5,
    minGapSec: 75,
    maxPerHour: 15,
    maxPerDay: 40,
    allowReplyToOthers: true,
    speakIntervalSec: 150,
    quietWhenStreamerTalks: false,
  },
  voice: {
    enabled: true,
    /** auto = 能用 DSH 语音服务就用，否则本地 SenseVoice；local = 只用本地；dsh = 只用 DSH 服务；off = 不听 */
    engine: 'auto',
    language: 'zh',
    clipSeconds: 20,
    minChars: 2,
    modelDir: '',
  },
  vision: {
    enabled: true,
    mode: 'auto',
    provider: '',
    model: '',
    baseURL: '',
    httpModel: '',
    apiKeyEnv: '',
    frames: 2,
    maxPerRoom: 40,
  },
  discovery: {
    searchPages: 2,
    cooldownMinutes: 4,
    minRoomStaySec: 180,
  },
  asr: {
    threads: 0,
    sherpaRoot: '',
  },
  session: {
    id: 'bili-chat-whale',
  },
  safety: {
    maxDanmakuChars: 20,
    blockedWords: ['加群', '微信', 'VX', 'v我', '私聊', '代练'],
  },
}

const clone = (value) => JSON.parse(JSON.stringify(value))

function merge(base, over) {
  const out = { ...base }
  for (const [key, value] of Object.entries(over || {})) {
    out[key] = value && typeof value === 'object' && !Array.isArray(value) ? merge(base[key] ?? {}, value) : value
  }
  return out
}

export function readConfig() {
  let user = {}
  try { user = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')) } catch { /* 首次运行：没有文件就用默认 */ }
  return merge(clone(DEFAULTS), user)
}

export function writeConfig(next) {
  fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true })
  const temp = `${CONFIG_PATH}.${process.pid}.tmp`
  try {
    fs.writeFileSync(temp, JSON.stringify(next, null, 2) + '\n')
    fs.renameSync(temp, CONFIG_PATH)
  } finally {
    try { fs.rmSync(temp, { force: true }) } catch {}
  }
}

const strList = (value, limit) => {
  const list = Array.isArray(value) ? value : String(value ?? '').split(/[,，\n]/)
  return [...new Set(list.map((x) => String(x ?? '').trim()).filter(Boolean))].slice(0, limit)
}

/**
 * 把设置页提交的内容收敛成合法配置。
 * 只认识白名单里的顶层字段；数字全部夹到安全区间 —— 设置页手滑写个 9999 不该变成刷屏机器。
 */
export function normalizeConfig(input, base = readConfig()) {
  const next = merge(clone(base), input && typeof input === 'object' ? input : {})
  const clamp = (value, min, max, fallback) => {
    const n = Number(value)
    return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback
  }
  const int = (value, min, max, fallback) => Math.round(clamp(value, min, max, fallback))

  if (!['off', 'watch', 'interact'].includes(next.mode)) next.mode = 'off'

  next.persona = {
    name: String(next.persona?.name ?? '').slice(0, 40),
    tone: String(next.persona?.tone ?? '').slice(0, 400),
    bio: String(next.persona?.bio ?? '').slice(0, 4000),
  }
  next.owner = {
    mid: String(next.owner?.mid ?? '').replace(/\D/g, '').slice(0, 20),
    name: String(next.owner?.name ?? '').slice(0, 60),
  }
  next.self = {
    mid: String(next.self?.mid ?? '').replace(/\D/g, '').slice(0, 20),
    name: String(next.self?.name ?? '').slice(0, 60),
  }

  const inputInterests = input?.interests ?? {}
  const baseInterests = base?.interests ?? {}
  const revisitMinutes = inputInterests.revisitMinutes !== undefined
    ? inputInterests.revisitMinutes
    : inputInterests.revisitHours !== undefined
      ? Number(inputInterests.revisitHours) * 60
      : baseInterests.revisitMinutes !== undefined
        ? baseInterests.revisitMinutes
        : baseInterests.revisitHours !== undefined
          ? Number(baseInterests.revisitHours) * 60
          : 360

  next.interests = {
    keywords: strList(next.interests?.keywords, 40),
    avoidKeywords: strList(next.interests?.avoidKeywords, 40),
    includeAreas: strList(next.interests?.includeAreas, 40),
    excludeAreas: strList(next.interests?.excludeAreas, 40),
    maxViewers: int(next.interests?.maxViewers, 0, 100000, 30),
    minViewers: int(next.interests?.minViewers, 0, 100000, 0),
    maxPopularity: int(next.interests?.maxPopularity, 0, 1000000, 3000),
    revisitMinutes: int(revisitMinutes, 1, 10080, 360),
    stayMinutes: int(next.interests?.stayMinutes, 1, 180, 8),
    roomsPerHour: int(next.interests?.roomsPerHour, 1, 30, 4),
    autoLeaveBoring: next.interests?.autoLeaveBoring !== false,
    boringEmptyStreak: int(next.interests?.boringEmptyStreak, 2, 20, 4),
    boringFailStreak: int(next.interests?.boringFailStreak, 2, 10, 3),
  }
  if (next.interests.minViewers > next.interests.maxViewers) next.interests.minViewers = next.interests.maxViewers

  next.interaction = {
    dryRun: next.interaction?.dryRun !== false,
    maxPerRoom: int(next.interaction?.maxPerRoom, 0, 30, 5),
    minGapSec: int(next.interaction?.minGapSec, 20, 3600, 75),
    maxPerHour: int(next.interaction?.maxPerHour, 0, 120, 15),
    maxPerDay: int(next.interaction?.maxPerDay, 0, 500, 40),
    allowReplyToOthers: next.interaction?.allowReplyToOthers !== false,
    speakIntervalSec: int(next.interaction?.speakIntervalSec, 45, 3600, 150),
    quietWhenStreamerTalks: next.interaction?.quietWhenStreamerTalks === true,
  }
  if (next.interaction.maxPerHour > next.interaction.maxPerDay) next.interaction.maxPerHour = next.interaction.maxPerDay

  next.voice = {
    enabled: next.voice?.enabled !== false,
    engine: ['auto', 'local', 'dsh', 'off'].includes(next.voice?.engine) ? next.voice.engine : 'auto',
    language: ['zh', 'en', 'ja', 'ko', 'yue', 'auto'].includes(next.voice?.language) ? next.voice.language : 'zh',
    clipSeconds: int(next.voice?.clipSeconds, 6, 60, 20),
    minChars: int(next.voice?.minChars, 0, 200, 2),
    modelDir: String(next.voice?.modelDir ?? '').slice(0, 500),
  }
  next.vision = {
    enabled: next.vision?.enabled !== false,
    mode: ['auto', 'llm', 'http', 'ocr', 'off'].includes(next.vision?.mode) ? next.vision.mode : 'auto',
    provider: String(next.vision?.provider ?? '').slice(0, 80),
    model: String(next.vision?.model ?? '').slice(0, 120),
    baseURL: String(next.vision?.baseURL ?? '').trim().slice(0, 300).replace(/\/+$/, ''),
    httpModel: String(next.vision?.httpModel ?? '').slice(0, 120),
    apiKeyEnv: String(next.vision?.apiKeyEnv ?? '').trim().slice(0, 100),
    frames: int(next.vision?.frames, 1, 4, 2),
    maxPerRoom: int(next.vision?.maxPerRoom, 0, 240, 40),
  }
  next.discovery = {
    searchPages: int(next.discovery?.searchPages, 1, 5, 2),
    cooldownMinutes: int(next.discovery?.cooldownMinutes, 1, 240, 4),
    minRoomStaySec: int(next.discovery?.minRoomStaySec, 30, 3600, 180),
  }
  next.asr = {
    threads: int(next.asr?.threads, 0, 16, 0),
    sherpaRoot: String(next.asr?.sherpaRoot ?? '').slice(0, 500),
  }
  next.session = { id: String(next.session?.id ?? 'bili-chat-whale').replace(/[^\w.-]/g, '').slice(0, 64) || 'bili-chat-whale' }
  next.safety = {
    maxDanmakuChars: int(next.safety?.maxDanmakuChars, 5, 20, 20),
    blockedWords: strList(next.safety?.blockedWords, 60),
  }
  return next
}

/** 首次运行时把目录建好；失败就让上层给出可读错误。 */
export function ensureDirs() {
  fs.mkdirSync(DATA_DIR, { recursive: true })
}
