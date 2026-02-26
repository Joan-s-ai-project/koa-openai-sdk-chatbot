import type { ChatMessage } from '../types/chat'

const SYSTEM_PROMPT = process.env.SYSTEM_PROMPT || '你是一个友好、专业的 AI 助手，用中文回答问题。'

/**
 * 上下文管理服务
 * 按 sessionId 维护各会话的消息历史（内存）
 */
class ContextService {
  private sessions = new Map<string, ChatMessage[]>()

  /**
   * 获取上下文（首次自动创建）
   */
  getMessages(sessionId: string): ChatMessage[] {
    if (!this.sessions.has(sessionId)) {
      this.sessions.set(sessionId, [
        { role: 'system', content: SYSTEM_PROMPT }
      ])
    }
    return this.sessions.get(sessionId)!
  }

  /**
   * 追加一轮对话（user + assistant）
   */
  addExchange(sessionId: string, userMsg: string, assistantMsg: string): void {
    const messages = this.getMessages(sessionId)
    messages.push(
      { role: 'user', content: userMsg },
      { role: 'assistant', content: assistantMsg }
    )
  }
}

// 单例导出
export const contextService = new ContextService()
