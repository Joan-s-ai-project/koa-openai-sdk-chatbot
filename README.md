# koa-openai-sdk-chatbot

基于 Koa + TypeScript 的 OpenAI API 代理服务，提供兼容 OpenAI SDK 的 `/v1/chat/completions` 接口，支持流式（SSE）和非流式响应。

## 功能特性

- 🔄 **OpenAI 协议兼容** — 前端可直接使用 OpenAI SDK 调用，无需额外适配
- 📡 **流式响应（SSE）** — 支持 `stream: true`，实时逐字输出
- 📦 **参数透传** — 前端传入 `messages`、`model`、`temperature` 等参数，后端直接转发
- 🔑 **API Key 后端托管** — 密钥存放在后端环境变量，前端无需暴露
- 🌐 **多平台兼容** — 支持 OpenAI、DeepSeek、ppinfra 等任何 OpenAI 兼容的 API 服务

## 技术栈

- **Koa** - Web 框架
- **TypeScript** - 类型支持
- **OpenAI SDK** - 对接 OpenAI 兼容的 API
- **dotenv** - 环境变量管理

## 快速开始

### 1. 安装依赖

```bash
npm install
```

### 2. 配置环境变量

复制 `.env.example` 并填入你的配置：

```bash
cp .env.example .env
```

```env
OPENAI_API_KEY=your-api-key-here
OPENAI_BASE_URL=https://api.openai.com/v1
OPENAI_MODEL=gpt-4o-mini
```

> 支持任何 OpenAI 兼容的 API 服务（如 ppinfra、DeepSeek 等），只需修改 `OPENAI_BASE_URL`。

### 3. 启动开发服务

```bash
npm run dev
```

服务默认运行在 `http://localhost:3000`。

## API 接口

### `GET /`

健康检查，返回服务状态。

### `POST /v1/chat/completions`

透传前端参数到 OpenAI，支持流式和非流式。

**非流式请求：**

```bash
curl -X POST http://localhost:3000/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gpt-4o-mini",
    "messages": [{"role": "user", "content": "你好"}]
  }'
```

**流式请求：**

```bash
curl -X POST http://localhost:3000/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gpt-4o-mini",
    "messages": [{"role": "user", "content": "你好"}],
    "stream": true
  }'
```

### 前端通过 OpenAI SDK 调用

由于接口兼容 OpenAI 协议，前端可直接使用 OpenAI SDK：

```typescript
import OpenAI from 'openai'

const client = new OpenAI({
  baseURL: '/v1',           // 通过 Vite proxy 转发到 localhost:3000
  apiKey: 'any',            // API Key 在后端管理，这里随意填
  dangerouslyAllowBrowser: true,
})

// 非流式
const completion = await client.chat.completions.create({
  model: 'gpt-4o-mini',
  messages: [{ role: 'user', content: '你好' }],
})

// 流式
const stream = await client.chat.completions.create({
  model: 'gpt-4o-mini',
  messages: [{ role: 'user', content: '你好' }],
  stream: true,
})

for await (const chunk of stream) {
  process.stdout.write(chunk.choices[0]?.delta?.content || '')
}
```

## 可用脚本

| 命令 | 说明 |
|------|------|
| `npm run dev` | 启动开发服务 |
| `npm run build` | 编译 TypeScript |
| `npm start` | 运行编译后的代码 |

## 项目结构

```
koa-openai-sdk-chatbot/
├── src/
│   └── app.ts          # 入口文件（包含路由、OpenAI 配置）
├── .env                # 环境变量（不提交到 git）
├── .env.example        # 环境变量模板
├── package.json
└── tsconfig.json
```
