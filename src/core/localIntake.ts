import { readdir, readFile, stat } from 'node:fs/promises'
import { basename, extname, join, resolve } from 'node:path'
import type {
  ArtifactKind,
  ArtifactModality,
  ContextArtifact,
  ResearchInput,
} from './types'

const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.webp', '.tif', '.tiff', '.bmp'])
const AUDIO_EXT = new Set(['.wav', '.mp3', '.flac', '.m4a', '.ogg'])
const VIDEO_EXT = new Set(['.mp4', '.mov', '.avi', '.mkv', '.webm'])
const TABLE_EXT = new Set(['.csv', '.tsv', '.parquet', '.feather', '.xlsx'])
const CODE_EXT = new Set([
  '.ts',
  '.tsx',
  '.js',
  '.jsx',
  '.py',
  '.r',
  '.rs',
  '.go',
  '.java',
  '.cpp',
  '.c',
  '.h',
  '.yaml',
  '.yml',
  '.json',
  '.toml',
])
const TEXT_EXT = new Set(['.md', '.txt', '.rst', '.tex'])
const PAPER_EXT = new Set(['.pdf', '.bib'])
const LOG_EXT = new Set(['.log', '.out', '.err'])
const IGNORED_DIRS = new Set([
  '.git',
  '.logs',
  '.playwright-mcp',
  'node_modules',
  '__pycache__',
  'dist',
  'outputs',
  'coverage',
  '.vite',
  '.cache',
])

type FileSummary = {
  totalFiles: number
  byExt: Map<string, number>
  sampleFiles: string[]
  hasPackage: boolean
  hasPythonProject: boolean
  hasBenchmarkHints: boolean
  hasMetricsHints: boolean
  hasDatasetHints: boolean
  hasRunLogs: boolean
  hasConfigHints: boolean
}

function makeId(prefix: string, value: string) {
  return `${prefix}-${value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 48)}`
}

async function walk(
  root: string,
  limit = 1200,
  out: string[] = [],
  current = root,
): Promise<string[]> {
  if (out.length >= limit) return out
  let entries
  try {
    entries = await readdir(current, { withFileTypes: true })
  } catch {
    return out
  }

  for (const entry of entries) {
    if (out.length >= limit) break
    if (IGNORED_DIRS.has(entry.name)) {
      continue
    }
    if (entry.name === '.env' || entry.name.endsWith('.local')) {
      continue
    }
    const path = join(current, entry.name)
    if (entry.isDirectory()) {
      await walk(root, limit, out, path)
    } else if (entry.isFile()) {
      out.push(path)
    }
  }
  return out
}

function summarizeFiles(root: string, files: string[]): FileSummary {
  const byExt = new Map<string, number>()
  let hasPackage = false
  let hasPythonProject = false
  let hasBenchmarkHints = false
  let hasMetricsHints = false
  let hasDatasetHints = false
  let hasRunLogs = false
  let hasConfigHints = false

  for (const file of files) {
    const ext = extname(file).toLowerCase() || '<none>'
    byExt.set(ext, (byExt.get(ext) ?? 0) + 1)
    const lower = file.toLowerCase().replaceAll('\\', '/')
    const name = basename(lower)
    if (name === 'package.json') hasPackage = true
    if (name === 'pyproject.toml' || name === 'requirements.txt' || name === 'setup.py') {
      hasPythonProject = true
    }
    if (lower.includes('benchmark') || lower.includes('leaderboard') || lower.includes('submission')) {
      hasBenchmarkHints = true
    }
    if (lower.includes('metric') || lower.includes('evaluate') || lower.includes('eval')) {
      hasMetricsHints = true
    }
    if (lower.includes('dataset') || lower.includes('data/') || lower.includes('/labels')) {
      hasDatasetHints = true
    }
    if (LOG_EXT.has(ext) || lower.includes('/runs/') || lower.includes('\\runs\\')) {
      hasRunLogs = true
    }
    if (
      name.includes('config') ||
      name.includes('protocol') ||
      name === 'package.json' ||
      name === 'pyproject.toml'
    ) {
      hasConfigHints = true
    }
  }

  return {
    totalFiles: files.length,
    byExt,
    sampleFiles: files.slice(0, 18).map(file => file.replace(root, '').replace(/^[/\\]/, '')),
    hasPackage,
    hasPythonProject,
    hasBenchmarkHints,
    hasMetricsHints,
    hasDatasetHints,
    hasRunLogs,
    hasConfigHints,
  }
}

function countExt(summary: FileSummary, extSet: Set<string>) {
  let count = 0
  for (const ext of extSet) {
    count += summary.byExt.get(ext) ?? 0
  }
  return count
}

function inferModality(summary: FileSummary): ArtifactModality {
  const image = countExt(summary, IMAGE_EXT)
  const audio = countExt(summary, AUDIO_EXT)
  const video = countExt(summary, VIDEO_EXT)
  const table = countExt(summary, TABLE_EXT)
  const code = countExt(summary, CODE_EXT)

  const active = [image, audio, video, table, code].filter(Boolean).length
  if (active > 1) return 'mixed'
  if (image) return 'image'
  if (audio) return 'audio'
  if (video) return 'video'
  if (table) return 'tabular'
  if (code) return 'code'
  return 'text'
}

function inferKind(path: string, summary: FileSummary, isDirectory: boolean): ArtifactKind {
  const ext = extname(path).toLowerCase()
  const lower = path.toLowerCase()
  if (summary.hasBenchmarkHints && summary.hasMetricsHints) return 'benchmark'
  if (isDirectory && (summary.hasPackage || summary.hasPythonProject)) return 'project-code'
  if (summary.hasDatasetHints || countExt(summary, TABLE_EXT) + countExt(summary, IMAGE_EXT) > 20) {
    return 'dataset'
  }
  if (PAPER_EXT.has(ext)) return 'paper'
  if (LOG_EXT.has(ext)) return 'experiment-log'
  if (CODE_EXT.has(ext)) return 'project-code'
  if (IMAGE_EXT.has(ext)) return 'image'
  if (AUDIO_EXT.has(ext)) return 'audio'
  if (VIDEO_EXT.has(ext)) return 'video'
  if (TABLE_EXT.has(ext)) return 'table'
  if (TEXT_EXT.has(ext)) return 'text'
  return 'unknown'
}

function risksFor(kind: ArtifactKind, summary: FileSummary): string[] {
  const risks = ['requires source verification']
  if (kind === 'benchmark') risks.push('do not mutate official evaluation protocol')
  if (kind === 'project-code') risks.push('entrypoints and dependency versions must be locked')
  if (kind === 'dataset') risks.push('split leakage and duplicate samples must be scanned')
  if (kind === 'experiment-log') risks.push('single-run logs are not enough for promotion')
  if (summary.totalFiles >= 1200) risks.push('scan limit reached; deeper indexing required')
  return risks
}

export async function scanLocalArtifact(pathLike: string): Promise<ContextArtifact> {
  const abs = resolve(pathLike)
  const info = await stat(abs)
  const files = info.isDirectory() ? await walk(abs) : [abs]
  const summary = summarizeFiles(info.isDirectory() ? abs : resolve(abs, '..'), files)
  const kind = inferKind(abs, summary, info.isDirectory())
  const modality = inferModality(summary)
  const extSummary = [...summary.byExt.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 6)
    .map(([ext, count]) => `${ext}:${count}`)
    .join(', ')

  return {
    id: makeId(kind, basename(abs) || abs),
    kind,
    modality,
    title: basename(abs) || abs,
    uri: abs,
    summary: `${summary.totalFiles} files scanned; ${extSummary || 'no extension summary'}.`,
    signals: [
      `${kind} artifact`,
      `${modality} modality`,
      summary.hasBenchmarkHints ? 'benchmark hints' : '',
      summary.hasMetricsHints ? 'metric/eval hints' : '',
      summary.hasDatasetHints ? 'dataset hints' : '',
      summary.hasRunLogs ? 'run/log hints' : '',
      summary.hasConfigHints ? 'config/protocol hints' : '',
      ...summary.sampleFiles.slice(0, 5),
    ].filter(Boolean),
    risks: risksFor(kind, summary),
    trust: kind === 'benchmark' ? 0.88 : kind === 'project-code' ? 0.78 : 0.68,
    metadata: {
      totalFiles: summary.totalFiles,
      hasPackage: summary.hasPackage,
      hasPythonProject: summary.hasPythonProject,
      hasBenchmarkHints: summary.hasBenchmarkHints,
      hasMetricsHints: summary.hasMetricsHints,
      hasDatasetHints: summary.hasDatasetHints,
      hasRunLogs: summary.hasRunLogs,
      hasConfigHints: summary.hasConfigHints,
    },
  }
}

export async function readResearchInputJson(pathLike: string): Promise<ResearchInput> {
  const text = await readFile(resolve(pathLike), 'utf-8')
  return JSON.parse(text) as ResearchInput
}

export async function createResearchInputFromPaths(args: {
  title: string
  goal: string
  metric: string
  paths: string[]
}): Promise<ResearchInput> {
  const scannedArtifacts = await Promise.all(args.paths.map(scanLocalArtifact))
  const artifacts = scannedArtifacts.flatMap(expandCompositeArtifact)
  const hasBenchmark = artifacts.some(artifact => artifact.kind === 'benchmark')
  const hasProject = artifacts.some(artifact => artifact.kind === 'project-code')
  const hasMixed = artifacts.some(artifact => artifact.modality === 'mixed')
  return {
    title: args.title,
    mode: hasBenchmark
      ? 'benchmark'
      : hasProject
        ? 'existing-project'
        : hasMixed
          ? 'multimodal'
          : 'open-ended',
    goal: args.goal,
    targetMetric: args.metric,
    artifacts,
    constraints: [
      'No hardcoded metric',
      'No test-set leakage',
      'Preserve benchmark protocol',
      'Clean-room rerun before accepting best candidate',
    ],
  }
}

function expandCompositeArtifact(artifact: ContextArtifact): ContextArtifact[] {
  const metadata = artifact.metadata ?? {}
  const derived: ContextArtifact[] = [artifact]
  const uri = artifact.uri
  const hasBenchmark = Boolean(metadata.hasBenchmarkHints)
  const hasMetrics = Boolean(metadata.hasMetricsHints)
  const hasDataset = Boolean(metadata.hasDatasetHints)
  const hasRunLogs = Boolean(metadata.hasRunLogs)
  const hasConfig = Boolean(metadata.hasConfigHints)
  const hasProject = Boolean(metadata.hasPackage || metadata.hasPythonProject)

  if (hasDataset && artifact.kind !== 'dataset') {
    derived.push({
      id: `${artifact.id}-dataset`,
      kind: 'dataset',
      modality: artifact.modality === 'mixed' ? 'tabular' : artifact.modality,
      title: `${artifact.title} dataset`,
      uri,
      summary: `Dataset files were discovered inside ${artifact.title}.`,
      signals: ['dataset hints', ...artifact.signals.slice(0, 4)],
      risks: ['split leakage and duplicate samples must be scanned'],
      trust: Math.min(0.86, artifact.trust + 0.04),
      metadata: { parentArtifact: artifact.id },
    })
  }

  if (hasBenchmark && hasMetrics && artifact.kind !== 'benchmark') {
    derived.push({
      id: `${artifact.id}-benchmark`,
      kind: 'benchmark',
      modality: 'code',
      title: `${artifact.title} benchmark protocol`,
      uri,
      summary: `Benchmark and metric/evaluation files were discovered inside ${artifact.title}.`,
      signals: ['benchmark hints', 'metric/eval hints', ...artifact.signals.slice(0, 4)],
      risks: ['do not mutate official evaluation protocol'],
      trust: Math.min(0.9, artifact.trust + 0.08),
      metadata: { parentArtifact: artifact.id },
    })
  }

  if (hasRunLogs) {
    derived.push({
      id: `${artifact.id}-logs`,
      kind: 'experiment-log',
      modality: 'text',
      title: `${artifact.title} run logs`,
      uri,
      summary: `Run logs or metric traces were discovered inside ${artifact.title}.`,
      signals: ['execution logs', 'metric trace available', ...artifact.signals.slice(0, 4)],
      risks: ['single-run logs are not enough for final promotion'],
      trust: Math.min(0.84, artifact.trust + 0.04),
      metadata: { parentArtifact: artifact.id },
    })
  }

  if (hasConfig) {
    derived.push({
      id: `${artifact.id}-config`,
      kind: 'config',
      modality: 'text',
      title: `${artifact.title} config/protocol`,
      uri,
      summary: `Config or protocol files were discovered inside ${artifact.title}.`,
      signals: ['config/protocol hints', ...artifact.signals.slice(0, 4)],
      risks: ['protocol and config changes must be explicit'],
      trust: Math.min(0.82, artifact.trust + 0.03),
      metadata: { parentArtifact: artifact.id },
    })
  }

  if (hasProject && artifact.kind !== 'project-code') {
    derived.push({
      id: `${artifact.id}-project`,
      kind: 'project-code',
      modality: 'code',
      title: `${artifact.title} project code`,
      uri,
      summary: `Executable project files were discovered inside ${artifact.title}.`,
      signals: ['project package', ...artifact.signals.slice(0, 4)],
      risks: ['entrypoints and dependency versions must be locked'],
      trust: Math.min(0.82, artifact.trust + 0.04),
      metadata: { parentArtifact: artifact.id },
    })
  }

  return derived
}
