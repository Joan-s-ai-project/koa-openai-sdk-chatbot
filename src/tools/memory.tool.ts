/**
 * OpenMem (MemOS) 记忆工具
 *
 * 提供两个工具：
 *  - memory_search : 在回答前检索用户相关记忆，为模型提供个性化上下文
 *  - memory_save   : 将本轮对话保存到记忆系统，供后续会话使用
 *
 * 环境变量：
 *  MEMOS_API_KEY   — OpenMem API Key（必填）
 *  MEMOS_USER_ID   — 稳定的用户标识符，建议用 SHA-256(email)（必填）
 *  MEMOS_BASE_URL  — API 基础地址（可选，默认 https://memos.memtensor.cn/api/openmem/v1）
 */

const BASE_URL =
  process.env.MEMOS_BASE_URL?.replace(/\/$/, '') ||
  'https://memos.memtensor.cn/api/openmem/v1'

function getHeaders(): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    Authorization: `Token ${process.env.MEMOS_API_KEY || ''}`,
  }
}

function getUserId(): string {
  return process.env.MEMOS_USER_ID || 'default_user'
}

// ─── Tool: memory_search ──────────────────────────────────────────────────────

export const searchDefinition = {
  type: 'function' as const,
  function: {
    name: 'memory_search',
    description:
      '在回答用户问题之前，先检索该用户的历史记忆片段（事实、偏好、行为轨迹等），' +
      '以便提供更个性化、更连贯的回答。当问题涉及用户个人信息、历史偏好、过往经历或需要上下文连贯性时使用。',
    parameters: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: '用于检索记忆的查询文本，描述当前问题或用户意图，尽量简洁精准',
        },
        conversation_id: {
          type: 'string',
          description: '当前会话 ID，用于提升本次对话记忆的优先级（可选）',
        },
      },
      required: ['query'],
    },
  },
}

export async function searchMemory(args: {
  query: string
  conversation_id?: string
}) {
  const apiKey = process.env.MEMOS_API_KEY
  if (!apiKey) {
    return { text: '未配置 MEMOS_API_KEY，记忆检索不可用', display: '⚠️ 记忆服务未配置' }
  }

  const body: Record<string, any> = {
    user_id: getUserId(),
    query: args.query,
    memory_limit_number: 9,
    include_preference: true,
    preference_limit_number: 6,
  }
  if (args.conversation_id) body.conversation_id = args.conversation_id

  const res = await fetch(`${BASE_URL}/search/memory`, {
    method: 'POST',
    headers: getHeaders(),
    body: JSON.stringify(body),
  })

  if (!res.ok) {
    const errText = await res.text()
    throw new Error(`MemOS search failed (${res.status}): ${errText}`)
  }

  const json = await res.json() as any
  if (json.code !== 0) {
    throw new Error(`MemOS search error: ${json.message}`)
  }

  const data = json.data || {}
  const lines: string[] = []
  const displayLines: string[] = []

  // 事实记忆
  const memories: any[] = data.memory_detail_list || []
  if (memories.length > 0) {
    lines.push('【事实记忆】')
    displayLines.push('**事实记忆：**')
    for (const m of memories) {
      const line = `- ${m.memory_key ? `[${m.memory_key}] ` : ''}${m.memory_value}`
      lines.push(line)
      displayLines.push(line)
    }
    lines.push('')
  }

  // 偏好记忆
  const prefs: any[] = data.preference_detail_list || []
  if (prefs.length > 0) {
    lines.push('【偏好记忆】')
    displayLines.push('\n**偏好记忆：**')
    for (const p of prefs) {
      const line = `- ${p.preference}`
      lines.push(line)
      displayLines.push(line)
    }
    lines.push('')
  }

  if (lines.length === 0) {
    return {
      text: '未找到相关记忆',
      display: '📭 未找到相关记忆',
    }
  }

  return {
    text: lines.join('\n'),
    display: displayLines.join('\n'),
  }
}

// ─── Tool: memory_save ───────────────────────────────────────────────────────

export const saveDefinition = {
  type: 'function' as const,
  function: {
    name: 'memory_save',
    description:
      '将本轮用户与助手的对话内容保存到记忆系统，以便在未来的对话中能够回忆起用户的偏好、经历和信息。' +
      '在完成一轮有价值的对话交互后调用，尤其是当用户分享了个人信息、偏好或重要事项时。',
    parameters: {
      type: 'object',
      properties: {
        messages: {
          type: 'array',
          description: '要保存的消息列表',
          items: {
            type: 'object',
            properties: {
              role: {
                type: 'string',
                enum: ['user', 'assistant'],
                description: '消息角色',
              },
              content: {
                type: 'string',
                description: '消息内容',
              },
            },
            required: ['role', 'content'],
          },
        },
        conversation_id: {
          type: 'string',
          description: '会话 ID，用于关联同一对话的多条消息',
        },
      },
      required: ['messages', 'conversation_id'],
    },
  },
}

export async function saveMemory(args: {
  messages: Array<{ role: 'user' | 'assistant'; content: string }>
  conversation_id: string
}) {
  const apiKey = process.env.MEMOS_API_KEY
  if (!apiKey) {
    return { text: '未配置 MEMOS_API_KEY，记忆保存不可用', display: '⚠️ 记忆服务未配置' }
  }

  const body = {
    user_id: getUserId(),
    conversation_id: args.conversation_id,
    messages: args.messages,
    async_mode: true,
  }

  const res = await fetch(`${BASE_URL}/add/message`, {
    method: 'POST',
    headers: getHeaders(),
    body: JSON.stringify(body),
  })

  if (!res.ok) {
    const errText = await res.text()
    throw new Error(`MemOS save failed (${res.status}): ${errText}`)
  }

  const json = await res.json() as any
  if (json.code !== 0) {
    throw new Error(`MemOS save error: ${json.message}`)
  }

  const taskId = json.data?.task_id || ''
  return {
    text: `记忆已提交保存${taskId ? `，任务 ID: ${taskId}` : ''}`,
    display: `✅ 记忆已保存${taskId ? `（task: ${taskId}）` : ''}`,
  }
}
