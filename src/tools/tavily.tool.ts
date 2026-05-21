import { tavily } from '@tavily/core'

const tvly = tavily({ apiKey: process.env.TAVILY_API_KEY || '' })

export const definition = {
  type: 'function' as const,
  function: {
    name: 'search_web',
    description: '当问题涉及实时信息、近期新闻、最新数据或你的训练数据截止日期之后的内容时，使用此工具搜索互联网获取最新资讯。',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '要搜索的关键词或问题，尽量简洁精准' },
      },
      required: ['query'],
    },
  },
}

export async function execute(args: { query: string }) {
  const response = await tvly.search(args.query, {
    searchDepth: 'advanced',
    maxResults: 10,
    includeAnswer: true,
  })

  // 给 LLM 的详细文本
  const lines: string[] = []
  if (response.answer) {
    lines.push(`【搜索摘要】${response.answer}`, '')
  }
  lines.push('【详细来源】')
  for (const [i, r] of response.results.entries()) {
    lines.push(`${i + 1}. ${r.title}`, `   来源: ${r.url}`)
    if (r.content) lines.push(`   摘要: ${r.content.slice(0, 300)}${r.content.length > 300 ? '...' : ''}`)
    lines.push('')
  }

  // 给前端展示的 Markdown
  const display: string[] = []
  if (response.answer) display.push(`**概要：** ${response.answer}`, '')
  display.push('**搜索结果：**')
  for (const r of response.results) {
    let domain = ''
    try { domain = new URL(r.url).hostname } catch { domain = r.url }
    display.push(`- [${r.title}](${r.url})`, `  ${domain}`, '')
  }

  return { text: lines.join('\n'), display: display.join('\n') }
}
