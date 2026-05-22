/**
 * LLM Provider — 多厂商 OpenAI 兼容接口适配层
 *
 * 设计：数据驱动。每个 Provider 只声明它的差异点（match / env / pricing / extraBody / parseDelta），
 * 公共部分（apiUrl、headers、calcCost、parseChunk 骨架、buildMultimodalContent）只写一次。
 */

// ─── 类型 ──────────────────────────────────────────────────────────────

export interface ChatRequestOptions {
  messages: any[]
  model: string
  temperature: number
  tools?: any[]
  toolChoice?: string
  stream?: boolean
  streamOptions?: Record<string, any>
}

export interface ParsedDelta {
  reasoning: string
  content: string
  toolCalls?: any[]
}

export interface ParsedChunk {
  delta: ParsedDelta
  finishReason: string | null
  usage: any | null
  model: string | null
}

export interface PricingInfo {
  input: number
  output: number
  cacheInput: number
  cacheOutput: number
  currency: 'CNY' | 'USD'
}

export interface CostResult {
  usage: { prompt_tokens: number; completion_tokens: number; total_tokens: number; cached_tokens: number }
  cost: { input_cost: number; cache_cost: number; output_cost: number; total_cost: number; currency: string }
}

export interface ModelOption {
  id: string
  label: string
  provider: string
}

export interface Provider {
  apiUrl: string
  headers: Record<string, string>
  buildRequestBody(options: ChatRequestOptions): Record<string, any>
  parseChunk(parsed: any): ParsedChunk
  calcCost(usage: any, model: string): CostResult
  buildMultimodalContent(message: string, images: string[]): any[]
}

// ─── Provider 配置表 ───────────────────────────────────────────────────

interface ProviderSpec {
  name: string
  /** model 名前缀匹配；createProvider 按顺序匹配，命中即用 */
  matches: string[]
  /** API key 环境变量名 */
  envKey: string
  /** baseUrl 环境变量名 */
  envBaseUrl: string
  /** 没配 envBaseUrl 时的默认值（可选） */
  defaultBaseUrl?: string
  /** baseUrl 兜底匹配关键字（用于通用 OPENAI_API_KEY 模式） */
  baseUrlHint?: string
  /** 定价表 */
  pricing: Record<string, PricingInfo>
  /** 找不到 model 时回退的定价 key */
  defaultPricingKey: string
  /** 自定义 reasoning 提取，返回 [reasoning, content]；默认走 delta.reasoning_content */
  parseDelta?: (delta: any) => [string, string]
  /** 前端模型列表 */
  models: { id: string; label: string; extraBody?: Record<string, any> }[]
}

const PROVIDERS: ProviderSpec[] = [
  {
    name: 'minimax',
    matches: ['MiniMax'],
    envKey: 'MINIMAX_API_KEY',
    envBaseUrl: 'MINIMAX_BASE_URL',
    pricing: {
      'MiniMax-M2.7': { input: 2.1, output: 8.4, cacheInput: 0.42, cacheOutput: 2.625, currency: 'CNY' },
      'MiniMax-M2.7-highspeed': { input: 4.2, output: 16.8, cacheInput: 0.42, cacheOutput: 2.625, currency: 'CNY' },
      'MiniMax-M2.5': { input: 2.1, output: 8.4, cacheInput: 0.21, cacheOutput: 2.625, currency: 'CNY' },
      'MiniMax-M2.5-highspeed': { input: 4.2, output: 16.8, cacheInput: 0.21, cacheOutput: 2.625, currency: 'CNY' },
    },
    defaultPricingKey: 'MiniMax-M2.7',
    // MiniMax 思考内容在 delta.reasoning_details[].text，兜底 reasoning_content
    parseDelta: (delta: any) => {
      const details = delta?.reasoning_details
      const reasoning = Array.isArray(details) && details.length
        ? details.filter((d: any) => d.type === 'reasoning.text').map((d: any) => d.text || '').join('')
        : (delta?.reasoning_content || '')
      return [reasoning, delta?.content || '']
    },
    models: [
      { id: 'MiniMax-M2.5', label: 'MiniMax M2.5', extraBody: { reasoning_split: true } },
      { id: 'MiniMax-M2.7', label: 'MiniMax M2.7', extraBody: { reasoning_split: true } },
    ],
  },
  {
    name: 'gemini',
    matches: ['gemini'],
    envKey: 'GEMINI_AI_KEY',
    envBaseUrl: 'GEMINI_BASE_URL',
    baseUrlHint: 'generativelanguage.googleapis.com',
    pricing: {
      'gemini-2.5-flash': { input: 0.15, output: 0.6, cacheInput: 0.0375, cacheOutput: 0.6, currency: 'USD' },
      'gemini-2.5-flash-preview': { input: 0.15, output: 0.6, cacheInput: 0.0375, cacheOutput: 0.6, currency: 'USD' },
      'gemini-2.5-pro': { input: 1.25, output: 10.0, cacheInput: 0.3125, cacheOutput: 10.0, currency: 'USD' },
      'gemini-2.5-pro-preview': { input: 1.25, output: 10.0, cacheInput: 0.3125, cacheOutput: 10.0, currency: 'USD' },
      'gemini-2.0-flash': { input: 0.1, output: 0.4, cacheInput: 0.025, cacheOutput: 0.4, currency: 'USD' },
      'gemini-3-flash-preview': { input: 0.15, output: 0.6, cacheInput: 0.0375, cacheOutput: 0.6, currency: 'USD' },
      'gemini-3.5-flash': { input: 0.15, output: 0.6, cacheInput: 0.0375, cacheOutput: 0.6, currency: 'USD' },
      'gemini-3.1-flash-lite-preview': { input: 0.25, output: 1.5, cacheInput: 0.0625, cacheOutput: 1.5, currency: 'USD' },
    },
    defaultPricingKey: 'gemini-2.5-flash',
    // Gemini 把思考内容塞在 delta.content 的 <thought>...</thought> 里
    parseDelta: (delta: any) => {
      const raw: string = delta?.content || ''
      const isThought = delta?.extra_content?.google?.thought === true
      if (isThought) {
        return [raw.replace(/^<thought>/i, '').replace(/<\/thought>$/i, ''), '']
      }
      if (raw.includes('<thought>') || raw.includes('</thought>')) {
        return ['', raw.replace(/<\/?thought>/gi, '').trim()]
      }
      return ['', raw]
    },
    models: [
      { id: 'gemini-3-flash-preview', label: 'Gemini 3 Flash', extraBody: { extra_body: { google: { thinking_config: { include_thoughts: true } } } } },
      { id: 'gemini-3.5-flash', label: 'Gemini 3.5 Flash', extraBody: { extra_body: { google: { thinking_config: { include_thoughts: true } } } } },
      { id: 'gemini-3.1-flash-lite-preview', label: 'Gemini 3.1 Flash Lite' },
    ],
  },
  {
    name: 'deepseek',
    matches: ['deepseek'],
    envKey: 'DEEPSEEK_API_KEY',
    envBaseUrl: 'DEEPSEEK_BASE_URL',
    baseUrlHint: 'deepseek',
    pricing: {
      'deepseek-chat': { input: 1.0, output: 2.0, cacheInput: 0.1, cacheOutput: 2.0, currency: 'CNY' },
      'deepseek-reasoner': { input: 4.0, output: 16.0, cacheInput: 1.0, cacheOutput: 16.0, currency: 'CNY' },
      'deepseek-v4-flash': { input: 1.0, output: 2.0, cacheInput: 0.1, cacheOutput: 2.0, currency: 'CNY' },
    },
    defaultPricingKey: 'deepseek-chat',
    models: [
      { id: 'deepseek-chat', label: 'DeepSeek Chat' },
      { id: 'deepseek-reasoner', label: 'DeepSeek Reasoner' },
    ],
  },
  {
    name: 'mimo',
    matches: ['mimo'],
    envKey: 'MIMO_API_KEY',
    envBaseUrl: 'MIMO_BASE_URL',
    defaultBaseUrl: 'https://token-plan-sgp.xiaomimimo.com/v1',
    pricing: {
      'mimo-v2.5': { input: 0, output: 0, cacheInput: 0, cacheOutput: 0, currency: 'USD' },
      'mimo-v2.5-pro': { input: 0, output: 0, cacheInput: 0, cacheOutput: 0, currency: 'USD' },
    },
    defaultPricingKey: 'mimo-v2.5-pro',
    models: [
      { id: 'mimo-v2.5', label: 'MiMo v2.5' },
      { id: 'mimo-v2.5-pro', label: 'MiMo v2.5 Pro' },
    ],
  },
]

// 兜底：当 model 名前缀不命中任何 provider 时使用的默认（MiniMax 形态）
const DEFAULT_SPEC = PROVIDERS[0]

// ─── 内部工具 ──────────────────────────────────────────────────────────

/** 默认 reasoning 提取：直接取 delta.reasoning_content（DeepSeek / MiMo） */
const defaultParseDelta = (delta: any): [string, string] =>
  [delta?.reasoning_content || '', delta?.content || '']

/** 按 model 名 + baseUrl 选 spec */
function pickSpec(model: string, baseUrl: string): ProviderSpec {
  const byModel = PROVIDERS.find(p => p.matches.some(m => model.startsWith(m)))
  if (byModel) return byModel
  const byUrl = PROVIDERS.find(p => p.baseUrlHint && baseUrl.includes(p.baseUrlHint))
  return byUrl || DEFAULT_SPEC
}

/** 按 spec 取定价（精确 → 前缀 → 默认 key） */
function getPricing(spec: ProviderSpec, model: string): PricingInfo {
  if (spec.pricing[model]) return spec.pricing[model]
  for (const [key, price] of Object.entries(spec.pricing)) {
    if (model.startsWith(key)) return price
  }
  return spec.pricing[spec.defaultPricingKey]
}

// ─── 公共：构造 Provider 实例 ─────────────────────────────────────────

export function createProvider(config?: { apiKey?: string; baseUrl?: string; model?: string }): Provider {
  const model = config?.model || process.env.DEFAULT_MODEL || ''
  const initialBaseUrl = config?.baseUrl || ''
  const spec = pickSpec(model, initialBaseUrl)

  const apiKey = config?.apiKey
    || process.env[spec.envKey]
    || process.env.OPENAI_API_KEY
    || ''
  const baseUrl = config?.baseUrl
    || process.env[spec.envBaseUrl]
    || spec.defaultBaseUrl
    || process.env.OPENAI_BASE_URL
    || ''

  console.log(`[createProvider] ${spec.name}, model=${model}, key=...${apiKey.slice(-6)}`)

  const parseDelta = spec.parseDelta || defaultParseDelta

  return {
    apiUrl: `${baseUrl}/chat/completions`,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },

    buildRequestBody(options) {
      const modelCfg = spec.models.find(m => m.id === options.model)
      const extra = modelCfg?.extraBody || {}
      return {
        model: options.model,
        messages: options.messages,
        temperature: options.temperature,
        tools: options.tools,
        tool_choice: options.toolChoice || 'auto',
        stream: options.stream ?? true,
        stream_options: options.streamOptions || { include_usage: true },
        ...extra,
      }
    },

    parseChunk(parsed) {
      const choice = parsed?.choices?.[0]
      const delta = choice?.delta
      const [reasoning, content] = delta ? parseDelta(delta) : ['', '']
      const finish = choice?.finish_reason as string | null
      return {
        delta: { reasoning, content, toolCalls: delta?.tool_calls },
        finishReason: finish ? finish.toLowerCase() : null,
        usage: parsed?.usage || null,
        model: parsed?.model || null,
      }
    },

    calcCost(usage, m) {
      const pricing = getPricing(spec, m)
      const prompt = usage?.prompt_tokens || 0
      const completion = usage?.completion_tokens || 0
      const cached = usage?.prompt_tokens_details?.cached_tokens || 0
      const normalInput = prompt - cached

      const inputCost = (normalInput / 1_000_000) * pricing.input
      const cacheCost = (cached / 1_000_000) * pricing.cacheInput
      const outputCost = (completion / 1_000_000) * pricing.output

      return {
        usage: {
          prompt_tokens: prompt,
          completion_tokens: completion,
          total_tokens: usage?.total_tokens || prompt + completion,
          cached_tokens: cached,
        },
        cost: {
          input_cost: +inputCost.toFixed(6),
          cache_cost: +cacheCost.toFixed(6),
          output_cost: +outputCost.toFixed(6),
          total_cost: +(inputCost + cacheCost + outputCost).toFixed(6),
          currency: pricing.currency,
        },
      }
    },


    buildMultimodalContent(message, images) {
      const parts: any[] = []
      for (const img of images) {
        if (/^data:image\/[^;]+;base64,/.test(img)) {
          parts.push({ type: 'image_url', image_url: { url: img } })
        }
      }
      if (message) parts.push({ type: 'text', text: message })
      return parts
    },
  }
}

// ─── 可用模型列表 ──────────────────────────────────────────────────────

export function getAvailableModels(): ModelOption[] {
  const models: ModelOption[] = []
  for (const spec of PROVIDERS) {
    if (process.env[spec.envKey]) {
      for (const m of spec.models) models.push({ ...m, provider: spec.name })
    }
  }
  // 兜底：通用 OPENAI_API_KEY
  if (models.length === 0 && process.env.OPENAI_API_KEY) {
    const id = process.env.DEFAULT_MODEL || ''
    models.push({ id, label: id, provider: 'default' })
  }
  return models
}
