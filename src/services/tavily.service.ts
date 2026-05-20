import { tavily } from '@tavily/core'

/**
 * Tavily 搜索服务
 */

const tvly = tavily({ apiKey: process.env.TAVILY_API_KEY || '' })

/** 搜索返回值 */
export interface SearchOutput {
  /** 供 LLM 消费的详细纯文本 */
  text: string
  /** 供前端展示的干净摘要 */
  display: string
}

/**
 * 执行网络搜索
 * 返回详细文本（给 LLM）+ 干净摘要（给前端展示）
 */
export async function tavilySearch(query: string): Promise<SearchOutput> {
  const response = await tvly.search(query, {
    searchDepth: 'advanced',
    maxResults: 10,
    includeAnswer: true,
  })

  // 给 LLM 的详细文本（包含 content 片段）
  const lines: string[] = []
  if (response.answer) {
    lines.push(`【搜索摘要】${response.answer}`)
    lines.push('')
  }
  lines.push('【详细来源】')
  for (const [i, result] of response.results.entries()) {
    lines.push(`${i + 1}. ${result.title}`)
    lines.push(`   来源: ${result.url}`)
    if (result.content) {
      const snippet = result.content.slice(0, 300)
      lines.push(`   摘要: ${snippet}${result.content.length > 300 ? '...' : ''}`)
    }
    lines.push('')
  }

  // 给前端展示的干净格式（只有摘要 + 标题链接列表）
  const displayLines: string[] = []
  if (response.answer) {
    displayLines.push(`**概要：** ${response.answer}`)
    displayLines.push('')
  }
  displayLines.push('**搜索结果：**')
  for (const result of response.results) {
    let domain = ''
    try { domain = new URL(result.url).hostname } catch { domain = result.url }
    displayLines.push(`- [${result.title}](${result.url})`)
    displayLines.push(`  ${domain}`)
    displayLines.push('')
  }

  return { text: lines.join('\n'), display: displayLines.join('\n') }
}
