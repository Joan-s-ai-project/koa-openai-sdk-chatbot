import type { PassThrough } from 'stream'

/**
 * 从 fetch Response.body (ReadableStream) 中按 SSE 协议逐条 yield 解析后的 JSON 对象
 *
 * 只关注 `data: ...` 行，自动跳过 `[DONE]` 和无法解析的帧
 */
export async function* parseSSEStream(body: ReadableStream<Uint8Array>): AsyncGenerator<any> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''

  while (true) {
    const { done, value } = await reader.read()
    if (done) break

    buffer += decoder.decode(value, { stream: true })
    const lines = buffer.split('\n')
    buffer = lines.pop() || ''

    for (const line of lines) {
      const trimmed = line.trim()
      if (!trimmed || !trimmed.startsWith('data:')) continue
      const dataStr = trimmed.slice(5).trim()
      if (!dataStr || dataStr === '[DONE]') continue
      try {
        yield JSON.parse(dataStr)
      } catch {
        // 忽略无法解析的帧
      }
    }
  }
}

/** 把任意对象序列化成 SSE 帧 */
export function formatSSE(event: any): string {
  return `data: ${JSON.stringify(event)}\n\n`
}

/** 一个轻量的 SSE 写入器，封装下游 PassThrough 的写入细节 */
export class SSEWriter {
  constructor(private out: PassThrough) { }

  /** 写一条 data 事件 */
  send(event: any): void {
    this.out.write(formatSSE(event))
  }

  /** 写一条原始 SSE 行（如 `event: close`） */
  raw(line: string): void {
    this.out.write(line.endsWith('\n\n') ? line : `${line}\n\n`)
  }

  end(): void {
    this.out.end()
  }
}
