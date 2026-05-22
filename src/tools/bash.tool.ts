import { exec } from 'child_process'
import * as fs from 'fs'
import * as path from 'path'

const TIMEOUT_MS = 15_000

// 沙箱根目录，可通过环境变量覆盖
const SANDBOX_ROOT = process.env.BASH_SANDBOX_ROOT || path.join(process.cwd(), 'sandbox')

// 白名单：只允许以这些命令开头（trimStart 后匹配）
const ALLOWED_PREFIXES = [
  'ls', 'cat', 'echo', 'printf',
  'grep', 'find', 'wc', 'head', 'tail',
  'sort', 'uniq', 'awk', 'sed', 'cut', 'tr', 'xargs',
  'python3', 'python', 'node', 'npm run', 'npx',
  'date', 'pwd', 'whoami', 'uname', 'env',
  'curl', 'wget',
  'mkdir', 'touch', 'cp', 'mv',
  'zip', 'unzip', 'tar',
  'jq', 'yq',
]

// 绝对禁止的模式（不受白名单保护）
const BLOCKED_PATTERNS: Array<{ pattern: RegExp; reason: string }> = [
  { pattern: /\bsudo\b/, reason: '禁止使用 sudo' },
  { pattern: /\bsu\b/, reason: '禁止切换用户' },
  { pattern: /\bshutdown\b|\breboot\b/, reason: '禁止系统操作' },
  { pattern: /\bkillall\b|\bkill\b/, reason: '禁止 kill 进程' },
  { pattern: /\bmkfs\b/, reason: '禁止格式化磁盘' },
  { pattern: /\bdd\b.*of=\/dev\//, reason: '禁止写入设备' },
  { pattern: />\s*\/dev\//, reason: '禁止写入设备' },
  { pattern: /\bchmod\b|\bchown\b/, reason: '禁止修改权限' },
  { pattern: /\brm\b/, reason: '禁止删除文件（沙箱内如需清理请联系管理员）' },
  // 路径穿越：禁止访问沙箱外的绝对路径或 ../
  { pattern: /\.\.\//, reason: '禁止路径穿越 (../)' },
  { pattern: /(?<!\w)(\/etc|\/var|\/usr|\/bin|\/sbin|\/lib|\/boot|\/sys|\/proc|\/root|\/home)\b/, reason: '禁止访问系统目录' },
  // 禁止写入沙箱外的绝对路径（允许写 /tmp）
  { pattern: />\s*\/(?!tmp)/, reason: '禁止写入沙箱外的绝对路径' },
  // 禁止通过环境变量或命令替换绕过限制
  { pattern: /\$\(.*\)/, reason: '禁止命令替换 $()' },
  { pattern: /`[^`]+`/, reason: '禁止反引号命令替换' },
]

export const definition = {
  type: 'function' as const,
  function: {
    name: 'run_bash',
    description: '在隔离沙箱目录中执行 bash 命令，返回 stdout、stderr 和退出码。适用于：运行脚本、文件操作、数据处理、调用命令行工具等任务。注意：每个会话有独立的沙箱目录，无法访问项目源码或系统目录。',
    parameters: {
      type: 'object',
      properties: {
        command: { type: 'string', description: '要执行的 bash 命令，支持管道、重定向等 shell 语法' },
      },
      required: ['command'],
    },
  },
}

function getSandboxDir(sessionId: string): string {
  // 防止 sessionId 包含路径穿越字符
  const safeId = sessionId.replace(/[^a-zA-Z0-9_-]/g, '_')
  return path.join(SANDBOX_ROOT, safeId)
}

function ensureSandbox(sandboxDir: string): void {
  fs.mkdirSync(sandboxDir, { recursive: true })
}

function checkCommand(command: string): string | null {
  // 1. 检查黑名单
  for (const { pattern, reason } of BLOCKED_PATTERNS) {
    if (pattern.test(command)) return reason
  }

  // 2. 检查白名单（取第一个 token，忽略前导空格）
  const firstToken = command.trimStart()
  const allowed = ALLOWED_PREFIXES.some(prefix => firstToken.startsWith(prefix))
  if (!allowed) {
    return `命令不在白名单中。允许的命令：${ALLOWED_PREFIXES.join(', ')}`
  }

  return null
}

export async function execute(args: { command: string; sessionId?: string }) {
  const { command, sessionId = 'default' } = args

  // 安全检查
  const blockReason = checkCommand(command)
  if (blockReason) {
    const msg = `命令被拒绝：${blockReason}`
    return {
      text: `exit_code: 1\n[blocked]\n${msg}`,
      display: `**$ ${command}**\n\`\`\`\n⛔ ${msg}\n\`\`\`\nexit code: 1`,
      exitCode: 1,
    }
  }

  // 准备沙箱目录
  const sandboxDir = getSandboxDir(sessionId)
  ensureSandbox(sandboxDir)

  // 清理后的环境变量：不暴露任何 API key 或项目敏感信息
  const safeEnv: NodeJS.ProcessEnv = {
    PATH: '/usr/local/bin:/usr/bin:/bin',
    HOME: sandboxDir,
    TMPDIR: sandboxDir,
    LANG: process.env.LANG || 'en_US.UTF-8',
    TERM: 'xterm-256color',
  }

  return new Promise<{ text: string; display: string; exitCode: number }>((resolve) => {
    exec(command, {
      timeout: TIMEOUT_MS,
      encoding: 'utf-8',
      cwd: sandboxDir,   // 工作目录锁定在沙箱
      env: safeEnv,      // 隔离环境变量
    }, (err, stdout, stderr) => {
      const exitCode = err?.code ?? 0
      const out = stdout.trim()
      const err_ = stderr.trim()

      const parts = [...(out ? [`[stdout]\n${out}`] : []), ...(err_ ? [`[stderr]\n${err_}`] : [])]
      const text = `exit_code: ${exitCode}\n${parts.join('\n') || '(no output)'}`

      const display = [
        `**$ ${command}**`, '```',
        ...(out ? [out] : []),
        ...(err_ ? [err_] : []),
        ...(!out && !err_ ? ['(no output)'] : []),
        '```', `exit code: ${exitCode}`,
      ].join('\n')

      resolve({ text, display, exitCode })
    })
  })
}
