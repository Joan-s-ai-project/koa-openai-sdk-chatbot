# SSEWriter 设计文档

## 背景

在基于 Koa 的流式聊天接口中，服务端需要通过 SSE（Server-Sent Events）协议持续向客户端推送事件。原始做法是直接操作 `PassThrough` 流并手动拼接 SSE 格式字符串，这会导致格式化逻辑散落在各个 controller 中，容易出错且难以维护。

`SSEWriter` 是对这一模式的轻量封装，目标是让 controller 只关心"发什么"，不关心"怎么格式化"。

---

## 文件位置

```
src/utils/sse.ts
```

---

## 相关函数

### `formatSSE(event: any): string`

将任意对象序列化为标准 SSE 数据帧：

```
data: {"type":"content","content":"hello"}\n\n
```

这是 SSE 协议中最基础的帧格式，`SSEWriter.send()` 内部依赖它。

### `parseSSEStream(body: ReadableStream<Uint8Array>)`

从上游 fetch 响应的 `ReadableStream` 中逐帧解析 SSE，供 `agent.service.ts` 消费上游 LLM 的流式响应使用。与 `SSEWriter` 方向相反——一个负责读，一个负责写。

---

## SSEWriter 类

### 设计目标

| 目标 | 说明 |
|------|------|
| 封装格式化细节 | 调用方无需关心 `data: ...\n\n` 的拼接 |
| 防止低级错误 | `raw()` 自动补全 `\n\n`，避免遗漏导致客户端无法解析 |
| 统一关闭入口 | `end()` 集中管理底层流的生命周期 |
| 保持轻量 | 不引入状态机、不做重试、不做缓冲，职责单一 |

### 接口

```ts
class SSEWriter {
  constructor(private out: PassThrough)

  /** 发送一条 data 事件，自动 JSON 序列化 */
  send(event: any): void

  /** 发送一条原始 SSE 行，如 `event: close`，自动补 \n\n */
  raw(line: string): void

  /** 关闭底层流 */
  end(): void
}
```

### 方法说明

#### `send(event)`

最常用的方法，将结构化事件对象写入流：

```ts
sse.send({ type: 'content', content: 'hello' })
// 写入: data: {"type":"content","content":"hello"}\n\n

sse.send({ type: 'done', model: 'gpt-4o' })
// 写入: data: {"type":"done","model":"gpt-4o"}\n\n
```

#### `raw(line)`

用于发送 SSE 控制帧（非 data 行），会自动补全末尾的 `\n\n`：

```ts
sse.raw('event: close')
// 写入: event: close\n\n
```

如果传入的字符串已经以 `\n\n` 结尾，则不重复添加。

#### `end()`

关闭底层 `PassThrough` 流，通知客户端连接结束：

```ts
sse.end()
```

通常放在 `finally` 块中确保一定执行。

---

## 在 Controller 中的使用模式

### 初始化

`prepareSSE()` 是 controller 内的私有工厂函数，负责设置响应头并返回 `SSEWriter` 实例：

```ts
function prepareSSE(ctx: Koa.Context): SSEWriter {
  ctx.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no',
  })
  ctx.compress = false

  const passthrough = new PassThrough()
  ctx.status = 200
  ctx.body = passthrough
  return new SSEWriter(passthrough)
}
```

### 标准使用模式

所有 SSE 接口遵循同一套模式：

```ts
export async function chatCompletion(ctx: Koa.Context) {
  const sse = prepareSSE(ctx)

  ;(async () => {
    try {
      for await (const event of runAgent(input)) {
        sse.send(event)          // 发送业务事件
      }
      sse.raw('event: close')    // 发送关闭控制帧
    } catch (err: any) {
      sse.send({ type: 'error', message: err.message })
    } finally {
      sse.end()                  // 确保流关闭
    }
  })()
}
```

注意异步块与 `ctx` 响应是解耦的——Koa 在 `ctx.body = passthrough` 时即开始响应，后续写入通过流推送，不阻塞事件循环。

---

## 职责边界

```
┌─────────────────────────────────────────────────────┐
│                  chat.controller.ts                  │
│                                                      │
│  prepareSSE()  →  new SSEWriter(passthrough)         │
│                                                      │
│  sse.send()  /  sse.raw()  /  sse.end()              │
└──────────────────────┬──────────────────────────────┘
                       │ 只关心"发什么"
                       ▼
┌─────────────────────────────────────────────────────┐
│                    SSEWriter                         │
│                                                      │
│  formatSSE()  →  passthrough.write()                 │
│                                                      │
│  负责"怎么格式化"和"何时关闭"                         │
└─────────────────────────────────────────────────────┘
```

`agent.service.ts` 完全不感知 `SSEWriter`，它只负责 `yield AgentEvent`，格式化和写入由 controller 层处理。这保证了 service 层的可测试性和协议无关性。

---

## 可选的演进方向

如果项目中 `raw()` 始终只用于发送 `event: close`，可以将其合并进 `end()`，简化接口：

```ts
end(sendClose = false): void {
  if (sendClose) this.out.write('event: close\n\n')
  this.out.end()
}
```

调用方变为：

```ts
sse.end(true)  // 发 close 帧后关闭
```

这是风格取舍，适合在 `raw()` 使用场景确定不会扩展时采用。

---

## 总结

`SSEWriter` 是一个职责单一、边界清晰的轻量封装：

- **不过度封装**：没有引入不必要的抽象层，底层仍是 `PassThrough`
- **解决了真实问题**：格式化逻辑集中，`\n\n` 补全自动化，关闭入口统一
- **与架构契合**：controller 负责协议适配，service 负责业务逻辑，两者通过 `AsyncGenerator` 解耦
