import type Koa from 'koa'

/**
 * 聊天控制器 — 占位，后续 Step 接入 Service
 */

/** POST /api/chat — 非流式（占位） */
export async function chat(ctx: Koa.Context) {
  ctx.body = { message: 'chat endpoint - coming soon' }
}

/** POST /api/chat/stream — 流式（占位） */
export async function stream(ctx: Koa.Context) {
  ctx.body = { message: 'chat stream endpoint - coming soon' }
}
