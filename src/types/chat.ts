/**
 * 聊天消息类型
 */
export interface ChatMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
  ts?: string
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
  | { type: 'done'; usage: TokenUsage }
  | { type: 'error'; message: string }

/**
 * 聊天请求 body
 */
export interface ChatRequestBody {
  sessionId: string
  message: string
  model?: string
  temperature?: number
}
