import type Koa from 'koa'
import { PassThrough } from 'stream'
import { llmService } from '../services/llm.service'
import type { ChatRequestBody } from '../types/chat'

/**
 * 聊天控制器
 */

/** POST /api/chat — 非流式聊天 */
export async function chat(ctx: Koa.Context) {
  const { message, model, temperature } = ctx.request.body as ChatRequestBody

  console.log(ctx.request.body )

  if (!message) {
    ctx.status = 400
    ctx.body = { error: { code: 'INVALID_REQUEST', message: '缺少 message 字段', status: 400 } }
    return
  }

  // Step 2: 暂时不接上下文，直接单条消息发给 LLM
  const messages = [
    { role: 'user' as const, content: message }
  ]

  const result = await llmService.chat(messages, { model, temperature })
  ctx.body = result
}

/** POST /api/chat/stream — 流式聊天 (SSE) */
export async function stream(ctx: Koa.Context) {
  const { message, model, temperature } = ctx.request.body as ChatRequestBody

  if (!message) {
    ctx.status = 400
    ctx.body = { error: { code: 'INVALID_REQUEST', message: '缺少 message 字段', status: 400 } }
    return
  }

  // 暂时不接上下文，直接单条消息
  const messages = [
    { role: 'user' as const, content: message }
  ]

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
    for await (const chunk of llmService.chatStream(messages, { model, temperature })) {
      passthrough.write(`data: ${JSON.stringify(chunk)}\n\n`)
    }
    passthrough.end()
  })()
}
