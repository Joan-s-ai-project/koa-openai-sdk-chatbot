import type { ChatMessage } from '../types/chat'
import { jsonlStorage } from '../utils/jsonl-storage'

const SYSTEM_PROMPT_BASE = process.env.SYSTEM_PROMPT || '你是一个友好、专业的 AI 助手，用中文回答问题。'

const MEMORY_INSTRUCTIONS = `

## 记忆工具使用规则

你拥有持久化记忆能力，可在合适的场景下使用：

### memory_search（按需调用）
- 当用户的问题涉及个人信息、历史偏好、过往经历，或需要上下文连贯性时，调用 memory_search 检索相关记忆
- 对于通用知识问答、简单闲聊、与用户个人无关的问题，无需调用
- query 使用用户消息的核心意图，简洁精准

### memory_save（按需调用）
- 当用户分享了个人信息、偏好、重要经历或值得记住的事项时，调用 memory_save 保存
- 对于无个性化价值的普通对话（如通用问答），无需保存
- messages 包含本轮的 user 消息和你的 assistant 回复
- conversation_id 使用当前会话标识`

/** 动态生成 system prompt，注入当前日期 */
function buildSystemPrompt(): string {
  const now = new Date()
  const dateStr = now.toLocaleDateString('zh-CN', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    weekday: 'long',
  })
  return `${SYSTEM_PROMPT_BASE}\n\n当前日期：${dateStr}${MEMORY_INSTRUCTIONS}`
}

/**
 * 从 JSONL 原始记录中过滤出合法的 chat messages。
 *
 * 需要清理的情况：
 *  1. `{"type":"done",...}` 等非消息记录（没有 role 字段）
 *  2. 多余的业务字段（createdAt、model、images、attachments 等），避免发给上游 API
 *  3. 保留 tool 相关字段（tool_calls / tool_call_id），以便带历史 tool 交互时不丢失上下文
 */
function sanitizeMessages(raw: Record<string, any>[]): ChatMessage[] {
  const validRoles = new Set(['system', 'user', 'assistant', 'tool'])
  const result: ChatMessage[] = []

  for (const entry of raw) {
    if (!entry.role || !validRoles.has(entry.role)) continue

    const msg: any = { role: entry.role }

    // content — 保留原值（可以是 string | null | array）
    if (entry.content !== undefined) msg.content = entry.content

    // assistant 可能带 tool_calls
    if (entry.role === 'assistant' && entry.tool_calls) {
      msg.tool_calls = entry.tool_calls
    }

    // tool 消息需要 tool_call_id
    if (entry.role === 'tool' && entry.tool_call_id) {
      msg.tool_call_id = entry.tool_call_id
    }

    // 保留 createdAt 用于内部排序（不会发给 API，buildRequestBody 取 messages 里的 role/content/tool_calls）
    if (entry.createdAt) msg.createdAt = entry.createdAt

    result.push(msg as ChatMessage)
  }

  return result
}

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
        const raw = jsonlStorage.readAll(sessionId)
        this.sessions.set(sessionId, sanitizeMessages(raw))
      } else {
        // 全新会话
        const initial: ChatMessage = { role: 'system', content: buildSystemPrompt(), createdAt: Date.now() }
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
