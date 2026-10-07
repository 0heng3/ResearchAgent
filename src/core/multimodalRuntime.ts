import { createHash } from 'node:crypto'
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { dirname, extname } from 'node:path'
import { safeJoinUnder, workspaceRelative } from './workspace'
import type { WorkspaceBinding } from './types'

export type MultimodalRoute = {
  route: string
  modelId: string
  channel: {
    baseUrl: string
    apiKey: string
  }
}

function sha(value: Buffer | string) {
  return createHash('sha256').update(value).digest('hex')
}

function mediaType(path: string) {
  const ext = extname(path).toLowerCase()
  if (ext === '.png') return 'image/png'
  if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg'
  if (ext === '.webp') return 'image/webp'
  if (ext === '.gif') return 'image/gif'
  if (ext === '.wav') return 'audio/wav'
  if (ext === '.mp3') return 'audio/mpeg'
  if (ext === '.mp4') return 'video/mp4'
  return 'application/octet-stream'
}

function chatUrl(baseUrl: string) {
  const clean = baseUrl.replace(/\/+$/, '')
  return clean.endsWith('/v1') ? `${clean}/chat/completions` : `${clean}/v1/chat/completions`
}

function extractText(payload: unknown) {
  if (!payload || typeof payload !== 'object') return ''
  const choices = Array.isArray((payload as { choices?: unknown[] }).choices)
    ? (payload as { choices: Array<{ message?: { content?: unknown } }> }).choices
    : []
  const content = choices[0]?.message?.content
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .map(block => {
        if (typeof block === 'string') return block
        if (block && typeof block === 'object' && typeof (block as { text?: unknown }).text === 'string') {
          return (block as { text: string }).text
        }
        return ''
      })
      .join('\n')
  }
  return ''
}

export async function analyzeMultimodalArtifact(args: {
  workspace: WorkspaceBinding
  path: string
  prompt?: string
  route?: MultimodalRoute
}) {
  const target = safeJoinUnder(args.workspace.root, args.path)
  const buffer = await readFile(target)
  const mime = mediaType(target)
  const hash = sha(buffer)
  const prompt = args.prompt || 'Analyze this artifact for content, structure, risks, and task-relevant evidence. Be concise and factual.'

  let analysis: Record<string, unknown>
  if (args.route && buffer.length <= 18 * 1024 * 1024 && mime.startsWith('image/')) {
    const response = await fetch(chatUrl(args.route.channel.baseUrl), {
      method: 'POST',
      headers: {
        authorization: `Bearer ${args.route.channel.apiKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: args.route.modelId,
        temperature: 0.2,
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: prompt },
              {
                type: 'image_url',
                image_url: {
                  url: `data:${mime};base64,${buffer.toString('base64')}`,
                },
              },
            ],
          },
        ],
      }),
    })
    if (!response.ok) {
      const detail = await response.text().catch(() => '')
      throw new Error(`vision route returned ${response.status}: ${detail.slice(0, 500)}`)
    }
    const payload = await response.json()
    analysis = {
      kind: 'semantic',
      route: args.route.route,
      modelId: args.route.modelId,
      mime,
      text: extractText(payload),
    }
  } else {
    analysis = {
      kind: 'metadata-only',
      mime,
      bytes: buffer.length,
      sha256: hash,
      note: args.route
        ? 'Semantic analysis currently supports image inputs on OpenAI-compatible vision chat routes; this artifact was recorded as metadata.'
        : 'No vision/audio route was supplied. Configure a vision-capable model or MCP route for semantic analysis.',
    }
  }

  const record = {
    path: workspaceRelative(args.workspace.root, target),
    analyzedAt: new Date().toISOString(),
    sha256: hash,
    analysis,
  }
  const out = safeJoinUnder(args.workspace.artifactRoot, 'multimodal', `${hash.slice(0, 16)}.json`)
  await mkdir(dirname(out), { recursive: true })
  await writeFile(out, JSON.stringify(record, null, 2))
  return { ...record, reportPath: workspaceRelative(args.workspace.root, out) }
}
