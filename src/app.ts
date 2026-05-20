import { config } from 'dotenv'
config({ override: true })  // 强制用 .env 覆盖系统环境变量

import Koa from 'koa'
import bodyParser from 'koa-bodyparser'
import chatRouter from './routes/chat'
import { errorHandler } from './middlewares/errorHandler'

const app = new Koa()
const PORT = process.env.PORT || 3000

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
