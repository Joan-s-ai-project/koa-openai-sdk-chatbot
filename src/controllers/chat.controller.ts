import type Koa from 'koa'
import { PassThrough } from 'stream'
import { llmService } from '../services/llm.service'
import { contextService } from '../services/context.service'
import { runAgent } from '../services/agent.service'
import * as historyService from '../services/history.service'
import { getAvailableModels } from '../llm'
import { SSEWriter } from '../utils/sse'
import type { ChatRequestBody } from '../types/chat'

/**
 * 聊天控制器 — 只做 HTTP 适配：
 *   1. 解析 + 校验请求体
 *   2. 设置响应头 / 状态码
 *   3. 把 service 产出的事件序列化写入响应流
 *   4. 把 service 错误映射成 HTTP 错误
 *
 * 业务逻辑（多轮 tool 循环、持久化、上下文）都在 services 里。
 */

/** 给所有 SSE 接口的统一响应头 */
function prepareSSE(ctx: Koa.Context): SSEWriter {
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
  return new SSEWriter(passthrough)
}

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

/** POST /api/chat/stream — 流式聊天 (SSE，OpenAI SDK 简化路径) */
export async function stream(ctx: Koa.Context) {
  const { sessionId, message, model, temperature, reasoning_split } = ctx.request.body as ChatRequestBody
  if (!message) ctx.throw(400, '缺少 message 字段')

  const history = contextService.getMessages(sessionId)
  const messages = [...history, { role: 'user' as const, content: message }]

  const sse = prepareSSE(ctx)

    ; (async () => {
      let fullContent = ''
      try {
        const stream = llmService.chatStream(messages, { model, temperature, reasoning_split })
        for await (const chunk of stream) {
          sse.send(chunk)
          if (chunk.type === 'content') fullContent += chunk.content
        }
        contextService.addExchange(sessionId, message, fullContent)
      } finally {
        sse.end()
      }
    })()
}

/** POST /api/v1/chat/completion — 多 Provider 流式聊天（含 Agent Tool 循环） */
export async function chatCompletion(ctx: Koa.Context) {
  const body = ctx.request.body as ChatRequestBody
  const { sessionId, message, model, temperature, images } = body

  if (!message && (!images || images.length === 0)) ctx.throw(400, '缺少 message 字段')

  const sse = prepareSSE(ctx)

    ; (async () => {
      try {
        for await (const event of runAgent({ sessionId, message, images, model, temperature })) {
          sse.send(event)
        }
        sse.raw('event: close')
      } catch (err: any) {
        console.error('[chatCompletion] unexpected error:', err.message, err.cause || '', err.stack)
        sse.send({ type: 'error', message: err.message })
      } finally {
        sse.end()
      }
    })()
}

/** GET /api/models — 可用模型列表 */
export async function getModels(ctx: Koa.Context) {
  ctx.body = getAvailableModels()
}

/** GET /api/history — 历史会话列表 */
export async function listHistory(ctx: Koa.Context) {
  ctx.body = historyService.listConversations()
}

/** GET /api/history/:id — 单个会话详情 */
export async function getHistory(ctx: Koa.Context) {
  const messages = historyService.getConversation(ctx.params.id)
  if (!messages) ctx.throw(404, '会话不存在')
  ctx.body = messages
}

/** DELETE /api/history/:id — 删除会话 */
export async function deleteHistory(ctx: Koa.Context) {
  const { existed, deleted } = historyService.deleteConversation(ctx.params.id)
  if (!existed) ctx.throw(404, '会话不存在')
  ctx.body = { success: deleted, message: deleted ? '删除成功' : '删除失败' }
}
