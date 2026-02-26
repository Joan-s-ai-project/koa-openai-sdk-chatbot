import 'dotenv/config'
import Koa from 'koa'
import bodyParser from 'koa-bodyparser'
import chatRouter from './routes/chat'
import { errorHandler } from './middlewares/errorHandler'

const app = new Koa()
const PORT = process.env.PORT || 3000

// 中间件
app.use(errorHandler)
app.use(bodyParser())

// 路由
app.use(chatRouter.routes())
app.use(chatRouter.allowedMethods())

app.listen(PORT, () => {
  console.log(`Server is running on http://localhost:${PORT}`)
})
