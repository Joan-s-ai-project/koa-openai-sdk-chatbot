# 后端开发步骤记录（koa-openai-sdk-chatbot）

每一步：开发 → 运行 → 验证通过 → 提交

---

## Step 1 — 项目结构 + 路由骨架 ✅

**做了什么**：把原来的单文件 `app.ts` 拆分为 3 层架构

**创建/修改的文件**：
- `src/app.ts` — 精简为入口，只加载中间件和路由
- `src/routes/chat.ts` — 定义 `POST /api/chat` 和 `POST /api/chat/stream` 路由
- `src/controllers/chat.controller.ts` — 占位 handler，返回 `{ message: "..." }`
- `src/middlewares/errorHandler.ts` — 全局 try-catch，统一返回 `{ error: {...} }` 格式
- `src/types/chat.ts` — `ChatMessage`、`StreamChunk`、`ChatRequestBody` 类型定义

**额外处理**：
- `nodemon.json` 的 exec 改为 `npx ts-node` 解决 PATH 问题
- `npm install` 安装本地 node_modules

**验证**：
```bash
curl -X POST http://localhost:3000/api/chat/stream
→ { "message": "chat stream endpoint - coming soon" }  ✅

curl -X POST http://localhost:3000/api/chat
→ { "message": "chat endpoint - coming soon" }  ✅
```

---

## Step 2 — LLMService（非流式） ✅

**做了什么**：封装 OpenAI SDK 调用为独立 Service，Controller 调用 Service

**创建/修改的文件**：
- `src/services/llm.service.ts` — `chat()` 方法，读取 env 配置调用 OpenAI
- `src/controllers/chat.controller.ts` — 校验 message 参数 → 调用 `llmService.chat()`
- `.env.example` — 新增 `DEFAULT_MODEL`、`DEFAULT_TEMPERATURE`、`SYSTEM_PROMPT`、`DATA_DIR`、`PORT`

**学到的知识**：
- curl 必须加 `-H 'Content-Type: application/json'`，否则 koa-bodyparser 不解析 body
- Controller vs Service 职责分离：Controller 管 HTTP，Service 管业务逻辑

**验证**：
```bash
curl -X POST http://localhost:3000/api/chat \
  -H 'Content-Type: application/json' \
  -d '{"sessionId":"test","message":"你好，用一句话介绍自己"}'
→ { "content": "我是Z.ai开发的GLM大语言模型...", "usage": {...} }  ✅

curl -X POST http://localhost:3000/api/chat -d '{}'
→ { "error": { "code": "INVALID_REQUEST", "message": "缺少 message 字段" } }  ✅
```

---

## Step 3 — LLMService（流式 SSE） ✅

**做了什么**：新增 `chatStream()` async generator，Controller 用 PassThrough 输出 SSE

**创建/修改的文件**：
- `src/services/llm.service.ts` — 新增 `chatStream()` 方法，yield `reasoning` / `content` / `done`
- `src/controllers/chat.controller.ts` — `stream()` 设置 SSE 头，IIFE 异步写入 PassThrough

**学到的知识**：
- SSE 格式：`data: {...}\n\n`（两个换行）
- 流式写入用 IIFE 包裹：让 handler 立刻 return → Koa 开始推流 → IIFE 后台写数据
- OpenAI 流式 usage 需要 `stream_options: { include_usage: true }`，且 usage 只在最后一个 chunk
- `let usage` 必须声明在 `for` 循环外面，否则循环结束后变量就没了

**验证**：
```bash
curl -N -X POST http://localhost:3000/api/chat/stream \
  -H 'Content-Type: application/json' \
  -d '{"sessionId":"test","message":"你好"}'
→ data: {"type":"reasoning","content":"收到"}
→ data: {"type":"reasoning","content":"用户"}
→ ...
→ data: {"type":"content","content":"你好！"}
→ ...
→ data: {"type":"done","usage":{"prompt_tokens":6,"completion_tokens":150,...}}  ✅
```

**Git commit**: `Step 3 — LLMService（流式 SSE）`

---

## Step 4 — ContextService（内存上下文） ✅

**做了什么**：按 sessionId 管理会话历史，实现多轮对话

**创建/修改的文件**：
- `src/services/context.service.ts` — `Map<sessionId, ChatMessage[]>`，`getMessages()` / `addExchange()`
- `src/controllers/chat.controller.ts` — 两个 handler 都接入 ContextService

**工作流程**：
1. Controller 用 `contextService.getMessages(sessionId)` 取历史
2. 拼上当前 user message → 发给 LLM
3. 拿到回复后 `contextService.addExchange(sessionId, userMsg, aiMsg)` 存回

**验证**：
```bash
curl ... -d '{"sessionId":"ctx-test","message":"我叫小明"}' | jq .content
→ "你好，小明！很高兴认识你..."  ✅

curl ... -d '{"sessionId":"ctx-test","message":"我叫什么名字？"}' | jq .content
→ "你叫小明呀。刚才你告诉我的，对吗？"  ✅  ← 上下文生效
```

**Git commit**: `Step 4 — ContextService（内存上下文）`

---

## Step 5 — JsonlStorage（文件持久化） ✅

**做了什么**：封装 JSONL 文件读写，ContextService 双写内存+磁盘

**创建/修改的文件**：
- `src/services/jsonl-storage.ts` — `append()` / `readAll()` / `exists()` / `listFiles()`
- `src/services/context.service.ts` — 接入 JsonlStorage，新会话写入、旧会话从磁盘恢复
- `.gitignore` — 新增 `data/`

**数据流**：
- 新 sessionId → 创建 `data/{sessionId}.jsonl`，写入 system prompt
- 对话结束 → `append` user + assistant 两行到文件
- 服务重启 → 用旧 sessionId 请求时从 JSONL 加载到内存

**验证**：
```bash
curl ... -d '{"sessionId":"ctx-test","message":"我叫小明"}'
ls data/  → ctx-test.jsonl  ✅
cat data/ctx-test.jsonl  → 3 行（system + user + assistant）  ✅
```

**Git commit**: `Step 5 — JsonlStorage（文件持久化）`

---

## Step 6 — 历史接口 ✅

**做了什么**：添加查看历史会话的 API

**创建/修改的文件**：
- `src/controllers/chat.controller.ts` — 新增 `listHistory()` / `getHistory()`
- `src/routes/chat.ts` — 新增 `GET /api/history` 和 `GET /api/history/:id`

**listHistory 逻辑**：扫描 data/ 下所有 .jsonl → 读取每个文件 → 取首条 user 消息作标题 → 按时间倒序

**验证**：
```bash
curl -s http://localhost:3000/api/history | jq .
→ [{ "id": "ctx-test", "title": "我叫小明", "createdAt": "...", "messageCount": 5 }]  ✅

curl -s http://localhost:3000/api/history/ctx-test | jq .
→ [{ "role": "system", ... }, { "role": "user", ... }, ...]  ✅
```

**Git commit**: `Step 6 — 历史接口`

---

## Step 7 — 错误处理 + 收尾 ✅

**做了什么**：完善错误分类，Controller 用 `ctx.throw()` 简化验证代码

**创建/修改的文件**：
- `src/middlewares/errorHandler.ts` — 增加 404/429 映射，自动识别 OpenAI 错误，日志带 method+path
- `src/controllers/chat.controller.ts` — 所有手动 error response 改为 `ctx.throw()`

**重构前后**：
```typescript
// 之前（每处写 4 行）
if (!message) {
  ctx.status = 400
  ctx.body = { error: { code: 'INVALID_REQUEST', message: '缺少...', status: 400 } }
  return
}

// 之后（1 行，中间件兜底）
if (!message) ctx.throw(400, '缺少 message 字段')
```

**验证**：
```bash
curl ... -d '{}'
→ { "error": { "code": "INVALID_REQUEST", "message": "缺少 message 字段", "status": 400 } }  ✅

curl http://localhost:3000/api/history/not-exist
→ { "error": { "code": "NOT_FOUND", "message": "会话不存在", "status": 404 } }  ✅
```

**Git commit**: `Step 7 — 错误处理 + 收尾`

---

## 最终架构总览

```
src/
├── app.ts                          # 入口
├── routes/chat.ts                  # 路由 → Controller
├── controllers/chat.controller.ts  # HTTP 层（参数、响应、SSE）
├── services/
│   ├── llm.service.ts              # OpenAI SDK 调用
│   ├── context.service.ts          # 会话上下文管理（内存 Map）
│   └── jsonl-storage.ts            # JSONL 文件读写
├── middlewares/errorHandler.ts     # 全局错误捕获
└── types/chat.ts                   # 类型定义
```

| 接口 | 方法 | 功能 |
|---|---|---|
| `/api/chat` | POST | 非流式聊天 |
| `/api/chat/stream` | POST | SSE 流式聊天 |
| `/api/history` | GET | 会话列表 |
| `/api/history/:id` | GET | 会话详情 |
