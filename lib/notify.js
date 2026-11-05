/**
 * Windows toast。只在 Windows 上可用；失败就把原因带回去，不假装成功。
 * 用 -EncodedCommand（UTF-16LE base64）避开引号/换行/中文在命令行里的转义问题。
 */
import { spawn } from 'node:child_process'

function psQuote(text) {
  return `'${String(text).replace(/\r?\n/g, ' ').replace(/'/g, "''")}'`
}

const SCRIPT = (message) => `
$ErrorActionPreference = 'Stop'
try {
  [Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null
  $t = [Windows.UI.Notifications.ToastTemplateType]::ToastText02
  $x = [Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent($t)
  $n = $x.GetElementsByTagName('text')
  $n.Item(0).AppendChild($x.CreateTextNode(${psQuote(title)})) | Out-Null
  $n.Item(1).AppendChild($x.CreateTextNode(${psQuote(message)})) | Out-Null
  $toast = [Windows.UI.Notifications.ToastNotification]::new($x)
  $app = '{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\WindowsPowerShell\\v1.0\\powershell.exe'
  [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($app).Show($toast)
  'TOAST_OK'
} catch {
  'TOAST_ERR: ' + $_.Exception.Message
  exit 1
}
`

export function notifyWindows(message, title = '你的 agent') {
  if (process.platform !== 'win32') return Promise.resolve({ ok: false, error: 'only on windows' })
  const text = String(message || '').slice(0, 120)
  const encoded = Buffer.from(SCRIPT(text), 'utf16le').toString('base64')
  return new Promise((resolve) => {
    let out = ''
    let done = false
    const finish = (result) => {
      if (done) return
      done = true
      resolve(result)
    }
    // 异步起进程：toast 失败/卡住也不能把整个 agent 的这一步堵 12 秒。
    const child = spawn('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded,
    ], { windowsHide: true })
    const timer = setTimeout(() => {
      try { child.kill() } catch { /* ignore */ }
      finish({ ok: false, error: '通知进程等太久了' })
    }, 12000)
    child.stdout.on('data', (d) => { out += String(d) })
    child.stderr.on('data', (d) => { out += String(d) })
    child.on('error', (err) => { clearTimeout(timer); finish({ ok: false, error: err.message }) })
    child.on('close', (code) => {
      clearTimeout(timer)
      const text = out.trim()
      if (code !== 0) return finish({ ok: false, error: text.slice(0, 300) || `exit ${code}` })
      if (!text.includes('TOAST_OK')) return finish({ ok: false, error: text.slice(0, 300) || 'toast did not report success' })
      finish({ ok: true })
    })
  })
}
