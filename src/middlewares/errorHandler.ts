import type Koa from 'koa'

/**
 * 全局错误处理中间件
 * 捕获所有 controller/service 抛出的异常，返回标准 JSON 格式
 */
export async function errorHandler(ctx: Koa.Context, next: Koa.Next) {
  try {
    await next()
  } catch (err: any) {
    const status = err.status || 500
    const code = status === 400 ? 'INVALID_REQUEST'
      : status === 502 ? 'OPENAI_ERROR'
      : 'INTERNAL_ERROR'

    ctx.status = status
    ctx.body = {
      error: {
        code,
        message: err.message || '服务器内部错误',
        status
      }
    }

    // 打印到控制台方便调试
    console.error(`[${code}]`, err.message)
  }
}
