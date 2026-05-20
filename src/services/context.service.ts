import type { ChatMessage } from '../types/chat'
import { jsonlStorage } from './jsonl-storage'

const SYSTEM_PROMPT = process.env.SYSTEM_PROMPT || '你是一个友好、专业的 AI 助手，用中文回答问题。'

/**
 * 上下文管理服务
 * 按 sessionId 维护各会话的消息历史
 * 内存 Map（运行时）+ JsonlStorage（持久化）
 */
class ContextService {
  private sessions = new Map<string, ChatMessage[]>()

  /**
   * 获取上下文（内存优先，未命中从 JSONL 加载）
   */
  getMessages(sessionId: string): ChatMessage[] {
    if (!this.sessions.has(sessionId)) {
      if (jsonlStorage.exists(sessionId)) {
        // 从磁盘恢复（场景：服务重启后用旧 sessionId 请求）
        this.sessions.set(sessionId, jsonlStorage.readAll(sessionId) as ChatMessage[])
      } else {
        // 全新会话
        const initial: ChatMessage = { role: 'system', content: SYSTEM_PROMPT, createdAt: Date.now() }
        this.sessions.set(sessionId, [initial])
        jsonlStorage.append(sessionId, initial)
      }
    }
    return this.sessions.get(sessionId)!
  }

  /**
   * 追加一轮对话（内存 + 磁盘）
   */
  addExchange(sessionId: string, userMsg: string, assistantMsg: string, reasoning?: string): void {
    const messages = this.getMessages(sessionId)
    const now = Date.now()
    const userEntry: ChatMessage = { role: 'user', content: userMsg, createdAt: now }
    const aiEntry: any = { role: 'assistant', content: assistantMsg, createdAt: now }
    if (reasoning) aiEntry.reasoning = reasoning

    messages.push(userEntry, aiEntry)
    jsonlStorage.append(sessionId, userEntry)
    jsonlStorage.append(sessionId, aiEntry)
  }
}

// 单例导出
export const contextService = new ContextService()
