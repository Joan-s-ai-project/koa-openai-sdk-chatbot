/**
 * LLM Provider 抽象层
 *
 * 统一不同 LLM 厂商（MiniMax、Gemini、DeepSeek 等）在 OpenAI 兼容接口上的差异：
 * - 请求体构建（thinking 配置、图片格式等）
 * - 响应解析（reasoning 字段名差异）
 */

// ─── 类型定义 ───────────────────────────────────────────────────────────

export interface ProviderConfig {
  apiKey: string
  baseUrl: string
  model: string
}

export interface ChatRequestOptions {
  messages: any[]
  model: string
  temperature: number
  tools?: any[]
  toolChoice?: string
  stream?: boolean
  streamOptions?: Record<string, any>
}

/** 从流式 delta 中解析出的标准化内容 */
export interface ParsedDelta {
  reasoning: string
  content: string
  toolCalls?: any[]
}

/** 从完整 chunk 中解析出的标准化结果 */
export interface ParsedChunk {
  delta: ParsedDelta
  finishReason: string | null
  usage: any | null
  model: string | null
}

/** 定价信息（每百万 token） */
export interface PricingInfo {
  input: number
  output: number
  cacheInput: number
  cacheOutput: number
  currency: string  // 'CNY' | 'USD'
}

/** 费用计算结果 */
export interface CostResult {
  usage: {
    prompt_tokens: number
    completion_tokens: number
    total_tokens: number
    cached_tokens: number
  }
  cost: {
    input_cost: number
    cache_cost: number
    output_cost: number
    total_cost: number
    currency: string
  }
}

// ─── Provider 基类 ──────────────────────────────────────────────────────

export abstract class LLMProvider {
  protected config: ProviderConfig

  constructor(config: ProviderConfig) {
    this.config = config
  }

  /** 获取 API 完整 URL */
  get apiUrl(): string {
    return `${this.config.baseUrl}/chat/completions`
  }

  /** 获取请求头 */
  get headers(): Record<string, string> {
    return {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${this.config.apiKey}`,
    }
  }

  /** 构建请求体（子类可覆盖以添加厂商特有字段） */
  abstract buildRequestBody(options: ChatRequestOptions): Record<string, any>

  /** 解析单个 SSE chunk JSON（标准化不同厂商的字段差异） */
  abstract parseChunk(parsed: any): ParsedChunk

  /** 获取模型定价（子类实现） */
  abstract getPricing(model: string): PricingInfo

  /** 根据 usage 计算费用 */
  calcCost(usage: any, model: string): CostResult {
    const pricing = this.getPricing(model)
    const promptTokens: number = usage.prompt_tokens || 0
    const completionTokens: number = usage.completion_tokens || 0
    const cachedTokens: number = usage.prompt_tokens_details?.cached_tokens || 0
    const normalInputTokens = promptTokens - cachedTokens

    const inputCost = (normalInputTokens / 1_000_000) * pricing.input
    const cacheCost = (cachedTokens / 1_000_000) * pricing.cacheInput
    const outputCost = (completionTokens / 1_000_000) * pricing.output
    const totalCost = inputCost + cacheCost + outputCost

    return {
      usage: {
        prompt_tokens: promptTokens,
        completion_tokens: completionTokens,
        total_tokens: usage.total_tokens || promptTokens + completionTokens,
        cached_tokens: cachedTokens,
      },
      cost: {
        input_cost: +inputCost.toFixed(6),
        cache_cost: +cacheCost.toFixed(6),
        output_cost: +outputCost.toFixed(6),
        total_cost: +totalCost.toFixed(6),
        currency: pricing.currency,
      },
    }
  }

  /** 构建包含图片的用户消息 content（子类可覆盖格式差异） */
  buildMultimodalContent(message: string, images: string[]): any[] {
    const parts: any[] = []
    for (const img of images) {
      const match = img.match(/^data:(image\/[^;]+);base64,(.+)$/)
      if (match) {
        parts.push({
          type: 'image_url',
          image_url: { url: img },
        })
      }
    }
    if (message) {
      parts.push({ type: 'text', text: message })
    }
    return parts
  }
}

// ─── MiniMax Provider ───────────────────────────────────────────────────

export class MiniMaxProvider extends LLMProvider {
  // 定价（人民币/百万 token），来源：platform.minimaxi.com
  private static PRICING: Record<string, PricingInfo> = {
    'MiniMax-M2.7': { input: 2.1, output: 8.4, cacheInput: 0.42, cacheOutput: 2.625, currency: 'CNY' },
    'MiniMax-M2.7-highspeed': { input: 4.2, output: 16.8, cacheInput: 0.42, cacheOutput: 2.625, currency: 'CNY' },
    'MiniMax-M2.5': { input: 2.1, output: 8.4, cacheInput: 0.21, cacheOutput: 2.625, currency: 'CNY' },
    'MiniMax-M2.5-highspeed': { input: 4.2, output: 16.8, cacheInput: 0.21, cacheOutput: 2.625, currency: 'CNY' },
  }

  getPricing(model: string): PricingInfo {
    return MiniMaxProvider.PRICING[model] || MiniMaxProvider.PRICING['MiniMax-M2.7']
  }

  buildRequestBody(options: ChatRequestOptions): Record<string, any> {
    return {
      model: options.model,
      messages: options.messages,
      temperature: options.temperature,
      tools: options.tools,
      tool_choice: options.toolChoice || 'auto',
      stream: options.stream ?? true,
      stream_options: options.streamOptions || { include_usage: true },
      // 将思考内容分离到 reasoning_details 字段
      reasoning_split: true,
    }
  }

  parseChunk(parsed: any): ParsedChunk {
    const choice = parsed.choices?.[0]
    const delta = choice?.delta

    let reasoning = ''
    let content = ''
    let toolCalls: any[] | undefined

    if (delta) {
      // reasoning_split=true 时思考内容在 delta.reasoning_details 数组中
      // MiniMax 实际格式：{ type: "reasoning.text", text: "..." }
      // 兜底兼容旧版 reasoning_content 字段
      if (Array.isArray(delta.reasoning_details) && delta.reasoning_details.length > 0) {
        reasoning = delta.reasoning_details
          .filter((d: any) => d.type === 'reasoning.text')
          .map((d: any) => d.text || '')
          .join('')
      } else {
        reasoning = delta.reasoning_content || ''
      }
      content = delta.content || ''
      toolCalls = delta.tool_calls
    }

    const rawFinishReason = choice?.finish_reason as string | null
    return {
      delta: { reasoning, content, toolCalls },
      finishReason: rawFinishReason ? rawFinishReason.toLowerCase() : null,
      usage: parsed.usage || null,
      model: parsed.model || null,
    }
  }
}

// ─── Gemini Provider (OpenAI 兼容) ─────────────────────────────────────

export class GeminiProvider extends LLMProvider {
  // 定价（美元/百万 token），来源：ai.google.dev/pricing
  // Gemini 2.5 Flash: input $0.15, output $0.60 (<=200k context)
  // Gemini 2.5 Pro: input $1.25, output $10.00 (<=200k context)
  // Gemini 3.5 Flash: input $0.15, output $0.60 (<=200k context)
  private static PRICING: Record<string, PricingInfo> = {
    'gemini-2.5-flash': { input: 0.15, output: 0.60, cacheInput: 0.0375, cacheOutput: 0.60, currency: 'USD' },
    'gemini-2.5-flash-preview': { input: 0.15, output: 0.60, cacheInput: 0.0375, cacheOutput: 0.60, currency: 'USD' },
    'gemini-2.5-pro': { input: 1.25, output: 10.0, cacheInput: 0.3125, cacheOutput: 10.0, currency: 'USD' },
    'gemini-2.5-pro-preview': { input: 1.25, output: 10.0, cacheInput: 0.3125, cacheOutput: 10.0, currency: 'USD' },
    'gemini-2.0-flash': { input: 0.10, output: 0.40, cacheInput: 0.025, cacheOutput: 0.40, currency: 'USD' },
    'gemini-3-flash-preview': { input: 0.15, output: 0.60, cacheInput: 0.0375, cacheOutput: 0.60, currency: 'USD' },
    'gemini-3.5-flash': { input: 0.15, output: 0.60, cacheInput: 0.0375, cacheOutput: 0.60, currency: 'USD' },
  }

  getPricing(model: string): PricingInfo {
    // 尝试精确匹配，否则按前缀匹配
    if (GeminiProvider.PRICING[model]) return GeminiProvider.PRICING[model]
    for (const [key, pricing] of Object.entries(GeminiProvider.PRICING)) {
      if (model.startsWith(key)) return pricing
    }
    // 默认 flash 定价
    return GeminiProvider.PRICING['gemini-2.5-flash']
  }

  buildRequestBody(options: ChatRequestOptions): Record<string, any> {
    return {
      model: options.model,
      messages: options.messages,
      temperature: options.temperature,
      tools: options.tools,
      tool_choice: options.toolChoice || 'auto',
      stream: options.stream ?? true,
      stream_options: options.streamOptions || { include_usage: true },
      // 开启明文思考内容输出
      "extra_body": {
        "google": {
          "thinking_config": {
            "include_thoughts": true
          }
        }
      }
    }
  }

  parseChunk(parsed: any): ParsedChunk {
    const choice = parsed.choices?.[0]
    const delta = choice?.delta

    let reasoning = ''
    let content = ''
    let toolCalls: any[] | undefined

    if (delta) {
      const rawContent: string = delta.content || ''

      // Gemini 把思考内容放在 delta.content 的 <thought>...</thought> 标签里
      // extra_content.google.thought === true 标记这是思考 chunk
      const isThoughtChunk = delta.extra_content?.google?.thought === true

      if (isThoughtChunk) {
        // 提取 <thought> 标签内的文本，去掉标签本身
        reasoning = rawContent
          .replace(/^<thought>/i, '')
          .replace(/<\/thought>$/i, '')
      } else if (rawContent.includes('<thought>') || rawContent.includes('</thought>')) {
        // 同一 chunk 里混有 </thought> 结束标签，直接丢弃标签
        const cleaned = rawContent.replace(/<\/?thought>/gi, '').trim()
        if (cleaned) content = cleaned
      } else {
        content = rawContent
      }

      // tool_calls 在 delta 里直接出现（不依赖 finish_reason）
      if (delta.tool_calls && delta.tool_calls.length > 0) {
        toolCalls = delta.tool_calls
      }
    }

    // Gemini finish_reason 统一转小写
    const rawFinishReason = choice?.finish_reason as string | null
    const finishReason = rawFinishReason ? rawFinishReason.toLowerCase() : null

    return {
      delta: { reasoning, content, toolCalls },
      finishReason,
      usage: parsed.usage || null,
      model: parsed.model || null,
    }
  }

  /** Gemini 图片格式与 OpenAI 一致，使用 inline_data 也可以，但 data URL 方式兼容 */
  buildMultimodalContent(message: string, images: string[]): any[] {
    // Gemini OpenAI 兼容接口支持 image_url 格式（含 base64 data URL）
    return super.buildMultimodalContent(message, images)
  }
}

// ─── MiMo Provider ─────────────────────────────────────────────────────

export class MiMoProvider extends LLMProvider {
  // 定价（美元/百万 token），来源：token-plan-sgp.xiaomimimo.com
  private static PRICING: Record<string, PricingInfo> = {
    'mimo-v2.5': { input: 0.0, output: 0.0, cacheInput: 0.0, cacheOutput: 0.0, currency: 'USD' },
    'mimo-v2.5-pro': { input: 0.0, output: 0.0, cacheInput: 0.0, cacheOutput: 0.0, currency: 'USD' },
  }

  getPricing(model: string): PricingInfo {
    return MiMoProvider.PRICING[model] || MiMoProvider.PRICING['mimo-v2.5-pro']
  }

  buildRequestBody(options: ChatRequestOptions): Record<string, any> {
    return {
      model: options.model,
      messages: options.messages,
      temperature: options.temperature,
      tools: options.tools,
      tool_choice: options.toolChoice || 'auto',
      stream: options.stream ?? true,
      stream_options: options.streamOptions || { include_usage: true },
    }
  }

  parseChunk(parsed: any): ParsedChunk {
    const choice = parsed.choices?.[0]
    const delta = choice?.delta

    let reasoning = ''
    let content = ''
    let toolCalls: any[] | undefined

    if (delta) {
      // MiMo 使用 reasoning_content 存放思考内容（与 DeepSeek 一致）
      reasoning = delta.reasoning_content || ''
      content = delta.content || ''
      toolCalls = delta.tool_calls
    }

    const rawFinishReason = choice?.finish_reason as string | null
    return {
      delta: { reasoning, content, toolCalls },
      finishReason: rawFinishReason ? rawFinishReason.toLowerCase() : null,
      usage: parsed.usage || null,
      model: parsed.model || null,
    }
  }
}

// ─── DeepSeek Provider ──────────────────────────────────────────────────

export class DeepSeekProvider extends LLMProvider {
  // 定价（人民币/百万 token），来源：platform.deepseek.com
  private static PRICING: Record<string, PricingInfo> = {
    'deepseek-chat': { input: 1.0, output: 2.0, cacheInput: 0.1, cacheOutput: 2.0, currency: 'CNY' },
    'deepseek-reasoner': { input: 4.0, output: 16.0, cacheInput: 1.0, cacheOutput: 16.0, currency: 'CNY' },
    'deepseek-v4-flash': { input: 1.0, output: 2.0, cacheInput: 0.1, cacheOutput: 2.0, currency: 'CNY' },
  }

  getPricing(model: string): PricingInfo {
    if (DeepSeekProvider.PRICING[model]) return DeepSeekProvider.PRICING[model]
    // 默认 chat 定价
    return DeepSeekProvider.PRICING['deepseek-chat']
  }

  buildRequestBody(options: ChatRequestOptions): Record<string, any> {
    return {
      model: options.model,
      messages: options.messages,
      temperature: options.temperature,
      tools: options.tools,
      tool_choice: options.toolChoice || 'auto',
      stream: options.stream ?? true,
      stream_options: options.streamOptions || { include_usage: true },
    }
  }

  parseChunk(parsed: any): ParsedChunk {
    const choice = parsed.choices?.[0]
    const delta = choice?.delta

    let reasoning = ''
    let content = ''
    let toolCalls: any[] | undefined

    if (delta) {
      // DeepSeek 使用 reasoning_content
      reasoning = delta.reasoning_content || ''
      content = delta.content || ''
      toolCalls = delta.tool_calls
    }

    const rawFinishReason = choice?.finish_reason as string | null
    return {
      delta: { reasoning, content, toolCalls },
      finishReason: rawFinishReason ? rawFinishReason.toLowerCase() : null,
      usage: parsed.usage || null,
      model: parsed.model || null,
    }
  }
}

// ─── 可用模型列表（前端下拉菜单数据源） ─────────────────────────────────

export interface ModelOption {
  id: string       // 发给 API 的 model 名
  label: string    // 前端显示名
  provider: string // 'minimax' | 'gemini' | 'deepseek'
}

/** 返回当前环境中已配置 key 的可用模型列表 */
export function getAvailableModels(): ModelOption[] {
  const models: ModelOption[] = []

  if (process.env.MINIMAX_API_KEY) {
    models.push(
      { id: 'MiniMax-M2.5', label: 'MiniMax M2.5', provider: 'minimax' },
      { id: 'MiniMax-M2.7', label: 'MiniMax M2.7', provider: 'minimax' },
    )
  }

  if (process.env.GEMINI_AI_KEY) {
    models.push(
      { id: 'gemini-3-flash-preview', label: 'Gemini 3 Flash', provider: 'gemini' },
      { id: 'gemini-3.5-flash', label: 'Gemini 3.5 Flash', provider: 'gemini' },
    )
  }

  if (process.env.DEEPSEEK_API_KEY) {
    models.push(
      { id: 'deepseek-chat', label: 'DeepSeek Chat', provider: 'deepseek' },
      { id: 'deepseek-reasoner', label: 'DeepSeek Reasoner', provider: 'deepseek' },
    )
  }

  if (process.env.MIMO_API_KEY) {
    models.push(
      { id: 'mimo-v2.5', label: 'MiMo v2.5', provider: 'mimo' },
      { id: 'mimo-v2.5-pro', label: 'MiMo v2.5 Pro', provider: 'mimo' },
    )
  }

  // 如果没有任何 provider 专属 key，回退到通用 OPENAI_API_KEY
  if (models.length === 0 && process.env.OPENAI_API_KEY) {
    const defaultModel = process.env.DEFAULT_MODEL || ''
    models.push({ id: defaultModel, label: defaultModel, provider: 'default' })
  }

  return models
}

// ─── 工厂函数：根据模型名自动选择 Provider 及对应 key/url ───────────────

/**
 * 根据 model 名自动选择对应厂商的 Provider，
 * 优先使用厂商专属环境变量（MINIMAX_API_KEY / GEMINI_API_KEY / DEEPSEEK_API_KEY），
 * 兜底使用通用 OPENAI_API_KEY / OPENAI_BASE_URL。
 */
export function createProvider(config?: Partial<ProviderConfig>): LLMProvider {
  const model = config?.model || process.env.DEFAULT_MODEL || ''

  // ── MiMo ──
  if (model.startsWith('mimo')) {
    const apiKey = config?.apiKey || process.env.MIMO_API_KEY || process.env.OPENAI_API_KEY || ''
    const baseUrl = config?.baseUrl || process.env.MIMO_BASE_URL || 'https://token-plan-sgp.xiaomimimo.com/v1'
    console.log(`[createProvider] MiMo, model=${model}, key=...${apiKey.slice(-6)}`)
    return new MiMoProvider({ apiKey, baseUrl, model })
  }

  // ── Gemini ──
  if (model.startsWith('gemini')) {
    const apiKey = config?.apiKey || process.env.GEMINI_AI_KEY || process.env.OPENAI_API_KEY || ''
    const baseUrl = config?.baseUrl || process.env.GEMINI_BASE_URL || process.env.OPENAI_BASE_URL || ''
    console.log(`[createProvider] Gemini, model=${model}, key=...${apiKey.slice(-6)}`)
    return new GeminiProvider({ apiKey, baseUrl, model })
  }

  // ── DeepSeek ──
  if (model.startsWith('deepseek')) {
    const apiKey = config?.apiKey || process.env.DEEPSEEK_API_KEY || process.env.OPENAI_API_KEY || ''
    const baseUrl = config?.baseUrl || process.env.DEEPSEEK_BASE_URL || process.env.OPENAI_BASE_URL || ''
    return new DeepSeekProvider({ apiKey, baseUrl, model })
  }

  // ── MiniMax（MiniMax-M2.x 前缀） ──
  if (model.startsWith('MiniMax')) {
    const apiKey = config?.apiKey || process.env.MINIMAX_API_KEY || process.env.OPENAI_API_KEY || ''
    const baseUrl = config?.baseUrl || process.env.MINIMAX_BASE_URL || process.env.OPENAI_BASE_URL || ''
    return new MiniMaxProvider({ apiKey, baseUrl, model })
  }

  // ── 兜底：通用 OPENAI_API_KEY，根据 baseUrl 判断厂商 ──
  const apiKey = config?.apiKey || process.env.OPENAI_API_KEY || ''
  const baseUrl = config?.baseUrl || process.env.OPENAI_BASE_URL || ''

  if (baseUrl.includes('generativelanguage.googleapis.com')) {
    return new GeminiProvider({ apiKey, baseUrl, model })
  }
  if (baseUrl.includes('deepseek')) {
    return new DeepSeekProvider({ apiKey, baseUrl, model })
  }
  return new MiniMaxProvider({ apiKey, baseUrl, model })
}
