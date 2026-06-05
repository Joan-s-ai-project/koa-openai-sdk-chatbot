/**
 * Browser Tool — 基于 Playwright 的无头浏览器工具
 *
 * 每个 sessionId 维护一个独立的浏览器上下文（独立 Cookie/Storage），
 * 空闲超过 IDLE_TIMEOUT_MS 后自动关闭，节省资源。
 *
 * 对外暴露的 action：
 *   navigate    — 打开 URL，返回标题 + 状态码 + 页面摘要
 *   screenshot  — 截图，返回 base64 PNG（可直接传给多模态模型）
 *   get_text    — 提取当前页面的纯文本内容
 *   get_html    — 获取当前页面的精简 HTML（去掉 script/style）
 *   click       — 点击指定 CSS selector 的元素
 *   type        — 在指定元素中输入文字
 *   select      — 选择 <select> 下拉框的选项
 *   evaluate    — 在页面中执行 JavaScript，返回结果
 *   scroll      — 滚动页面（up/down/top/bottom 或像素值）
 *   wait        — 等待指定 selector 出现
 *   go_back     — 浏览器后退
 *   close       — 关闭当前会话的浏览器
 */

import { chromium, type Browser, type BrowserContext, type Page } from 'playwright'
import * as fs from 'fs'
import * as path from 'path'

// ─── 配置 ─────────────────────────────────────────────────────────────────────

const IDLE_TIMEOUT_MS = 5 * 60 * 1000   // 5 分钟无操作自动关闭
const NAV_TIMEOUT_MS = 30_000           // 页面导航超时
const ACTION_TIMEOUT = 10_000           // 元素操作超时
const MAX_TEXT_LEN = 8_000              // 返回给 LLM 的最大文本长度
const MAX_HTML_LEN = 12_000             // 返回给 LLM 的最大 HTML 长度

// 与 bash.tool.ts 保持一致，截图存入对应 session 的沙箱目录
const SANDBOX_ROOT = process.env.BASH_SANDBOX_ROOT || path.join(process.cwd(), 'sandbox')

// ─── 会话管理 ─────────────────────────────────────────────────────────────────

interface SessionEntry {
  browser: Browser
  context: BrowserContext
  page: Page
  timer: ReturnType<typeof setTimeout>
}

const sessions = new Map<string, SessionEntry>()
let sharedBrowser: Browser | null = null

async function getSharedBrowser(): Promise<Browser> {
  if (!sharedBrowser || !sharedBrowser.isConnected()) {
    sharedBrowser = await chromium.launch({
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
      ],
    })
  }
  return sharedBrowser
}

async function getSession(sessionId: string): Promise<SessionEntry> {
  if (sessions.has(sessionId)) {
    const entry = sessions.get(sessionId)!
    // 重置空闲计时器
    clearTimeout(entry.timer)
    entry.timer = setTimeout(() => closeSession(sessionId), IDLE_TIMEOUT_MS)
    return entry
  }

  // 新建会话
  const browser = await getSharedBrowser()
  const context = await browser.newContext({
    viewport: { width: 1280, height: 800 },
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    locale: 'zh-CN',
    timezoneId: 'Asia/Shanghai',
  })
  const page = await context.newPage()

  const timer = setTimeout(() => closeSession(sessionId), IDLE_TIMEOUT_MS)
  const entry: SessionEntry = { browser, context, page, timer }
  sessions.set(sessionId, entry)
  return entry
}

async function closeSession(sessionId: string): Promise<void> {
  const entry = sessions.get(sessionId)
  if (!entry) return
  clearTimeout(entry.timer)
  sessions.delete(sessionId)
  try {
    await entry.context.close()
  } catch { /* 忽略关闭错误 */ }
}

// ─── 工具定义 ─────────────────────────────────────────────────────────────────

export const definition = {
  type: 'function' as const,
  function: {
    name: 'browser',
    description: `控制无头浏览器完成网页交互任务。支持打开网页、截图、提取文本、点击、输入、执行 JS 等操作。
每个会话有独立的浏览器上下文（独立 Cookie/Storage），5 分钟无操作后自动关闭。
适用场景：网页自动化、表单填写、页面截图、抓取动态内容（JS 渲染页面）、网页操作演示等。`,
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['navigate', 'screenshot', 'get_text', 'get_html', 'click', 'type', 'select', 'evaluate', 'scroll', 'wait', 'go_back', 'close'],
          description: '要执行的浏览器操作',
        },
        url: {
          type: 'string',
          description: '[navigate] 要打开的完整 URL，必须包含 http:// 或 https://',
        },
        selector: {
          type: 'string',
          description: '[click/type/select/wait] CSS selector 或文本选择器（如 "text=登录"）',
        },
        text: {
          type: 'string',
          description: '[type] 要输入的文字内容',
        },
        value: {
          type: 'string',
          description: '[select] 要选择的 <option> value 值',
        },
        script: {
          type: 'string',
          description: '[evaluate] 要在页面中执行的 JavaScript 代码，最后一个表达式的值会被返回',
        },
        direction: {
          type: 'string',
          enum: ['up', 'down', 'top', 'bottom'],
          description: '[scroll] 滚动方向，默认 down',
        },
        pixels: {
          type: 'number',
          description: '[scroll] 滚动像素数，默认 500',
        },
      },
      required: ['action'],
    },
  },
}

// ─── 执行入口 ─────────────────────────────────────────────────────────────────

export async function execute(
  args: {
    action: string
    url?: string
    selector?: string
    text?: string
    value?: string
    script?: string
    direction?: string
    pixels?: number
  },
  sessionId = 'default',
): Promise<{ text: string; display: string }> {
  try {
    return await dispatch(args, sessionId)
  } catch (err: any) {
    const msg = `浏览器操作失败：${err.message}`
    return { text: msg, display: `❌ ${msg}` }
  }
}

async function dispatch(
  args: Parameters<typeof execute>[0],
  sessionId: string,
): Promise<{ text: string; display: string }> {
  const { action } = args

  // close 不需要 page
  if (action === 'close') {
    await closeSession(sessionId)
    return { text: '浏览器已关闭', display: '🔒 浏览器已关闭' }
  }

  const { page } = await getSession(sessionId)

  switch (action) {
    case 'navigate': return doNavigate(page, args.url!)
    case 'screenshot': return doScreenshot(page, sessionId)
    case 'get_text': return doGetText(page)
    case 'get_html': return doGetHtml(page)
    case 'click': return doClick(page, args.selector!)
    case 'type': return doType(page, args.selector!, args.text ?? '')
    case 'select': return doSelect(page, args.selector!, args.value!)
    case 'evaluate': return doEvaluate(page, args.script!)
    case 'scroll': return doScroll(page, args.direction ?? 'down', args.pixels ?? 500)
    case 'wait': return doWait(page, args.selector!)
    case 'go_back': return doGoBack(page)
    default:
      return { text: `未知 action: ${action}`, display: `⚠️ 未知 action: ${action}` }
  }
}

// ─── 各 action 实现 ───────────────────────────────────────────────────────────

async function doNavigate(page: Page, url: string) {
  if (!/^https?:\/\//i.test(url)) url = 'https://' + url

  const response = await page.goto(url, {
    waitUntil: 'domcontentloaded',
    timeout: NAV_TIMEOUT_MS,
  })

  const status = response?.status() ?? 0
  const title = await page.title()
  const currentUrl = page.url()

  // 提取页面摘要（前 1000 字）
  const bodyText = await page.evaluate(() => {
    const body = document.body
    if (!body) return ''
    return body.innerText.replace(/\s+/g, ' ').trim().slice(0, 1000)
  })

  const text = `已导航到: ${currentUrl}\n标题: ${title}\nHTTP状态: ${status}\n\n页面摘要:\n${bodyText}`
  const display = `🌐 **${title}**\n\`${currentUrl}\` (HTTP ${status})\n\n${bodyText.slice(0, 300)}${bodyText.length > 300 ? '...' : ''}`

  return { text, display }
}

async function doScreenshot(page: Page, sessionId: string) {
  const buffer = await page.screenshot({ type: 'png', fullPage: false })
  const base64 = buffer.toString('base64')
  const dataUrl = `data:image/png;base64,${base64}`

  const title = await page.title()
  const url = page.url()

  // 保存到沙箱目录，文件名用时间戳
  const safeId = sessionId.replace(/[^a-zA-Z0-9_-]/g, '_')
  const sandboxDir = path.join(SANDBOX_ROOT, safeId)
  fs.mkdirSync(sandboxDir, { recursive: true })
  const filename = `screenshot_${Date.now()}.png`
  const filepath = path.join(sandboxDir, filename)
  fs.writeFileSync(filepath, buffer)

  // text 给 LLM：只告知文件路径，不传 base64（避免撑爆 context window）
  const port = process.env.PORT || 3000
  const httpUrl = `http://localhost:${port}/sandbox/${safeId}/${filename}`
  const text = `截图完成。当前页面: ${title} (${url})\n已保存至沙箱: ${filename}\n可访问地址: ${httpUrl}\n如需在回复中展示图片，请使用: ![截图](${httpUrl})`

  // display 给前端：带 base64 直接渲染
  const display = `📸 截图: **${title}**\n\`${url}\`\n已保存: \`${filename}\`\n\n![screenshot](${dataUrl})`

  return { text, display }
}

async function doGetText(page: Page) {
  const text = await page.evaluate(() => {
    // 移除 script/style/noscript 后提取文本
    const clone = document.body.cloneNode(true) as HTMLElement
    clone.querySelectorAll('script, style, noscript, svg').forEach(el => el.remove())
    return clone.innerText.replace(/\n{3,}/g, '\n\n').trim()
  })

  const truncated = text.length > MAX_TEXT_LEN
    ? text.slice(0, MAX_TEXT_LEN) + `\n\n...[已截断，共 ${text.length} 字符]`
    : text

  return {
    text: truncated,
    display: `📄 页面文本 (${text.length} 字符):\n\`\`\`\n${truncated.slice(0, 500)}${truncated.length > 500 ? '\n...' : ''}\n\`\`\``,
  }
}

async function doGetHtml(page: Page) {
  const html = await page.evaluate(() => {
    const clone = document.documentElement.cloneNode(true) as HTMLElement
    clone.querySelectorAll('script, style, noscript, link[rel="stylesheet"]').forEach(el => el.remove())
    // 只保留 body 内容
    return clone.querySelector('body')?.innerHTML ?? ''
  })

  const truncated = html.length > MAX_HTML_LEN
    ? html.slice(0, MAX_HTML_LEN) + `\n<!-- 已截断，共 ${html.length} 字符 -->`
    : html

  return {
    text: truncated,
    display: `🗂️ 页面 HTML (${html.length} 字符):\n\`\`\`html\n${truncated.slice(0, 500)}${truncated.length > 500 ? '\n...' : ''}\n\`\`\``,
  }
}

async function doClick(page: Page, selector: string) {
  await page.click(selector, { timeout: ACTION_TIMEOUT })
  // 等待可能的导航
  await page.waitForLoadState('domcontentloaded', { timeout: 5000 }).catch(() => { })
  const title = await page.title()
  const url = page.url()

  return {
    text: `已点击: ${selector}\n当前页面: ${title} (${url})`,
    display: `🖱️ 已点击 \`${selector}\`\n当前页面: **${title}**`,
  }
}

async function doType(page: Page, selector: string, text: string) {
  await page.click(selector, { timeout: ACTION_TIMEOUT })
  await page.fill(selector, text)

  return {
    text: `已在 ${selector} 中输入: ${text}`,
    display: `⌨️ 已输入 \`${text}\` → \`${selector}\``,
  }
}

async function doSelect(page: Page, selector: string, value: string) {
  await page.selectOption(selector, value, { timeout: ACTION_TIMEOUT })

  return {
    text: `已选择 ${selector} 的选项: ${value}`,
    display: `📋 已选择 \`${value}\` → \`${selector}\``,
  }
}

async function doEvaluate(page: Page, script: string) {
  const result = await page.evaluate(script)
  const resultStr = JSON.stringify(result, null, 2)

  return {
    text: `JS 执行结果:\n${resultStr}`,
    display: `⚡ JS 结果:\n\`\`\`json\n${resultStr.slice(0, 1000)}\n\`\`\``,
  }
}

async function doScroll(page: Page, direction: string, pixels: number) {
  const scrollMap: Record<string, string> = {
    down: `window.scrollBy(0, ${pixels})`,
    up: `window.scrollBy(0, -${pixels})`,
    top: 'window.scrollTo(0, 0)',
    bottom: 'window.scrollTo(0, document.body.scrollHeight)',
  }
  const script = scrollMap[direction] ?? scrollMap.down
  await page.evaluate(script)

  return {
    text: `已滚动: ${direction} ${pixels}px`,
    display: `↕️ 已滚动 ${direction}`,
  }
}

async function doWait(page: Page, selector: string) {
  await page.waitForSelector(selector, { timeout: ACTION_TIMEOUT })

  return {
    text: `元素已出现: ${selector}`,
    display: `⏳ 元素已出现: \`${selector}\``,
  }
}

async function doGoBack(page: Page) {
  await page.goBack({ timeout: NAV_TIMEOUT_MS, waitUntil: 'domcontentloaded' })
  const title = await page.title()
  const url = page.url()

  return {
    text: `已后退。当前页面: ${title} (${url})`,
    display: `⬅️ 已后退 → **${title}**`,
  }
}
