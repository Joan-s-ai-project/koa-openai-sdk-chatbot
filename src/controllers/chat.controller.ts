import type Koa from 'koa'
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

/** POST /api/chat/stream — 流式聊天（占位，Step 3 实现） */
export async function stream(ctx: Koa.Context) {
  ctx.body = { message: 'chat stream endpoint - coming in Step 3' }
}
