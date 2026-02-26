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

  /**
   * 流式聊天 — 返回 AsyncGenerator，逐 chunk 产出
   */
  async *chatStream(
    messages: ChatMessage[],
    options?: { model?: string; temperature?: number }
  ): AsyncGenerator<StreamChunk> {
    try {
      const stream = await this.client.chat.completions.create({
        model: options?.model || process.env.DEFAULT_MODEL || 'gpt-4o-mini',
        messages,
        temperature: options?.temperature ?? parseFloat(process.env.DEFAULT_TEMPERATURE || '0.7'),
        stream: true,
      })

      let usage = undefined  // 在循环外声明，最后一个 chunk 会赋值

      for await (const chunk of stream) {
        const choice = chunk.choices[0]
        usage = chunk.usage

        if (!choice) continue

        // GLM-5 等模型的推理内容
        const reasoning = (choice.delta as any)?.reasoning_content
        const content = choice.delta?.content

        if (reasoning) {
          yield { type: 'reasoning', content: reasoning }
        } else if (content) {
          yield { type: 'content', content }
        }
      }

      yield { type: 'done', usage: usage || { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 } }
    } catch (err: any) {
      yield { type: 'error', message: err.message || 'OpenAI API 调用失败' }
    }
  }
}

// 单例导出
export const llmService = new LLMService()
