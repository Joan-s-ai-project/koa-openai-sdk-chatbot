import type Koa from 'koa'

/**
 * 全局错误处理中间件
 * 捕获所有 controller/service 抛出的异常，返回标准 JSON 格式
 */
export async function errorHandler(ctx: Koa.Context, next: Koa.Next) {
  try {
    await next()
  } catch (err: any) {
    const status = err.status || err.statusCode || 500

    // 根据错误来源分类 code
    let code = 'INTERNAL_ERROR'
    if (status === 400) code = 'INVALID_REQUEST'
    else if (status === 404) code = 'NOT_FOUND'
    else if (status === 429) code = 'RATE_LIMIT'
    else if (err.message?.includes('OpenAI') || err.message?.includes('API')) code = 'OPENAI_ERROR'

    ctx.status = status
    ctx.body = {
      error: {
        code,
        message: err.message || '服务器内部错误',
        status
      }
    }

    console.error(`[${code}] ${ctx.method} ${ctx.path} →`, err.message)
  }
}
