import { createHash } from 'node:crypto'
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { dirname, extname } from 'node:path'
import { safeJoinUnder, workspaceRelative } from './workspace'
import type { WorkspaceBinding } from './types'

function sha(value: Buffer | string) {
  return createHash('sha256').update(value).digest('hex')
}

function parseIpynb(buffer: Buffer) {
  const notebook = JSON.parse(buffer.toString('utf-8')) as {
    cells?: Array<{ cell_type?: string; source?: string[] | string; outputs?: unknown[] }>
    metadata?: Record<string, unknown>
  }
  const cells = notebook.cells ?? []
  return {
    kind: 'notebook',
    cells: cells.map((cell, index) => ({
      index,
      type: cell.cell_type ?? 'unknown',
      source: Array.isArray(cell.source) ? cell.source.join('') : cell.source ?? '',
      outputs: Array.isArray(cell.outputs) ? cell.outputs.length : 0,
    })),
    metadataKeys: Object.keys(notebook.metadata ?? {}),
  }
}

function parsePdf(buffer: Buffer) {
  const text = buffer
    .toString('latin1')
    .replace(/\r/g, '\n')
    .match(/\(([^()]{2,200})\)\s*Tj/g)
    ?.map(match => match.replace(/^\(/, '').replace(/\)\s*Tj$/, ''))
    .join(' ') ?? ''
  return {
    kind: 'pdf',
    bytes: buffer.length,
    textPreview: text.replace(/\s+/g, ' ').slice(0, 5000),
    note: text ? 'basic PDF text operator extraction' : 'no extractable text found without optional PDF parser',
  }
}

function parseCsv(buffer: Buffer) {
  const text = buffer.toString('utf-8')
  const rows = text.split(/\r?\n/).filter(Boolean)
  const header = rows[0]?.split(',') ?? []
  return {
    kind: 'table',
    rows: rows.length,
    columns: header.length,
    header,
    preview: rows.slice(0, 12),
  }
}

function mediaMetadata(buffer: Buffer, path: string) {
  return {
    kind: 'media',
    extension: extname(path).toLowerCase(),
    bytes: buffer.length,
    sha256: sha(buffer),
    note: 'binary media metadata recorded; use a vision/audio MCP or model route for semantic analysis',
  }
}

export async function inspectDocument(args: {
  workspace: WorkspaceBinding
  path: string
}) {
  const target = safeJoinUnder(args.workspace.root, args.path)
  const buffer = await readFile(target)
  const ext = extname(target).toLowerCase()
  const analysis =
    ext === '.ipynb' ? parseIpynb(buffer)
    : ext === '.pdf' ? parsePdf(buffer)
    : ['.csv', '.tsv'].includes(ext) ? parseCsv(buffer)
    : ['.png', '.jpg', '.jpeg', '.webp', '.gif', '.wav', '.mp3', '.mp4', '.mov'].includes(ext) ? mediaMetadata(buffer, target)
    : {
        kind: 'text',
        bytes: buffer.length,
        sha256: sha(buffer),
        preview: buffer.toString('utf-8').slice(0, 8000),
      }
  const record = {
    path: workspaceRelative(args.workspace.root, target),
    inspectedAt: new Date().toISOString(),
    sha256: sha(buffer),
    analysis,
  }
  const out = safeJoinUnder(args.workspace.artifactRoot, 'documents', `${sha(target).slice(0, 16)}.json`)
  await mkdir(dirname(out), { recursive: true })
  await writeFile(out, JSON.stringify(record, null, 2))
  return { ...record, reportPath: workspaceRelative(args.workspace.root, out) }
}
