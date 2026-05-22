import * as tavilyTool from './tavily.tool'
import * as bashTool from './bash.tool'

/** 工具执行结果：text 给 LLM，display 给前端展示 */
export interface ToolResult {
  text: string
  display: string
}

/** 工具注册项 */
export interface ToolEntry {
  /** OpenAI 兼容的 tool 声明（直接传给上游 LLM） */
  definition: any
  /** 实际执行函数 */
  execute: (args: any) => Promise<ToolResult>
  /** 当 tool 被触发时，发送给前端的"开始执行"事件 */
  buildStartEvent: (args: Record<string, any>) => Record<string, any>
}

/**
 * 工具注册表 — 新增 tool 在这里加一行就够了
 *
 * 每个 entry 包含 LLM 能看到的声明、实际执行逻辑、前端展示事件，
 * 不需要在 controller / service 里再 switch 一次。
 */
export const TOOL_REGISTRY: Record<string, ToolEntry> = {
  search_web: {
    definition: tavilyTool.definition,
    execute: tavilyTool.execute,
    buildStartEvent: (args) => ({ type: 'searching', query: args.query || '' }),
  },
  run_bash: {
    definition: bashTool.definition,
    execute: bashTool.execute,
    buildStartEvent: (args) => ({ type: 'bash_running', command: args.command || '' }),
  },
}

/** 所有可用 tool 的声明数组（直接传给 provider.buildRequestBody） */
export const TOOL_DEFINITIONS = Object.values(TOOL_REGISTRY).map(t => t.definition)

/** 按名称分发 tool 执行；未知 tool 返回降级结果 */
export async function dispatchTool(name: string, args: Record<string, any>): Promise<ToolResult> {
  const entry = TOOL_REGISTRY[name]
  if (!entry) {
    return { text: `未知工具：${name}`, display: `⚠️ 未知工具：${name}` }
  }
  try {
    return await entry.execute(args)
  } catch (err: any) {
    const msg = `工具执行失败：${err.message}`
    return { text: msg, display: msg }
  }
}

/** 构建发给前端的"开始执行"事件 */
export function buildToolStartEvent(name: string, args: Record<string, any>): Record<string, any> {
  const entry = TOOL_REGISTRY[name]
  if (!entry) return { type: 'tool_running', name, args }
  return entry.buildStartEvent(args)
}
