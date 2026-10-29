import fs from 'node:fs'
import path from 'node:path'
import { resolveReportsDir } from './paths.js'

/**
 * 今日观察日记：
 *   1. 汇总当天真实活动
 *   2. 第一遍：让模型先整理回忆、纠正语音识别错句、挑出有情绪的片段
 *   3. 第二遍：写成日记草稿
 *   4. 第三遍：把草稿润色成真正通顺的日记（自己取标题、500 字内）
 *   没有可用文本模型时，用同一份素材生成朴素但成篇的兜底稿。
 */

function dateOf(value) {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return ''
  return date.toLocaleDateString('en-CA')
}

export function summarizeActivity(activity, date, range = null) {
  const from = Number(range?.from ?? 0)
  const to = Number(range?.to ?? 0)
  const rows = (activity ?? []).filter((item) => {
    const at = new Date(item.at).getTime()
    if (from || to) return at >= (from || 0) && at <= (to || Number.MAX_SAFE_INTEGER)
    return dateOf(item.at) === date
  })
  const enters = rows.filter((item) => item.kind === 'enter')
  const leaves = rows.filter((item) => item.kind === 'leave')
  const says = rows.filter((item) => item.kind === 'say' || item.kind === 'say-dry')
  const follows = rows.filter((item) => item.kind === 'follow')
  const observes = rows.filter((item) => item.kind === 'observe')
  const rooms = []
  for (const item of enters) {
    const title = String(item.title ?? '').trim()
    if (title && !rooms.includes(title)) rooms.push(title)
  }
  return {
    rooms,
    entered: enters.length,
    left: leaves.length,
    says: says.map((item) => String(item.text ?? '').trim()).filter(Boolean).slice(-20),
    follows: follows.map((item) => ({ title: String(item.title ?? ''), detail: String(item.detail ?? '') })),
    observations: observes.map((item) => String(item.detail ?? '').trim()).filter(Boolean).slice(-10),
    leaveReasons: leaves.map((item) => String(item.detail ?? '').trim()).filter(Boolean).slice(-8),
  }
}

function clampText(text, limit = 500) {
  const clean = String(text ?? '').replace(/\r\n/g, '\n').trim()
  const chars = [...clean]
  if (chars.length <= limit) return clean
  const slice = chars.slice(0, limit).join('')
  const lastStop = Math.max(slice.lastIndexOf('。'), slice.lastIndexOf('！'), slice.lastIndexOf('？'), slice.lastIndexOf('\n'))
  return lastStop > 220 ? slice.slice(0, lastStop + 1) : slice
}

function cleanTitle(value) {
  return String(value ?? '').replace(/^[《「【\s]+|[》」】\s]+$/g, '').replace(/^(标题|题目)[：:]\s*/, '').slice(0, 30)
}

function splitTitle(text) {
  const lines = String(text ?? '').replace(/\r\n/g, '\n').trim().split('\n')
  let title = ''
  const first = lines[0]?.trim() ?? ''
  const match = first.match(/^(?:标题|题目)[：:]\s*(.+)$/) || first.match(/^#\s+(.+)$/) || first.match(/^《(.+)》$/)
  if (match) { title = cleanTitle(match[1]); lines.shift() }
  else if (/^[^\n。！？]{2,18}$/.test(first) && lines.length > 1) { title = cleanTitle(first); lines.shift() }
  while (lines[0] === '') lines.shift()
  return { title, body: lines.join('\n').trim() }
}

function fallbackTitle(summary) {
  const room = summary.rooms[0]
  if (room) return `在「${room.slice(0, 12)}」停了一会儿`
  return '今晚的直播间'
}

export function fallbackReport(summary, { date, persona = {} } = {}) {
  const name = persona.name || '聊天鲸'
  const title = fallbackTitle(summary)
  if (!summary.entered && !summary.rooms.length) {
    return {
      title,
      text: `今天还没怎么出门。\n\n${name} 在家里翻了翻昨天看过的直播间，等下一次开播，再去那些安静的小房间坐坐。`,
    }
  }
  const paragraphs = []
  paragraphs.push(`今天走了 ${summary.rooms.length || summary.entered} 个直播间。`)
  if (summary.observations.length) {
    const first = summary.observations[0].replace(/^语音\s*/, '').replace(/｜画面.*$/, '').slice(0, 90)
    const room = summary.rooms[0] || '第一个房间'
    paragraphs.push(`在「${room}」里，我听见 ${first}。有些句子识别得不太清楚，但能感觉到主播是在认真说话。`)
  }
  if (summary.says.length) {
    paragraphs.push(`后来我接了几句话：${summary.says.slice(-3).map((text) => `「${text}」`).join('、')}。说完就安静听着，没有抢话。`)
  } else {
    paragraphs.push('今天基本在听，没怎么插话。偶尔想接一句，又觉得让主播自己说完更好。')
  }
  if (summary.follows.length) {
    const names = summary.follows.map((item) => String(item.detail || item.title || '').replace(/^关注了主播\s*/, '')).filter(Boolean)
    paragraphs.push(`今天关注了 ${names.join('、')}。不是每个房间都值得留下，但遇到聊得来的，还是想下次再见到。`)
  } else {
    paragraphs.push('今天没有新关注谁。人来人往，先继续观察。')
  }
  if (summary.leaveReasons.length) {
    paragraphs.push(`离开的原因也记得：${[...new Set(summary.leaveReasons)].slice(0, 3).join('；')}。`)
  }
  paragraphs.push('关掉直播的时候，房间里的声音还在脑子里转。明天再去看看。')
  return { title, text: clampText(paragraphs.join('\n\n'), 500) }
}

let routeCache = { at: 0, routes: [] }

async function textRoutes(ctx) {
  if (Date.now() - routeCache.at < 10 * 60_000 && routeCache.routes.length) return routeCache.routes
  const llm = ctx?.get?.('llm') ?? null
  if (!llm?.listProviders || !llm?.listModels) return []
  const routes = []
  try {
    for (const provider of await llm.listProviders()) {
      let models = []
      try { models = await llm.listModels(provider.id) } catch { continue }
      for (const model of models) {
        const input = model.inputModalities ?? []
        if (input.includes('image') && !input.includes('text')) continue
        routes.push({ provider: provider.id, model: model.id })
      }
    }
  } catch { return [] }
  const score = (route) => (/deepseek|qwen|gpt|claude|glm|doubao|kimi/i.test(route.model) ? 10 : 0)
  routes.sort((a, b) => score(b) - score(a))
  routeCache = { at: Date.now(), routes: routes.slice(0, 2) }
  return routeCache.routes
}

async function streamText(llm, route, prompt, { maxTokens = 1200, temperature = 0.7 } = {}, log = () => {}) {
  const chunks = []
  const blocks = []
  const types = []
  const stream = llm.stream({
    provider: route.provider,
    model: route.model,
    messages: [{ role: 'user', content: [{ type: 'text', text: prompt }] }],
    temperature,
    maxTokens,
    signal: AbortSignal.timeout(25_000),
  })
  for await (const chunk of stream) {
    if (!types.includes(chunk.type)) types.push(chunk.type)
    if (chunk.type === 'text-delta') chunks.push(chunk.text)
    if (chunk.type === 'block-end' && chunk.block?.type === 'text' && chunk.block.text) blocks.push(chunk.block.text)
    if (chunk.type === 'finish' && chunk.reason?.kind === 'error') throw new Error(chunk.reason.failure?.message ?? '模型调用失败')
    if (chunk.type === 'finish' && chunk.reason?.kind === 'aborted') throw new Error('生成已取消')
  }
  const text = (chunks.join('').trim() || [...new Set(blocks)].join('').trim()).trim()
  if (!text) throw new Error(`模型没有返回文本（chunks: ${types.join(',') || 'none'}）`)
  return text
}

async function callText(llm, routes, prompt, options, log) {
  let lastError = null
  for (const route of routes) {
    try {
      const text = await streamText(llm, route, prompt, options, log)
      if (text) return { text, model: `${route.provider}/${route.model}` }
    } catch (error) {
      lastError = error
      log(`[chat-whale] 日记模型失败（${route.provider}/${route.model}）：${error.message}`)
    }
  }
  if (lastError) throw lastError
  throw new Error('没有可用的文本模型')
}

function parseMemory(text) {
  const raw = String(text ?? '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '')
  const start = raw.indexOf('{')
  const end = raw.lastIndexOf('}')
  if (start >= 0 && end > start) {
    try { return JSON.parse(raw.slice(start, end + 1)) } catch {}
  }
  return null
}

const MEMORY_PROMPT = ({ summary, persona, date }) => `你是「${persona.name || '聊天鲸'}」的观察记录员。下面是今天在 B 站直播间的原始日志，语音识别可能有错字、漏字、断句错误。

先不要写日记。请做三件事：
1. 结合画面描述，纠正语音转写里的同音字/断句错误；不确定的词用（？）标出
2. 按直播间归并今天真正发生了什么，挑出 2–3 个有情绪、有互动的瞬间
3. 总结今天的心情和收获

输出 JSON（只输出 JSON，不要代码块/解释）：
{"rooms":["..."],"moments":[{"room":"...","heard":"...","said":"...","feeling":"..."}],"follows":["..."],"corrections":["原句→纠正"],"mood":"..."}

日期：${date}
人设：${persona.tone || '自然、松弛'}
素材：
${JSON.stringify(summary).slice(0, 7000)}`

const DRAFT_PROMPT = ({ memory, persona, date }) => `你是「${persona.name || '聊天鲸'}」。${persona.tone ? `说话风格：${persona.tone}。` : ''}
${persona.bio ? `你的人设：\n${persona.bio.slice(0, 1200)}\n` : ''}

下面是已经整理并纠正过语音错句的今日回忆。请先写一版日记草稿：
- 第一人称，像晚上坐下来回忆一天，不要逐条列日志
- 写出具体画面、听到的话、接过的弹幕，以及当时的感受
- 只写素材里发生过的事，不编造
- 300–600 字即可，不需要标题

日期：${date}
回忆：
${JSON.stringify(memory).slice(0, 6000)}`

const POLISH_PROMPT = ({ draft, memory, persona, date }) => `你是「${persona.name || '聊天鲸'}」。${persona.tone ? `说话风格：${persona.tone}。` : ''}
${persona.bio ? `你的人设：\n${persona.bio.slice(0, 1200)}\n` : ''}

下面是你刚写的今日日记草稿。它可能像日志、像拼凑的片段，或者不够通顺。请把它**重写/润色成一篇真正的中文日记**：

- 标题由你自己取，8–16 个字，贴今天的内容，不要用「XX的今日观察日记」这种固定标题
- 正文 420–480 个汉字，**绝对不能超过 500 字**
- 有开头、有具体的场景和对话、有情绪和收获、有收尾；不要逐条列「去了哪、说了哪几句」
- 纠正草稿里不通顺的句子；保留真实发生过的事，不添加素材外的事实
- 不要暴露 UID、Cookie、密钥、系统路径
- 不要提 AI、插件、模型、程序、任务
- 禁止使用 bullet、编号、小标题

输出格式（严格）：
标题：……
（空行）
正文……

日期：${date}
整理后的回忆（事实校验用）：
${JSON.stringify(memory).slice(0, 5000)}

草稿：
${String(draft).slice(0, 5000)}`

export async function generateReport({ ctx, activity, config = {}, date, from = null, to = null, dir = null, log = () => {} }) {
  const summary = summarizeActivity(activity, date, { from, to })
  const persona = config.persona ?? {}
  const fallback = fallbackReport(summary, { date, persona })
  let text = fallback.text
  let title = fallback.title
  let model = null
  let usedPolish = false

  const llm = ctx?.get?.('llm') ?? null
  const routes = await textRoutes(ctx)
  if (llm?.stream && routes.length && summary.entered) {
    try {
      // 第一遍：整理回忆 + 纠正语音
      let memory = null
      try {
        const memoryResult = await callText(llm, routes, MEMORY_PROMPT({ summary, persona, date }), { maxTokens: 3000, temperature: 0.2 }, log)
        memory = parseMemory(memoryResult.text)
        model = memoryResult.model
      } catch (error) {
        log(`[chat-whale] 日记回忆整理失败，直接用原始素材：${error.message}`)
      }
      if (!memory) {
        memory = {
          rooms: summary.rooms,
          moments: summary.observations.slice(-5),
          follows: summary.follows.map((item) => item.detail || item.title),
          corrections: [],
          mood: '',
        }
      }

      // 第二遍：写草稿
      const draftResult = await callText(llm, routes, DRAFT_PROMPT({ memory, persona, date }), { maxTokens: 4000, temperature: 0.7 }, log)
      model = draftResult.model
      let draft = draftResult.text

      // 第三遍：润色成日记（标题 + 500 字内）
      try {
        const polishResult = await callText(llm, routes, POLISH_PROMPT({ draft, memory, persona, date }), { maxTokens: 4000, temperature: 0.5 }, log)
        model = polishResult.model
        draft = polishResult.text
        usedPolish = true
      } catch (error) {
        log(`[chat-whale] 日记润色失败，使用草稿：${error.message}`)
      }

      const parsed = splitTitle(draft)
      if (parsed.body && parsed.body.length >= 30) {
        title = parsed.title || fallbackTitle(summary)
        text = clampText(parsed.body, 500)
      } else {
        log('[chat-whale] 日记模型返回内容太短，使用兜底稿')
      }
    } catch (error) {
      log(`[chat-whale] 今日日记生成失败，使用兜底稿：${error.message}`)
    }
  } else if (!routes.length) {
    log('[chat-whale] 今日日记：没有可用文本模型，使用兜底稿')
  }

  const record = {
    date,
    title,
    text,
    fallback: text === fallback.text,
    polished: usedPolish,
    model,
    generatedAt: new Date().toISOString(),
  }
  try {
    const outDir = dir || resolveReportsDir(config)
    fs.mkdirSync(outDir, { recursive: true })
    const file = path.join(outDir, `${date}.md`)
    fs.writeFileSync(file, `# ${title}\n\n${text}\n`)
    record.path = file
  } catch (error) {
    log(`[chat-whale] 日记保存失败：${error.message}`)
  }
  return record
}
