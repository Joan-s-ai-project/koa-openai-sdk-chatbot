import { createProvider, type Provider } from '../llm'
import { contextService } from './context.service'
import { jsonlStorage, traceStorage } from '../utils/jsonl-storage'
import { parseSSEStream } from '../utils/sse'
import { TOOL_DEFINITIONS, dispatchTool, buildToolStartEvent } from '../tools'

const MAX_TOOL_ROUNDS = 100

// ─── 类型 ──────────────────────────────────────────────────────────────

export interface Attachment {
  type: 'image' | 'document'
  name: string
  content?: string   // 文档提取的纯文本
  dataUrl?: string   // 图片 base64 data URL
}

export interface AgentRunInput {
  sessionId: string
  message: string
  images?: string[]
  attachments?: Attachment[]
  model?: string
  temperature?: number
}

/**
 * Agent 对外 yield 的事件类型。
 * 控制器只负责把它原样写进 SSE 流。
 */
export type AgentEvent =
  | { type: 'reasoning'; content: string }
  | { type: 'content'; content: string }
  | { type: 'tool_result'; name: string; result: string;[k: string]: any }
  | { type: 'done'; model: string; usage?: any; cost?: any }
  | { type: 'error'; code?: number | string; message: string }
  // tool 开始执行的事件（searching / bash_running / ...），由 buildToolStartEvent 决定
  | { type: string;[k: string]: any }

/** Tool call 流式分片累加器 */
interface ToolCallEntry {
  id: string
  name: string
  argumentsRaw: string
  extraContent?: any
}

/**
 * 收集 LLM 流式 tool_calls 分片
 *
 * 兼容两种上游：
 *  - 标准 OpenAI 协议：分片用 index 关联，首个 chunk 带 id/name
 *  - Gemini：并行 tool call 每个都有独立 id，但后续分片可能只有 index 没 id
 */
class ToolCallCollector {
  private byId = new Map<string, ToolCallEntry>()
  private indexToId = new Map<number, string>()

  ingest(deltas: any[]): void {
    for (const d of deltas) {
      const id: string | undefined = d.id
      const index: number = d.index ?? 0

      if (id) {
        if (!this.byId.has(id)) this.byId.set(id, { id, name: '', argumentsRaw: '' })
        this.indexToId.set(index, id)
        this.update(id, d)
      } else {
        const mapped = this.indexToId.get(index)
        if (mapped) this.update(mapped, d)
      }
    }
  }

  private update(id: string, d: any): void {
    const entry = this.byId.get(id)!
    if (d.function?.name) entry.name = d.function.name
    if (d.function?.arguments) entry.argumentsRaw += d.function.arguments
    if (d.extra_content) entry.extraContent = d.extra_content
  }

  /** 取出有效的 tool calls（id 或 name 至少一个非空） */
  collect(): ToolCallEntry[] {
    return [...this.byId.values()].filter(tc => tc.id || tc.name)
  }
}

// ─── 私有：本轮流处理结果 ─────────────────────────────────────────────

interface RoundResult {
  assistantContent: string
  reasoning: string
  finishReason: string | null
  toolCalls: ToolCallEntry[]
  usage: any | null
  model: string | null
}

// ─── 私有：从 fetch error response 提取 code/message ──────────────────

async function parseUpstreamError(response: Response): Promise<{ code: number | string; message: string }> {
  const errorText = await response.text()
  let code: number | string = response.status
  let message = `API 请求失败 (${response.status})`
  try {
    const json = JSON.parse(errorText)
    const errObj = Array.isArray(json) ? json[0]?.error : json?.error
    if (errObj) {
      code = errObj.code ?? response.status
      message = (errObj.message as string)?.split('\n')[0] || message
    }
  } catch { /* 非 JSON */ }
  console.error(`[agent] upstream error (${response.status}):`, errorText)
  return { code, message }
}

// ─── Agent 主流程 ──────────────────────────────────────────────────────

/**
 * 一次完整的 agent 运行：负责
 *  - 调用 LLM Provider
 *  - 多轮 tool 循环（直到模型不再调用工具）
 *  - 持久化 user / assistant / tool 消息 + trace
 *  - 更新内存上下文
 *  - 通过 yield 把所有"该让前端知道的事"暴露出去
 *
 * 不感知 HTTP / SSE 协议；控制器负责把事件序列化写出。
 */
export async function* runAgent(input: AgentRunInput): AsyncGenerator<AgentEvent> {
  const { sessionId, message, images, attachments, model, temperature } = input

  const provider = createProvider({ model })

  if (!provider.headers['Authorization'] || provider.headers['Authorization'] === 'Bearer ') {
    yield { type: 'error', code: 401, message: '未配置 API_KEY' }
    return
  }

  // 构建首轮上下文 + 持久化 user 消息
  const userMessage = buildUserMessage(provider, message, images, attachments)
  const msgs: any[] = [...contextService.getMessages(sessionId), userMessage]
  const userEntry: any = { role: 'user', content: message, createdAt: Date.now() }
  if (images && images.length > 0) userEntry.images = images
  if (attachments && attachments.length > 0) userEntry.attachments = attachments.map(a => ({
    type: a.type,
    name: a.name,
    ...(a.type === 'image' && a.dataUrl ? { dataUrl: a.dataUrl } : {}),
  }))
  jsonlStorage.append(sessionId, userEntry)

  let fullContent = ''
  let lastUsage: any = null
  let lastModel = model || process.env.DEFAULT_MODEL || ''

  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    console.log(`[agent] round ${round + 1}, messages: ${msgs.length}`)

    // 1) 发起本轮请求
    const requestBody = provider.buildRequestBody({
      messages: msgs,
      model: lastModel,
      temperature: temperature ?? 0.7,
      tools: TOOL_DEFINITIONS,
      toolChoice: 'auto',
      stream: true,
      streamOptions: { include_usage: true },
    })
    traceStorage.append(sessionId, requestBody)

    const response = await fetch(provider.apiUrl, {
      method: 'POST',
      headers: provider.headers,
      body: JSON.stringify(requestBody),
    })

    if (!response.ok || !response.body) {
      const err = await parseUpstreamError(response)
      yield { type: 'error', ...err }
      return
    }

    // 2) 消费本轮流，沿途 yield reasoning/content
    const round$ = consumeRound(response.body, provider, sessionId)
    let result: RoundResult | null = null
    for await (const ev of round$) {
      if (ev.kind === 'event') {
        yield ev.event
        if (ev.event.type === 'content') fullContent += ev.event.content
      } else {
        result = ev.result
      }
    }
    if (!result) break // 不该发生，安全退出

    if (result.usage) lastUsage = result.usage
    if (result.model) lastModel = result.model

    // 3) 有 tool call → 执行 tool → 进入下一轮
    if (result.toolCalls.length > 0) {
      yield* runToolRound(sessionId, msgs, lastModel, result)
      continue
    }

    // 4) 正常结束：写入最终 assistant 消息
    persistAssistantMessage(sessionId, lastModel, result.assistantContent, result.reasoning)
    console.log(`[agent] finished, reason=${result.finishReason}, content=${fullContent.length} chars`)
    break
  }

  // 5) 收尾：成本 + 内存上下文 + done 事件
  const costData = lastUsage ? provider.calcCost(lastUsage, lastModel) : null
  syncContext(sessionId, message, fullContent)

  const doneEvent: AgentEvent = { type: 'done', model: lastModel, ...(costData ?? {}) }
  jsonlStorage.append(sessionId, doneEvent as any)
  yield doneEvent
}

// ─── 私有：单轮流处理 ─────────────────────────────────────────────────

type RoundYield =
  | { kind: 'event'; event: AgentEvent }
  | { kind: 'final'; result: RoundResult }

/**
 * 消费一轮上游 SSE 流。沿途 yield reasoning/content 事件，
 * 结束时 yield 一个 final，包含本轮聚合状态供调用方决定后续动作。
 */
async function* consumeRound(
  body: ReadableStream<Uint8Array>,
  provider: Provider,
  sessionId: string,
): AsyncGenerator<RoundYield> {
  const collector = new ToolCallCollector()
  let assistantContent = ''
  let reasoning = ''
  let finishReason: string | null = null
  let usage: any = null
  let modelName: string | null = null

  for await (const parsed of parseSSEStream(body)) {
    console.log(`[agent] raw chunk:`, JSON.stringify(parsed))
    traceStorage.append(sessionId, parsed)

    const r = provider.parseChunk(parsed)
    if (r.usage) usage = r.usage
    if (r.model) modelName = r.model
    if (r.finishReason) finishReason = r.finishReason

    if (r.delta.reasoning) {
      reasoning += r.delta.reasoning
      yield { kind: 'event', event: { type: 'reasoning', content: r.delta.reasoning } }
    }
    if (r.delta.content) {
      assistantContent += r.delta.content
      yield { kind: 'event', event: { type: 'content', content: r.delta.content } }
    }
    if (r.delta.toolCalls) collector.ingest(r.delta.toolCalls)
  }

  yield {
    kind: 'final',
    result: {
      assistantContent,
      reasoning,
      finishReason,
      toolCalls: collector.collect(),
      usage,
      model: modelName,
    },
  }
}

// ─── 私有：tool 轮 ────────────────────────────────────────────────────

/**
 * 执行 tool round：
 *  - 落盘本轮 assistant tool_calls 消息
 *  - 把 tool_calls 推回 msgs（保持 reasoning / extra_content 原样回传）
 *  - 按 registry 分发执行每个 tool
 *  - 把 tool 结果写入 msgs + JSONL，并 yield 给前端
 */
async function* runToolRound(
  sessionId: string,
  msgs: any[],
  model: string,
  round: RoundResult,
): AsyncGenerator<AgentEvent> {
  console.log(
    `[agent] tool calls (finishReason=${round.finishReason}):`,
    round.toolCalls.map(tc => `${tc.name}(${tc.argumentsRaw})`),
  )

  // 1) 持久化本轮 assistant 消息（带 reasoning + tool_calls）
  jsonlStorage.append(sessionId, {
    role: 'assistant',
    content: round.assistantContent || null,
    createdAt: Date.now(),
    model,
    ...(round.reasoning ? { reasoning: round.reasoning } : {}),
    tool_calls: round.toolCalls.map(tc => ({
      id: tc.id,
      type: 'function',
      function: { name: tc.name, arguments: tc.argumentsRaw },
    })),
  })

  // 2) 推回上下文（带上 reasoning_content 和 extra_content，部分 provider 必需）
  msgs.push({
    role: 'assistant',
    content: round.assistantContent || null,
    ...(round.reasoning ? { reasoning_content: round.reasoning } : {}),
    tool_calls: round.toolCalls.map(tc => ({
      id: tc.id,
      type: 'function',
      function: { name: tc.name, arguments: tc.argumentsRaw },
      ...(tc.extraContent ? { extra_content: tc.extraContent } : {}),
    })),
  })

  // 3) 逐个执行
  for (const tc of round.toolCalls) {
    const args = safeParseJSON(tc.argumentsRaw)

    yield buildToolStartEvent(tc.name, args) as AgentEvent
    console.log(`[agent] executing tool "${tc.name}" with args:`, args)

    const result = await dispatchTool(tc.name, args, { sessionId })
    console.log(`[agent] tool "${tc.name}" result length: ${result.text.length}`)

    jsonlStorage.append(sessionId, {
      role: 'tool',
      tool_call_id: tc.id,
      name: tc.name,
      content: result.display,
      createdAt: Date.now(),
    })

    msgs.push({ role: 'tool', tool_call_id: tc.id, content: result.text })

    yield { type: 'tool_result', name: tc.name, ...args, result: result.display }
  }
}

// ─── 私有：辅助函数 ───────────────────────────────────────────────────

function buildUserMessage(provider: Provider, message: string, images?: string[], attachments?: Attachment[]): any {
  // 合并所有图片来源：直传 images + 图片附件的 dataUrl
  const allImages: string[] = [
    ...(images || []),
    ...(attachments?.filter(a => a.type === 'image' && a.dataUrl).map(a => a.dataUrl!) || []),
  ]

  // 文档附件：用 XML 标签包裹注入，让模型明确区分附件来源
  const docParts = attachments
    ?.filter(a => a.type === 'document' && a.content)
    .map(a => `<file name="${a.name}">\n${a.content}\n</file>`) ?? []

  const fullText = docParts.length > 0
    ? `${docParts.join('\n\n')}\n\n---\n\n${message}`
    : message

  if (allImages.length > 0) {
    return { role: 'user', content: provider.buildMultimodalContent(fullText, allImages) }
  }
  return { role: 'user', content: fullText }
}

function persistAssistantMessage(sessionId: string, model: string, content: string, reasoning: string): void {
  const entry: any = { role: 'assistant', content, createdAt: Date.now(), model }
  if (reasoning) entry.reasoning = reasoning
  jsonlStorage.append(sessionId, entry)
}

function syncContext(sessionId: string, userMsg: string, assistantMsg: string): void {
  const ctxMessages = contextService.getMessages(sessionId)
  const now = Date.now()
  ctxMessages.push({ role: 'user', content: userMsg, createdAt: now })
  ctxMessages.push({ role: 'assistant', content: assistantMsg, createdAt: now })
}

function safeParseJSON(raw: string): Record<string, any> {
  try { return JSON.parse(raw) } catch { return {} }
}
