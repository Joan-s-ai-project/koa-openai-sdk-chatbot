import OpenAI from 'openai'
import type { ChatCompletionMessageParam, ChatCompletionTool, ChatCompletionChunk } from 'openai/resources'
import type { Stream } from 'openai/streaming'
import type { ChatMessage, StreamChunk } from '../types/chat'
import { TOOL_DEFINITIONS, dispatchTool, buildToolStartEvent } from '../tools'

// 最大 Tool Call 轮数（防止模型无限循环调用工具）
const MAX_TOOL_ROUNDS = 3

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
   * 流式聊天 — 支持 Tool Call 循环（Tavily 搜索）
   *
   * 核心流程：
   * 1. 发起流式请求，同时声明可用工具（tools）
   * 2. 消费 stream，检测 finish_reason
   *    - 'tool_calls'  → 执行 Tavily 搜索 → 将结果追加到消息 → 重新发起请求（下一轮）
   *    - 'stop'        → 正常结束，退出循环
   * 3. 最多循环 MAX_TOOL_ROUNDS 次，超出则强制结束
   */
  async *chatStream(
    messages: ChatMessage[],
    options?: { model?: string; temperature?: number, reasoning_split?: boolean }
  ): AsyncGenerator<StreamChunk> {
    // 将用户消息转为 OpenAI 格式（复制一份，避免污染调用方的 messages）
    const msgs: ChatCompletionMessageParam[] = messages.map(m => ({
      role: m.role,
      content: m.content,
    }))

    // 保存最近一轮的 usage，供安全退出时使用
    let lastUsage: any = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 }

    try {
      for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
        // ── 发起本轮流式请求 ──────────────────────────────────────────
        const stream = await this.client.chat.completions.create({
          model: options?.model || process.env.DEFAULT_MODEL || 'gpt-4o-mini',
          messages: msgs,
          temperature: options?.temperature ?? parseFloat(process.env.DEFAULT_TEMPERATURE || '0.7'),
          stream: true,
          tools: TOOL_DEFINITIONS as any,
          tool_choice: 'auto', // 让模型自己决定是否要调用工具
          // reasoning_split: options?.reasoning_split
        } as any) as unknown as Stream<ChatCompletionChunk>

        // ── 消费流，同时拼接 tool_calls 的中间状态 ────────────────────
        let finishReason: string | null = null
        let usage = undefined

        // 用于拼装 tool_calls（流式下 tool_calls 是分片下发的）
        const toolCallAccumulator: {
          id: string
          name: string
          argumentsRaw: string
        }[] = []

        let assistantContent = ''

        for await (const chunk of stream) {
          console.log(JSON.stringify(chunk));
          const choice = chunk.choices[0]
          usage = chunk.usage
          // 每轮同步更新 lastUsage，供超出最大轮数时安全退出使用
          if (usage) lastUsage = usage

          if (!choice) continue

          // 记录本轮的 finish_reason
          if (choice.finish_reason) {
            finishReason = choice.finish_reason
          }

          const delta = choice.delta

          // 处理 reasoning（GLM-5 等模型的思考过程）
          const reasoning = (delta as any)?.reasoning_content
          if (reasoning) {
            yield { type: 'reasoning', content: reasoning }
          }

          // 处理普通文本内容
          if (delta?.content) {
            assistantContent += delta.content
            yield { type: 'content', content: delta.content }
          }

          // 拼装 tool_calls（流式 delta 中 tool_calls 是分片的）
          if (delta?.tool_calls) {
            for (const tcDelta of delta.tool_calls) {
              const idx = tcDelta.index

              // 初始化这个 index 的 accumulator
              if (!toolCallAccumulator[idx]) {
                toolCallAccumulator[idx] = {
                  id: tcDelta.id || '',
                  name: tcDelta.function?.name || '',
                  argumentsRaw: '',
                }
              }

              // 补全 id 和 name（首个 chunk 才有）
              if (tcDelta.id) toolCallAccumulator[idx].id = tcDelta.id
              if (tcDelta.function?.name) toolCallAccumulator[idx].name = tcDelta.function.name

              // 拼接 arguments 字符串（跨多个 chunk）
              if (tcDelta.function?.arguments) {
                toolCallAccumulator[idx].argumentsRaw += tcDelta.function.arguments
              }
            }
          }
        }

        // ── 判断本轮结束原因 ─────────────────────────────────────────
        if (finishReason === 'tool_calls' && toolCallAccumulator.length > 0) {
          // 1. 先把 assistant 的 tool_calls 消息追加到上下文
          msgs.push({
            role: 'assistant',
            content: assistantContent || null,
            tool_calls: toolCallAccumulator.map(tc => ({
              id: tc.id,
              type: 'function' as const,
              function: { name: tc.name, arguments: tc.argumentsRaw },
            })),
          })

          // 2. 逐个执行工具调用（通过 registry 分发）
          for (const tc of toolCallAccumulator) {
            let args: Record<string, any> = {}
            try {
              args = JSON.parse(tc.argumentsRaw)
            } catch {
              args = {}
            }

            // 通知前端：tool 开始执行（searching / bash_running / ...）
            const startEvent = buildToolStartEvent(tc.name, args)
            yield startEvent as StreamChunk

            // 通过 registry 执行（llm.service 无 sessionId，使用随机沙箱）
            const { text: toolText } = await dispatchTool(tc.name, args, { sessionId: `llm-${Date.now()}` })

            // 3. 将 tool 结果以 tool 角色追加到上下文
            msgs.push({
              role: 'tool',
              tool_call_id: tc.id,
              content: toolText,
            })
          }

          continue
        }

        // finish_reason === 'stop'：正常结束，输出 done
        yield {
          type: 'done',
          usage: usage || { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 }
        }
        return // 退出 generator
      }

      // 超过最大轮数，安全退出（带上最后一轮的真实 usage）
      yield {
        type: 'done',
        usage: lastUsage
      }
    } catch (err: any) {
      yield { type: 'error', message: err.message || 'OpenAI API 调用失败' }
    }
  }
}

// 单例导出
export const llmService = new LLMService()
