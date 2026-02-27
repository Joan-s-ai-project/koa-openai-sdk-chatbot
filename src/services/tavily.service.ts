import { tavily } from '@tavily/core'

/**
 * Tavily 搜索服务
 * 
 * 封装说明：
 * - 客户端初始化从 .env 读取 TAVILY_API_KEY，不硬编码
 * - tavilySearch() 返回一段格式化纯文本，专为 LLM 消费设计
 *   格式：摘要答案（如有）+ 每条结果的标题、来源 URL、摘要内容
 */

const tvly = tavily({ apiKey: process.env.TAVILY_API_KEY || '' })

/**
 * 执行网络搜索，返回供 LLM 阅读的纯文本摘要
 * @param query 搜索关键词（由 LLM Function Call 提供）
 * @returns 格式化的搜索结果文本
 */
export async function tavilySearch(query: string): Promise<string> {
  const response = await tvly.search(query, {
    searchDepth: 'advanced',
    maxResults: 5,
    includeAnswer: true, // 让 Tavily 返回一个简短的直接答案
  })

  const lines: string[] = []

  // 1. 如果有直接摘要答案，优先附上
  if (response.answer) {
    lines.push(`【搜索摘要】${response.answer}`)
    lines.push('')
  }

  // 2. 逐条拼接搜索结果
  lines.push('【详细来源】')
  for (const [i, result] of response.results.entries()) {
    lines.push(`${i + 1}. ${result.title}`)
    lines.push(`   来源: ${result.url}`)
    if (result.content) {
      // 截断过长的内容片段，避免 token 浪费
      const snippet = result.content.slice(0, 300)
      lines.push(`   摘要: ${snippet}${result.content.length > 300 ? '...' : ''}`)
    }
    lines.push('')
  }

  return lines.join('\n')
}
