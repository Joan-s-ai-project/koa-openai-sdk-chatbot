import { exec } from 'child_process'

const TIMEOUT_MS = 15_000

const DANGEROUS_PATTERNS = [
  /rm\s+-rf?\s+\/(?!\S)/,
  /\bsudo\b/,
  /\bshutdown\b/,
  /\breboot\b/,
  />\s*\/dev\//,
  /\bmkfs\b/,
  /\bdd\b.*of=\/dev\//,
  /\bchmod\s+-R\s+777\s+\//,
  /\bkillall\b/,
]

export const definition = {
  type: 'function' as const,
  function: {
    name: 'run_bash',
    description: '在服务器上执行一段 bash 命令，返回 stdout、stderr 和退出码。适用于：运行脚本、文件操作、系统查询、数据处理、调用命令行工具等任务。',
    parameters: {
      type: 'object',
      properties: {
        command: { type: 'string', description: '要执行的 bash 命令，支持管道、重定向等 shell 语法' },
      },
      required: ['command'],
    },
  },
}

export async function execute(args: { command: string }) {
  const { command } = args

  const blocked = DANGEROUS_PATTERNS.find(p => p.test(command))
  if (blocked) {
    const msg = `命令被拒绝：检测到危险操作 (${blocked})`
    return {
      text: `exit_code: 1\n[blocked]\n${msg}`,
      display: `**$ ${command}**\n\`\`\`\n⛔ ${msg}\n\`\`\`\nexit code: 1`,
      exitCode: 1,
    }
  }

  return new Promise<{ text: string; display: string; exitCode: number }>((resolve) => {
    exec(command, { timeout: TIMEOUT_MS, encoding: 'utf-8' }, (err, stdout, stderr) => {
      const exitCode = err?.code ?? 0
      const out = stdout.trim()
      const err_ = stderr.trim()

      const parts = [...(out ? [`[stdout]\n${out}`] : []), ...(err_ ? [`[stderr]\n${err_}`] : [])]
      const text = `exit_code: ${exitCode}\n${parts.join('\n') || '(no output)'}`

      const display = [
        `**$ ${command}**`, '```',
        ...(out ? [out] : []), ...(err_ ? [err_] : []),
        ...(!out && !err_ ? ['(no output)'] : []),
        '```', `exit code: ${exitCode}`,
      ].join('\n')

      resolve({ text, display, exitCode })
    })
  })
}
