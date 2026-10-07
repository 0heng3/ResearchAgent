import { exec } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises'
import { dirname, extname, isAbsolute, join, relative, resolve } from 'node:path'
import { promisify } from 'node:util'
import { startBackgroundTask, listBackgroundTasks, stopBackgroundTask } from './backgroundRuntime'
import { runBrowserAction } from './browserRuntime'
import { createCapabilityManifest, CLAW_MCP_SERVERS } from './capabilities'
import { discoverWorkspaceCapabilities, installDefaultExtensibility, workspaceCapabilityRoots } from './capabilityRuntime'
import { inspectDocument } from './documentRuntime'
import { auditBenchmarkLedger, readBenchmarkLedger, recordBenchmarkEvidence } from './evidenceRuntime'
import { listHooks, registerHook, emitHook } from './hookRuntime'
import { discoverDynamicMcpTools, executeDynamicMcpTool } from './mcpClient'
import { analyzeMultimodalArtifact, type MultimodalRoute } from './multimodalRuntime'
import { selectModelForRun } from './modelRouter'
import { persistSessionMemory } from './persistentMemory'
import { readPermissionDecisions, recordPermissionDecision } from './permissions'
import { managePromptPack } from './promptPackRuntime'
import { runRepairLoop } from './repairRuntime'
import { createArtifactCard, inspectSamples, runExperiment } from './researchRuntime'
import { CLAW_SKILLS } from './skills'
import { manageSkill } from './skillRuntime'
import { fetchSourceSnapshot, searchWeb } from './webTools'
import { createWorkerTask } from './workerRuntime'
import { buildContextGraph } from './contextGraph'
import {
  isInsideWorkspace,
  safeJoinUnder,
  safeWorkspaceResolve,
  sanitizePathSegment,
  workspaceBindingFromRoot,
  workspaceRelative,
} from './workspace'
import type { CapabilityKind, RuntimePermissionMode, ToolCallTrace, WorkspaceBinding } from './types'
import type { ResearchInput } from './types'

const execAsync = promisify(exec)

type JsonSchema = {
  type: 'object'
  properties: Record<string, unknown>
  required?: string[]
  additionalProperties?: boolean
}

export type RuntimeToolContext = {
  workspace: WorkspaceBinding
  trace: ToolCallTrace[]
  input?: ResearchInput
  permissionMode?: RuntimePermissionMode
  modelRoute?: MultimodalRoute
  emitTrace?: (event: {
    id: string
    title: string
    status: 'queued' | 'running' | 'complete' | 'blocked' | 'error'
    detail: string
  }) => void
}

export type RuntimeToolDefinition = {
  name: string
  displayName: string
  description: string
  parameters: JsonSchema
  capabilityKind: CapabilityKind
  permissions: Array<'read' | 'write' | 'network' | 'execute'>
  mcpCompatible: boolean
  run(input: Record<string, unknown>, context: RuntimeToolContext): Promise<unknown>
}

const ignoredDirs = new Set([
  '.git',
  'node_modules',
  'dist',
  '.vite',
  '.cache',
  'coverage',
  'artifacts',
  'checkpoints',
  'datasets',
  'tmp',
])

const textExtensions = new Set([
  '.ts',
  '.tsx',
  '.js',
  '.jsx',
  '.mjs',
  '.cjs',
  '.json',
  '.md',
  '.txt',
  '.css',
  '.scss',
  '.html',
  '.py',
  '.rs',
  '.go',
  '.java',
  '.c',
  '.cpp',
  '.h',
  '.hpp',
  '.yaml',
  '.yml',
  '.toml',
  '.xml',
  '.sql',
  '.sh',
  '.ps1',
])

const planAllowedTools = new Set([
  'cog_read',
  'cog_glob',
  'cog_grep',
  'cog_workspace_status',
  'cog_permissions',
  'cog_skill_discover',
  'cog_mcp_discover',
  'cog_memory_compact',
  'cog_hook',
  'cog_background_task',
  'cog_benchmark_evidence',
  'cog_model_route',
  'cog_prompt_pack',
])

function toolInputString(value: unknown, fallback = '') {
  return typeof value === 'string' ? value : fallback
}

function toolInputBoolean(value: unknown, fallback = false) {
  return typeof value === 'boolean' ? value : fallback
}

function toolInputNumber(value: unknown, fallback: number, min: number, max: number) {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.min(max, Math.max(min, value))
    : fallback
}

function workspacePath(workspace: WorkspaceBinding, pathValue: unknown, permissionMode?: RuntimePermissionMode) {
  const raw = toolInputString(pathValue, '.')
  if (isAbsolute(raw)) {
    if ((permissionMode === 'noGate' || permissionMode === 'bypassPermissions') && isInsideWorkspace(process.cwd(), raw)) {
      return resolve(raw)
    }
    return safeWorkspaceResolve(workspace.root, workspaceRelative(workspace.root, raw))
  }
  return safeJoinUnder(workspace.root, raw)
}

function isProbablyText(path: string) {
  return textExtensions.has(extname(path).toLowerCase())
}

async function walkFiles(root: string, limit: number, base = root): Promise<string[]> {
  const files: string[] = []
  const entries = await readdir(root, { withFileTypes: true }).catch(() => [])
  for (const entry of entries) {
    if (files.length >= limit) break
    if (entry.name.startsWith('.') && entry.name !== '.cogclaw' && entry.name !== '.env.example') {
      if (ignoredDirs.has(entry.name)) continue
    }
    if (entry.name === '.env' || entry.name.endsWith('.local')) continue
    if (ignoredDirs.has(entry.name)) continue
    const target = join(root, entry.name)
    if (entry.isDirectory()) {
      files.push(...await walkFiles(target, Math.max(0, limit - files.length), base))
    } else if (entry.isFile()) {
      files.push(relative(base, target))
    }
  }
  return files
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

function summarize(value: unknown, max = 1600) {
  const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2)
  return text.length > max ? `${text.slice(0, max)}\n...truncated...` : text
}

function runtimeSkillCatalog() {
  return CLAW_SKILLS.map(skill => ({
    id: skill.id,
    name: skill.name,
    description: skill.purpose,
    trigger: skill.trigger,
    outputs: skill.outputs,
    source: 'runtime-built-in',
  }))
}

function runtimeMcpCatalog() {
  return CLAW_MCP_SERVERS.map(server => ({
    id: server.id,
    name: server.name,
    status: server.status,
    transport: server.transport,
    exposes: server.exposes,
    trustBoundary: server.trustBoundary,
    source: 'runtime-built-in',
  }))
}

function blockedShellReason(command: string) {
  const patterns: Array<[RegExp, string]> = [
    [/\brm\s+-rf\b/i, 'recursive deletion requires explicit approval'],
    [/\bgit\s+reset\s+--hard\b/i, 'destructive git reset requires explicit approval'],
    [/\bgit\s+clean\s+-f/i, 'destructive git clean requires explicit approval'],
    [/\bgit\s+push\b.*\s--force\b/i, 'force push requires explicit approval'],
    [/\bRemove-Item\b.*\b-Recurse\b/i, 'recursive PowerShell deletion requires explicit approval'],
    [/\bdel\s+\/s\b/i, 'recursive deletion requires explicit approval'],
    [/\bformat\b\s+[A-Z]:/i, 'disk format is blocked'],
    [/\bshutdown\b|\breboot\b/i, 'system power operations are blocked'],
  ]
  return patterns.find(([pattern]) => pattern.test(command))?.[1]
}

function shellWorkspaceEscapeReason(command: string, workspace: WorkspaceBinding) {
  const cdMatch = /(?:^|[;&|]\s*)cd(?:\s+\/d)?\s+["']?([^"';&|\r\n]+)["']?/i.exec(command)
  if (cdMatch?.[1]) {
    const target = resolve(workspace.root, cdMatch[1].trim())
    if (!isInsideWorkspace(workspace.root, target)) {
      return `shell command attempts to change directory outside workspace: ${cdMatch[1].trim()}`
    }
  }
  const absoluteCandidates = command.match(/[A-Za-z]:[\\/][^\s"';&|]+|\/(?:Users|home|mnt|var|tmp|opt|data|workspace|Volumes)\/[^\s"';&|]+/g) ?? []
  for (const candidate of absoluteCandidates) {
    const normalized = resolve(candidate)
    if (!isInsideWorkspace(workspace.root, normalized)) {
      return `shell command references an absolute path outside workspace: ${candidate}`
    }
  }
  return undefined
}

function normalizeWorkspaceCommand(command: string, workspace: WorkspaceBinding) {
  const root = workspace.root.replace(/\\/g, '/')
  const base = workspace.root.split(/[\\/]+/).filter(Boolean).at(-1)
  if (!base) return command
  const escapedBase = base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const duplicateRelativeCd = new RegExp(
    `^\\s*cd\\s+([^&|;\\r\\n]*[/\\\\])?${escapedBase}\\s*(?:&&|;|\\r?\\n)\\s*`,
    'i',
  )
  const duplicateAbsoluteCd = new RegExp(
    `^\\s*cd\\s+["']?${root.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}["']?\\s*(?:&&|;|\\r?\\n)\\s*`,
    'i',
  )
  return command
    .replace(/\\/g, '/')
    .replace(duplicateAbsoluteCd, '')
    .replace(duplicateRelativeCd, '')
}

function permissionModeLabel(mode?: RuntimePermissionMode) {
  if (mode === 'noGate') return 'No Gate'
  if (mode === 'bypassPermissions') return 'Bypass Permissions'
  if (mode === 'plan') return 'Plan'
  return 'Auto'
}

function planModeBlocks(tool: RuntimeToolDefinition, input: Record<string, unknown>) {
  const action = toolInputString(input.action)
  if (tool.name === 'cog_background_task' && action !== 'list') {
    return `Plan mode blocks ${tool.displayName}; background tasks can be listed, but start/stop requires Auto, Bypass Permissions or No Gate.`
  }
  if (tool.name === 'cog_hook' && action !== 'list') {
    return `Plan mode blocks ${tool.displayName}; hooks can be listed, but register/emit requires Auto, Bypass Permissions or No Gate.`
  }
  if (tool.name === 'cog_benchmark_evidence' && action === 'record') {
    return `Plan mode blocks ${tool.displayName}; evidence can be read/audited, but recording ledger entries requires Auto, Bypass Permissions or No Gate.`
  }
  if (tool.name === 'cog_skill_manage' && !['', 'list'].includes(action)) {
    return `Plan mode blocks ${tool.displayName}; skills can be listed, but enable/disable/version/smoke requires Auto, Bypass Permissions or No Gate.`
  }
  if (planAllowedTools.has(tool.name)) return ''
  if (!tool.permissions.some(permission => permission === 'write' || permission === 'execute' || permission === 'network')) {
    return ''
  }
  return `Plan mode blocks ${tool.displayName}; COG-CLAW may inspect and propose steps, but will not perform write/execute/network actions until mode changes. Requested input: ${summarize(input, 420)}`
}

async function runWithTrace(
  tool: RuntimeToolDefinition,
  input: Record<string, unknown>,
  context: RuntimeToolContext,
) {
  const id = `${tool.name}-${Date.now().toString(36)}-${context.trace.length + 1}`
  const started = Date.now()
  const mode = context.permissionMode ?? context.input?.permissionMode ?? 'auto'
  const planBlock = mode === 'plan' ? planModeBlocks(tool, input) : ''
  if (planBlock) {
    const trace: ToolCallTrace = {
      id,
      name: tool.displayName,
      capabilityKind: tool.capabilityKind,
      status: 'blocked',
      summary: `${tool.description} Permission mode: ${permissionModeLabel(mode)}.`,
      inputSummary: summarize(input, 320),
      outputSummary: planBlock,
      permissions: tool.permissions,
      mcpCompatible: tool.mcpCompatible,
      durationMs: Date.now() - started,
    }
    context.trace.push(trace)
    context.emitTrace?.({
      id,
      title: tool.displayName,
      status: 'blocked',
      detail: planBlock,
    })
    return { blocked: true, permissionMode: mode, reason: planBlock }
  }
  context.emitTrace?.({
    id,
    title: tool.displayName,
    status: 'running',
    detail: summarize(input, 420),
  })
  try {
    const output = await tool.run(input, context)
    const trace: ToolCallTrace = {
      id,
      name: tool.displayName,
      capabilityKind: tool.capabilityKind,
      status: 'complete',
      summary: tool.description,
      inputSummary: summarize(input, 320),
      outputSummary: summarize(output, 900),
      permissions: tool.permissions,
      mcpCompatible: tool.mcpCompatible,
      durationMs: Date.now() - started,
    }
    context.trace.push(trace)
    context.emitTrace?.({
      id,
      title: tool.displayName,
      status: 'complete',
      detail: trace.outputSummary,
    })
    return output
  } catch (error) {
    const message = error instanceof Error ? error.message : 'tool failed'
    const trace: ToolCallTrace = {
      id,
      name: tool.displayName,
      capabilityKind: tool.capabilityKind,
      status: 'error',
      summary: tool.description,
      inputSummary: summarize(input, 320),
      outputSummary: message,
      permissions: tool.permissions,
      mcpCompatible: tool.mcpCompatible,
      durationMs: Date.now() - started,
    }
    context.trace.push(trace)
    context.emitTrace?.({
      id,
      title: tool.displayName,
      status: 'error',
      detail: message,
    })
    return { error: message }
  }
}

function parseJsonObject(value: unknown) {
  if (!value) return {}
  if (typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>
  if (typeof value !== 'string' || !value.trim()) return {}
  const parsed = JSON.parse(value)
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Expected a JSON object')
  }
  return parsed as Record<string, unknown>
}

export const runtimeTools: RuntimeToolDefinition[] = [
  {
    name: 'cog_worker_task',
    displayName: 'Worker Task',
    description: 'Create a bounded worker task, optionally isolated in a git worktree, and persist its result.',
    capabilityKind: 'tool',
    permissions: ['read', 'write', 'execute'],
    mcpCompatible: true,
    parameters: {
      type: 'object',
      properties: {
        title: { type: 'string' },
        prompt: { type: 'string' },
        owner: { type: 'string' },
        command: { type: 'string' },
        use_worktree: { type: 'boolean' },
        timeout_ms: { type: 'number' },
      },
      required: ['title', 'prompt'],
      additionalProperties: false,
    },
    async run(input, { workspace }) {
      return createWorkerTask({
        workspace,
        title: toolInputString(input.title),
        prompt: toolInputString(input.prompt),
        owner: toolInputString(input.owner, 'cogclaw'),
        command: toolInputString(input.command),
        useWorktree: toolInputBoolean(input.use_worktree),
        timeoutMs: toolInputNumber(input.timeout_ms, 600_000, 1_000, 1_800_000),
      })
    },
  },
  {
    name: 'cog_permissions',
    displayName: 'Permissions',
    description: 'Read or record workspace-scoped tool permission decisions.',
    capabilityKind: 'tool',
    permissions: ['read', 'write'],
    mcpCompatible: true,
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['list', 'record'] },
        tool: { type: 'string' },
        behavior: { type: 'string', enum: ['allow', 'deny', 'ask'] },
        reason: { type: 'string' },
      },
      required: ['action'],
      additionalProperties: false,
    },
    async run(input, { workspace }) {
      const action = toolInputString(input.action, 'list')
      if (action === 'record') {
        return recordPermissionDecision(workspace, {
          tool: toolInputString(input.tool, 'unknown'),
          behavior: ['allow', 'deny', 'ask'].includes(toolInputString(input.behavior))
            ? toolInputString(input.behavior) as 'allow' | 'deny' | 'ask'
            : 'ask',
          reason: toolInputString(input.reason, 'recorded by COG-CLAW runtime'),
          source: 'runtime',
        })
      }
      return {
        decisions: await readPermissionDecisions(workspace),
      }
    },
  },
  {
    name: 'cog_hook',
    displayName: 'Hook',
    description: 'List, register or emit workspace lifecycle hooks such as PreToolUse, PostToolUse, Compact and Stop.',
    capabilityKind: 'tool',
    permissions: ['read', 'write', 'execute'],
    mcpCompatible: true,
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['list', 'register', 'emit'] },
        id: { type: 'string' },
        event: { type: 'string' },
        command: { type: 'string' },
        note: { type: 'string' },
        enabled: { type: 'boolean' },
        payload_json: { type: 'string' },
      },
      required: ['action'],
      additionalProperties: false,
    },
    async run(input, { workspace }) {
      const action = toolInputString(input.action, 'list')
      if (action === 'register') {
        return registerHook(workspace, {
          id: toolInputString(input.id),
          event: toolInputString(input.event),
          command: toolInputString(input.command),
          note: toolInputString(input.note),
          enabled: typeof input.enabled === 'boolean' ? input.enabled : true,
        })
      }
      if (action === 'emit') {
        return emitHook(workspace, toolInputString(input.event), parseJsonObject(input.payload_json))
      }
      return { hooks: await listHooks(workspace) }
    },
  },
  {
    name: 'cog_web_fetch',
    displayName: 'WebFetch',
    description: 'Fetch a URL, snapshot source evidence and store hash/timestamp/excerpt in the active workspace.',
    capabilityKind: 'browser',
    permissions: ['network', 'read', 'write'],
    mcpCompatible: true,
    parameters: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'HTTP or HTTPS URL to fetch.' },
        max_bytes: { type: 'number', description: 'Maximum bytes to snapshot.' },
      },
      required: ['url'],
      additionalProperties: false,
    },
    async run(input, { workspace }) {
      return fetchSourceSnapshot({
        workspace,
        url: toolInputString(input.url),
        maxBytes: toolInputNumber(input.max_bytes, 2_000_000, 20_000, 8_000_000),
      })
    },
  },
  {
    name: 'cog_browser_action',
    displayName: 'Browser Action',
    description: 'Use Chrome DevTools browser actions when configured, or snapshot pages through a fetch fallback.',
    capabilityKind: 'browser',
    permissions: ['network', 'read', 'write'],
    mcpCompatible: true,
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['snapshot', 'evaluate', 'click', 'type'] },
        url: { type: 'string' },
        selector: { type: 'string' },
        text: { type: 'string' },
        expression: { type: 'string' },
        cdp_url: { type: 'string' },
      },
      required: ['action', 'url'],
      additionalProperties: false,
    },
    async run(input, { workspace }) {
      const action = toolInputString(input.action, 'snapshot')
      if (!['snapshot', 'evaluate', 'click', 'type'].includes(action)) {
        throw new Error(`Unsupported browser action: ${action}`)
      }
      return runBrowserAction({
        workspace,
        action: action as 'snapshot' | 'evaluate' | 'click' | 'type',
        url: toolInputString(input.url),
        selector: toolInputString(input.selector),
        text: toolInputString(input.text),
        expression: toolInputString(input.expression),
        cdpUrl: toolInputString(input.cdp_url),
      })
    },
  },
  {
    name: 'cog_web_search',
    displayName: 'WebSearch',
    description: 'Search the web and store a timestamped search result record in the active workspace.',
    capabilityKind: 'browser',
    permissions: ['network', 'read', 'write'],
    mcpCompatible: true,
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search query.' },
        limit: { type: 'number', description: 'Maximum results.' },
      },
      required: ['query'],
      additionalProperties: false,
    },
    async run(input, { workspace }) {
      return searchWeb({
        workspace,
        query: toolInputString(input.query),
        limit: toolInputNumber(input.limit, 5, 1, 10),
      })
    },
  },
  {
    name: 'cog_sample_inspect',
    displayName: 'Sample Inspector',
    description: 'Inspect dataset/project/multimodal samples and write a sample profile under artifacts.',
    capabilityKind: 'verifier',
    permissions: ['read', 'write'],
    mcpCompatible: true,
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Workspace-relative path to inspect. Defaults to workspace root.' },
        limit: { type: 'number', description: 'Maximum files to sample.' },
      },
      additionalProperties: false,
    },
    async run(input, { workspace }) {
      return inspectSamples({
        workspace,
        path: toolInputString(input.path, '.'),
        limit: toolInputNumber(input.limit, 30, 1, 200),
      })
    },
  },
  {
    name: 'cog_document_inspect',
    displayName: 'Document Inspect',
    description: 'Inspect notebooks, PDFs, text, tables and binary media metadata inside the active workspace.',
    capabilityKind: 'verifier',
    permissions: ['read', 'write'],
    mcpCompatible: true,
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Workspace-relative document or media path.' },
      },
      required: ['path'],
      additionalProperties: false,
    },
    async run(input, { workspace }) {
      return inspectDocument({
        workspace,
        path: toolInputString(input.path),
      })
    },
  },
  {
    name: 'cog_multimodal_analyze',
    displayName: 'Multimodal Analyze',
    description: 'Analyze image/media artifacts semantically through the selected vision-capable model route when available.',
    capabilityKind: 'verifier',
    permissions: ['read', 'write', 'network'],
    mcpCompatible: true,
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Workspace-relative image/media path.' },
        prompt: { type: 'string', description: 'Analysis instruction.' },
      },
      required: ['path'],
      additionalProperties: false,
    },
    async run(input, { workspace, modelRoute }) {
      return analyzeMultimodalArtifact({
        workspace,
        path: toolInputString(input.path),
        prompt: toolInputString(input.prompt),
        route: modelRoute,
      })
    },
  },
  {
    name: 'cog_experiment_run',
    displayName: 'Experiment Runner',
    description: 'Run an explicit or inferred project command and persist stdout/stderr/exit evidence.',
    capabilityKind: 'runner',
    permissions: ['read', 'write', 'execute'],
    mcpCompatible: true,
    parameters: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'Command to run inside the active workspace.' },
        timeout_ms: { type: 'number', description: 'Timeout in milliseconds.' },
      },
      additionalProperties: false,
    },
    async run(input, { workspace }) {
      return runExperiment({
        workspace,
        command: toolInputString(input.command),
        timeoutMs: toolInputNumber(input.timeout_ms, 600_000, 1_000, 1_800_000),
      })
    },
  },
  {
    name: 'cog_repair_loop',
    displayName: 'Repair Loop',
    description: 'Run a command, optionally apply one exact-string patch after failure, rerun, and persist repair evidence.',
    capabilityKind: 'runner',
    permissions: ['read', 'write', 'execute'],
    mcpCompatible: true,
    parameters: {
      type: 'object',
      properties: {
        command: { type: 'string' },
        patch_path: { type: 'string' },
        old_string: { type: 'string' },
        new_string: { type: 'string' },
        max_attempts: { type: 'number' },
      },
      required: ['command'],
      additionalProperties: false,
    },
    async run(input, { workspace }) {
      return runRepairLoop({
        workspace,
        command: toolInputString(input.command),
        patchPath: toolInputString(input.patch_path),
        oldString: typeof input.old_string === 'string' ? input.old_string : undefined,
        newString: typeof input.new_string === 'string' ? input.new_string : undefined,
        maxAttempts: toolInputNumber(input.max_attempts, 2, 1, 5),
      })
    },
  },
  {
    name: 'cog_background_task',
    displayName: 'Background Task',
    description: 'Start, list or stop long-running workspace commands with persisted task records.',
    capabilityKind: 'runner',
    permissions: ['read', 'write', 'execute'],
    mcpCompatible: true,
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['start', 'list', 'stop'] },
        name: { type: 'string' },
        command: { type: 'string' },
        id: { type: 'string' },
      },
      required: ['action'],
      additionalProperties: false,
    },
    async run(input, { workspace }) {
      const action = toolInputString(input.action, 'list')
      if (action === 'start') {
        const command = toolInputString(input.command)
        const blocked = blockedShellReason(command) ?? shellWorkspaceEscapeReason(command, workspace)
        if (blocked) return { blocked: true, reason: blocked, command }
        return startBackgroundTask({
          workspace,
          name: toolInputString(input.name, 'background-task'),
          command,
        })
      }
      if (action === 'stop') {
        return stopBackgroundTask(workspace, toolInputString(input.id))
      }
      return { tasks: await listBackgroundTasks(workspace) }
    },
  },
  {
    name: 'cog_benchmark_evidence',
    displayName: 'Benchmark Evidence',
    description: 'Record, read or audit the benchmark evidence ledger for no-cheating SOTA work.',
    capabilityKind: 'verifier',
    permissions: ['read', 'write'],
    mcpCompatible: true,
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['record', 'read', 'audit'] },
        kind: { type: 'string', enum: ['dataset-split', 'metric-script', 'protocol', 'seed', 'config', 'run', 'claim'] },
        label: { type: 'string' },
        value: { type: 'string' },
        locked: { type: 'boolean' },
      },
      required: ['action'],
      additionalProperties: false,
    },
    async run(input, { workspace }) {
      const action = toolInputString(input.action, 'audit')
      if (action === 'record') {
        const kind = toolInputString(input.kind, 'claim')
        if (!['dataset-split', 'metric-script', 'protocol', 'seed', 'config', 'run', 'claim'].includes(kind)) {
          throw new Error(`Unsupported evidence kind: ${kind}`)
        }
        return recordBenchmarkEvidence({
          workspace,
          kind: kind as 'dataset-split' | 'metric-script' | 'protocol' | 'seed' | 'config' | 'run' | 'claim',
          label: toolInputString(input.label),
          value: toolInputString(input.value),
          locked: typeof input.locked === 'boolean' ? input.locked : undefined,
        })
      }
      if (action === 'read') return readBenchmarkLedger(workspace)
      return auditBenchmarkLedger(workspace)
    },
  },
  {
    name: 'cog_artifact_card',
    displayName: 'Artifact Card',
    description: 'Scan a workspace path and store a durable artifact card.',
    capabilityKind: 'tool',
    permissions: ['read', 'write'],
    mcpCompatible: true,
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Workspace-relative path to scan.' },
      },
      required: ['path'],
      additionalProperties: false,
    },
    async run(input, { workspace }) {
      return createArtifactCard({
        workspace,
        path: toolInputString(input.path),
      })
    },
  },
  {
    name: 'cog_memory_compact',
    displayName: 'Memory Compact',
    description: 'Persist compact/KV memory state for the active session and workspace.',
    capabilityKind: 'tool',
    permissions: ['read', 'write'],
    mcpCompatible: true,
    parameters: {
      type: 'object',
      properties: {},
      additionalProperties: false,
    },
    async run(_input, { workspace, input }) {
      if (!input) throw new Error('ResearchInput is required for memory compaction')
      return persistSessionMemory(workspace, input)
    },
  },
  {
    name: 'cog_read',
    displayName: 'Read',
    description: 'Read a file inside the active workspace with line numbers.',
    capabilityKind: 'tool',
    permissions: ['read'],
    mcpCompatible: true,
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Workspace-relative or absolute path inside the workspace.' },
        offset: { type: 'number', description: '1-based line offset.' },
        limit: { type: 'number', description: 'Maximum lines to return.' },
      },
      required: ['path'],
      additionalProperties: false,
    },
    async run(input, { workspace, permissionMode }) {
      const target = workspacePath(workspace, input.path, permissionMode)
      const text = await readFile(target, 'utf-8')
      const offset = toolInputNumber(input.offset, 1, 1, Number.MAX_SAFE_INTEGER)
      const limit = toolInputNumber(input.limit, 400, 1, 2000)
      const lines = text.split(/\r?\n/)
      const selected = lines.slice(offset - 1, offset - 1 + limit)
      return {
        path: workspaceRelative(workspace.root, target),
        totalLines: lines.length,
        offset,
        limit,
        content: selected.map((line, index) => `${offset + index}\t${line}`).join('\n'),
      }
    },
  },
  {
    name: 'cog_glob',
    displayName: 'Glob',
    description: 'Find files by glob pattern in the active workspace.',
    capabilityKind: 'tool',
    permissions: ['read'],
    mcpCompatible: true,
    parameters: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'Glob pattern such as **/*.ts.' },
        limit: { type: 'number', description: 'Maximum matched paths.' },
      },
      required: ['pattern'],
      additionalProperties: false,
    },
    async run(input, { workspace, permissionMode }) {
      const pattern = toolInputString(input.pattern, '**/*')
      const limit = toolInputNumber(input.limit, 120, 1, 500)
      const regex = globToRegex(pattern)
      const effectiveRoot = (!isAbsolute(workspace.root) && (permissionMode === 'noGate' || permissionMode === 'bypassPermissions'))
        ? resolve(process.cwd(), workspace.root)
        : workspace.root
      const files = await walkFiles(effectiveRoot, 4000)
      const matches = files
        .map(file => file.replace(/\\/g, '/'))
        .filter(file => regex.test(file))
        .slice(0, limit)
      return { pattern, count: matches.length, matches }
    },
  },
  {
    name: 'cog_grep',
    displayName: 'Grep',
    description: 'Search text files with a regex inside the active workspace.',
    capabilityKind: 'tool',
    permissions: ['read'],
    mcpCompatible: true,
    parameters: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'Regular expression to search.' },
        glob: { type: 'string', description: 'Optional file glob filter.' },
        limit: { type: 'number', description: 'Maximum matches.' },
      },
      required: ['pattern'],
      additionalProperties: false,
    },
    async run(input, { workspace, permissionMode }) {
      const pattern = toolInputString(input.pattern)
      const glob = toolInputString(input.glob, '**/*')
      const limit = toolInputNumber(input.limit, 80, 1, 300)
      const regex = new RegExp(pattern, 'i')
      const globRegex = globToRegex(glob)
      const effectiveRoot = (!isAbsolute(workspace.root) && (permissionMode === 'noGate' || permissionMode === 'bypassPermissions'))
        ? resolve(process.cwd(), workspace.root)
        : workspace.root
      const files = (await walkFiles(effectiveRoot, 5000))
        .filter(file => globRegex.test(file.replace(/\\/g, '/')))
        .filter(file => isProbablyText(file))
      const matches: Array<{ path: string; line: number; text: string }> = []
      for (const file of files) {
        if (matches.length >= limit) break
        const path = safeJoinUnder(effectiveRoot, file)
        const info = await stat(path).catch(() => null)
        if (!info || info.size > 900_000) continue
        const text = await readFile(path, 'utf-8').catch(() => '')
        text.split(/\r?\n/).forEach((line, index) => {
          if (matches.length < limit && regex.test(line)) {
            matches.push({ path: file, line: index + 1, text: line.slice(0, 500) })
          }
        })
      }
      return { pattern, glob, count: matches.length, matches }
    },
  },
  {
    name: 'cog_write',
    displayName: 'Write',
    description: 'Create or fully rewrite a file inside the active workspace.',
    capabilityKind: 'tool',
    permissions: ['write'],
    mcpCompatible: true,
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        content: { type: 'string' },
      },
      required: ['path', 'content'],
      additionalProperties: false,
    },
    async run(input, { workspace, permissionMode }) {
      const target = workspacePath(workspace, input.path, permissionMode)
      await mkdir(dirname(target), { recursive: true })
      const existed = existsSync(target)
      const content = toolInputString(input.content)
      await writeFile(target, content)
      return {
        path: workspaceRelative(workspace.root, target),
        existed,
        bytes: Buffer.byteLength(content),
      }
    },
  },
  {
    name: 'cog_edit',
    displayName: 'Edit',
    description: 'Replace exact text in an existing file inside the active workspace.',
    capabilityKind: 'tool',
    permissions: ['read', 'write'],
    mcpCompatible: true,
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        old_string: { type: 'string' },
        new_string: { type: 'string' },
        replace_all: { type: 'boolean' },
      },
      required: ['path', 'old_string', 'new_string'],
      additionalProperties: false,
    },
    async run(input, { workspace, permissionMode }) {
      const target = workspacePath(workspace, input.path, permissionMode)
      const oldString = toolInputString(input.old_string)
      const newString = toolInputString(input.new_string)
      const replaceAll = toolInputBoolean(input.replace_all)
      const original = await readFile(target, 'utf-8')
      if (!original.includes(oldString)) {
        throw new Error('old_string was not found in the file')
      }
      const occurrences = original.split(oldString).length - 1
      if (occurrences > 1 && !replaceAll) {
        throw new Error(`old_string is not unique (${occurrences} matches); pass replace_all=true or provide a more specific string`)
      }
      const updated = replaceAll ? original.split(oldString).join(newString) : original.replace(oldString, newString)
      await writeFile(target, updated)
      return {
        path: workspaceRelative(workspace.root, target),
        replacements: replaceAll ? occurrences : 1,
        bytes: Buffer.byteLength(updated),
      }
    },
  },
  {
    name: 'cog_bash',
    displayName: 'Bash',
    description: 'Run a shell command in the active workspace.',
    capabilityKind: 'tool',
    permissions: ['read', 'write', 'execute', 'network'],
    mcpCompatible: true,
    parameters: {
      type: 'object',
      properties: {
        command: { type: 'string' },
        timeout_ms: { type: 'number' },
      },
      required: ['command'],
      additionalProperties: false,
    },
    async run(input, { workspace, permissionMode }) {
      const originalCommand = toolInputString(input.command)
      const command = normalizeWorkspaceCommand(originalCommand, workspace)
      const skipEscapeCheck = permissionMode === 'noGate' || permissionMode === 'bypassPermissions'
      const blocked = blockedShellReason(command) ?? (skipEscapeCheck ? undefined : shellWorkspaceEscapeReason(command, workspace))
      if (blocked) {
        return { blocked: true, reason: blocked, command, originalCommand }
      }
      const timeout = toolInputNumber(input.timeout_ms, 120_000, 1_000, 600_000)
      const cwd = isAbsolute(workspace.root) ? workspace.root : process.cwd()
      const { stdout, stderr } = await execAsync(command, {
        cwd,
        timeout,
        maxBuffer: 8 * 1024 * 1024,
        windowsHide: true,
        shell: process.platform === 'win32' ? 'powershell.exe' : undefined,
      })
      return {
        command,
        originalCommand,
        cwd: workspace.root,
        stdout: stdout.slice(0, 6000),
        stderr: stderr.slice(0, 4000),
      }
    },
  },
  {
    name: 'cog_todo_write',
    displayName: 'TodoWrite',
    description: 'Record a visible work queue for long tasks.',
    capabilityKind: 'tool',
    permissions: ['read', 'write'],
    mcpCompatible: true,
    parameters: {
      type: 'object',
      properties: {
        todos: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              content: { type: 'string' },
              status: { type: 'string', enum: ['pending', 'in_progress', 'completed'] },
            },
            required: ['content', 'status'],
          },
        },
      },
      required: ['todos'],
      additionalProperties: false,
    },
    async run(input, { workspace }) {
      const target = safeJoinUnder(workspace.sessionRoot, 'todos.json')
      await mkdir(dirname(target), { recursive: true })
      await writeFile(target, JSON.stringify({ updatedAt: new Date().toISOString(), todos: input.todos ?? [] }, null, 2))
      return { path: workspaceRelative(workspace.root, target), todos: input.todos ?? [] }
    },
  },
  {
    name: 'cog_skill_discover',
    displayName: 'Skill',
    description: 'Discover installed workspace skills.',
    capabilityKind: 'skill',
    permissions: ['read'],
    mcpCompatible: true,
    parameters: {
      type: 'object',
      properties: {},
      additionalProperties: false,
    },
    async run(_input, { workspace }) {
      const discovery = await discoverWorkspaceCapabilities(workspace)
      const installedIds = new Set(discovery.skills.map(skill => skill.id))
      const builtIn = runtimeSkillCatalog().filter(skill => !installedIds.has(skill.id))
      return {
        roots: discovery.roots,
        summary: {
          installed: discovery.skills.length,
          builtIn: builtIn.length,
          totalVisible: discovery.skills.length + builtIn.length,
        },
        skills: discovery.skills.map(skill => ({
          id: skill.id,
          name: skill.name,
          description: skill.description,
          path: skill.path,
          allowedTools: skill.allowedTools,
          source: skill.source,
        })),
        builtInSkills: builtIn,
        note: 'Installed skills are workspace SKILL.md files. Built-in skills are runtime capabilities that COG-CLAW can invoke or materialize into workspace skills when needed.',
      }
    },
  },
  {
    name: 'cog_skill_install',
    displayName: 'Install Skill',
    description: 'Install or author a workspace-scoped skill.',
    capabilityKind: 'skill',
    permissions: ['read', 'write'],
    mcpCompatible: true,
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        name: { type: 'string' },
        description: { type: 'string' },
        body: { type: 'string' },
        allowed_tools: { type: 'string' },
      },
      required: ['id', 'name', 'description', 'body'],
      additionalProperties: false,
    },
    async run(input, { workspace }) {
      await installDefaultExtensibility(workspace)
      const roots = workspaceCapabilityRoots(workspace)
      const id = sanitizePathSegment(toolInputString(input.id)).toLowerCase()
      const dir = safeJoinUnder(roots.skills, id)
      await mkdir(dir, { recursive: true })
      const target = safeJoinUnder(dir, 'SKILL.md')
      const body = `---
name: ${toolInputString(input.name, id)}
description: ${toolInputString(input.description, `${id} skill`)}
allowed_tools: ${toolInputString(input.allowed_tools, 'Read, Grep, Glob, Bash, Edit, Write')}
---

${toolInputString(input.body)}
`
      await writeFile(target, body)
      return { id, path: target }
    },
  },
  {
    name: 'cog_skill_manage',
    displayName: 'Skill Manage',
    description: 'List, enable, disable, version or smoke-test workspace skills.',
    capabilityKind: 'skill',
    permissions: ['read', 'write', 'execute'],
    mcpCompatible: true,
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['list', 'enable', 'disable', 'version', 'smoke'] },
        id: { type: 'string' },
        version: { type: 'string' },
        command: { type: 'string' },
      },
      required: ['action'],
      additionalProperties: false,
    },
    async run(input, { workspace }) {
      const action = toolInputString(input.action, 'list')
      if (!['list', 'enable', 'disable', 'version', 'smoke'].includes(action)) {
        throw new Error(`Unsupported skill action: ${action}`)
      }
      return manageSkill({
        workspace,
        action: action as 'list' | 'enable' | 'disable' | 'version' | 'smoke',
        id: toolInputString(input.id),
        version: toolInputString(input.version),
        command: toolInputString(input.command),
      })
    },
  },
  {
    name: 'cog_prompt_pack',
    displayName: 'Prompt Pack',
    description: 'List, register or load external Claude-harness-style prompt packs into COG-CLAW context.',
    capabilityKind: 'skill',
    permissions: ['read', 'write'],
    mcpCompatible: true,
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['list', 'register', 'context'] },
        id: { type: 'string' },
        name: { type: 'string' },
        path: { type: 'string' },
        include: {
          type: 'array',
          items: { type: 'string' },
        },
        enabled: { type: 'boolean' },
        max_bytes: { type: 'number' },
      },
      required: ['action'],
      additionalProperties: false,
    },
    async run(input, { workspace }) {
      const action = toolInputString(input.action, 'list')
      if (!['list', 'register', 'context'].includes(action)) {
        throw new Error(`Unsupported prompt pack action: ${action}`)
      }
      return managePromptPack({
        workspace,
        action: action as 'list' | 'register' | 'context',
        id: toolInputString(input.id),
        name: toolInputString(input.name),
        path: toolInputString(input.path),
        include: Array.isArray(input.include) ? input.include.filter((item): item is string => typeof item === 'string') : undefined,
        enabled: typeof input.enabled === 'boolean' ? input.enabled : undefined,
        maxBytes: toolInputNumber(input.max_bytes, 80_000, 1_000, 500_000),
      })
    },
  },
  {
    name: 'cog_mcp_discover',
    displayName: 'MCP Discover',
    description: 'Discover configured workspace MCP manifests.',
    capabilityKind: 'mcp',
    permissions: ['read'],
    mcpCompatible: true,
    parameters: {
      type: 'object',
      properties: {},
      additionalProperties: false,
    },
    async run(_input, { workspace }) {
      const discovery = await discoverWorkspaceCapabilities(workspace)
      const installedIds = new Set(discovery.mcpServers.map(server => server.id))
      const builtIn = runtimeMcpCatalog().filter(server => !installedIds.has(server.id))
      return {
        roots: discovery.roots,
        summary: {
          installed: discovery.mcpServers.length,
          builtIn: builtIn.length,
          dynamicRuntimeTools: createCapabilityManifest().filter(capability => capability.kind === 'mcp').length,
        },
        mcpServers: discovery.mcpServers,
        builtInMcpServers: builtIn,
        note: 'Installed MCP servers are workspace manifests. Built-in MCP entries describe configured/discoverable runtime adapters and installer capabilities.',
      }
    },
  },
  {
    name: 'cog_mcp_install_manifest',
    displayName: 'Install MCP',
    description: 'Install a workspace-scoped MCP manifest.',
    capabilityKind: 'mcp',
    permissions: ['read', 'write', 'execute'],
    mcpCompatible: true,
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        manifest_json: { type: 'string', description: 'Full MCP manifest JSON.' },
      },
      required: ['id', 'manifest_json'],
      additionalProperties: false,
    },
    async run(input, { workspace }) {
      await installDefaultExtensibility(workspace)
      const roots = workspaceCapabilityRoots(workspace)
      const id = sanitizePathSegment(toolInputString(input.id)).toLowerCase()
      const parsed = JSON.parse(toolInputString(input.manifest_json))
      const manifest = {
        id,
        name: parsed.name ?? id,
        transport: parsed.transport ?? 'stdio',
        command: parsed.command,
        args: parsed.args ?? [],
        url: parsed.url,
        env: parsed.env ?? {},
        tools: parsed.tools ?? [],
        permissions: parsed.permissions ?? ['read'],
        status: parsed.status ?? 'installed',
      }
      const target = safeJoinUnder(roots.mcp, `${id}.json`)
      await mkdir(dirname(target), { recursive: true })
      await writeFile(target, JSON.stringify(manifest, null, 2))
      return { id, path: target, manifest }
    },
  },
  {
    name: 'cog_workspace_status',
    displayName: 'Workspace Status',
    description: 'Report active workspace and git state.',
    capabilityKind: 'tool',
    permissions: ['read'],
    mcpCompatible: true,
    parameters: {
      type: 'object',
      properties: {},
      additionalProperties: false,
    },
    async run(_input, { workspace }) {
      return workspaceBindingFromRoot(workspace.root, workspace.shared)
    },
  },
  {
    name: 'cog_model_route',
    displayName: 'Model Route',
    description: 'Resolve COG-CLAW model routing intent for controller/coder/verifier/browser/vision/budget work.',
    capabilityKind: 'model',
    permissions: ['read'],
    mcpCompatible: true,
    parameters: {
      type: 'object',
      properties: {
        preferred_model_id: { type: 'string' },
        task: { type: 'string' },
      },
      additionalProperties: false,
    },
    async run(input, { input: researchInput }) {
      if (!researchInput) {
        return {
          selected: toolInputString(input.preferred_model_id, 'runtime-selected'),
          note: 'No ResearchInput was available; current runtime model remains active.',
        }
      }
      const graph = buildContextGraph(researchInput)
      const route = selectModelForRun(
        researchInput,
        graph,
        toolInputString(input.preferred_model_id, researchInput.preferredModelId),
      )
      return {
        task: toolInputString(input.task),
        route,
      }
    },
  },
]

export function openAiToolDefinitions() {
  return runtimeTools.map(tool => ({
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    },
  }))
}

export async function openAiToolDefinitionsForWorkspace(workspace?: WorkspaceBinding) {
  const builtInTools = openAiToolDefinitions()
  if (!workspace) return builtInTools
  const dynamicTools = await discoverDynamicMcpTools(workspace).catch(() => [])
  return [
    ...builtInTools,
    ...dynamicTools.map(tool => ({
      type: 'function',
      function: {
        name: tool.runtimeName,
        description: `MCP ${tool.serverId}/${tool.toolName}: ${tool.description}`,
        parameters: tool.inputSchema,
      },
    })),
  ]
}

export async function executeRuntimeTool(
  name: string,
  input: Record<string, unknown>,
  context: RuntimeToolContext,
) {
  const tool = runtimeTools.find(item => item.name === name)
  if (!tool && name.startsWith('mcp_')) {
    const mcpTool: RuntimeToolDefinition = {
      name,
      displayName: `MCP ${name}`,
      description: 'Execute a dynamically discovered MCP tool.',
      capabilityKind: 'mcp',
      permissions: ['read', 'write', 'network', 'execute'],
      mcpCompatible: true,
      parameters: {
        type: 'object',
        properties: {},
        additionalProperties: true,
      },
      async run(mcpInput, { workspace }) {
        return executeDynamicMcpTool({
          workspace,
          runtimeName: name,
          input: mcpInput,
        })
      },
    }
    return runWithTrace(mcpTool, input, context)
  }
  if (!tool) return { error: `Unknown COG-CLAW tool: ${name}` }
  return runWithTrace(tool, input, context)
}
