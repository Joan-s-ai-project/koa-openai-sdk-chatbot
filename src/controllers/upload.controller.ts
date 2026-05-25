/**
 * 文件上传控制器
 *
 * POST /api/v1/upload
 * - 图片：转 base64 data URL 返回
 * - 文档：提取纯文本返回
 */

import type Koa from 'koa'
import { fileParserService } from '../services/file-parser.service'

const IMAGE_MIME_TYPES = new Set([
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
])

/** 文档提取文本最大字符数（约 10 万 token 以内） */
const MAX_TEXT_LENGTH = 100_000

interface MulterFile {
  originalname: string
  mimetype: string
  buffer: Buffer
  size: number
}

export async function uploadFile(ctx: Koa.Context) {
  const file = (ctx.request as any).file as MulterFile | undefined

  if (!file) {
    ctx.status = 400
    ctx.body = { error: { code: 'NO_FILE', message: '未收到文件' } }
    return
  }

  // multer 默认用 latin1 解析文件名，中文会乱码，需要重新解码为 UTF-8
  const originalname = Buffer.from(file.originalname, 'latin1').toString('utf8')
  const { mimetype, buffer } = file

  // ── 图片：直接转 base64 ──────────────────────────────────────────────
  if (IMAGE_MIME_TYPES.has(mimetype)) {
    const dataUrl = `data:${mimetype};base64,${buffer.toString('base64')}`
    ctx.body = {
      type: 'image',
      name: originalname,
      mimeType: mimetype,
      dataUrl,
    }
    return
  }

  // ── 文档：提取文本 ───────────────────────────────────────────────────
  try {
    let content = await fileParserService.parse(buffer, originalname)

    // 超长截断
    if (content.length > MAX_TEXT_LENGTH) {
      content = content.slice(0, MAX_TEXT_LENGTH) + '\n\n[内容过长，已截断至前 10 万字符]'
    }

    ctx.body = {
      type: 'document',
      name: originalname,
      mimeType: mimetype,
      content,
      charCount: content.length,
    }
  } catch (err: any) {
    console.error('[upload] parse error:', err.message)
    ctx.status = 422
    ctx.body = {
      error: {
        code: 'PARSE_FAILED',
        message: `文件解析失败: ${err.message}`,
      },
    }
  }
}
