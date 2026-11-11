/**
 * 语音识别纠错：
 *   · 先用启发式判断「这段转写是不是明显不清楚」（太短、重复字、乱码、超长无标点）
 *   · 明显不清楚时，借 DSH 的文本模型结合画面/上一句做一次保守还原
 *   · 任何一步失败都回退到原始转写，绝不因为纠错失败而丢内容
 */

import { resolveRoutes, callTextRoute } from './llm.js'

export function speechLooksUnclear(text) {
  const clean = String(text ?? '').replace(/\s+/g, '')
  if (!clean) return false
  if (clean.length <= 2) return true
  if (/(.)\1{3,}/.test(clean)) return true
  if (/[�]{1,}/.test(clean)) return true
  const weird = clean.replace(/[\u4e00-\u9fa5a-zA-Z0-9，。！？、,.!?：:；;“”"'（）()《》【】\s]/g, '')
  if (weird.length > 2) return true
  if (clean.length >= 25 && !/[，。！？、,.!?：:；;]/.test(clean)) return true
  return false
}

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

const PROMPT = ({ text, vision, previous }) => `你在帮一个直播观众理解语音识别转写。

这段转写来自 B 站直播，可能有同音字、错字、断句错误。请结合画面和上一句，保守地还原主播最可能的意思。

要求：
- 只输出一句修正后的中文，不要解释
- 不要编造转写和画面里没有的事实
- 实在不确定的词用（？）标出
- 如果原句已经通顺，就原样输出

【转写】
${text}

【上一句】
${previous || '（无）'}

【画面】
${vision || '（无）'}`

export async function clarifySpeech({ ctx, text, vision = '', previous = '', config = {}, signal, log = () => {} } = {}) {
  const raw = String(text ?? '').trim()
  if (!raw) return null
  const llm = ctx?.get?.('llm') ?? null
  if (!llm?.stream) return null
  const routes = await textRoutes(ctx, config)
  if (!routes.length) return null
  const prompt = PROMPT({ text: raw, vision, previous })
  try {
    const result = await callTextRoute(llm, routes, prompt, { temperature: 0.2, maxTokens: 1200, signal }, log)
    const clarified = String(result.text).split('\n').map((line) => line.trim()).filter(Boolean)[0]?.slice(0, 300) ?? ''
    if (clarified && clarified !== raw) {
      log(`[chat-whale] 语音纠错（${result.label}）：${raw.slice(0, 60)} → ${clarified.slice(0, 60)}`)
      return { text: clarified, provider: result.route.provider, model: result.route.model, effort: result.route.reasoningEffort ?? null }
    }
    return null
  } catch (error) {
    if (signal?.aborted) return null
    log(`[chat-whale] 语音纠错失败：${error.message}`)
    return null
  }
}

export function speechPromptNote(observation) {
  if (!observation) return ''
  if (observation.speechClarified) return '这段语音识别已经做过一次保守纠错；仍可能有猜测成分，接话时别把不确定的词当事实。'
  if (observation.speechRaw && observation.speechRaw !== observation.speech) return '这段语音识别不太清楚，已尽量还原；不确定的地方可以含糊一点。'
  return ''
}
