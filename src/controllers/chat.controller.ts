import type Koa from 'koa'
import { PassThrough } from 'stream'
import { llmService } from '../services/llm.service'
import { contextService } from '../services/context.service'
import { jsonlStorage, traceStorage } from '../utils/jsonl-storage'
import { createProvider, getAvailableModels } from '../services/llm-provider'
import * as tavilyTool from '../tools/tavily.tool'
import * as bashTool from '../tools/bash.tool'
import type { ChatRequestBody } from '../types/chat'

// Agent 可用工具列表 — 新增 tool 在这里加一行
const TOOLS = [tavilyTool.definition, bashTool.definition]

interface ToolCallAccumulator { id: string; name: string; argumentsRaw: string; extraContent?: any }
interface ToolActivity { toolCallId: string; toolName: string; input: Record<string, any>; result?: string }

/**
 * 聊天控制器
 */

/** POST /api/chat — 非流式聊天 */
export async function chat(ctx: Koa.Context) {
  const { sessionId, message, model, temperature } = ctx.request.body as ChatRequestBody

  if (!message) ctx.throw(400, '缺少 message 字段')

  const history = contextService.getMessages(sessionId)
  const messages = [...history, { role: 'user' as const, content: message }]

  const result = await llmService.chat(messages, { model, temperature })

  contextService.addExchange(sessionId, message, result.content)

  ctx.body = result
}

/** POST /api/chat/stream — 流式聊天 (SSE) */
export async function stream(ctx: Koa.Context) {
  const { sessionId, message, model, temperature, reasoning_split } = ctx.request.body as ChatRequestBody

  if (!message) ctx.throw(400, '缺少 message 字段')

  const history = contextService.getMessages(sessionId)
  const messages = [...history, { role: 'user' as const, content: message }]

  ctx.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no',
  })
  ctx.compress = false

  const passthrough = new PassThrough()
  ctx.status = 200
  ctx.body = passthrough

  const streamGen = await llmService.chatStream(messages, { model, temperature, reasoning_split })

    ; (async () => {
      let fullContent = ''
      for await (const chunk of streamGen) {
        passthrough.write(`data: ${JSON.stringify(chunk)}\n\n`)
        if (chunk.type === 'content') fullContent += chunk.content
      }
      contextService.addExchange(sessionId, message, fullContent)
      passthrough.end()
    })()
}

/** POST /api/v1/chat/completion — 多 Provider 流式聊天（含 Agent Tool 循环） */
export async function chatCompletion(ctx: Koa.Context) {
  ctx.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no',
  })
  ctx.compress = false

  const passthrough = new PassThrough()
  ctx.status = 200
  ctx.body = passthrough

  const body = ctx.request.body as ChatRequestBody
  const { sessionId, message, model, temperature, images } = body

  if (!message && (!images || images.length === 0)) ctx.throw(400, '缺少 message 字段')

  const provider = createProvider({ model })

  if (!provider.headers['Authorization'] || provider.headers['Authorization'] === 'Bearer ') {
    ctx.status = 401
    ctx.body = { error: { code: 401, message: '未配置 API_KEY' } }
    return
  }

  const history = contextService.getMessages(sessionId)

  // 构建用户消息（支持多模态）
  const userMessage: any = (images && images.length > 0)
    ? { role: 'user', content: provider.buildMultimodalContent(message, images) }
    : { role: 'user', content: message }

  const msgs: any[] = [...history, userMessage]

  // 写入 user 消息到 JSONL
  jsonlStorage.append(sessionId, { role: 'user', content: message, createdAt: Date.now() })

    ; (async () => {
      let fullContent = ''
      let lastUsage: any = null
      let lastModel = model || process.env.DEFAULT_MODEL || ''

      const MAX_TOOL_ROUNDS = 100

      try {
        for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
          console.log(`[chatCompletion] Round ${round + 1}, messages: ${msgs.length}`)

          const requestBody = provider.buildRequestBody({
            messages: msgs,
            model: lastModel,
            temperature: temperature ?? 0.7,
            tools: TOOLS,
            toolChoice: 'auto',
            stream: true,
            streamOptions: { include_usage: true },
          })

          const response = await fetch(provider.apiUrl, {
            method: 'POST',
            headers: provider.headers,
            body: JSON.stringify(requestBody),
          })

          if (!response.ok || !response.body) {
            const errorText = await response.text()
            console.error(`[chatCompletion] API error (${response.status}):`, errorText)

            let errCode: number | string = response.status
            let errMessage = `API 请求失败 (${response.status})`
            try {
              const errJson = JSON.parse(errorText)
              const errObj = Array.isArray(errJson) ? errJson[0]?.error : errJson?.error
              if (errObj) {
                errCode = errObj.code ?? response.status
                errMessage = (errObj.message as string)?.split('\n')[0] || errMessage
              }
            } catch { /* 非 JSON，用默认值 */ }

            passthrough.write(`data: ${JSON.stringify({ type: 'error', code: errCode, message: errMessage })}\n\n`)
            break
          }

          // 记录本轮请求 trace
          traceStorage.append(sessionId, requestBody)

          // ── 读取本轮流 ──────────────────────────────────────────────────
          const reader = response.body.getReader()
          const decoder = new TextDecoder()
          let buffer = ''
          let finishReason: string | null = null
          let assistantContent = ''
          let roundReasoning = ''

          // Map<id, accumulator>，兼容 Gemini 并行 tool call（无 index）
          const toolCallMap = new Map<string, ToolCallAccumulator>()

          while (true) {
            const { done, value } = await reader.read()
            if (done) break

            buffer += decoder.decode(value, { stream: true })
            const lines = buffer.split('\n')
            buffer = lines.pop() || ''

            for (const line of lines) {
              const trimmed = line.trim()
              if (!trimmed || !trimmed.startsWith('data:')) continue
              const dataStr = trimmed.slice(5).trim()
              if (dataStr === '[DONE]') continue

              try {
                const parsed = JSON.parse(dataStr)
                console.log(`[chatCompletion] raw chunk:`, JSON.stringify(parsed))

                traceStorage.append(sessionId, parsed)

                const result = provider.parseChunk(parsed)

                if (result.usage) lastUsage = result.usage
                if (result.model) lastModel = result.model
                if (result.finishReason) finishReason = result.finishReason

                // reasoning
                if (result.delta.reasoning) {
                  roundReasoning += result.delta.reasoning
                  passthrough.write(`data: ${JSON.stringify({ type: 'reasoning', content: result.delta.reasoning })}\n\n`)
                }

                // content
                if (result.delta.content) {
                  assistantContent += result.delta.content
                  fullContent += result.delta.content
                  passthrough.write(`data: ${JSON.stringify({ type: 'content', content: result.delta.content })}\n\n`)
                }

                // tool_calls 分片拼装
                if (result.delta.toolCalls) {
                  for (const tcDelta of result.delta.toolCalls) {
                    const tcId: string = tcDelta.id
                    const tcIndex: number = tcDelta.index ?? 0

                    if (tcId) {
                      if (!toolCallMap.has(tcId)) {
                        toolCallMap.set(tcId, { id: tcId, name: '', argumentsRaw: '' })
                      }
                      const entry = toolCallMap.get(tcId)!
                      if (tcDelta.function?.name) entry.name = tcDelta.function.name
                      if (tcDelta.function?.arguments) entry.argumentsRaw += tcDelta.function.arguments
                      if (tcDelta.extra_content) entry.extraContent = tcDelta.extra_content
                        // 记录 index→id 映射，供后续无 id 的分片使用
                        ; (toolCallMap as any)[`__idx_${tcIndex}`] = tcId
                    } else {
                      // 后续分片：通过 index 找到对应条目
                      const mappedId = (toolCallMap as any)[`__idx_${tcIndex}`]
                      if (mappedId && toolCallMap.has(mappedId)) {
                        const entry = toolCallMap.get(mappedId)!
                        if (tcDelta.function?.arguments) entry.argumentsRaw += tcDelta.function.arguments
                        if (tcDelta.extra_content) entry.extraContent = tcDelta.extra_content
                      }
                    }
                  }
                }
              } catch {
                // 忽略解析错误
              }
            }
          }

          // ── 本轮结束：判断是否有 tool call ──────────────────────────────
          const toolCallAccumulator = [...toolCallMap.values()].filter(tc => tc.id || tc.name)

          if (toolCallAccumulator.length > 0) {
            console.log(
              `[chatCompletion] Tool calls (finishReason=${finishReason}):`,
              toolCallAccumulator.map(tc => `${tc.name}(${tc.argumentsRaw})`),
            )

            // 写入本轮 assistant 消息（带 thinking 和 tool_calls）到 JSONL
            const assistantEntry: any = {
              role: 'assistant',
              content: assistantContent || null,
              createdAt: Date.now(),
              model: lastModel,
            }
            if (roundReasoning) assistantEntry.reasoning = roundReasoning
            assistantEntry.tool_calls = toolCallAccumulator.map(tc => ({
              id: tc.id,
              type: 'function',
              function: { name: tc.name, arguments: tc.argumentsRaw },
            }))
            jsonlStorage.append(sessionId, assistantEntry)

            // 将 assistant 的 tool_calls 消息追加到上下文
            msgs.push({
              role: 'assistant',
              content: assistantContent || null,
              ...(roundReasoning ? { reasoning_content: roundReasoning } : {}),
              tool_calls: toolCallAccumulator.map(tc => ({
                id: tc.id,
                type: 'function',
                function: { name: tc.name, arguments: tc.argumentsRaw },
                ...(tc.extraContent ? { extra_content: tc.extraContent } : {}),
              })),
            })

            // ── 逐个执行 tool，通过 registry 分发 ──────────────────────
            for (const tc of toolCallAccumulator) {
              let args: Record<string, any> = {}
              try {
                args = JSON.parse(tc.argumentsRaw)
              } catch {
                args = {}
              }

              // 通知前端：tool 开始执行
              const startEvent = buildToolStartEvent(tc.name, args)
              passthrough.write(`data: ${JSON.stringify(startEvent)}\n\n`)
              console.log(`[chatCompletion] Executing tool "${tc.name}" with args:`, args)

              let toolText = ''
              let toolDisplay = ''
              try {
                let result: { text: string; display: string }
                if (tc.name === 'search_web') {
                  result = await tavilyTool.execute(args as any)
                } else if (tc.name === 'run_bash') {
                  result = await bashTool.execute(args as any)
                } else {
                  result = { text: `未知工具：${tc.name}`, display: `⚠️ 未知工具：${tc.name}` }
                }
                toolText = result.text
                toolDisplay = result.display
                console.log(`[chatCompletion] Tool "${tc.name}" result length: ${toolText.length}`)
              } catch (err: any) {
                console.error(`[chatCompletion] Tool "${tc.name}" failed:`, err.message)
                toolText = `工具执行失败：${err.message}`
                toolDisplay = toolText
              }

              // 写入 tool 结果到 JSONL
              jsonlStorage.append(sessionId, {
                role: 'tool',
                tool_call_id: tc.id,
                name: tc.name,
                content: toolDisplay,
                createdAt: Date.now(),
              })

              // 将 tool 结果追加到上下文
              msgs.push({ role: 'tool', tool_call_id: tc.id, content: toolText })

              // 通知前端
              passthrough.write(`data: ${JSON.stringify({ type: 'tool_result', name: tc.name, ...args, result: toolDisplay })}\n\n`)
            }

            continue // 进入下一轮，让模型根据 tool 结果生成回答
          }

          // 正常结束：写入最后一轮 assistant 消息到 JSONL
          const finalAssistantEntry: any = {
            role: 'assistant',
            content: assistantContent,
            createdAt: Date.now(),
            model: lastModel,
          }
          if (roundReasoning) finalAssistantEntry.reasoning = roundReasoning
          jsonlStorage.append(sessionId, finalAssistantEntry)

          console.log(`[chatCompletion] Finished, reason: ${finishReason}, content: ${fullContent.length} chars`)
          break
        }

        // ── 写入 done 事件到 JSONL ──────────────────────────────────
        const costData = lastUsage ? provider.calcCost(lastUsage, lastModel) : null

        // 更新内存上下文
        const ctxMessages = contextService.getMessages(sessionId)
        ctxMessages.push({ role: 'user', content: message, createdAt: Date.now() })
        ctxMessages.push({ role: 'assistant', content: fullContent, createdAt: Date.now() })

        // 发送 done 事件
        const doneEvent: Record<string, any> = { type: 'done', model: lastModel, ...(costData ?? {}) }
        jsonlStorage.append(sessionId, doneEvent)
        passthrough.write(`data: ${JSON.stringify(doneEvent)}\n\n`)
        passthrough.write(`event: close\n\n`)
      } catch (err: any) {
        console.error(`[chatCompletion] Unexpected error:`, err.message, err.cause || '', err.stack)
        passthrough.write(`data: ${JSON.stringify({ type: 'error', message: err.message })}\n\n`)
      } finally {
        passthrough.end()
      }
    })()
}

/** GET /api/models — 可用模型列表 */
export async function getModels(ctx: Koa.Context) {
  ctx.body = getAvailableModels()
}

/** GET /api/history — 历史会话列表 */
export async function listHistory(ctx: Koa.Context) {
  const files = jsonlStorage.listFiles()

  const conversations = files.map(id => {
    const messages = jsonlStorage.readAll(id)
    const firstUserMsg = messages.find(m => m.role === 'user')
    const title = firstUserMsg?.content?.slice(0, 50) || '新会话'
    const createdAt = messages[0]?.createdAt || 0
    return { id, title, createdAt, messageCount: messages.length }
  })

  conversations.sort((a, b) => (b.createdAt as number) - (a.createdAt as number))
  ctx.body = conversations
}

/** GET /api/history/:id — 单个会话详情 */
export async function getHistory(ctx: Koa.Context) {
  const id = ctx.params.id
  if (!jsonlStorage.exists(id)) ctx.throw(404, '会话不存在')
  ctx.body = jsonlStorage.readAll(id)
}

/** DELETE /api/history/:id — 删除会话 */
export async function deleteHistory(ctx: Koa.Context) {
  const id = ctx.params.id
  if (!jsonlStorage.exists(id)) ctx.throw(404, '会话不存在')

  const deleted = jsonlStorage.delete(id)

  // 同时删除对应的 trace 文件（如果存在）
  if (traceStorage.exists(id)) {
    traceStorage.delete(id)
  }

  ctx.body = { success: deleted, message: deleted ? '删除成功' : '删除失败' }
}

// ─── 工具函数 ──────────────────────────────────────────────────────────────

/**
 * 根据 tool name 和 args 构建"开始执行"通知事件
 * 不同 tool 有不同的前端事件类型（search_web → searching，run_bash → bash_running）
 */
function buildToolStartEvent(name: string, args: Record<string, any>): Record<string, any> {
  switch (name) {
    case 'search_web':
      return { type: 'searching', query: args.query || '' }
    case 'run_bash':
      return { type: 'bash_running', command: args.command || '' }
    default:
      return { type: 'tool_running', name, args }
  }
}
