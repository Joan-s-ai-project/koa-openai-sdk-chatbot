import OpenAI from 'openai'
import type { ChatMessage, StreamChunk } from '../types/chat'

/**
 * LLM 服务 — 封装 OpenAI SDK 调用
 */
class LLMService {
  private client: OpenAI

  constructor() {
    this.client = new OpenAI({
      apiKey: process.env.OPENAI_API_KEY,
      baseURL: process.env.OPENAI_BASE_URL
    })
  }

  /**
   * 非流式聊天
   */
  async chat(
    messages: ChatMessage[],
    options?: { model?: string; temperature?: number }
  ) {
    const response = await this.client.chat.completions.create({
      model: options?.model || process.env.DEFAULT_MODEL || 'gpt-4o-mini',
      messages,
      temperature: options?.temperature ?? parseFloat(process.env.DEFAULT_TEMPERATURE || '0.7'),
    })

    const choice = response.choices[0]
    const content = choice?.message?.content || ''
    // GLM-5 等模型的推理内容
    const reasoning = (choice?.message as any)?.reasoning_content || ''

    return {
      content,
      reasoning: reasoning || undefined,
      usage: response.usage
    }
  }
}

// 单例导出
export const llmService = new LLMService()
