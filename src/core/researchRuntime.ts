import { exec } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises'
import { dirname, extname, join } from 'node:path'
import { promisify } from 'node:util'
import { scanLocalArtifact } from './localIntake'
import { safeJoinUnder, workspaceRelative } from './workspace'
import type { ContextArtifact, WorkspaceBinding } from './types'

const execAsync = promisify(exec)

const dataExts = new Set(['.csv', '.tsv', '.jsonl', '.json', '.parquet', '.feather', '.xlsx'])
const mediaExts = new Set(['.png', '.jpg', '.jpeg', '.webp', '.tif', '.tiff', '.wav', '.mp3', '.mp4', '.mov'])

async function walk(root: string, limit: number, out: string[] = []): Promise<string[]> {
  if (out.length >= limit) return out
  const entries = await readdir(root, { withFileTypes: true }).catch(() => [])
  for (const entry of entries) {
    if (out.length >= limit) break
    if (['.git', 'node_modules', 'dist', '.vite', '.cache'].includes(entry.name)) continue
    const target = join(root, entry.name)
    if (entry.isDirectory()) await walk(target, limit, out)
    if (entry.isFile()) out.push(target)
  }
  return out
}

async function previewTextFile(path: string) {
  const text = await readFile(path, 'utf-8').catch(() => '')
  return text.split(/\r?\n/).slice(0, 12).join('\n').slice(0, 4000)
}

export async function inspectSamples(args: {
  workspace: WorkspaceBinding
  path?: string
  limit?: number
}) {
  const root = args.path ? safeJoinUnder(args.workspace.root, args.path) : args.workspace.root
  const info = await stat(root)
  const files = info.isDirectory() ? await walk(root, args.limit ?? 80) : [root]
  const samples = []
  for (const file of files.slice(0, args.limit ?? 30)) {
    const fileInfo = await stat(file).catch(() => null)
    if (!fileInfo) continue
    const ext = extname(file).toLowerCase()
    samples.push({
      path: workspaceRelative(args.workspace.root, file),
      bytes: fileInfo.size,
      extension: ext || '<none>',
      modality: dataExts.has(ext) ? 'tabular/text' : mediaExts.has(ext) ? 'media' : 'text/code',
      preview: dataExts.has(ext) || fileInfo.size < 128_000 ? await previewTextFile(file) : '',
    })
  }
  const artifact = await scanLocalArtifact(root)
  const target = safeJoinUnder(args.workspace.artifactRoot, 'inspectors', `sample-${Date.now().toString(36)}.json`)
  const report = {
    createdAt: new Date().toISOString(),
    root: workspaceRelative(args.workspace.root, root),
    artifact,
    samples,
    risks: [
      artifact.kind === 'dataset' ? 'scan for split leakage before optimization' : '',
      samples.some(sample => sample.bytes === 0) ? 'empty files present' : '',
      files.length >= (args.limit ?? 80) ? 'scan limit reached' : '',
    ].filter(Boolean),
  }
  await mkdir(dirname(target), { recursive: true })
  await writeFile(target, JSON.stringify(report, null, 2))
  return { ...report, path: workspaceRelative(args.workspace.root, target) }
}

function inferCommands(workspace: WorkspaceBinding) {
  const commands: string[] = []
  if (existsSync(safeJoinUnder(workspace.root, 'package.json'))) {
    commands.push('npm test -- --runInBand')
    commands.push('npm run build')
  }
  if (existsSync(safeJoinUnder(workspace.root, 'pyproject.toml'))) {
    commands.push('python -m pytest')
  } else if (existsSync(safeJoinUnder(workspace.root, 'requirements.txt'))) {
    commands.push('python -m pytest')
  }
  return commands
}

export async function runExperiment(args: {
  workspace: WorkspaceBinding
  command?: string
  timeoutMs?: number
}) {
  const command = args.command || inferCommands(args.workspace)[0]
  if (!command) {
    return {
      blocked: true,
      reason: 'no command provided and no package/python runner was detected',
      inferredCommands: inferCommands(args.workspace),
    }
  }
  const startedAt = new Date().toISOString()
  const started = Date.now()
  let exitCode = 0
  let stdout = ''
  let stderr = ''
  try {
    const result = await execAsync(command, {
      cwd: args.workspace.root,
      timeout: args.timeoutMs ?? 600_000,
      maxBuffer: 12 * 1024 * 1024,
      windowsHide: true,
    })
    stdout = result.stdout
    stderr = result.stderr
  } catch (error) {
    const failure = error as { code?: number; stdout?: string; stderr?: string; message?: string }
    exitCode = typeof failure.code === 'number' ? failure.code : 1
    stdout = failure.stdout ?? ''
    stderr = failure.stderr || failure.message || ''
  }
  const target = safeJoinUnder(args.workspace.artifactRoot, 'runs', `run-${Date.now().toString(36)}.json`)
  const report = {
    command,
    cwd: args.workspace.root,
    startedAt,
    finishedAt: new Date().toISOString(),
    durationMs: Date.now() - started,
    exitCode,
    stdout: stdout.slice(0, 20_000),
    stderr: stderr.slice(0, 12_000),
    passed: exitCode === 0,
  }
  await mkdir(dirname(target), { recursive: true })
  await writeFile(target, JSON.stringify(report, null, 2))
  return { ...report, path: workspaceRelative(args.workspace.root, target) }
}

export async function createArtifactCard(args: {
  workspace: WorkspaceBinding
  path: string
}): Promise<ContextArtifact & { cardPath: string }> {
  const target = safeJoinUnder(args.workspace.root, args.path)
  const artifact = await scanLocalArtifact(target)
  const card = safeJoinUnder(args.workspace.artifactRoot, 'cards', `${artifact.id}.json`)
  await mkdir(dirname(card), { recursive: true })
  await writeFile(card, JSON.stringify(artifact, null, 2))
  return { ...artifact, cardPath: workspaceRelative(args.workspace.root, card) }
}
