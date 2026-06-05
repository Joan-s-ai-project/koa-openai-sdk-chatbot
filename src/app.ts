import { config } from 'dotenv'
config({ override: true })  // 强制用 .env 覆盖系统环境变量

import Koa from 'koa'
import bodyParser from 'koa-bodyparser'
import serve from 'koa-static'
import * as path from 'path'
import chatRouter from './routes/chat'
import { errorHandler } from './middlewares/errorHandler'

const app = new Koa()
const PORT = process.env.PORT || 3000

// 沙箱静态文件服务：GET /sandbox/<sessionId>/screenshot_xxx.png
const SANDBOX_ROOT = process.env.BASH_SANDBOX_ROOT || path.join(process.cwd(), 'sandbox')
app.use(async (ctx, next) => {
  if (ctx.path.startsWith('/sandbox/')) {
    ctx.path = ctx.path.slice('/sandbox'.length)  // 去掉前缀，交给 serve 处理
    await serve(SANDBOX_ROOT, { maxAge: 0 })(ctx, next)
  } else {
    await next()
  }
})

// 中间件
app.use(errorHandler)
app.use(bodyParser({
  jsonLimit: '20mb',  // 支持 base64 图片上传
}))

// 路由
app.use(chatRouter.routes())
app.use(chatRouter.allowedMethods())

app.listen(PORT, () => {
  console.log(`Server is running on http://localhost:${PORT}`)
})
