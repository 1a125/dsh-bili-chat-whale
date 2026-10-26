import { recommendRooms, roomInfo, searchLive } from './bili.js'

/**
 * 找房间的「眼光」。
 *
 * 目标不是找最火的，而是找**说了话会被看见**的房间：
 *   · 人少（默认 ≤30 人在线，最好是 0–10）
 *   · 标题/分区/标签跟主人的兴趣对得上
 *   · 刚开播不久、小主播（关注数低）—— 更容易注意到一个新观众
 *   · 最近去过的先跳过，别盯着一个人薅
 *
 * 实测经验（2026-10）：`聊天`/`杂谈`/`唱歌` 的搜索结果被大主播占满，
 * 小房间反而集中在 `自习`、`刚开播`、`画画`、`深夜`、`新人` 这些词下面。
 * 所以发现逻辑会一轮多试几个词，并且用 keywordCursor 轮换，别每轮都撞同一批。
 */

const FALLBACK_KEYWORDS = ['刚开播', '自习', '画画', '深夜', '新人', '闲聊']
const norm = (value) => String(value ?? '').toLowerCase()

export function matchesInterests(room, config) {
  const title = norm(room.title)
  const extra = norm(`${room.category ?? ''} ${room.uname ?? ''} ${(room.tags ?? []).join(' ')} ${room.description ?? ''}`)
  const keywords = (config.interests?.keywords ?? []).filter(Boolean)
  const titleHits = keywords.filter((word) => title.includes(norm(word)))
  const hits = keywords.filter((word) => title.includes(norm(word)) || extra.includes(norm(word)))
  const blocked = (config.interests?.avoidKeywords ?? []).filter((word) => word && (title.includes(norm(word)) || extra.includes(norm(word))))

  // 分区：父分区/子分区/分类名都参与匹配；搜索阶段只有 cate_name，没有父分区，
  // 所以「只进」条件在搜索阶段先不淘汰（areaReady=false），复核拿到 parent_area_name 后再判。
  const areaReady = typeof room.parentArea === 'string' && room.parentArea.length > 0
  const areaText = norm(`${room.parentArea ?? ''} ${typeof room.area === 'string' ? room.area : ''} ${room.category ?? ''}`)
  const areaIncluded = (config.interests?.includeAreas ?? []).filter((word) => word && areaText.includes(norm(word)))
  const areaExcluded = (config.interests?.excludeAreas ?? []).filter((word) => word && areaText.includes(norm(word)))

  return { hits, titleHits, blocked, areaReady, areaText, areaIncluded, areaExcluded, haystack: `${title} ${extra}` }
}

export function scoreRoom(room, config, state, now = Date.now()) {
  const { hits, titleHits, blocked, areaReady, areaIncluded, areaExcluded } = matchesInterests(room, config)
  if (blocked.length) return { score: -Infinity, reason: `避开词：${blocked.join('、')}`, hits, titleHits, blocked }
  if (areaExcluded.length) return { score: -Infinity, reason: `排除分区：${areaExcluded.join('、')}`, hits, titleHits, areaExcluded }
  if ((config.interests?.includeAreas ?? []).length && areaReady && !areaIncluded.length) {
    return { score: -Infinity, reason: `不在允许的分区：${room.parentArea} / ${room.area ?? ''}`, hits, titleHits }
  }
  if (room.liveStatus !== undefined && room.liveStatus !== 1) return { score: -Infinity, reason: '没在直播', hits, titleHits, blocked }
  // 注意：B 站公开接口的 online 是「人气」，不是精确在线人数。
  // 0 表示不限；默认 3000。旧配置里的 maxViewers 不再参与筛选（30 会几乎把所有房间挡掉）。
  const maxPopularity = Number(config.interests?.maxPopularity ?? 3000)
  if (maxPopularity > 0 && room.online > maxPopularity) {
    return { score: -Infinity, reason: `人气 ${room.online} 超过上限 ${maxPopularity}`, hits, titleHits, blocked }
  }

  const visited = state.visited?.[room.roomId]
  const revisitMs = Number(config.interests?.revisitMinutes ?? 360) * 60_000
  if (visited && now - Number(visited.at ?? 0) < revisitMs) {
    return { score: -Infinity, reason: `${config.interests?.revisitMinutes ?? 360} 分钟内去过`, hits, titleHits, blocked }
  }

  // 关键词为空 = 不限制关键词：不因「没命中」扣分；搜索仍会用分区名/宽泛词召回
  const keywordCount = (config.interests?.keywords ?? []).filter(Boolean).length
  let score = 40
  if (keywordCount) {
    // 综合判断：同时命中多条关键词的房间优先。
    // 每多命中一条 +12；命中标题再 +6；第二条起每条额外 +10（两条比两个单命中的房间明显更高）。
    score += hits.length * 12
    score += titleHits.length * 6
    score += Math.max(0, hits.length - 1) * 10
    if (!hits.length) score -= 12
  }
  if (areaIncluded.length) score += 8

  // 人气越低越优先；人气 0 往往是新开播/未统计，给中等偏上的分。
  if (room.online <= 0) score += 16
  else if (room.online <= 100) score += 30
  else if (room.online <= 500) score += 24
  else if (room.online <= 1500) score += 16
  else if (room.online <= 3000) score += 8

  if (Number(room.attentions ?? 0) > 0 && Number(room.attentions) < 300) score += 8
  if (Number(room.attentions ?? 0) >= 5000) score -= 4

  const liveAt = room.liveTime ? new Date(String(room.liveTime).replace(' ', 'T')).getTime() : 0
  if (liveAt && now - liveAt < 60 * 60_000) score += 6
  if (liveAt && now - liveAt > 4 * 3600_000) score -= 6

  const titleLen = [...String(room.title ?? '')].length
  if (titleLen >= 4 && titleLen <= 30) score += 3
  if (titleLen < 3) score -= 4

  score += Math.random() * 6
  return { score, reason: null, hits, titleHits, blocked, areaIncluded }
}

function keywordPlan(keywords, state, max, extra = []) {
  // 关键词为空时不能只搜「聊天」——用宽泛词兜底，否则删掉关键词就几乎搜不到房。
  const base = keywords.length ? keywords : [...FALLBACK_KEYWORDS]
  // 分区名也当作搜索词，放在前面：只选了分区、关键词为空时也要能搜到房。
  const list = [...extra, ...base].filter((word, index, all) => word && all.indexOf(word) === index)
  const start = Number(state.keywordCursor ?? 0) % Math.max(1, list.length)
  const out = []
  for (let i = 0; i < list.length && out.length < max; i += 1) out.push(list[(start + i) % list.length])
  for (const word of [...extra, ...FALLBACK_KEYWORDS]) {
    if (out.length >= max + 3) break
    if (!out.includes(word)) out.push(word)
  }
  return out
}

/**
 * 跑一轮发现：多个兴趣词 × 若干页，过滤、排序，再用 room_info 复核前几名。
 * 复核是必要的：搜索结果里的在线人数可能是缓存值，而且房间可能刚好下播。
 */
export async function discoverRooms({ config, cred, state, limit = 8, keyword = null, now = Date.now(), log = () => {} }) {
  const pages = Math.max(1, Number(config.discovery?.searchPages ?? 2))
  const areaTerms = config.interests?.includeAreas ?? []
  const picks = keyword ? [keyword] : keywordPlan(config.interests?.keywords ?? [], state, 5, areaTerms)
  const seen = new Set()
  const found = []
  const errors = []
  const used = []

  // 边搜边攒；多搜几个词（尤其是分区名），否则只搜第一个词就停会漏掉别的分区
  for (const word of picks) {
    if (found.length >= 80) break
    used.push(word)
    try {
      const rooms = await searchLive(word, 1, { cred, pages })
      log(`搜索「${word}」→ ${rooms.length} 个直播间`)
      let fresh = 0
      for (const room of rooms) {
        if (seen.has(room.roomId)) continue
        seen.add(room.roomId)
        const verdict = scoreRoom(room, config, state, now)
        if (verdict.score === -Infinity) continue
        found.push({ ...room, score: Math.round(verdict.score), hits: verdict.hits, titleHits: verdict.titleHits })
        fresh += 1
      }
      log(`  可用 ${fresh} 个（累计 ${found.length}）`)
      if (fresh === 0 && keyword) break
    } catch (error) {
      errors.push(`「${word}」搜索失败：${error.message}`)
      log(errors.at(-1))
    }
  }

  // 搜索词都没结果时，退一步看推荐列表 —— 当作兜底，不当主力。
  if (!found.length) {
    try {
      const rooms = await recommendRooms(1, { cred })
      for (const room of rooms) {
        if (seen.has(room.roomId)) continue
        seen.add(room.roomId)
        const verdict = scoreRoom({ ...room, liveStatus: 1 }, config, state, now)
        if (verdict.score === -Infinity) continue
        found.push({ ...room, score: Math.round(verdict.score), hits: verdict.hits, titleHits: verdict.titleHits })
      }
      log(`推荐列表兜底 → 可用 ${found.length} 个`)
    } catch (error) {
      errors.push(`推荐列表失败：${error.message}`)
    }
  }

  found.sort((a, b) => b.score - a.score)
  const verified = []
  const areaFiltered = (config.interests?.includeAreas ?? []).length || (config.interests?.excludeAreas ?? []).length
  const verifyCount = areaFiltered ? Math.max(limit * 12, 96) : Math.max(limit * 4, 32)
  for (const room of found.slice(0, verifyCount)) {
    try {
      const info = await roomInfo(room.roomId, { cred })
      if (info.liveStatus !== 1) continue
      const merged = {
        ...room,
        title: info.title || room.title,
        uname: room.uname || '',
        online: info.online,
        attentions: room.attentions || info.attention,
        area: info.area,
        parentArea: info.parentArea,
        liveTime: info.liveTime || room.liveTime,
        uid: info.uid || room.uid,
        description: info.description,
      }
      const verdict = scoreRoom(merged, config, state, now)
      if (verdict.score === -Infinity) continue
      verified.push({
        ...merged,
        score: Math.round(verdict.score),
        hits: verdict.hits,
        titleHits: verdict.titleHits,
        areaIncluded: verdict.areaIncluded ?? [],
      })
      if (verified.length >= limit) break
    } catch (error) {
      errors.push(`复核房间 ${room.roomId} 失败：${error.message}`)
    }
  }

  verified.sort((a, b) => b.score - a.score)
  return { candidates: verified, keywordsUsed: used, errors, scanned: seen.size }
}
