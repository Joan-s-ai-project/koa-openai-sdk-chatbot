/**
 * 文件解析服务
 * 按文件扩展名分发到对应解析器，统一返回纯文本字符串
 */

import path from 'path'
import { parse as parseHtml } from 'node-html-parser'

// ─── 各格式解析器（按需动态 import，避免启动时全量加载） ──────────────

async function parsePdf(buffer: Buffer): Promise<string> {
  const pdfParse = (await import('pdf-parse-new')).default
  const result = await pdfParse(buffer)
  return result.text?.trim() || ''
}

async function parseDoc(buffer: Buffer): Promise<string> {
  // word-extractor 接受文件路径或 Buffer
  const WordExtractor = (await import('word-extractor')).default
  const extractor = new WordExtractor()
  const doc = await extractor.extract(buffer)
  return doc.getBody()?.trim() || ''
}

async function parseOfficeFile(buffer: Buffer): Promise<string> {
  const { parseOffice } = await import('officeparser')
  // 新版 officeparser 返回 AST 对象，调用 .toText() 获取纯文本
  const ast = await parseOffice(buffer)
  return (ast as any).toText?.() ?? String(ast) ?? ''
}

async function parseXlsx(buffer: Buffer): Promise<string> {
  const XLSX = await import('xlsx')
  const workbook = XLSX.read(buffer, { type: 'buffer' })
  const sections: string[] = []
  for (const sheetName of workbook.SheetNames) {
    const sheet = workbook.Sheets[sheetName]
    const csv = XLSX.utils.sheet_to_csv(sheet, { blankrows: false })
    if (csv.trim()) {
      sections.push(`[Sheet: ${sheetName}]\n${csv.trim()}`)
    }
  }
  return sections.join('\n\n')
}

function parseHtmlText(buffer: Buffer): string {
  const html = buffer.toString('utf-8')
  const root = parseHtml(html)
  // 移除 script / style 标签内容
  root.querySelectorAll('script, style').forEach(el => el.remove())
  return root.structuredText.replace(/\n{3,}/g, '\n\n').trim()
}

function parseText(buffer: Buffer): string {
  return buffer.toString('utf-8')
}

// ─── 扩展名映射表 ─────────────────────────────────────────────────────

const EXT_PARSERS: Record<string, (buf: Buffer) => Promise<string>> = {
  '.pdf': parsePdf,
  '.doc': parseDoc,
  '.docx': parseOfficeFile,
  '.pptx': parseOfficeFile,
  '.odt': parseOfficeFile,
  '.odp': parseOfficeFile,
  '.ods': parseOfficeFile,
  '.xlsx': parseXlsx,
  '.xls': parseXlsx,
  '.html': async (buf) => parseHtmlText(buf),
  '.htm': async (buf) => parseHtmlText(buf),
}

// 纯文本类：直接 UTF-8 读取
const TEXT_EXTS = new Set([
  '.txt', '.md', '.markdown', '.csv', '.json', '.xml',
  '.js', '.ts', '.jsx', '.tsx', '.mjs', '.cjs',
  '.py', '.java', '.c', '.cpp', '.cc', '.h', '.hpp',
  '.cs', '.go', '.rs', '.rb', '.php', '.swift', '.kt',
  '.sh', '.bash', '.zsh', '.fish',
  '.yaml', '.yml', '.toml', '.ini', '.env', '.conf',
  '.sql', '.graphql', '.proto',
])

// ─── 对外接口 ─────────────────────────────────────────────────────────

export const fileParserService = {
  /**
   * 解析文件 Buffer，返回提取的纯文本
   * @throws 不支持的格式时抛出错误
   */
  async parse(buffer: Buffer, filename: string): Promise<string> {
    const ext = path.extname(filename).toLowerCase()

    if (EXT_PARSERS[ext]) {
      return EXT_PARSERS[ext](buffer)
    }

    if (TEXT_EXTS.has(ext)) {
      return parseText(buffer)
    }

    throw new Error(`不支持的文件格式: ${ext || '(无扩展名)'}`)
  },

  /** 判断文件名是否为支持的文档格式 */
  isSupportedDocument(filename: string): boolean {
    const ext = path.extname(filename).toLowerCase()
    return ext in EXT_PARSERS || TEXT_EXTS.has(ext)
  },
}
