import Router from 'koa-router'
import { chat, stream, listHistory, getHistory } from '../controllers/chat.controller'

const router = new Router()

router.get('/', (ctx) => {
  ctx.body = 'hello world'
})

/** 非流式聊天 */
router.post('/api/chat', chat)

/** 流式聊天 (SSE) */
router.post('/api/chat/stream', stream)

/** 历史会话列表 */
router.get('/api/history', listHistory)

/** 单个会话详情 */
router.get('/api/history/:id', getHistory)

export default router
