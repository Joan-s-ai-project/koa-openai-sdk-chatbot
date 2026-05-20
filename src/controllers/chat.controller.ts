import type Koa from 'koa'
import { PassThrough } from 'stream'
import { llmService } from '../services/llm.service'
import { contextService } from '../services/context.service'
import { jsonlStorage } from '../services/jsonl-storage'
import { tavilySearch } from '../services/tavily.service'
import { createProvider, getAvailableModels } from '../services/llm-provider'
import type { ChatRequestBody } from '../types/chat'

/**
 * 聊天控制器
 */

/** POST /api/chat — 非流式聊天 */
export async function chat(ctx: Koa.Context) {
  const { sessionId, message, model, temperature } = ctx.request.body as ChatRequestBody

  if (!message) ctx.throw(400, '缺少 message 字段')

  // 获取上下文 + 拼接当前消息
  const history = contextService.getMessages(sessionId)
  const messages = [...history, { role: 'user' as const, content: message }]

  const result = await llmService.chat(messages, { model, temperature })

  // 更新上下文
  contextService.addExchange(sessionId, message, result.content)

  ctx.body = result
}

/** POST /api/chat/stream — 流式聊天 (SSE) */
export async function stream(ctx: Koa.Context) {
  const { sessionId, message, model, temperature, reasoning_split } = ctx.request.body as ChatRequestBody

  if (!message) ctx.throw(400, '缺少 message 字段')

  // 获取上下文 + 拼接当前消息
  const history = contextService.getMessages(sessionId)
  const messages = [...history, { role: 'user' as const, content: message }]

  // 设置 SSE 响应头
  ctx.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no',  // 禁用 Nginx/代理层缓冲
  })
  ctx.compress = false  // 禁用 Koa 压缩（如果有的话）

  const passthrough = new PassThrough()
  ctx.status = 200
  ctx.body = passthrough

  const stream = await llmService.chatStream(messages, { model, temperature, reasoning_split });

  // 流式写入
  ; (async () => {
    let fullContent = ''
    for await (const chunk of stream) {
      passthrough.write(`data: ${JSON.stringify(chunk)}\n\n`)
      if (chunk.type === 'content') fullContent += chunk.content
    }

    // 流结束后更新上下文
    contextService.addExchange(sessionId, message, fullContent)

    passthrough.end()
  })()
}

/** POST /api/v1/chat/completion — 自定义聊天补全 */
export async function chatCompletion(ctx: Koa.Context) {
  // 设置 SSE 响应头
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

  // 创建 LLM Provider（自动根据环境配置选择 MiniMax / Gemini / DeepSeek）
  const provider = createProvider({ model })

  // 获取上下文 + 拼接当前消息
  const history = contextService.getMessages(sessionId)

  // 构建用户消息：如果有图片则使用多模态 content 格式
  let userMessage: any
  if (images && images.length > 0) {
    userMessage = { role: 'user', content: provider.buildMultimodalContent(message, images) }
  } else {
    userMessage = { role: 'user', content: message }
  }

  const messages = [...history, userMessage]

  if (!provider.headers['Authorization'] || provider.headers['Authorization'] === 'Bearer ') {
    ctx.status = 401
    ctx.body = { error: { code: 401, message: '未配置 API_KEY' } }
    return
  }

  // tool 声明
  const TOOLS = [
    {
      type: 'function',
      function: {
        name: 'search_web',
        description: '当问题涉及实时信息、近期新闻、最新数据或你的训练数据截止日期之后的内容时，使用此工具搜索互联网获取最新资讯。',
        parameters: {
          type: 'object',
          properties: {
            query: { type: 'string', description: '要搜索的关键词或问题，尽量简洁精准' },
          },
          required: ['query'],
        },
      },
    },
  ]

  const MAX_TOOL_ROUNDS = 10
  const msgs: any[] = [...messages]

  // 先把 user 消息写入 jsonl
  jsonlStorage.append(sessionId, { role: 'user', content: message, createdAt: Date.now() })

    ; (async () => {
      let fullContent = ''
      let fullReasoning = ''
      let lastUsage: any = null
      let lastModel = model || process.env.DEFAULT_MODEL || ''

      const toolActivities: { toolCallId: string; toolName: string; input: Record<string, any>; result?: string }[] = []

      try {
        for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
          console.log(`[chatCompletion] Round ${round + 1}, messages count: ${msgs.length}`)

          // 使用 Provider 构建请求体
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

            // 解析错误信息，只取 code 和 message 返回前端
            let errCode: number | string = response.status
            let errMessage = `API 请求失败 (${response.status})`
            try {
              const errJson = JSON.parse(errorText)
              const errObj = Array.isArray(errJson) ? errJson[0]?.error : errJson?.error
              if (errObj) {
                errCode = errObj.code ?? response.status
                // message 只取第一行（Gemini 的 message 很长，截断到换行符前）
                errMessage = (errObj.message as string)?.split('\n')[0] || errMessage
              }
            } catch { /* 非 JSON，用默认值 */ }

            passthrough.write(`data: ${JSON.stringify({ type: 'error', code: errCode, message: errMessage })}\n\n`)
            break
          }

          // 读取本轮流
          const reader = response.body.getReader()
          const decoder = new TextDecoder()
          let buffer = ''
          let finishReason: string | null = null
          let assistantContent = ''
          // 用 Map<id, ...> 替代数组，解决 Gemini 并行 tool call 不返回 index 的问题
          const toolCallMap = new Map<string, { id: string; name: string; argumentsRaw: string; extraContent?: any }>()

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

                // 打印原始响应数据（调试用）
                console.log(`[chatCompletion] raw chunk:`, JSON.stringify(parsed))

                // 使用 Provider 统一解析 chunk
                const result = provider.parseChunk(parsed)

                if (result.usage) lastUsage = result.usage
                if (result.model) lastModel = result.model

                if (result.finishReason) finishReason = result.finishReason

                // reasoning
                if (result.delta.reasoning) {
                  fullReasoning += result.delta.reasoning
                  passthrough.write(`data: ${JSON.stringify({ type: 'reasoning', content: result.delta.reasoning })}\n\n`)
                }

                // content
                if (result.delta.content) {
                  assistantContent += result.delta.content
                  fullContent += result.delta.content
                  passthrough.write(`data: ${JSON.stringify({ type: 'content', content: result.delta.content })}\n\n`)
                }

                // tool_calls
                if (result.delta.toolCalls) {
                  for (const tcDelta of result.delta.toolCalls) {
                    // 优先用 id 作为 key；Gemini 并行 tool call 每个都有独立 id
                    // 对于流式分片（同一 tool call 的 arguments 分多个 chunk），id 只在首个 chunk 出现，
                    // 后续 chunk 用 index 关联——用临时 index→id 映射解决
                    const tcId = tcDelta.id
                    const tcIndex = tcDelta.index ?? 0

                    if (tcId) {
                      // 首个 chunk：有 id，建立条目
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
                      // 后续分片：无 id，通过 index 找到对应条目
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

          // 本轮结束：只要 accumulator 有 tool call 就触发（兼容 Gemini 用 stop 而非 tool_calls 结束的情况）
          const toolCallAccumulator = [...toolCallMap.values()]
          if (toolCallAccumulator.filter(tc => tc.id || tc.name).length > 0) {
            console.log(`[chatCompletion] Tool calls detected (finishReason=${finishReason}):`, toolCallAccumulator.map(tc => `${tc.name}(${tc.argumentsRaw})`))

            msgs.push({
              role: 'assistant',
              content: assistantContent || null,
              tool_calls: toolCallAccumulator.map(tc => ({
                id: tc.id,
                type: 'function',
                function: { name: tc.name, arguments: tc.argumentsRaw },
                // 回传 extra_content（Gemini 要求 thought_signature 原样带回）
                ...(tc.extraContent ? { extra_content: tc.extraContent } : {}),
              })),
            })

            for (const tc of toolCallAccumulator) {
              let query = ''
              try {
                query = JSON.parse(tc.argumentsRaw).query || ''
              } catch {
                query = tc.argumentsRaw
              }

              passthrough.write(`data: ${JSON.stringify({ type: 'searching', query })}\n\n`)
              console.log(`[chatCompletion] Tavily searching: "${query}"`)

              let searchText = ''
              let searchDisplay = ''
              try {
                const result = await tavilySearch(query)
                searchText = result.text
                searchDisplay = result.display
                console.log(`[chatCompletion] Tavily result length: text=${searchText.length}, display=${searchDisplay.length}`)
              } catch (err: any) {
                console.error(`[chatCompletion] Tavily search failed:`, err.message, err.stack)
                searchText = `搜索失败：${err.message}`
                searchDisplay = searchText
              }

              msgs.push({ role: 'tool', tool_call_id: tc.id, content: searchText })

              toolActivities.push({
                toolCallId: tc.id,
                toolName: tc.name,
                input: { query },
                result: searchDisplay,
              })

              passthrough.write(`data: ${JSON.stringify({ type: 'tool_result', name: tc.name, query, result: searchDisplay })}\n\n`)
            }

            continue
          }

          // 正常结束
          console.log(`[chatCompletion] Stream finished, reason: ${finishReason}, content length: ${fullContent.length}`)
          break
        }

        // 写入 assistant 消息
        const aiEntry: any = {
          role: 'assistant',
          content: fullContent,
          createdAt: Date.now(),
          model: lastModel,
        }
        if (fullReasoning) aiEntry.reasoning = fullReasoning
        if (toolActivities.length > 0) aiEntry.toolActivities = toolActivities
        jsonlStorage.append(sessionId, aiEntry)

        // 内存上下文更新
        const ctxMessages = contextService.getMessages(sessionId)
        ctxMessages.push({ role: 'user', content: message, createdAt: Date.now() })
        ctxMessages.push({ role: 'assistant', content: fullContent, createdAt: Date.now() })

        // 发送 done 事件
        const costData = lastUsage ? provider.calcCost(lastUsage, lastModel) : {}
        passthrough.write(`data: ${JSON.stringify({ type: 'done', model: lastModel, ...costData })}\n\n`)
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
    // 取首条 user 消息作为标题
    const firstUserMsg = messages.find(m => m.role === 'user')
    const title = firstUserMsg?.content?.slice(0, 50) || '新会话'
    // 取首条消息的时间戳
    const createdAt = messages[0]?.createdAt || 0

    return {
      id,
      title,
      createdAt,
      messageCount: messages.length
    }
  })

  // 按创建时间倒序
  conversations.sort((a, b) => (b.createdAt as number) - (a.createdAt as number))

  ctx.body = conversations
}

/** GET /api/history/:id — 单个会话详情 */
export async function getHistory(ctx: Koa.Context) {
  const id = ctx.params.id

  if (!jsonlStorage.exists(id)) ctx.throw(404, '会话不存在')

  ctx.body = jsonlStorage.readAll(id)
}
