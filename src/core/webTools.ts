import { createHash } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { safeJoinUnder, workspaceRelative } from './workspace'
import type { WorkspaceBinding } from './types'

export type SourceSnapshot = {
  id: string
  url: string
  title: string
  fetchedAt: string
  status: number
  contentType: string
  contentHash: string
  excerpt: string
  path: string
}

function sha256(value: string | Buffer) {
  return createHash('sha256').update(value).digest('hex')
}

function extractTitle(html: string) {
  return /<title[^>]*>([\s\S]*?)<\/title>/i
    .exec(html)?.[1]
    ?.replace(/\s+/g, ' ')
    .trim() ?? ''
}

function htmlToText(html: string) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/\s+/g, ' ')
    .trim()
}

function snapshotPath(workspace: WorkspaceBinding, id: string) {
  return safeJoinUnder(workspace.artifactRoot, 'sources', `${id}.json`)
}

export async function fetchSourceSnapshot(args: {
  url: string
  workspace: WorkspaceBinding
  maxBytes?: number
}): Promise<SourceSnapshot> {
  const url = new URL(args.url)
  if (!['http:', 'https:'].includes(url.protocol)) {
    throw new Error(`unsupported URL protocol: ${url.protocol}`)
  }

  const response = await fetch(url, {
    headers: {
      'user-agent': 'COG-CLAW/2.0 source verifier',
      accept: 'text/html,application/xhtml+xml,application/json,text/plain;q=0.9,*/*;q=0.8',
    },
    redirect: 'follow',
  })
  const arrayBuffer = await response.arrayBuffer()
  const maxBytes = args.maxBytes ?? 2_000_000
  const buffer = Buffer.from(arrayBuffer).subarray(0, maxBytes)
  const raw = buffer.toString('utf-8')
  const contentType = response.headers.get('content-type') ?? ''
  const text = contentType.includes('html') ? htmlToText(raw) : raw.replace(/\s+/g, ' ').trim()
  const title = contentType.includes('html') ? extractTitle(raw) : ''
  const contentHash = sha256(buffer)
  const id = `source-${sha256(`${url.href}:${contentHash}`).slice(0, 16)}`
  const target = snapshotPath(args.workspace, id)
  const snapshot: SourceSnapshot = {
    id,
    url: url.href,
    title: title || url.hostname,
    fetchedAt: new Date().toISOString(),
    status: response.status,
    contentType,
    contentHash,
    excerpt: text.slice(0, 8000),
    path: workspaceRelative(args.workspace.root, target),
  }
  await mkdir(dirname(target), { recursive: true })
  await writeFile(target, JSON.stringify(snapshot, null, 2))
  return snapshot
}

function decodeHtml(value: string) {
  return value
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/\s+/g, ' ')
    .trim()
}

export async function searchWeb(args: {
  query: string
  workspace: WorkspaceBinding
  limit?: number
}) {
  const query = args.query.trim()
  if (!query) throw new Error('query is required')
  const limit = Math.min(10, Math.max(1, args.limit ?? 5))
  const searchUrl = `https://duckduckgo.com/html/?q=${encodeURIComponent(query)}`
  const response = await fetch(searchUrl, {
    headers: {
      'user-agent': 'COG-CLAW/2.0 source verifier',
      accept: 'text/html',
    },
  })
  const html = await response.text()
  const results: Array<{ title: string; url: string; snippet: string }> = []
  const blockPattern = /<a[^>]+class="result__a"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?<a[^>]+class="result__snippet"[^>]*>([\s\S]*?)<\/a>/gi
  for (const match of html.matchAll(blockPattern)) {
    if (results.length >= limit) break
    const rawUrl = decodeHtml(match[1] ?? '')
    const title = decodeHtml(htmlToText(match[2] ?? ''))
    const snippet = decodeHtml(htmlToText(match[3] ?? ''))
    let url = rawUrl
    try {
      const parsed = new URL(rawUrl)
      const uddg = parsed.searchParams.get('uddg')
      if (uddg) url = decodeURIComponent(uddg)
    } catch {
      // Keep the raw URL if DuckDuckGo returns a direct link.
    }
    if (title && url) results.push({ title, url, snippet })
  }

  const id = `search-${sha256(`${query}:${Date.now()}`).slice(0, 16)}`
  const target = safeJoinUnder(args.workspace.artifactRoot, 'sources', `${id}.json`)
  const record = {
    id,
    query,
    searchedAt: new Date().toISOString(),
    provider: 'duckduckgo-html',
    status: response.status,
    results,
    path: workspaceRelative(args.workspace.root, target),
  }
  await mkdir(dirname(target), { recursive: true })
  await writeFile(target, JSON.stringify(record, null, 2))
  return record
}
