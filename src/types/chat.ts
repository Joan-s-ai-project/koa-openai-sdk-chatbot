/**
 * 聊天消息类型
 */
export interface ChatMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
  createdAt?: number
  reasoning?: string
  model?: string
  toolActivities?: ToolActivity[]
}

/**
 * Tool 调用活动
 */
export interface ToolActivity {
  toolCallId: string
  toolName: string
  input: Record<string, any>
  result?: string
}

/**
 * Token 用量
 */
export interface TokenUsage {
  prompt_tokens: number
  completion_tokens: number
  total_tokens: number
}

/**
 * 流式 chunk 类型
 */
export type StreamChunk =
  | { type: 'reasoning'; content: string }
  | { type: 'content'; content: string }
  | { type: 'searching'; query: string }   // Tavily 搜索触发时通知前端
  | { type: 'done'; usage: TokenUsage }
  | { type: 'error'; message: string }

/**
 * 聊天请求 body
 */
export interface ChatRequestBody {
  sessionId: string
  message: string
  images?: string[]  // base64 data URL 格式的图片
  attachments?: Array<{
    type: 'image' | 'document'
    name: string
    content?: string   // 文档提取的纯文本
    dataUrl?: string   // 图片 base64 data URL
  }>
  model?: string
  temperature?: number,
  reasoning_split?: boolean
}
