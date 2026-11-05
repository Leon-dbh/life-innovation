/**
 * Windows toast。只在 Windows 上可用；失败就把原因带回去，不假装成功。
 * 用 -EncodedCommand（UTF-16LE base64）避开引号/换行/中文在命令行里的转义问题。
 */
import { spawnSync } from 'node:child_process'

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
  $n.Item(0).AppendChild($x.CreateTextNode(${psQuote('鲸鲸')})) | Out-Null
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

export function notifyWindows(message) {
  if (process.platform !== 'win32') return Promise.resolve({ ok: false, error: 'only on windows' })
  const text = String(message || '').slice(0, 120)
  const encoded = Buffer.from(SCRIPT(text), 'utf16le').toString('base64')
  const res = spawnSync('powershell.exe', [
    '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded,
  ], { encoding: 'utf8', timeout: 12000, windowsHide: true })
  if (res.error) return Promise.resolve({ ok: false, error: res.error.message })
  if (res.status !== 0) {
    return Promise.resolve({ ok: false, error: String(res.stdout || res.stderr || '').trim().slice(0, 300) || `exit ${res.status}` })
  }
  const out = String(res.stdout || '')
  if (!out.includes('TOAST_OK')) {
    return Promise.resolve({ ok: false, error: out.trim().slice(0, 300) || 'toast did not report success' })
  }
  return Promise.resolve({ ok: true })
}
