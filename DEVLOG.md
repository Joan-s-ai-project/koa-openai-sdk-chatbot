# 前端开发步骤（frontend-vue3-chatbot）

现状：`App.vue` 564 行单文件，直接从浏览器调 OpenAI SDK。
目标：重构为组件化结构，通过 Koa 后端 API 交互。

每一步：开发 → 运行 → 浏览器验证 → 下一步

---

## Step 1 — 清理 + API Service + Vite Proxy

**做什么**：
- 清空 `App.vue`，只留一个 "Hello Chat" 占位
- 删掉 `services/openai.ts`（不再直接调 OpenAI SDK）
- 新建 `services/chat.ts` — 封装后端 `/api/chat` 和 `/api/chat/stream` 调用
- 修改 `vite.config.ts` — 清理旧代理，加 `/api` → `localhost:3000` 代理
- 生成 `sessionId`（`crypto.randomUUID()`）

**验证**：浏览器打开 → 看到 "Hello Chat" → 控制台无报错

- [ ] 完成

---

## Step 2 — ChatInput 组件 + 非流式发送

**做什么**：
- 新建 `components/ChatInput.vue` — 输入框 + 发送按钮
- `App.vue` 引入 ChatInput，调用 `chatService.send()` 发非流式请求
- 把 AI 回复 `console.log` 出来，确认后端通了

**验证**：输入 "你好" → 点发送 → 控制台打印 AI 回复内容

- [ ] 完成

---

## Step 3 — MessageList + MessageBubble 组件（消息展示）

**做什么**：
- 新建 `components/MessageList.vue` — 消息列表容器，自动滚动到底部
- 新建 `components/MessageBubble.vue` — 单条消息气泡（区分 user / assistant）
- `App.vue` 维护 `messages[]`，发送后推入 user 消息，收到回复推入 assistant 消息

**验证**：浏览器里看到对话气泡，user 靠右，assistant 靠左

- [ ] 完成

---

## Step 4 — 流式 SSE 接入 + 打字效果

**做什么**：
- `services/chat.ts` — 新增 `sendStream()` 方法，用 `fetch` + `ReadableStream` 解析 SSE
- `App.vue` 切换为调用 `sendStream()`，实时更新 assistant 消息内容
- 打字效果：流式追加 content → 页面实时显示

**验证**：发消息后，AI 回复逐字出现（而非整块出现）

- [ ] 完成

---

## Step 5 — ThinkingBlock 组件（推理过程展示）

**做什么**：
- 新建 `components/ThinkingBlock.vue` — 可折叠的推理过程展示
- `MessageBubble.vue` 里判断有 `reasoning` 就渲染 ThinkingBlock
- SSE 解析时分别收集 `reasoning` 和 `content`

**验证**：发消息后看到 "思考中..." 折叠块，展开可看到推理过程

- [ ] 完成

---

## Step 6 — UI 美化 + 体验优化

**做什么**：
- 整体布局：顶栏 + 消息区 + 输入区
- 加载状态：发送时 loading 动画
- 空状态：欢迎页面
- 自适应：手机/桌面布局
- 键盘：Enter 发送 / Shift+Enter 换行
- 体验优化：打字效果智能自动滚到底部（用户上滑浏览时自动暂停）

**验证**：整体 UI 美观、流畅、可用

- [x] 完成
