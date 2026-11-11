/**
 * 关注前让聊天鲸自己判断：
 *   「条件满足」只是候选，不是关注理由。
 *   只有真的对主播/房间感兴趣、想下次再来，才允许关注；
 *   只是热闹、被点名、礼貌、条件凑够 → 不关注。
 */

import { resolveRoutes, callTextRoute } from './llm.js'

let routeCache = { at: 0, routes: [], key: '' }

async function textRoutes(ctx, config = {}) {
  const model = config.model ?? {}
  const key = `${model.provider ?? ''}/${model.model ?? ''}/${model.reasoningEffort ?? ''}`
  if (Date.now() - routeCache.at < 10 * 60_000 && routeCache.routes.length && routeCache.key === key) return routeCache.routes
  const routes = await resolveRoutes(ctx, {
    provider: model.provider,
    model: model.model,
    reasoningEffort: model.reasoningEffort,
    max: 3,
  })
  routeCache = { at: Date.now(), routes, key }
  return routes
}

export function parseFollowDecision(text) {
  const raw = String(text ?? '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '')
  const start = raw.indexOf('{')
  const end = raw.lastIndexOf('}')
  if (start >= 0 && end > start) {
    try {
      const data = JSON.parse(raw.slice(start, end + 1))
      if (typeof data.follow === 'boolean') {
        return {
          follow: data.follow,
          reason: String(data.reason ?? '').slice(0, 300),
          confidence: Math.max(0, Math.min(1, Number(data.confidence ?? 0) || 0)),
        }
      }
    } catch {}
  }
  // 模型没按 JSON 输出时，只有非常明确的 yes 才放行；否则保守拒绝
  if (/"follow"\s*:\s*true|^\s*是\s*[，,。]/i.test(raw)) return { follow: true, reason: '模型明确表示想关注', confidence: 0.5 }
  return { follow: false, reason: '判断结果不明确，保守不关注', confidence: 0 }
}

const PROMPT = ({ config, room, roomState, danmaku, observations }) => {
  const persona = config.persona ?? {}
  const sent = (roomState.sentTexts ?? []).slice(-10).map((item) => item.text).filter(Boolean)
  const chat = (danmaku ?? []).slice(-15).map((item) => `${item.uname || '观众'}：${String(item.text).slice(0, 80)}`).join('\n') || '（没什么人说话）'
  const heard = (observations ?? []).slice(-4).map((item) => `语音：${String(item.speech ?? '').slice(0, 120)}\n画面：${String(item.vision ?? '').slice(0, 100)}`).join('\n\n') || '（没有听到/看到明显内容）'
  return `你是「${persona.name || '聊天鲸'}」。${persona.tone ? `你的性格和说话风格：${persona.tone}。` : ''}
${persona.bio ? `你的人设：\n${persona.bio.slice(0, 1200)}\n` : ''}

你正在决定：要不要关注一个 B 站主播。请用你自己的兴趣和感受判断，不要因为条件满足就关注，也不需要礼貌性关注。

【直播间】
标题：${room.meta?.title ?? ''}
主播：${room.meta?.uname ?? ''}
分区：${room.meta?.area ?? ''}
你在里面待了：${Math.round((Date.now() - Number(room.enteredAt ?? Date.now())) / 60000)} 分钟
你已经发了：${roomState.spoken ?? 0} 条弹幕

【你发过的话】
${sent.map((text) => `- ${text}`).join('\n') || '（还没说过）'}

【最近弹幕】
${chat}

【你听到/看到的】
${heard}

判断标准：
- 只有你真的对这位主播或这个房间感兴趣、觉得聊得来、想下次再来，才 follow=true
- 只是房间热闹、被提到名字、出于礼貌、为了完成任务、或者条件刚好凑够 → follow=false
- 不感兴趣就明确拒绝；「${persona.name || '聊天鲸'}」不需要关注每个人
- 不要因为对方是新人/人少就同情性关注

只输出 JSON：
{"follow":true或false,"reason":"用一句你自己的话说为什么","confidence":0到1}`
}

export async function judgeFollow({ ctx, config = {}, room, roomState, danmaku, observations, log = () => {} } = {}) {
  const llm = ctx?.get?.('llm') ?? null
  if (!llm?.stream) {
    log('[chat-whale] 关注判断：没有可用文本模型，先不关注')
    return { follow: false, reason: '没有可用文本模型，先不关注', model: null }
  }
  const routes = await textRoutes(ctx, config)
  if (!routes.length) {
    log('[chat-whale] 关注判断：没有可用文本模型，先不关注')
    return { follow: false, reason: '没有可用文本模型，先不关注', model: null }
  }
  const prompt = PROMPT({ config, room, roomState, danmaku, observations })
  try {
    const result = await callTextRoute(llm, routes, prompt, { temperature: 0.2, maxTokens: 3000 }, log)
    const decision = parseFollowDecision(result.text)
    log(`[chat-whale] 关注判断（${result.label}）：${decision.follow ? '想关注' : '不关注'} · ${decision.reason}`)
    return { ...decision, model: `${result.route.provider}/${result.route.model}` }
  } catch (error) {
    return { follow: false, reason: `判断失败：${error.message}`, model: null }
  }
}
