import fs from 'node:fs'
import path from 'node:path'
import { ocrAvailable, ocrImage } from './ocr.js'
import { listModels, resolveRoutes, isUnsupportedEffort } from './llm.js'

/**
 * 看懂画面。
 *
 * 三级梯队（设置里可以指定，默认 auto）：
 *   1. DSH 的视觉模型（ctx.llm）：如果 profile 里有声明 image 输入的模型，直接借。
 *   2. HTTP 视觉接口：OpenAI 兼容的 /v1/chat/completions，配 baseURL + model + 密钥环境变量。
 *   3. 本机 OCR：Windows 自带的 OCR，把画面上的字读出来（离线、免费，但没有语义）。
 *
 * 都不通就老实说「这一轮看不到画面」，让 agent 只靠声音和弹幕聊天 —— 不编造画面内容。
 */

const PROMPT = (meta) => `你在看一张 B 站直播间的画面截屏（可能是 1–2 帧拼在一起）。
主播：${meta.uname || '未知'}｜标题：${meta.title || '未知'}｜分区：${meta.area || '未知'}｜在线：${meta.online ?? '?'}

请用 2–3 句中文，客观描述：
1) 主播在做什么（出镜聊天 / 打游戏 / 唱歌 / 画画 / 屏幕演示 / 只是挂机…）
2) 画面主体和场景
3) 屏幕上看得清的文字（字幕、歌词、游戏名、公告；看不清就略过）

只写你看到的。不要猜声音、不要猜镜头外的事、不要评价。不要复述这段说明。`

export class VisionEngine {
  constructor({ ctx = null, config = {}, log = () => {} } = {}) {
    this.ctx = ctx
    this.config = config
    this.log = log
    this.routeCache = { at: 0, routes: undefined }
    this.lastRoute = null
    this.lastError = null
    this.llmBlockedUntil = 0
    this.httpBlockedUntil = 0
    this.httpFailures = 0
    this.lastResult = null
  }

  updateConfig(config) {
    const before = `${this.config.vision?.provider ?? ''}/${this.config.vision?.model ?? ''}`
    const after = `${config.vision?.provider ?? ''}/${config.vision?.model ?? ''}`
    this.config = config
    if (before !== after) this.routeCache = { at: 0, routes: undefined }
  }

  status() {
    return {
      enabled: this.config.vision?.enabled !== false,
      mode: this.config.vision?.mode ?? 'auto',
      ocrAvailable: ocrAvailable(),
      llm: this.lastRoute?.kind === 'llm' ? this.lastRoute : null,
      http: this.config.vision?.baseURL && (this.config.vision?.httpModel || this.config.vision?.model)
        ? { baseURL: this.config.vision.baseURL, model: this.config.vision.httpModel || this.config.vision.model }
        : null,
      lastError: this.lastError,
      lastResult: this.lastResult,
    }
  }

  async listLlmRoutes() {
    const listed = await listModels(this.ctx)
    if (!listed.ok && !listed.models.length) return { ok: false, error: listed.error ?? '没有可用模型', routes: [] }
    return {
      ok: true,
      routes: listed.models.map((item) => ({
        provider: item.provider,
        providerName: item.providerName,
        model: item.id,
        name: item.name,
        input: item.input,
        image: item.image,
      })),
    }
  }

  async resolveLlmRoutes({ force = false } = {}) {
    const vision = this.config.vision ?? {}
    const chosen = this.config.model ?? {}
    // 设置页选的模型优先（视觉这一路单独覆盖仍可用 vision.provider/model 精确指定）
    if (vision.provider && vision.model) {
      return [{
        kind: 'llm',
        provider: vision.provider,
        model: vision.model,
        reasoningEffort: chosen.reasoningEffort || null,
        source: 'config',
      }]
    }
    if (!force && this.routeCache.routes !== undefined && Date.now() - this.routeCache.at < 10 * 60_000) return this.routeCache.routes
    this.routeCache = { at: Date.now(), routes: [] }
    // 主开关选的是纯文本模型时，画面这条线不能跟着它走 —— 自动挑一个能看图的
    let provider = chosen.provider ?? ''
    let model = chosen.model ?? ''
    if (provider && model) {
      const listed = await listModels(this.ctx)
      const picked = (listed.models ?? []).find((item) => item.provider === provider && item.id === model)
      if (!picked?.image) { provider = ''; model = '' }
    }
    const routes = await resolveRoutes(this.ctx, {
      provider,
      model,
      reasoningEffort: chosen.reasoningEffort ?? '',
      needImage: true,
      max: 4,
    })
    this.routeCache = { at: Date.now(), routes: routes.map((item) => ({ kind: 'llm', ...item })) }
    return this.routeCache.routes
  }

  async apiKey() {
    const credentials = this.ctx?.get?.('credentials') ?? null
    const refs = [...new Set([
      String(this.config.vision?.apiKeyEnv ?? '').trim(),
      'CHAT_WHALE_VISION_API_KEY',
    ].filter(Boolean))]
    for (const ref of refs) {
      if (process.env[ref]) return process.env[ref]
      if (credentials?.resolve) {
        try {
          const resolved = await credentials.resolve(ref)
          if (resolved?.value) return resolved.value
        } catch {}
      }
    }
    return null
  }

  /** 设置页只显示"有没有配"，永远不回显密钥。 */
  async keyConfigured() {
    const credentials = this.ctx?.get?.('credentials') ?? null
    const refs = [...new Set([
      String(this.config.vision?.apiKeyEnv ?? '').trim(),
      'CHAT_WHALE_VISION_API_KEY',
    ].filter(Boolean))]
    for (const ref of refs) {
      if (process.env[ref]) return { configured: true, ref, source: 'env' }
      if (credentials?.describe) {
        try {
          const info = await credentials.describe(ref)
          if (info?.configured) return { configured: true, ref, source: info.source ?? 'credentials' }
        } catch {}
      }
    }
    return { configured: false }
  }

  async saveKey(key) {
    const credentials = this.ctx?.get?.('credentials') ?? null
    if (!credentials?.set) throw new Error('宿主没有 credentials 服务，无法安全保存密钥')
    const value = String(key ?? '').trim()
    if (!value) throw new Error('密钥是空的')
    if (value.length > 4096) throw new Error('密钥太长')
    await credentials.set('CHAT_WHALE_VISION_API_KEY', value)
    return { ok: true, ref: 'CHAT_WHALE_VISION_API_KEY' }
  }

  async clearKey() {
    const credentials = this.ctx?.get?.('credentials') ?? null
    if (!credentials?.unset) throw new Error('宿主没有 credentials 服务')
    await credentials.unset('CHAT_WHALE_VISION_API_KEY')
    return { ok: true }
  }

  async describeWithLlm(route, imageFile, meta, { signal } = {}) {
    const llm = this.ctx?.get?.('llm') ?? null
    const attachments = this.ctx?.get?.('attachments') ?? null
    if (!llm || !attachments) throw new Error('宿主没有 llm / attachments 服务')
    const bytes = fs.readFileSync(imageFile)
    const limits = attachments.imageLimits
    if (limits?.maxImageBytes && bytes.length > limits.maxImageBytes) throw new Error(`截图 ${(bytes.length / 1024 | 0)}KB 超过模型上限`)
    const ref = await attachments.saveImage({ data: new Uint8Array(bytes), mediaType: 'image/jpeg', name: path.basename(imageFile) })
    const chunks = []
    const blocks = []
    let finish = null
    const request = {
      provider: route.provider,
      model: route.model,
      messages: [{ role: 'user', content: [{ type: 'text', text: PROMPT(meta) }, { type: 'image', attachment: ref }] }],
      temperature: 0.2,
      maxTokens: 1200,
      signal,
    }
    if (route.reasoningEffort) request.reasoningEffort = route.reasoningEffort
    const stream = llm.stream(request)
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
    // 有些适配器只发 block-end、不发 delta —— 这里不能只认 delta，否则会把成功的调用当空描述
    if (!text) text = [...new Set(blocks)].join('').trim()
    if (!text) throw new Error(`模型返回了空描述（${route.provider}/${route.model}${finish?.kind ? ' · ' + finish.kind : ''}）`)
    return text
  }

  async describeWithHttp(imageFile, meta, { signal } = {}) {
    const vision = this.config.vision ?? {}
    const model = vision.httpModel || vision.model
    if (!vision.baseURL || !model) throw new Error('HTTP 视觉接口没配置（baseURL + httpModel）')
    const key = await this.apiKey()
    if (!key) throw new Error(`没有找到密钥（环境变量 ${vision.apiKeyEnv || '未配置'}）`)
    const base = String(vision.baseURL ?? '').replace(/\/+$/, '')
    const url = /\/v1$/i.test(base) ? `${base}/chat/completions` : `${base}/v1/chat/completions`
    const dataUrl = `data:image/jpeg;base64,${fs.readFileSync(imageFile).toString('base64')}`
    const response = await fetch(url, {
      method: 'POST',
      headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
      signal: AbortSignal.any([AbortSignal.timeout(45_000), ...(signal ? [signal] : [])]),
      body: JSON.stringify({
        model,
        messages: [{
          role: 'user',
          content: [
            { type: 'text', text: PROMPT(meta) },
            { type: 'image_url', image_url: { url: dataUrl } },
          ],
        }],
        max_tokens: 300,
        temperature: 0.2,
      }),
    })
    const text = await response.text()
    if (!response.ok) {
      let message = `HTTP ${response.status}`
      try { message += `：${JSON.parse(text)?.error?.message ?? ''}` } catch {}
      throw new Error(message.slice(0, 240))
    }
    let body
    try { body = JSON.parse(text) } catch { throw new Error('视觉接口返回了非 JSON') }
    const content = body?.choices?.[0]?.message?.content
    const result = typeof content === 'string' ? content : Array.isArray(content) ? content.map((part) => part?.text ?? '').join('') : ''
    if (!String(result).trim()) throw new Error('视觉接口返回了空描述')
    return String(result).trim()
  }

  /**
   * 描述一张拼好的画面。
   * 返回 { ok, mode, text, route, error }；调用方把 text 拼进给 agent 的观察记录。
   */
  async describe(imageFile, meta = {}, { signal } = {}) {
    const vision = this.config.vision ?? {}
    if (vision.enabled === false) return { ok: false, mode: 'off', text: '', error: '画面理解已关闭' }
    if (!imageFile || !fs.existsSync(imageFile)) return { ok: false, mode: 'none', text: '', error: '没有截图' }
    const mode = vision.mode ?? 'auto'
    const errors = []

    const tryLlm = async () => {
      if (Date.now() < this.llmBlockedUntil) throw new Error('视觉模型刚刚失败过，稍后再试')
      const routes = await this.resolveLlmRoutes()
      if (!routes.length) throw new Error('DSH 里没有声明图片输入的模型')
      const failures = []
      for (const route of routes.slice(0, 3)) {
        try {
          const text = await this.describeWithLlm(route, imageFile, meta, { signal })
          this.lastRoute = route
          return { ok: true, mode: 'llm', text, route }
        } catch (error) {
          failures.push(`${route.provider}/${route.model}: ${error.message}`)
          // 模型不支持这个推理等级：去掉等级再试一次同一个模型
          if (route.reasoningEffort && isUnsupportedEffort(error)) {
            try {
              const relaxed = { ...route, reasoningEffort: null }
              const text = await this.describeWithLlm(relaxed, imageFile, meta, { signal })
              this.lastRoute = relaxed
              return { ok: true, mode: 'llm', text, route: relaxed }
            } catch (retryError) {
              failures.push(`${route.provider}/${route.model}（无推理等级）: ${retryError.message}`)
            }
          }
        }
      }
      throw new Error(failures.join('；').slice(0, 400))
    }
    const tryHttp = async () => {
      if (Date.now() < this.httpBlockedUntil) throw new Error('HTTP 视觉接口刚连续失败过，稍后再试')
      if (!vision.baseURL || !(vision.httpModel || vision.model)) throw new Error('HTTP 视觉接口没配置')
      const text = await this.describeWithHttp(imageFile, meta, { signal })
      this.httpFailures = 0
      this.lastRoute = { kind: 'http', baseURL: vision.baseURL, model: vision.httpModel || vision.model }
      return { ok: true, mode: 'http', text, route: this.lastRoute }
    }
    const tryOcr = async () => {
      if (!ocrAvailable()) throw new Error('本机 OCR 不可用')
      const result = await ocrImage(imageFile)
      if (!result.ok) throw new Error(result.error || 'OCR 失败')
      const text = result.lines.length ? `画面文字：${result.lines.join(' / ')}` : '画面文字：（没读出字）'
      this.lastRoute = { kind: 'ocr', lang: result.lang }
      return { ok: true, mode: 'ocr', text, route: this.lastRoute }
    }

    const order = mode === 'off' ? [] : mode === 'auto' ? ['llm', 'http', 'ocr'] : [mode]
    for (const attempt of order) {
      try {
        const result = attempt === 'llm' ? await tryLlm() : attempt === 'http' ? await tryHttp() : await tryOcr()
        this.lastError = null
        this.lastResult = { at: Date.now(), mode: result.mode, text: result.text.slice(0, 500) }
        return result
      } catch (error) {
        errors.push(`${attempt}: ${error.message}`)
        if (attempt === 'llm') this.llmBlockedUntil = Date.now() + 2 * 60_000
        if (attempt === 'http') {
          this.httpFailures += 1
          if (this.httpFailures >= 2) this.httpBlockedUntil = Date.now() + 10 * 60_000
        }
        this.log(`[chat-whale] 画面理解（${attempt}）失败：${error.message}`)
      }
    }
    this.lastError = errors.join('；') || '画面理解不可用'
    this.lastResult = { at: Date.now(), mode: 'failed', text: '', error: this.lastError }
    return { ok: false, mode: 'failed', text: '', error: this.lastError }
  }
}

/** 给设置页的「测试画面理解」用：直接描述一张图。 */
export async function probeVision(engine, imageFile, meta = {}) {
  const started = Date.now()
  const result = await engine.describe(imageFile, meta)
  return { ...result, ms: Date.now() - started }
}
