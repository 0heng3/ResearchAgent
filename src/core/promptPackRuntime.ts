import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, extname, isAbsolute, join, resolve } from 'node:path'
import { safeJoinUnder, sanitizePathSegment, workspaceRelative } from './workspace'
import type { WorkspaceBinding } from './types'

export type PromptPackManifest = {
  id: string
  name: string
  path: string
  include?: string[]
  maxBytes?: number
  enabled?: boolean
  source: 'workspace' | 'external'
}

const promptExtensions = new Set(['.md', '.txt', '.yaml', '.yml', '.json', '.ts', '.tsx', '.js', '.mjs'])
const defaultIncludes = [
  '**/*.md',
  '**/*.txt',
  '**/*.yaml',
  '**/*.yml',
  '**/*.json',
  '**/*.ts',
  '**/*.tsx',
  '**/*.js',
  '**/*.mjs',
]

function promptPackRoot(workspace: WorkspaceBinding) {
  return safeJoinUnder(workspace.root, '.cogclaw', 'prompt-packs')
}

function envPromptPackPaths() {
  return [
    process.env.COG_CLAW_PROMPT_PACK_PATHS ?? '',
    process.env.CLAUDE_HARNESS_PATHS ?? '',
  ]
    .join(';')
    .split(/[;,]/)
    .map(item => item.trim())
    .filter(Boolean)
}

function manifestPath(workspace: WorkspaceBinding, id: string) {
  return safeJoinUnder(promptPackRoot(workspace), `${sanitizePathSegment(id).toLowerCase()}.json`)
}

function normalizeManifest(raw: Partial<PromptPackManifest>, fallback: string, source: PromptPackManifest['source']) {
  const id = sanitizePathSegment(raw.id || basename(raw.path || fallback)).toLowerCase()
  return {
    id,
    name: raw.name || id,
    path: raw.path || fallback,
    include: raw.include?.length ? raw.include : defaultIncludes,
    maxBytes: raw.maxBytes ?? 80_000,
    enabled: raw.enabled !== false,
    source,
  } satisfies PromptPackManifest
}

function globToRegex(pattern: string) {
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*/g, '\u0000')
    .replace(/\*/g, '[^/]*')
    .replace(/\?/g, '[^/]')
    .replace(/\u0000/g, '.*')
    .replace(/\\/g, '/')
  return new RegExp(`^${escaped}$`, 'i')
}

function matchesInclude(file: string, patterns: string[]) {
  return patterns.some(pattern => {
    if (globToRegex(pattern).test(file)) return true
    if (pattern.startsWith('**/')) return globToRegex(pattern.slice(3)).test(file)
    return false
  })
}

function isDefaultIncludeSet(patterns: string[]) {
  return patterns.length === defaultIncludes.length &&
    patterns.every(pattern => defaultIncludes.includes(pattern))
}

function selectIncludedFiles(files: string[], include?: string[]) {
  const patterns = include?.length ? include : defaultIncludes
  const matched = files.filter(file => matchesInclude(file, patterns))
  if (matched.length || !isDefaultIncludeSet(patterns)) return matched
  return files.filter(file => promptExtensions.has(extname(file).toLowerCase()))
}

async function walk(root: string, maxFiles = 120, base = root): Promise<string[]> {
  const files: string[] = []
  const entries = await readdir(root, { withFileTypes: true }).catch(() => [])
  for (const entry of entries) {
    if (files.length >= maxFiles) break
    if (['.git', 'node_modules', 'dist', 'artifacts', '.cache'].includes(entry.name)) continue
    const target = join(root, entry.name)
    if (entry.isDirectory()) {
      files.push(...await walk(target, Math.max(0, maxFiles - files.length), base))
    } else if (entry.isFile() && promptExtensions.has(extname(entry.name).toLowerCase())) {
      files.push(workspaceRelative(base, target).replace(/\\/g, '/'))
    }
  }
  return files
}

function walkSync(root: string, maxFiles = 120, base = root): string[] {
  const files: string[] = []
  const entries = (() => {
    try {
      return readdirSync(root, { withFileTypes: true })
    } catch {
      return []
    }
  })()
  for (const entry of entries) {
    if (files.length >= maxFiles) break
    if (['.git', 'node_modules', 'dist', 'artifacts', '.cache'].includes(entry.name)) continue
    const target = join(root, entry.name)
    if (entry.isDirectory()) {
      files.push(...walkSync(target, Math.max(0, maxFiles - files.length), base))
    } else if (entry.isFile() && promptExtensions.has(extname(entry.name).toLowerCase())) {
      files.push(workspaceRelative(base, target).replace(/\\/g, '/'))
    }
  }
  return files
}

export async function registerPromptPack(args: {
  workspace: WorkspaceBinding
  id: string
  name?: string
  path: string
  include?: string[]
  enabled?: boolean
  maxBytes?: number
}) {
  const resolved = isAbsolute(args.path) ? resolve(args.path) : safeJoinUnder(args.workspace.root, args.path)
  if (!existsSync(resolved)) throw new Error(`Prompt pack path does not exist: ${resolved}`)
  const manifest = normalizeManifest({
    id: args.id,
    name: args.name,
    path: resolved,
    include: args.include,
    enabled: args.enabled,
    maxBytes: args.maxBytes,
  }, resolved, isAbsolute(args.path) ? 'external' : 'workspace')
  const target = manifestPath(args.workspace, manifest.id)
  await mkdir(dirname(target), { recursive: true })
  await writeFile(target, JSON.stringify(manifest, null, 2))
  return { manifest, path: workspaceRelative(args.workspace.root, target) }
}

export async function discoverPromptPacks(workspace: WorkspaceBinding) {
  const manifests: PromptPackManifest[] = []
  const root = promptPackRoot(workspace)
  if (existsSync(root)) {
    const files = await readdir(root).catch(() => [])
    for (const file of files.filter(item => item.endsWith('.json'))) {
      try {
        const parsed = JSON.parse(await readFile(safeJoinUnder(root, file), 'utf-8')) as Partial<PromptPackManifest>
        manifests.push(normalizeManifest(parsed, parsed.path || file, parsed.source ?? 'workspace'))
      } catch {
        // Broken prompt-pack manifests are ignored; the manage tool reports them by path if needed.
      }
    }
  }
  for (const externalPath of envPromptPackPaths()) {
    manifests.push(normalizeManifest({
      id: basename(externalPath),
      name: basename(externalPath),
      path: resolve(externalPath),
      include: defaultIncludes,
      enabled: true,
    }, externalPath, 'external'))
  }
  const seen = new Set<string>()
  return manifests.filter(manifest => {
    const key = `${manifest.id}:${manifest.path}`
    if (seen.has(key)) return false
    seen.add(key)
    return manifest.enabled !== false
  })
}

export function discoverPromptPacksSync(workspace: WorkspaceBinding) {
  const manifests: PromptPackManifest[] = []
  const root = promptPackRoot(workspace)
  if (existsSync(root)) {
    const files = (() => {
      try {
        return readdirSync(root)
      } catch {
        return []
      }
    })()
    for (const file of files.filter(item => item.endsWith('.json'))) {
      try {
        const parsed = JSON.parse(readFileSync(safeJoinUnder(root, file), 'utf-8')) as Partial<PromptPackManifest>
        manifests.push(normalizeManifest(parsed, parsed.path || file, parsed.source ?? 'workspace'))
      } catch {
        // Broken prompt-pack manifests are ignored during prompt assembly.
      }
    }
  }
  for (const externalPath of envPromptPackPaths()) {
    manifests.push(normalizeManifest({
      id: basename(externalPath),
      name: basename(externalPath),
      path: resolve(externalPath),
      include: defaultIncludes,
      enabled: true,
    }, externalPath, 'external'))
  }
  const seen = new Set<string>()
  return manifests.filter(manifest => {
    const key = `${manifest.id}:${manifest.path}`
    if (seen.has(key)) return false
    seen.add(key)
    return manifest.enabled !== false
  })
}

export async function loadPromptPackContext(workspace: WorkspaceBinding) {
  const packs = await discoverPromptPacks(workspace)
  const loaded = []
  for (const pack of packs.slice(0, 6)) {
    const root = resolve(pack.path)
    if (!existsSync(root)) {
      loaded.push({ pack, error: `missing path: ${root}` })
      continue
    }
    const info = await stat(root).catch(() => null)
    const files = info?.isFile()
      ? [basename(root)]
      : selectIncludedFiles(await walk(root), pack.include)
    let remaining = pack.maxBytes ?? 80_000
    const contents = []
    for (const file of files.slice(0, 24)) {
      if (remaining <= 0) break
      const target = info?.isFile() ? root : resolve(root, file)
      const raw = await readFile(target, 'utf-8').catch(() => '')
      if (!raw.trim()) continue
      const excerpt = raw.slice(0, remaining)
      remaining -= Buffer.byteLength(excerpt)
      contents.push({
        path: info?.isFile() ? workspaceRelative(workspace.root, root) : file,
        excerpt,
      })
    }
    loaded.push({ pack, files: contents })
  }
  return loaded
}

export function loadPromptPackContextSync(workspace: WorkspaceBinding) {
  const packs = discoverPromptPacksSync(workspace)
  const loaded = []
  for (const pack of packs.slice(0, 6)) {
    const root = resolve(pack.path)
    if (!existsSync(root)) {
      loaded.push({ pack, error: `missing path: ${root}` })
      continue
    }
    const info = (() => {
      try {
        return statSync(root)
      } catch {
        return null
      }
    })()
    const files = info?.isFile()
      ? [basename(root)]
      : selectIncludedFiles(walkSync(root), pack.include)
    let remaining = pack.maxBytes ?? 80_000
    const contents = []
    for (const file of files.slice(0, 24)) {
      if (remaining <= 0) break
      const target = info?.isFile() ? root : resolve(root, file)
      const raw = (() => {
        try {
          return readFileSync(target, 'utf-8')
        } catch {
          return ''
        }
      })()
      if (!raw.trim()) continue
      const excerpt = raw.slice(0, remaining)
      remaining -= Buffer.byteLength(excerpt)
      contents.push({
        path: info?.isFile() ? workspaceRelative(workspace.root, root) : file,
        excerpt,
      })
    }
    loaded.push({ pack, files: contents })
  }
  return loaded
}

export async function managePromptPack(args: {
  workspace: WorkspaceBinding
  action: 'list' | 'register' | 'context'
  id?: string
  name?: string
  path?: string
  include?: string[]
  enabled?: boolean
  maxBytes?: number
}) {
  if (args.action === 'register') {
    if (!args.id || !args.path) throw new Error('id and path are required')
    return registerPromptPack({
      workspace: args.workspace,
      id: args.id,
      name: args.name,
      path: args.path,
      include: args.include,
      enabled: args.enabled,
      maxBytes: args.maxBytes,
    })
  }
  if (args.action === 'context') {
    return { promptPacks: await loadPromptPackContext(args.workspace) }
  }
  return {
    root: workspaceRelative(args.workspace.root, promptPackRoot(args.workspace)),
    env: envPromptPackPaths(),
    promptPacks: await discoverPromptPacks(args.workspace),
  }
}
