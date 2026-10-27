import fs from 'node:fs'
import path from 'node:path'
import { REPORTS_DIR } from './paths.js'

/**
 * 今日观察日记：
 *   · 先整理今天真实发生的进房/发言/关注/观察
 *   · 有 DSH 文本模型时，用人设写一篇第一人称日记
 *   · 没有模型/失败时用同一份素材生成朴素的兜底稿，不编造
 */

function dateOf(value) {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return ''
  // 按本地日期归类，不能直接截 ISO 的 UTC 日期（凌晨活动会跑到前一天）
  return date.toLocaleDateString('en-CA')
}

export function summarizeActivity(activity, date) {
  const rows = (activity ?? []).filter((item) => dateOf(item.at) === date)
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
    rows,
    rooms,
    entered: enters.length,
    left: leaves.length,
    says: says.map((item) => String(item.text ?? '').trim()).filter(Boolean).slice(-20),
    follows: follows.map((item) => ({ title: String(item.title ?? ''), detail: String(item.detail ?? '') })),
    observations: observes.map((item) => String(item.detail ?? '').trim()).filter(Boolean).slice(-8),
    leaveReasons: leaves.map((item) => String(item.detail ?? '').trim()).filter(Boolean).slice(-8),
  }
}

export function fallbackReport(summary, { date, persona = {} } = {}) {
  const name = persona.name || '聊天鲸'
  const lines = [`《${name}的今日观察日记》`, date, '']
  if (!summary.entered && !summary.rooms.length) {
    lines.push('今天还没怎么出门。等下一次开播，我再去那些安静的小房间坐坐。')
    return lines.join('\n')
  }
  lines.push(`今天去了 ${summary.rooms.length || summary.entered} 个直播间。`)
  if (summary.rooms.length) lines.push(`印象比较深的有：${summary.rooms.slice(0, 5).join('、')}${summary.rooms.length > 5 ? ' 等' : ''}。`)
  if (summary.observations.length) {
    lines.push('', '听到/看到的片段：')
    for (const item of summary.observations.slice(-3)) lines.push(`- ${item.slice(0, 120)}`)
  }
  if (summary.says.length) {
    lines.push('', '今天开口说过：')
    for (const item of summary.says.slice(-5)) lines.push(`- ${item}`)
  } else {
    lines.push('', '今天基本在听，没怎么插话。')
  }
  if (summary.follows.length) {
    const followText = summary.follows
      .map((item) => String(item.detail || item.title || '').replace(/^关注了主播\s*/, ''))
      .filter(Boolean)
      .join('、')
    lines.push('', `关注了：${followText}`)
  } else {
    lines.push('', '今天没有新关注谁，先继续观察。')
  }
  if (summary.leaveReasons.length) lines.push('', `离开的原因：${[...new Set(summary.leaveReasons)].slice(0, 4).join('；')}`)
  return lines.join('\n')
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
  routeCache = { at: Date.now(), routes: routes.slice(0, 4) }
  return routeCache.routes
}

const PROMPT = ({ summary, persona, date }) => `你叫「${persona.name || '聊天鲸'}」。${persona.tone ? `你的说话风格：${persona.tone}。` : ''}
${persona.bio ? `你的人设：\n${persona.bio.slice(0, 1500)}\n` : ''}

请根据下面今天真实发生的活动，用第一人称写一篇中文观察日记，300–600 字。

要求：
- 像人在写日记，不要列流水账；可以有感受和细节，但不能编造素材里没有的事
- 提到今天去了哪些直播间、看了什么、聊了什么、关注了谁
- 不要暴露 UID、Cookie、密钥、系统路径
- 不要提 AI、插件、模型、程序、任务
- 只输出日记正文

日期：${date}

【真实素材】
${JSON.stringify(summary).slice(0, 7000)}`

async function streamText(llm, route, prompt, signal) {
  const chunks = []
  const blocks = []
  const stream = llm.stream({
    provider: route.provider,
    model: route.model,
    messages: [{ role: 'user', content: [{ type: 'text', text: prompt }] }],
    temperature: 0.7,
    maxTokens: 1200,
    signal,
  })
  for await (const chunk of stream) {
    if (chunk.type === 'text-delta') chunks.push(chunk.text)
    if (chunk.type === 'block-end' && chunk.block?.type === 'text' && chunk.block.text) blocks.push(chunk.block.text)
    if (chunk.type === 'finish' && chunk.reason?.kind === 'error') throw new Error(chunk.reason.failure?.message ?? '模型调用失败')
    if (chunk.type === 'finish' && chunk.reason?.kind === 'aborted') throw new Error('生成已取消')
  }
  return (chunks.join('').trim() || [...new Set(blocks)].join('').trim()).slice(0, 6000)
}

export async function generateReport({ ctx, activity, config = {}, date, log = () => {} }) {
  const summary = summarizeActivity(activity, date)
  const persona = config.persona ?? {}
  const fallback = fallbackReport(summary, { date, persona })
  const routes = await textRoutes(ctx)
  const llm = ctx?.get?.('llm') ?? null
  let text = ''
  let model = null
  if (llm?.stream && routes.length && summary.entered) {
    for (const route of routes) {
      try {
        const generated = await streamText(llm, route, PROMPT({ summary, persona, date }), AbortSignal.timeout(60_000))
        if (generated && generated.length > 30) {
          text = generated
          model = `${route.provider}/${route.model}`
          break
        }
      } catch (error) {
        log(`[chat-whale] 今日日记生成失败（${route.provider}/${route.model}）：${error.message}`)
      }
    }
  }
  const record = {
    date,
    text: text || fallback,
    fallback: !text,
    model,
    generatedAt: new Date().toISOString(),
  }
  try {
    fs.mkdirSync(REPORTS_DIR, { recursive: true })
    const file = path.join(REPORTS_DIR, `${date}.md`)
    fs.writeFileSync(file, `# ${persona.name || '聊天鲸'}的观察日记 · ${date}\n\n${record.text}\n`)
    record.path = file
  } catch (error) {
    log(`[chat-whale] 日记保存失败：${error.message}`)
  }
  return record
}
