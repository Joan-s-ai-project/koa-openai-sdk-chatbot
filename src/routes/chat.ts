import Router from 'koa-router'
import { chat, stream } from '../controllers/chat.controller'

const router = new Router()

/** 非流式聊天 */
router.post('/api/chat', chat)

/** 流式聊天 (SSE) */
router.post('/api/chat/stream', stream)

export default router
