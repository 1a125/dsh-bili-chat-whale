/**
 * 语音识别纠错：
 *   · 先用启发式判断「这段转写是不是明显不清楚」（太短、重复字、乱码、超长无标点）
 *   · 明显不清楚时，借 DSH 的文本模型结合画面/上一句做一次保守还原
 *   · 任何一步失败都回退到原始转写，绝不因为纠错失败而丢内容
 */

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

let routeCache = { at: 0, routes: [] }

async function textRoutes(ctx) {
  if (Date.now() - routeCache.at < 10 * 60_000 && routeCache.routes.length) return routeCache.routes
  const llm = ctx?.get?.('llm') ?? null
  if (!llm?.listProviders || !llm?.listModels) return []
  const routes = []
  try {
    const providers = await llm.listProviders()
    for (const provider of providers) {
      let models = []
      try { models = await llm.listModels(provider.id) } catch { continue }
      for (const model of models) {
        const input = model.inputModalities ?? []
        // 纯图像模型不做文本纠错
        if (input.includes('image') && !input.includes('text')) continue
        routes.push({ provider: provider.id, model: model.id })
      }
    }
  } catch { return [] }
  const score = (route) => (/deepseek|qwen|gpt|claude|glm|doubao|kimi/i.test(route.model) ? 10 : 0)
  routes.sort((a, b) => score(b) - score(a))
  routeCache = { at: Date.now(), routes: routes.slice(0, 4) }
  return routeCache.routes
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

async function streamText(llm, route, prompt, signal) {
  const chunks = []
  const blocks = []
  let finish = null
  const stream = llm.stream({
    provider: route.provider,
    model: route.model,
    messages: [{ role: 'user', content: [{ type: 'text', text: prompt }] }],
    temperature: 0.2,
    maxTokens: 300,
    signal,
  })
  for await (const chunk of stream) {
    if (chunk.type === 'text-delta') chunks.push(chunk.text)
    if (chunk.type === 'block-end' && chunk.block?.type === 'text' && chunk.block.text) blocks.push(chunk.block.text)
    if (chunk.type === 'finish') {
      finish = chunk.reason
      if (chunk.reason?.kind === 'error') throw new Error(chunk.reason.failure?.message ?? '模型调用失败')
      if (chunk.reason?.kind === 'aborted') throw new Error('模型调用已取消')
    }
  }
  let text = chunks.join('').trim()
  if (!text) text = [...new Set(blocks)].join('').trim()
  if (!text) throw new Error(`模型返回空文本${finish?.kind ? `（${finish.kind}）` : ''}`)
  return text.split('\n').map((line) => line.trim()).filter(Boolean)[0].slice(0, 300)
}

export async function clarifySpeech({ ctx, text, vision = '', previous = '', signal, log = () => {} } = {}) {
  const raw = String(text ?? '').trim()
  if (!raw) return null
  const llm = ctx?.get?.('llm') ?? null
  if (!llm?.stream) return null
  const routes = await textRoutes(ctx)
  if (!routes.length) return null
  const prompt = PROMPT({ text: raw, vision, previous })
  let lastError = null
  for (const route of routes) {
    try {
      const clarified = await streamText(llm, route, prompt, signal)
      if (clarified && clarified !== raw) {
        log(`[chat-whale] 语音纠错（${route.provider}/${route.model}）：${raw.slice(0, 60)} → ${clarified.slice(0, 60)}`)
        return { text: clarified, provider: route.provider, model: route.model }
      }
      return null
    } catch (error) {
      lastError = error
      if (signal?.aborted) return null
    }
  }
  if (lastError) log(`[chat-whale] 语音纠错失败：${lastError.message}`)
  return null
}

export function speechPromptNote(observation) {
  if (!observation) return ''
  if (observation.speechClarified) return '这段语音识别已经做过一次保守纠错；仍可能有猜测成分，接话时别把不确定的词当事实。'
  if (observation.speechRaw && observation.speechRaw !== observation.speech) return '这段语音识别不太清楚，已尽量还原；不确定的地方可以含糊一点。'
  return ''
}
