import type Koa from 'koa'
import { PassThrough } from 'stream'
import { llmService } from '../services/llm.service'
import { contextService } from '../services/context.service'
import { jsonlStorage } from '../services/jsonl-storage'
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
  const { sessionId, message, model, temperature } = ctx.request.body as ChatRequestBody

  if (!message) ctx.throw(400, '缺少 message 字段')

  // 获取上下文 + 拼接当前消息
  const history = contextService.getMessages(sessionId)
  const messages = [...history, { role: 'user' as const, content: message }]

  // 设置 SSE 响应头
  ctx.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
  })

  const passthrough = new PassThrough()
  ctx.status = 200
  ctx.body = passthrough

  // 流式写入
  ;(async () => {
    let fullContent = ''
    for await (const chunk of llmService.chatStream(messages, { model, temperature })) {
      passthrough.write(`data: ${JSON.stringify(chunk)}\n\n`)
      if (chunk.type === 'content') fullContent += chunk.content
    }

    // 流结束后更新上下文
    contextService.addExchange(sessionId, message, fullContent)

    passthrough.end()
  })()
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
    const createdAt = messages[0]?.ts || ''

    return {
      id,
      title,
      createdAt,
      messageCount: messages.length
    }
  })

  // 按创建时间倒序
  conversations.sort((a, b) => b.createdAt.localeCompare(a.createdAt))

  ctx.body = conversations
}

/** GET /api/history/:id — 单个会话详情 */
export async function getHistory(ctx: Koa.Context) {
  const id = ctx.params.id

  if (!jsonlStorage.exists(id)) ctx.throw(404, '会话不存在')

  ctx.body = jsonlStorage.readAll(id)
}
