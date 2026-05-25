import Router from 'koa-router'
import multer from '@koa/multer'
import { chat, stream, chatCompletion, getModels, listHistory, getHistory, deleteHistory } from '../controllers/chat.controller'
import { uploadFile } from '../controllers/upload.controller'

const router = new Router()

/** multer：文件存内存，100MB 兜底限制 */
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 100 * 1024 * 1024 },
})

router.get('/', (ctx) => {
  ctx.body = 'hello world'
})

/** 可用模型列表 */
router.get('/api/models', getModels)

/** 非流式聊天 */
router.post('/api/chat', chat)

/** 流式聊天 (SSE) */
router.post('/api/chat/stream', stream)

/** 自定义聊天补全 */
router.post('/api/v1/chat/completion', chatCompletion)

/** 历史会话列表 */
router.get('/api/history', listHistory)

/** 单个会话详情 */
router.get('/api/history/:id', getHistory)

/** 删除会话 */
router.delete('/api/history/:id', deleteHistory)

/** 文件上传（图片转 base64 / 文档提取文本） */
router.post('/api/v1/upload', upload.single('file'), uploadFile)

export default router
