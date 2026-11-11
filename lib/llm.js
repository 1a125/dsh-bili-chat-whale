/**
 * 统一的「用哪个模型」解析。
 *
 * 之前每个模块各自 listProviders/listModels 再按名字瞎猜，结果永远落在同一个
 * 默认模型上，用户在设置页没法像对话那样换模型和推理等级。现在集中在这里：
 *   · 设置页显式选 provider/model/reasoningEffort
 *   · 没选才自动挑（文本优先 text，视觉优先 image）
 *   · 调用时把推理等级一起带上；模型不支持就自动降级为不带
 */

const TEXT_HINT = /deepseek|qwen|gpt|claude|glm|doubao|kimi|gemini|llama|mistral/i
const IMAGE_HINT = /gpt-5|gpt-6|gemini|claude|vision|omni|4o|qwen.*vl|glm.*v|doubao.*vision/i

let providerCache = { at: 0, providers: [] }

export function resetRouteCache() {
  providerCache = { at: 0, providers: [] }
}

/** 列出宿主所有 provider（带缓存，热重载或换账号时会过期）。 */
export async function listProviders(ctx, { force = false } = {}) {
  const llm = ctx?.get?.('llm') ?? null
  if (!llm?.listProviders) return []
  if (!force && providerCache.providers.length && Date.now() - providerCache.at < 10 * 60_000) return providerCache.providers
  try {
    const list = await llm.listProviders()
    providerCache = { at: Date.now(), providers: list }
    return list
  } catch {
    return []
  }
}

/**
 * 列出可选模型。
 * 需要 includeImage 时把声明了 image 输入的也带上，并标注 image/text。
 */
export async function listModels(ctx, { force = false } = {}) {
  const llm = ctx?.get?.('llm') ?? null
  if (!llm?.listProviders || !llm?.listModels) return { ok: false, error: '宿主没有 llm 服务', models: [] }
  const models = []
  try {
    for (const provider of await listProviders(ctx, { force })) {
      let list = []
      try {
        list = await llm.listModels(provider.id)
      } catch (error) {
        models.push({ provider: provider.id, providerName: provider.name, error: error.message })
        continue
      }
      for (const model of list) {
        const input = [...(model.inputModalities ?? [])]
        models.push({
          provider: provider.id,
          providerName: provider.name,
          id: model.id,
          name: model.name || model.id,
          description: model.description ?? '',
          input,
          text: !input.length || input.includes('text'),
          image: input.includes('image'),
        })
      }
    }
  } catch (error) {
    return { ok: false, error: error.message, models }
  }
  return { ok: true, models }
}

/** 查某个模型支持的推理等级；不支持则返回空列表。 */
export async function listReasoning(ctx, provider, model) {
  const llm = ctx?.get?.('llm') ?? null
  if (!llm?.resolveModelInfo || !provider || !model) return { ok: true, efforts: [], defaultEffort: null }
  try {
    const info = await llm.resolveModelInfo(provider, model, AbortSignal.timeout(8_000))
    const efforts = (info?.reasoning?.efforts ?? []).map((item) => ({
      id: String(item.id),
      name: item.name || String(item.id),
      description: item.description ?? '',
    }))
    return { ok: true, efforts, defaultEffort: info?.reasoning?.defaultEffort ? String(info.reasoning.defaultEffort) : null }
  } catch (error) {
    return { ok: false, error: error.message, efforts: [], defaultEffort: null }
  }
}

function scoreText(model) {
  let score = TEXT_HINT.test(model.id) ? 10 : 0
  if (model.name && model.name !== model.id) score += 1
  return score
}

function scoreImage(model) {
  let score = IMAGE_HINT.test(model.id) ? 10 : 0
  if (/flash|mini|lite|fast/i.test(model.id)) score += 2
  return score
}

/**
 * 解析出实际要用的路由列表。
 *   · 设置里指定了 provider + model → 只用这一个
 *   · 否则自动挑：needImage 时只看 image 模型，否则只看 text 模型
 * 返回 [{ provider, model, reasoningEffort, source }]
 */
export async function resolveRoutes(ctx, { provider = '', model = '', reasoningEffort = '', needImage = false, max = 4, fallback = true } = {}) {
  const effort = String(reasoningEffort ?? '').trim()
  const chosenProvider = String(provider ?? '').trim()
  const chosenModel = String(model ?? '').trim()
  if (chosenProvider && chosenModel) {
    const chosen = [{ provider: chosenProvider, model: chosenModel, reasoningEffort: effort || null, source: 'config' }]
    if (!fallback) return chosen
    // 指定的模型挂了（上游 502/超时/被下线）时仍能出内容，而不是直接退兜底稿
    const rest = await autoRoutes(ctx, { reasoningEffort: effort, needImage, max })
    const others = rest.filter((item) => !(item.provider === chosenProvider && item.model === chosenModel))
    return [...chosen, ...others]
  }
  return autoRoutes(ctx, { reasoningEffort: effort, needImage, max })
}

async function autoRoutes(ctx, { reasoningEffort = '', needImage = false, max = 4 } = {}) {
  const listed = await listModels(ctx)
  if (!listed.ok) return []
  const usable = listed.models.filter((item) => item.provider && item.id && (needImage ? item.image : item.text))
  if (!usable.length) return []
  usable.sort((a, b) => (needImage ? scoreImage(b) - scoreImage(a) : scoreText(b) - scoreText(a)))
  return usable.slice(0, max).map((item) => ({
    provider: item.provider,
    model: item.id,
    reasoningEffort: reasoningEffort || null,
    source: 'auto',
  }))
}

/** 把推理等级加进请求；模型不支持时下一次自动去掉。 */
function callOptions(route, extra) {
  const options = { provider: route.provider, model: route.model, ...extra }
  if (route.reasoningEffort) options.reasoningEffort = route.reasoningEffort
  return options
}

export function isUnsupportedEffort(error) {
  return /reasoning|effort|unsupported|invalid.*(param|argument)/i.test(String(error?.message ?? ''))
}

/**
 * 收集一次流式文本调用的结果。delta 和 block-end 都要看：
 * 有的适配器只发 block-end，只认 delta 会把成功当空。
 */
export async function collectText(llm, route, prompt, { maxTokens = 1200, temperature = 0.7, signal = null, timeoutMs = 25_000 } = {}) {
  const chunks = []
  const blocks = []
  const types = []
  const stream = llm.stream(callOptions(route, {
    messages: [{ role: 'user', content: [{ type: 'text', text: prompt }] }],
    temperature,
    maxTokens,
    signal: signal ?? AbortSignal.timeout(timeoutMs),
  }))
  for await (const chunk of stream) {
    if (!types.includes(chunk.type)) types.push(chunk.type)
    if (chunk.type === 'text-delta') chunks.push(chunk.text)
    if (chunk.type === 'block-end' && chunk.block?.type === 'text' && chunk.block.text) blocks.push(chunk.block.text)
    if (chunk.type === 'finish' && chunk.reason?.kind === 'error') throw new Error(chunk.reason.failure?.message ?? '模型调用失败')
    if (chunk.type === 'finish' && chunk.reason?.kind === 'aborted') throw new Error('模型调用已取消')
  }
  const text = (chunks.join('').trim() || [...new Set(blocks)].join('').trim()).trim()
  if (!text) throw new Error(`模型没有返回文本（chunks: ${types.join(',') || 'none'}）`)
  return text
}

/**
 * 多路由兜底调用：指定路由只用指定那个；自动路由逐个试。
 * 推理等级不被支持时，去掉等级重试同一路由一次。
 */
export async function callTextRoute(llm, routes, prompt, options = {}, log = () => {}) {
  let lastError = null
  for (const route of routes) {
    for (const attempt of route.reasoningEffort ? [route, { ...route, reasoningEffort: null }] : [route]) {
      try {
        const text = await collectText(llm, attempt, prompt, options)
        if (text) return { text, route: attempt, label: `${attempt.provider}/${attempt.model}${attempt.reasoningEffort ? ` · ${attempt.reasoningEffort}` : ''}` }
      } catch (error) {
        lastError = error
        log(`[chat-whale] 模型调用失败（${attempt.provider}/${attempt.model}${attempt.reasoningEffort ? ` · ${attempt.reasoningEffort}` : ''}）：${error.message}`)
        if (!attempt.reasoningEffort || !isUnsupportedEffort(error)) break
      }
    }
  }
  if (lastError) throw lastError
  throw new Error('没有可用的文本模型')
}
