import { jsonlStorage, traceStorage } from '../utils/jsonl-storage'

/**
 * 会话历史服务
 * 把 controller 的"列表/详情/删除"业务逻辑收敛到一处
 */

export interface ConversationSummary {
  id: string
  title: string
  createdAt: number
  messageCount: number
}

/** 列出全部会话，按时间倒序 */
export function listConversations(): ConversationSummary[] {
  const files = jsonlStorage.listFiles()
  const conversations = files.map(id => {
    const messages = jsonlStorage.readAll(id)
    const firstUserMsg = messages.find(m => m.role === 'user')
    const title = firstUserMsg?.content?.slice(0, 50) || '新会话'
    const createdAt = messages[0]?.createdAt || 0
    return { id, title, createdAt, messageCount: messages.length }
  })
  conversations.sort((a, b) => b.createdAt - a.createdAt)
  return conversations
}

/** 获取单个会话的全部消息；不存在返回 null */
export function getConversation(id: string): Record<string, any>[] | null {
  if (!jsonlStorage.exists(id)) return null
  return jsonlStorage.readAll(id)
}

/** 删除会话和对应 trace；返回是否存在 + 是否删除成功 */
export function deleteConversation(id: string): { existed: boolean; deleted: boolean } {
  if (!jsonlStorage.exists(id)) return { existed: false, deleted: false }
  const deleted = jsonlStorage.delete(id)
  if (traceStorage.exists(id)) traceStorage.delete(id)
  return { existed: true, deleted }
}
