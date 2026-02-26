import fs from 'fs'
import path from 'path'

const DATA_DIR = process.env.DATA_DIR || 'data/'

/**
 * JSONL 文件读写服务
 * 纯 I/O 封装，不关心业务含义
 */
class JsonlStorage {
  private dataDir: string

  constructor(dataDir: string) {
    this.dataDir = dataDir
    // 确保目录存在
    if (!fs.existsSync(this.dataDir)) {
      fs.mkdirSync(this.dataDir, { recursive: true })
    }
  }

  /** 追加一行到文件 */
  append(filename: string, data: Record<string, any>): void {
    const filePath = path.join(this.dataDir, `${filename}.jsonl`)
    fs.appendFileSync(filePath, JSON.stringify(data) + '\n')
  }

  /** 读取整个文件，返回对象数组 */
  readAll(filename: string): Record<string, any>[] {
    const filePath = path.join(this.dataDir, `${filename}.jsonl`)
    if (!fs.existsSync(filePath)) return []
    const content = fs.readFileSync(filePath, 'utf-8').trim()
    if (!content) return []
    return content.split('\n').map(line => JSON.parse(line))
  }

  /** 文件是否存在 */
  exists(filename: string): boolean {
    return fs.existsSync(path.join(this.dataDir, `${filename}.jsonl`))
  }

  /** 列出所有文件名（不含扩展名） */
  listFiles(): string[] {
    if (!fs.existsSync(this.dataDir)) return []
    return fs.readdirSync(this.dataDir)
      .filter(f => f.endsWith('.jsonl'))
      .map(f => f.replace('.jsonl', ''))
  }
}

// 单例导出
export const jsonlStorage = new JsonlStorage(DATA_DIR)
