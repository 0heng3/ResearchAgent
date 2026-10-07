import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { platform } from 'node:os'
import { safeJoinUnder, workspaceRelative } from './workspace'
import type { WorkspaceBinding } from './types'

type BrowserAction = 'snapshot' | 'evaluate' | 'click' | 'type'

let launchedCdpUrl: string | undefined

function hash(value: string | Buffer) {
  return createHash('sha256').update(value).digest('hex').slice(0, 16)
}

function htmlToText(html: string) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/\s+/g, ' ')
    .trim()
}

async function cdpEndpoint(cdpUrl: string, url: string) {
  const base = cdpUrl.replace(/\/+$/, '')
  const created = await fetch(`${base}/json/new?${encodeURIComponent(url)}`, { method: 'PUT' })
    .then(response => response.ok ? response.json() : null)
    .catch(() => null) as { webSocketDebuggerUrl?: string; id?: string } | null
  if (created?.webSocketDebuggerUrl) return created
  const tabs = await fetch(`${base}/json`).then(response => response.json()) as Array<{ webSocketDebuggerUrl?: string; id?: string; url?: string }>
  return tabs.find(tab => tab.webSocketDebuggerUrl) ?? null
}

async function waitForCdp(cdpUrl: string, timeoutMs = 8000) {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    const ok = await fetch(`${cdpUrl.replace(/\/+$/, '')}/json/version`)
      .then(response => response.ok)
      .catch(() => false)
    if (ok) return cdpUrl
    await new Promise(resolve => setTimeout(resolve, 250))
  }
  throw new Error(`Chrome DevTools endpoint did not become ready: ${cdpUrl}`)
}

function chromeCandidates() {
  const env = process.env.COG_CLAW_CHROME_PATH || process.env.CHROME_PATH
  const candidates = env ? [env] : []
  if (platform() === 'win32') {
    candidates.push(
      'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
      'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
      `${process.env.LOCALAPPDATA || ''}\\Google\\Chrome\\Application\\chrome.exe`,
      'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
      'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    )
  } else if (platform() === 'darwin') {
    candidates.push(
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
      '/Applications/Chromium.app/Contents/MacOS/Chromium',
    )
  } else {
    candidates.push('google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser', 'microsoft-edge')
  }
  return candidates.filter(Boolean)
}

function canSpawnChrome(path: string) {
  return !path.includes('\\') && !path.startsWith('/') ? true : existsSync(path)
}

async function ensureCdpUrl(workspace: WorkspaceBinding, requested?: string) {
  const configured = requested || process.env.COG_CLAW_CDP_URL || process.env.CHROME_REMOTE_DEBUGGING_URL
  if (configured) return configured
  if (launchedCdpUrl) return launchedCdpUrl
  const port = Number(process.env.COG_CLAW_CDP_PORT || 9222)
  const url = `http://127.0.0.1:${port}`
  const alreadyRunning = await waitForCdp(url, 700).catch(() => undefined)
  if (alreadyRunning) {
    launchedCdpUrl = alreadyRunning
    return launchedCdpUrl
  }
  const chrome = chromeCandidates().find(canSpawnChrome)
  if (!chrome) return undefined
  const userDataDir = safeJoinUnder(workspace.artifactRoot, 'browser-profile')
  await mkdir(userDataDir, { recursive: true })
  const child = spawn(chrome, [
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${userDataDir}`,
    '--headless=new',
    '--disable-gpu',
    '--no-first-run',
    '--no-default-browser-check',
  ], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  })
  child.on('error', () => {
    // The caller will fall back to fetch snapshots when CDP cannot be launched.
  })
  child.unref()
  launchedCdpUrl = await waitForCdp(url)
  return launchedCdpUrl
}

async function withCdp<T>(
  cdpUrl: string,
  url: string,
  fn: (send: (method: string, params?: Record<string, unknown>) => Promise<Record<string, unknown>>) => Promise<T>,
) {
  const endpoint = await cdpEndpoint(cdpUrl, url)
  if (!endpoint?.webSocketDebuggerUrl || typeof WebSocket === 'undefined') {
    throw new Error('No Chrome DevTools WebSocket endpoint is available')
  }
  const socket = new WebSocket(endpoint.webSocketDebuggerUrl)
  let nextId = 1
  const pending = new Map<number, {
    resolve: (value: Record<string, unknown>) => void
    reject: (error: Error) => void
  }>()
  socket.addEventListener('message', event => {
    const message = JSON.parse(String(event.data)) as { id?: number; result?: Record<string, unknown>; error?: { message?: string } }
    if (!message.id) return
    const request = pending.get(message.id)
    if (!request) return
    pending.delete(message.id)
    if (message.error) request.reject(new Error(message.error.message || 'CDP request failed'))
    else request.resolve(message.result ?? {})
  })
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('CDP socket open timed out')), 10_000)
    socket.addEventListener('open', () => {
      clearTimeout(timer)
      resolve()
    }, { once: true })
    socket.addEventListener('error', () => {
      clearTimeout(timer)
      reject(new Error('CDP socket failed to open'))
    }, { once: true })
  })
  const send = (method: string, params: Record<string, unknown> = {}) => {
    const id = nextId++
    socket.send(JSON.stringify({ id, method, params }))
    return new Promise<Record<string, unknown>>((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id)
        reject(new Error(`CDP request timed out: ${method}`))
      }, 20_000)
      pending.set(id, {
        resolve(value) {
          clearTimeout(timer)
          resolve(value)
        },
        reject(error) {
          clearTimeout(timer)
          reject(error)
        },
      })
    })
  }
  try {
    return await fn(send)
  } finally {
    socket.close()
  }
}

export async function runBrowserAction(args: {
  workspace: WorkspaceBinding
  action: BrowserAction
  url: string
  selector?: string
  text?: string
  expression?: string
  cdpUrl?: string
}) {
  const cdpUrl = await ensureCdpUrl(args.workspace, args.cdpUrl).catch(() => undefined)
  const recordId = `browser-${Date.now().toString(36)}`
  const target = safeJoinUnder(args.workspace.artifactRoot, 'browser', `${recordId}.json`)
  let result: Record<string, unknown>

  if (cdpUrl) {
    result = await withCdp(cdpUrl, args.url, async send => {
      await send('Page.enable')
      await send('Runtime.enable')
      await send('Page.navigate', { url: args.url })
      await new Promise(resolve => setTimeout(resolve, 1200))
      if (args.action === 'click' && args.selector) {
        await send('Runtime.evaluate', {
          expression: `document.querySelector(${JSON.stringify(args.selector)})?.click()`,
          awaitPromise: true,
        })
      }
      if (args.action === 'type' && args.selector) {
        await send('Runtime.evaluate', {
          expression: `(() => { const el = document.querySelector(${JSON.stringify(args.selector)}); if (el) { el.focus(); el.value = ${JSON.stringify(args.text ?? '')}; el.dispatchEvent(new Event('input', { bubbles: true })); } })()`,
          awaitPromise: true,
        })
      }
      const evaluated = args.action === 'evaluate' && args.expression
        ? await send('Runtime.evaluate', { expression: args.expression, returnByValue: true, awaitPromise: true })
        : await send('Runtime.evaluate', { expression: 'document.body ? document.body.innerText.slice(0, 12000) : ""', returnByValue: true })
      const screenshot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false })
        .catch(() => ({} as Record<string, unknown>))
      const screenshotData = typeof screenshot.data === 'string' ? screenshot.data : undefined
      return {
        mode: 'cdp',
        cdpUrl,
        action: args.action,
        url: args.url,
        text: (evaluated.result as { value?: unknown } | undefined)?.value ?? evaluated,
        screenshotBase64: screenshotData ? `${screenshotData.slice(0, 120)}...` : undefined,
      }
    })
  } else {
    if (args.action !== 'snapshot') {
      throw new Error('Interactive browser actions require COG_CLAW_CDP_URL or CHROME_REMOTE_DEBUGGING_URL')
    }
    const response = await fetch(args.url, {
      headers: { 'user-agent': 'COG-CLAW/2.0 browser snapshot' },
    })
    const html = await response.text()
    result = {
      mode: 'fetch-fallback',
      note: 'No Chrome CDP endpoint was configured or auto-startable; snapshot used fetch fallback.',
      action: args.action,
      url: response.url,
      status: response.status,
      contentType: response.headers.get('content-type') ?? '',
      text: htmlToText(html).slice(0, 12000),
      contentHash: hash(html),
    }
  }

  const record = {
    id: recordId,
    createdAt: new Date().toISOString(),
    ...result,
    path: workspaceRelative(args.workspace.root, target),
  }
  await mkdir(dirname(target), { recursive: true })
  await writeFile(target, JSON.stringify(record, null, 2))
  return record
}
