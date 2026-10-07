#!/usr/bin/env node
import { createInterface } from 'node:readline/promises'
import { stdin as input, stdout as output } from 'node:process'
import { existsSync, statSync } from 'node:fs'
import { copyFile, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { discoverWorkspaceCapabilities, installDefaultExtensibility } from './core/capabilityRuntime'
import { runClawHarness } from './core/harness'
import { createResearchInputFromPaths, scanLocalArtifact } from './core/localIntake'
import {
  applyLocalEnvFile,
  listRuntimeModels,
  resolveUsableModelRoute,
  type ResolvedModelRoute,
} from './core/runtimeEnv'
import { runStreamingToolLoop, type StreamTraceEvent } from './core/chatStreamRuntime'
import { manageSkill } from './core/skillRuntime'
import { discoverDynamicMcpTools } from './core/mcpClient'
import { createRegisteredSessionWorkspace, readWorkspaceRegistry, upsertWorkspace } from './core/workspaceRegistry'
import { initializeWorkspaceGit, safeJoinUnder, sanitizePathSegment, workspaceBindingFromRoot } from './core/workspace'
import type {
  ContextArtifact,
  ConversationTurn,
  ResearchInput,
  RuntimePermissionMode,
  WorkspaceBinding,
} from './core/types'

type CliOptions = {
  workspace?: string
  model?: string
  mode: RuntimePermissionMode
  once?: string
  attachments: string[]
  listWorkspaces: boolean
  listSessions: boolean
  resume?: string | boolean
  newSession: boolean
}

type CliSession = {
  id: string
  title: string
  workspace: WorkspaceBinding
  input: ResearchInput
  model?: string
  mode: RuntimePermissionMode
  createdAt: string
  updatedAt: string
}

type CliState = {
  workspace: WorkspaceBinding
  model?: string
  mode: RuntimePermissionMode
  session: CliSession
  conversation: ConversationTurn[]
  attachments: ContextArtifact[]
}

type CliSessionRegistry = {
  activeSessionId?: string
  sessions: Array<{
    id: string
    title: string
    workspaceName: string
    workspaceRoot: string
    updatedAt: string
    path: string
  }>
}

const reset = '\x1b[0m'
const dim = '\x1b[2m'
const bold = '\x1b[1m'
const cyan = '\x1b[36m'
const green = '\x1b[32m'
const yellow = '\x1b[33m'
const red = '\x1b[31m'
const gray = '\x1b[90m'

function color(value: string, code: string) {
  return `${code}${value}${reset}`
}

function normalizeMode(value?: string): RuntimePermissionMode {
  if (value === 'plan') return 'plan'
  if (value === 'bypass' || value === 'bypassPermissions') return 'bypassPermissions'
  if (value === 'nogate' || value === 'noGate') return 'noGate'
  return 'auto'
}

function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = {
    mode: 'auto',
    attachments: [],
    listWorkspaces: false,
    listSessions: false,
    newSession: false,
  }
  const positional: string[] = []

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    const next = argv[index + 1]
    if (arg === '--workspace' || arg === '--root' || arg === '--project' || arg === '-r') {
      options.workspace = next
      index += 1
    } else if (arg === '--model' || arg === '-m') {
      options.model = next
      index += 1
    } else if (arg === '--mode') {
      options.mode = normalizeMode(next)
      index += 1
    } else if (arg === '--once' || arg === '-p') {
      options.once = next
      index += 1
    } else if (arg === '--attach' || arg === '--file' || arg === '-a') {
      if (next) options.attachments.push(next)
      index += 1
    } else if (arg === '--workspaces' || arg === '--list-workspaces') {
      options.listWorkspaces = true
    } else if (arg === '--sessions' || arg === '--list-sessions') {
      options.listSessions = true
    } else if (arg === '--resume') {
      options.resume = next && !next.startsWith('-') ? next : true
      if (typeof options.resume === 'string') index += 1
    } else if (arg === '--new') {
      options.newSession = true
    } else if (arg && !arg.startsWith('-')) {
      positional.push(arg)
    }
  }

  if (positional[0] === 'workspaces') {
    options.listWorkspaces = true
    return options
  }
  if (positional[0] === 'sessions') {
    options.listSessions = true
    return options
  }
  if (positional[0] === 'resume') {
    options.resume = positional[1] ?? true
    return options
  }

  if (!options.workspace && positional[0] && existsSync(resolve(positional[0]))) {
    const firstPath = positional.shift()!
    const info = statSync(resolve(firstPath))
    if (info.isDirectory()) {
      options.workspace = firstPath
    } else {
      options.attachments.push(firstPath)
    }
  }

  if (!options.once && positional.length) {
    options.once = positional.join(' ')
  }

  return options
}

function cliRoot() {
  return resolve(process.cwd(), 'artifacts', 'cli')
}

function cliRegistryPath() {
  return resolve(cliRoot(), 'sessions.json')
}

function cliSessionPath(id: string) {
  return resolve(cliRoot(), 'sessions', `${id}.json`)
}

function sessionId() {
  return `cli-${Date.now().toString(36)}`
}

function titleFromMessage(message: string, fallback: string) {
  const clean = message.replace(/\s+/g, ' ').trim()
  if (!clean) return fallback
  return clean.length > 54 ? `${clean.slice(0, 53)}...` : clean
}

function shortPath(path: string) {
  const cwd = process.cwd()
  const rel = relative(cwd, path)
  if (rel && !rel.startsWith('..')) return rel || '.'
  const parts = path.split(/[\\/]+/)
  return parts.length > 4 ? `.../${parts.slice(-3).join('/')}` : path
}

function pathInside(base: string, target: string) {
  const rel = relative(resolve(base), resolve(target))
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

async function copyPathIntoInbox(
  source: string,
  root: string,
  inboxRoot: string,
): Promise<Array<{ source: string; target: string }>> {
  const absolute = resolve(source)
  if (pathInside(inboxRoot, absolute)) return []
  const info = await stat(absolute)
  const safeName = sanitizePathSegment(basename(absolute) || 'attachment')
  const target = safeJoinUnder(root, safeName)
  if (info.isDirectory()) {
    await mkdir(target, { recursive: true })
    const copied: Array<{ source: string; target: string }> = []
    const entries = await readdir(absolute, { withFileTypes: true })
    for (const entry of entries) {
      if ([
        '.git',
        '.cogclaw',
        '.logs',
        '.cache',
        '.vite',
        'node_modules',
        'dist',
        'artifacts',
        'outputs',
        'runs',
        'coverage',
      ].includes(entry.name)) continue
      copied.push(...await copyPathIntoInbox(join(absolute, entry.name), target, inboxRoot))
    }
    return copied
  }
  await mkdir(dirname(target), { recursive: true })
  await copyFile(absolute, target)
  return [{ source: absolute, target }]
}

async function attachPaths(workspace: WorkspaceBinding, paths: string[]) {
  const requested = paths.map(item => item.trim()).filter(Boolean)
  if (!requested.length) return { artifacts: [] as ContextArtifact[], root: '', files: [] as Array<{ source: string; target: string }> }
  const batch = `cli-inbox-${Date.now().toString(36)}`
  const root = safeJoinUnder(workspace.artifactRoot, 'inbox', batch)
  await mkdir(root, { recursive: true })
  const files: Array<{ source: string; target: string }> = []
  const artifactTargets: string[] = []
  for (const path of requested) {
    if (!existsSync(resolve(path))) {
      throw new Error(`Attachment does not exist: ${resolve(path)}`)
    }
    const copied = await copyPathIntoInbox(path, root, root)
    files.push(...copied)
    artifactTargets.push(safeJoinUnder(root, sanitizePathSegment(basename(resolve(path)) || 'attachment')))
  }
  const artifacts = await Promise.all(artifactTargets.map(scanLocalArtifact))
  await writeFile(
    safeJoinUnder(root, 'manifest.json'),
    JSON.stringify({
      batch,
      createdAt: new Date().toISOString(),
      files,
      artifacts: artifacts.map(artifact => ({
        id: artifact.id,
        kind: artifact.kind,
        modality: artifact.modality,
        title: artifact.title,
        uri: artifact.uri,
      })),
    }, null, 2),
  )
  return { artifacts, root, files }
}

function workspaceLabel(workspace: WorkspaceBinding, index?: number) {
  const prefix = index === undefined ? '' : `${String(index + 1).padStart(2, '0')}. `
  const git = workspace.git?.initialized
    ? `${workspace.git.branch || 'git'}${workspace.git.dirty ? '*' : ''}`
    : 'no-git'
  const scope = workspace.shared ? 'shared' : 'isolated'
  return `${prefix}${color(workspace.name, bold)} ${color(`[${scope} / ${git}]`, gray)}\n    ${shortPath(workspace.root)}`
}

function printBanner() {
  console.log('')
  console.log(`${color('(o)', cyan)} ${color('COG-CLAW', bold + cyan)} ${color('terminal cockpit', dim)} ${color('Claude-Code-style local agent runtime', gray)}`)
  console.log(color('Type /help for commands. Work happens inside the active workspace.', gray))
  console.log('')
}

function startSpinner(label: string) {
  if (!process.stdout.isTTY) return () => undefined
  const frames = ['(.)', '(o)', '(O)', '(o)']
  let index = 0
  const timer = setInterval(() => {
    output.write(`\r${color(frames[index % frames.length], cyan)} ${color(label, gray)} `)
    index += 1
  }, 140)
  return () => {
    clearInterval(timer)
    output.write('\r\x1b[2K')
  }
}

function formatTime(value: string) {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return date.toLocaleString([], {
    month: 'short',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  })
}

async function printWorkspaces(active?: WorkspaceBinding) {
  const registry = await readWorkspaceRegistry()
  console.log(color('Workspaces', bold))
  if (!registry.workspaces.length) {
    console.log(color('  no registered workspaces', gray))
    console.log('')
    return
  }
  registry.workspaces.forEach((workspace, index) => {
    const marker = active?.id === workspace.id ? color('* ', green) : '  '
    console.log(`${marker}${workspaceLabel(workspace, index)}`)
    console.log(`    ${color(workspace.id, gray)}`)
  })
  console.log('')
}

async function resolveWorkspace(pathLike?: string) {
  if (pathLike) {
    const root = resolve(pathLike)
    if (!existsSync(root)) throw new Error(`Workspace does not exist: ${root}`)
    return upsertWorkspace(workspaceBindingFromRoot(root, true))
  }
  const registry = await readWorkspaceRegistry()
  return registry.workspaces[0] ?? upsertWorkspace(workspaceBindingFromRoot(process.cwd(), true))
}

async function selectWorkspace(idOrIndex: string) {
  const registry = await readWorkspaceRegistry()
  const numeric = Number(idOrIndex)
  if (Number.isFinite(numeric)) return registry.workspaces[numeric - 1]
  return registry.workspaces.find(workspace =>
    workspace.id === idOrIndex ||
    workspace.name === idOrIndex ||
    resolve(workspace.root) === resolve(idOrIndex),
  )
}

async function readCliRegistry(): Promise<CliSessionRegistry> {
  try {
    return JSON.parse(await readFile(cliRegistryPath(), 'utf-8')) as CliSessionRegistry
  } catch {
    return { sessions: [] }
  }
}

async function writeCliRegistry(registry: CliSessionRegistry) {
  await mkdir(cliRoot(), { recursive: true })
  await writeFile(cliRegistryPath(), JSON.stringify(registry, null, 2))
}

async function saveCliSession(session: CliSession) {
  await mkdir(resolve(cliRoot(), 'sessions'), { recursive: true })
  await writeFile(cliSessionPath(session.id), JSON.stringify(session, null, 2))
  const registry = await readCliRegistry()
  const next = [
    {
      id: session.id,
      title: session.title,
      workspaceName: session.workspace.name,
      workspaceRoot: session.workspace.root,
      updatedAt: session.updatedAt,
      path: cliSessionPath(session.id),
    },
    ...registry.sessions.filter(item => item.id !== session.id),
  ].slice(0, 80)
  await writeCliRegistry({ activeSessionId: session.id, sessions: next })
}

async function loadCliSession(idOrIndex?: string | boolean) {
  const registry = await readCliRegistry()
  let meta: CliSessionRegistry['sessions'][number] | undefined = registry.sessions[0]
  if (typeof idOrIndex === 'string' && idOrIndex !== 'true') {
    const index = Number(idOrIndex)
    meta = Number.isFinite(index)
      ? registry.sessions[index - 1]
      : registry.sessions.find(item => item.id === idOrIndex || item.title === idOrIndex)
  } else if (registry.activeSessionId) {
    meta = registry.sessions.find(item => item.id === registry.activeSessionId) ?? meta
  }
  if (!meta) return undefined
  return JSON.parse(await readFile(meta.path, 'utf-8')) as CliSession
}

async function deleteCliSession(idOrIndex: string) {
  const registry = await readCliRegistry()
  const index = Number(idOrIndex)
  const meta = Number.isFinite(index)
    ? registry.sessions[index - 1]
    : registry.sessions.find(item => item.id === idOrIndex || item.title === idOrIndex)
  if (!meta) return false
  await rm(meta.path, { force: true })
  const sessions = registry.sessions.filter(item => item.id !== meta.id)
  await writeCliRegistry({
    activeSessionId: registry.activeSessionId === meta.id ? sessions[0]?.id : registry.activeSessionId,
    sessions,
  })
  return true
}

async function printCliSessions(activeId?: string) {
  const registry = await readCliRegistry()
  console.log(color('Sessions', bold))
  if (!registry.sessions.length) {
    console.log(color('  no saved CLI sessions', gray))
    console.log('')
    return
  }
  registry.sessions.forEach((session, index) => {
    const marker = activeId === session.id ? color('* ', green) : '  '
    console.log(
      `${marker}${String(index + 1).padStart(2, '0')}. ${color(session.title, bold)} ${color(session.id, gray)}\n` +
      `    ${session.workspaceName} / ${shortPath(session.workspaceRoot)} / ${formatTime(session.updatedAt)}`,
    )
  })
  console.log('')
}

function inferMetric(message: string) {
  if (/\bmacro[_-]?f1\b/i.test(message)) return 'macro_f1'
  const metric = message.match(/\b(metric|accuracy|f1|auc|loss|score)\b/i)
  return metric?.[0] ?? 'task-dependent'
}

async function createInput(args: {
  workspace: WorkspaceBinding
  message: string
  mode: RuntimePermissionMode
  model?: string
  conversation: ConversationTurn[]
  attachments: ContextArtifact[]
}) {
  const scanned = await createResearchInputFromPaths({
    title: args.message.slice(0, 80) || 'COG-CLAW CLI Session',
    goal: args.message || 'Continue the current COG-CLAW terminal session.',
    metric: inferMetric(args.message),
    paths: [args.workspace.root],
  })
  return {
    ...scanned,
    artifacts: [...(scanned.artifacts ?? []), ...args.attachments],
    permissionMode: args.mode,
    preferredModelId: args.model,
    workspace: args.workspace,
    conversation: args.conversation,
    constraints: [
      ...(scanned.constraints ?? []),
      'Operate only inside the active workspace unless the user explicitly changes workspace.',
      'Keep terminal-visible tool trace honest and concise.',
    ],
  } satisfies ResearchInput
}

async function resolveModel(route?: string) {
  const resolved = await resolveUsableModelRoute(route)
  if (resolved) return resolved
  const models = await listRuntimeModels().catch(() => [])
  if (!models.length) return undefined
  return resolveUsableModelRoute(models[0]?.id)
}

function printTrace(event: StreamTraceEvent) {
  const tone =
    event.status === 'complete' ? green :
      event.status === 'running' ? cyan :
        event.status === 'blocked' ? yellow :
          event.status === 'error' ? red :
            gray
  const icon =
    event.status === 'complete' ? 'ok' :
      event.status === 'running' ? '..' :
        event.status === 'blocked' ? '!' :
          event.status === 'error' ? 'xx' :
            '--'
  console.log(`${color(icon, tone)} ${color(event.title, bold)} ${color(event.status, tone)} ${color(event.detail, gray)}`)
}

async function persistCliSession(session: CliSession) {
  const root = resolve(session.workspace.sessionRoot, 'cli')
  await mkdir(root, { recursive: true })
  await writeFile(resolve(root, `${session.id}.json`), JSON.stringify(session, null, 2))
  await saveCliSession(session)
}

async function runTurn(args: {
  workspace: WorkspaceBinding
  route?: ResolvedModelRoute
  model?: string
  mode: RuntimePermissionMode
  message: string
  conversation: ConversationTurn[]
  attachments: ContextArtifact[]
}) {
  const userTurn: ConversationTurn = {
    id: `user-${Date.now().toString(36)}`,
    role: 'user',
    content: args.message,
    mode: 'work',
  }
  const conversation = [...args.conversation, userTurn]
  const input = await createInput({
    workspace: args.workspace,
    message: args.message,
    mode: args.mode,
    model: args.model,
    conversation,
    attachments: args.attachments,
  })

  const run = await runClawHarness(input)
  console.log(`${color('loop', dim)} ${color(run.decision.loop, cyan)} ${color(run.decision.reason, gray)}`)
  console.log(`${color('workspace', dim)} ${args.workspace.name} ${color(shortPath(args.workspace.root), gray)}`)

  if (!args.route) {
    const error = 'No live model route configured. Set .env model keys or pass /model after listing models.'
    console.log(color(error, red))
    return {
      assistant: {
        id: `assistant-${Date.now().toString(36)}`,
        role: 'assistant' as const,
        content: `COG-CLAW runtime error.\nError: ${error}`,
        mode: 'work' as const,
      },
      input,
    }
  }

  let assistantContent = ''
  console.log(color('COG-CLAW', bold + cyan))
  let stopSpinner = startSpinner('core is arranging tools')
  const stopThinking = () => {
    stopSpinner()
    stopSpinner = () => undefined
  }
  const result = await runStreamingToolLoop({
    input,
    workspace: args.workspace,
    route: args.route,
    permissionMode: args.mode,
    send(event, value) {
      if (event === 'trace') {
        stopThinking()
        printTrace(value as StreamTraceEvent)
      }
      if (event === 'delta') {
        stopThinking()
        const delta = String((value as { content?: string }).content ?? '')
        assistantContent += delta
        output.write(delta)
      }
    },
  })
  stopThinking()
  console.log('\n')
  if (result.error) console.log(color(result.error, red))
  const assistant: ConversationTurn = {
    id: `assistant-${Date.now().toString(36)}`,
    role: 'assistant',
    content: assistantContent || result.content || result.error || '',
    mode: 'work',
    modelId: result.modelId,
    toolCalls: result.toolCalls,
  }
  return { assistant, input }
}

function printHelp() {
  console.log(color('Commands', bold))
  console.log('/help                      show this help')
  console.log('/workspace                 list workspaces')
  console.log('/workspace add <path>      register and switch to a local workspace')
  console.log('/workspace new [name]      create an isolated workspace and switch to it')
  console.log('/workspace use <number|id> switch active workspace')
  console.log('/workspaces                alias for /workspace')
  console.log('/model                     list runtime models')
  console.log('/model <route>             select model route, e.g. main:gpt-5.1')
  console.log('/mode auto|plan|bypass|nogate')
  console.log('/sessions                  list saved CLI sessions')
  console.log('/session new               start a fresh session in the current workspace')
  console.log('/session use <number|id>   switch/resume session')
  console.log('/session resume <number|id>')
  console.log('/session delete <number|id>')
  console.log('/new                       alias for /session new')
  console.log('/resume [number|id]        alias for /session resume')
  console.log('/history                   show recent turns')
  console.log('/attach <path...>          copy files/folders into workspace inbox and attach them')
  console.log('/attachments               list attached CLI artifacts')
  console.log('/skills                    list real workspace skills')
  console.log('/mcp                       list real workspace MCP servers')
  console.log('/mcp tools                 list dynamic MCP tools')
  console.log('/git init                  initialize git in active workspace')
  console.log('/status                    show current session state')
  console.log('/quota                     show daily API quota status')
  console.log('/quota set <tokens>        set daily token limit (0 = unlimited)')
  console.log('/quota cost <dollars>      set daily cost limit (0 = unlimited)')
  console.log('/quota enable|disable      toggle quota enforcement')
  console.log('/exit                      quit')
  console.log('')
  console.log(color('Launch examples', bold))
  console.log('npm run cli -- workspaces')
  console.log('npm run cli -- --attach ./data.csv "Analyze this CSV"')
  console.log('npm run cli -- examples/local-cog-benchmark "Run benchmark and improve macro_f1"')
  console.log('npm run cli -- --root examples/local-cog-benchmark --once "Run benchmark"')
  console.log('')
}

async function handleCommand(args: {
  command: string
  workspace: WorkspaceBinding
  model?: string
  mode: RuntimePermissionMode
  session: CliSession
  conversation: ConversationTurn[]
  attachments: ContextArtifact[]
}): Promise<CliState> {
  const parts = args.command.trim().split(/\s+/)
  const [name, sub, ...rest] = parts
  if (name === '/help') {
    printHelp()
    return args
  }
  if (name === '/workspace' || name === '/workspaces') {
    if (sub === 'add') {
      const root = rest.join(' ')
      if (!root) {
        console.log(color('Usage: /workspace add <path>', yellow))
        return args
      }
      const workspace = await resolveWorkspace(root)
      console.log(`${color('active workspace', green)} ${workspaceLabel(workspace)}`)
      return {
        ...args,
        workspace,
        session: {
          ...args.session,
          workspace,
          updatedAt: new Date().toISOString(),
        },
      }
    }
    if (sub === 'new') {
      const id = sessionId()
      const workspace = await createRegisteredSessionWorkspace({
        sessionId: id,
        name: rest.join(' ') || undefined,
        shared: false,
      })
      await installDefaultExtensibility(workspace)
      console.log(`${color('new workspace', green)} ${workspaceLabel(workspace)}`)
      return {
        ...args,
        workspace,
        session: {
          ...args.session,
          workspace,
          updatedAt: new Date().toISOString(),
        },
      }
    }
    if (sub === 'use') {
      const workspace = await selectWorkspace(rest[0] ?? '')
      if (!workspace) {
        console.log(color('Workspace index not found.', red))
        return args
      }
      await installDefaultExtensibility(workspace)
      console.log(`${color('active workspace', green)} ${workspaceLabel(workspace)}`)
      return {
        ...args,
        workspace,
        session: {
          ...args.session,
          workspace,
          updatedAt: new Date().toISOString(),
        },
      }
    }
    await printWorkspaces(args.workspace)
    return args
  }
  if (name === '/model') {
    if (sub) {
      console.log(`${color('model', green)} ${sub}`)
      return {
        ...args,
        model: sub,
        session: { ...args.session, model: sub, updatedAt: new Date().toISOString() },
      }
    }
    const models = await listRuntimeModels()
    if (!models.length) console.log(color('No runtime models found. Check .env.', yellow))
    for (const model of models) {
      console.log(`${color(model.id, cyan)} ${color(model.ownedBy, gray)}`)
    }
    return args
  }
  if (name === '/mode') {
    const mode = normalizeMode(sub)
    console.log(`${color('mode', green)} ${mode}`)
    return {
      ...args,
      mode,
      session: { ...args.session, mode, updatedAt: new Date().toISOString() },
    }
  }
  if (name === '/sessions') {
    await printCliSessions(args.session.id)
    return args
  }
  if (name === '/session' || name === '/new' || name === '/resume') {
    const action =
      name === '/new' ? 'new' :
        name === '/resume' ? 'resume' :
          sub
    const actionArgs =
      name === '/new' ? [sub, ...rest].filter(Boolean) :
        name === '/resume' ? [sub, ...rest].filter(Boolean) :
          rest
    if (action === 'new') {
      const workspace = args.workspace
      const nextSession: CliSession = {
        id: sessionId(),
        title: basename(workspace.root),
        workspace,
        input: await createInput({
          workspace,
          message: 'COG-CLAW CLI session started.',
          mode: args.mode,
          model: args.model,
          conversation: [],
          attachments: args.attachments,
        }),
        model: args.model,
        mode: args.mode,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      }
      await saveCliSession(nextSession)
      console.log(`${color('new session', green)} ${nextSession.id}`)
      return { ...args, session: nextSession, conversation: [], attachments: [] }
    }
    if (action === 'use' || action === 'resume') {
      const loaded = await loadCliSession(actionArgs[0] ?? true)
      if (!loaded) {
        console.log(color('Session not found.', red))
        return args
      }
      await installDefaultExtensibility(loaded.workspace)
      await saveCliSession({ ...loaded, updatedAt: new Date().toISOString() })
      console.log(`${color('resumed', green)} ${loaded.title} ${color(loaded.id, gray)}`)
      return {
        ...args,
        session: loaded,
        workspace: loaded.workspace,
        model: loaded.model,
        mode: loaded.mode,
        conversation: loaded.input.conversation ?? [],
        attachments: loaded.input.artifacts ?? [],
      }
    }
    if (action === 'delete') {
      const ok = await deleteCliSession(actionArgs[0] ?? '')
      console.log(ok ? color('deleted', green) : color('Session not found.', red))
      return args
    }
    await printCliSessions(args.session.id)
    return args
  }
  if (name === '/history') {
    const turns = args.conversation.slice(-12)
    if (!turns.length) console.log(color('No conversation turns yet.', gray))
    for (const turn of turns) {
      const label = turn.role === 'user' ? 'you' : 'cog'
      const text = turn.content.replace(/\s+/g, ' ').slice(0, 220)
      console.log(`${color(label, turn.role === 'user' ? green : cyan)} ${text}`)
    }
    return args
  }
  if (name === '/attach') {
    const paths = [sub, ...rest].filter(Boolean)
    if (!paths.length) {
      console.log(color('Usage: /attach <path...>', yellow))
      return args
    }
    try {
      const attached = await attachPaths(args.workspace, paths)
      console.log(`${color('attached', green)} ${attached.artifacts.length} artifact(s) -> ${shortPath(attached.root)}`)
      for (const artifact of attached.artifacts) {
        console.log(`  ${color(artifact.kind, cyan)} ${artifact.title} ${color(artifact.uri ? shortPath(artifact.uri) : '', gray)}`)
      }
      const attachments = [...args.attachments, ...attached.artifacts]
      return {
        ...args,
        attachments,
        session: {
          ...args.session,
          input: {
            ...args.session.input,
            artifacts: attachments,
          },
          updatedAt: new Date().toISOString(),
        },
      }
    } catch (error) {
      console.log(color(error instanceof Error ? error.message : String(error), red))
      return args
    }
  }
  if (name === '/attachments') {
    if (!args.attachments.length) {
      console.log(color('No CLI attachments in this session.', gray))
      return args
    }
    console.log(color('Attachments', bold))
    for (const artifact of args.attachments) {
      console.log(`${color(artifact.kind, cyan)} ${artifact.title} ${color(artifact.modality, gray)}`)
      if (artifact.uri) console.log(`    ${shortPath(artifact.uri)}`)
      console.log(`    ${artifact.summary}`)
    }
    return args
  }
  if (name === '/skills') {
    const result = await manageSkill({ workspace: args.workspace, action: 'list' })
    const skills = result.skills ?? []
    if (!skills.length) {
      console.log(color('No workspace skills installed.', gray))
      return args
    }
    console.log(color('Skills', bold))
    for (const skill of skills) {
      const status = skill.enabled ? color('enabled', green) : color('disabled', yellow)
      console.log(`${status} ${color(skill.id, cyan)} ${skill.name}`)
      console.log(`    ${skill.description}`)
      console.log(`    ${shortPath(skill.path)}`)
    }
    return args
  }
  if (name === '/mcp') {
    const discovery = await discoverWorkspaceCapabilities(args.workspace)
    if (sub === 'tools') {
      const tools = await discoverDynamicMcpTools(args.workspace)
      if (!tools.length) {
        console.log(color('No dynamic MCP tools discovered.', gray))
        return args
      }
      console.log(color('MCP Tools', bold))
      for (const tool of tools) {
        console.log(`${color(tool.runtimeName, cyan)} ${color(tool.serverId, gray)}`)
        console.log(`    ${tool.description}`)
      }
      return args
    }
    if (!discovery.mcpServers.length) {
      console.log(color('No workspace MCP servers installed.', gray))
      return args
    }
    console.log(color('MCP Servers', bold))
    for (const server of discovery.mcpServers) {
      console.log(`${color(server.id, cyan)} ${server.transport} ${color(server.status, gray)}`)
      console.log(`    tools: ${server.tools.join(', ') || '(none declared)'}`)
      console.log(`    ${shortPath(server.path)}`)
    }
    return args
  }
  if (name === '/git' && sub === 'init') {
    const git = initializeWorkspaceGit(args.workspace.root, {
      name: 'wpxcoder',
      email: 'wpxcoder@users.noreply.github.com',
    })
    const workspace = await upsertWorkspace({ ...args.workspace, git })
    console.log(`${color('git initialized', green)} ${workspace.git?.branch || '(new repo)'}`)
    return {
      ...args,
      workspace,
      session: { ...args.session, workspace, updatedAt: new Date().toISOString() },
    }
  }
  if (name === '/status') {
    const discovery = await discoverWorkspaceCapabilities(args.workspace)
    console.log(`${color('session', bold)} ${args.session.title} ${color(args.session.id, gray)}`)
    console.log(`${color('workspace', bold)} ${workspaceLabel(args.workspace)}`)
    console.log(`${color('model', bold)} ${args.model ?? '(auto)'}`)
    console.log(`${color('mode', bold)} ${args.mode}`)
    console.log(`${color('capabilities', bold)} ${discovery.skills.length} skills / ${discovery.mcpServers.length} MCP`)
    console.log(`${color('turns', bold)} ${args.conversation.length}`)
    return args
  }
  if (name === '/quota') {
    try {
      // Resolve the API base URL from the Vite server
      const base = `http://localhost:${process.env.PORT || '5173'}`
      if (sub === 'set') {
        const limit = Number.parseInt(rest[0] ?? '0', 10)
        const res = await fetch(`${base}/api/quota/config`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ dailyLimit: limit, enabled: limit > 0 }),
        })
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        console.log(`${color('quota', bold)} Daily token limit set to ${limit.toLocaleString()} tokens/day`)
      } else if (sub === 'cost') {
        const costLimit = Number.parseFloat(rest[0] ?? '0')
        const res = await fetch(`${base}/api/quota/config`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ dailyCostLimit: costLimit, enabled: costLimit > 0 }),
        })
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        console.log(`${color('quota', bold)} Daily cost limit set to $${costLimit.toFixed(2)}/day`)
      } else if (sub === 'enable') {
        await fetch(`${base}/api/quota/config`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ enabled: true }) })
        console.log(`${color('quota', bold)} Quota enforcement enabled`)
      } else if (sub === 'disable') {
        await fetch(`${base}/api/quota/config`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ enabled: false }) })
        console.log(`${color('quota', bold)} Quota enforcement disabled`)
      } else {
        const res = await fetch(`${base}/api/quota/status`)
        const q = await res.json()
        if (q.enabled) {
          const parts: string[] = []
          if (q.dailyLimit > 0) parts.push(`${q.dailyTokens.toLocaleString()} / ${q.dailyLimit.toLocaleString()} tokens ${color(`(${q.percent}%)`, q.percent >= 90 ? red : q.percent >= 70 ? yellow : gray)}`)
          if (q.dailyCostLimit > 0) parts.push(`$${q.dailyCost.toFixed(3)} / $${q.dailyCostLimit.toFixed(2)} ${color(`(${q.costPercent}%)`, q.costPercent >= 90 ? red : q.costPercent >= 70 ? yellow : gray)}`)
          console.log(`${color('quota', bold)} ${parts.join(' | ')}`)
        } else {
          console.log(`${color('quota', bold)} ${q.dailyTokens.toLocaleString()} tokens, $${q.dailyCost.toFixed(4)} used (no limit set)`)
        }
        if (q.dailyCost > 0 && q.enabled) console.log(`${color('daily cost', bold)} $${q.dailyCost.toFixed(4)}`)
      }
    } catch (err) {
      console.log(color('quota command failed — is the COG-CLAW server running?', yellow))
      console.log(color(String(err), gray))
    }
    return args
  }
  console.log(color('Unknown command. Type /help.', yellow))
  return args
}

async function main() {
  applyLocalEnvFile()
  const options = parseArgs(process.argv.slice(2))
  printBanner()

  if (options.listWorkspaces) {
    await printWorkspaces()
    return
  }
  if (options.listSessions) {
    await printCliSessions()
    return
  }

  const resumed = options.resume && !options.newSession ? await loadCliSession(options.resume) : undefined
  let workspace = resumed?.workspace ?? await resolveWorkspace(options.workspace)
  await installDefaultExtensibility(workspace)
  workspace = await upsertWorkspace(workspace)
  let model = options.model ?? resumed?.model
  let mode = resumed?.mode ?? options.mode
  let route = await resolveModel(model)
  if (!model && route?.route) model = route.route

  console.log(`${color('active', green)} ${workspaceLabel(workspace)}`)
  console.log(`${color('mode', dim)} ${mode}  ${color('model', dim)} ${model ?? '(not configured)'}`)
  console.log('')

  let attachments: ContextArtifact[] = resumed?.input.artifacts ?? []
  if (options.attachments.length) {
    const attached = await attachPaths(workspace, options.attachments)
    attachments = [...attachments, ...attached.artifacts]
    console.log(`${color('attached', green)} ${attached.artifacts.length} artifact(s) -> ${shortPath(attached.root)}`)
    for (const artifact of attached.artifacts) {
      console.log(`  ${color(artifact.kind, cyan)} ${artifact.title} ${color(artifact.uri ? shortPath(artifact.uri) : '', gray)}`)
    }
    console.log('')
  }

  let session: CliSession = resumed ?? {
    id: sessionId(),
    title: titleFromMessage(options.once ?? '', basename(workspace.root)),
    workspace,
    input: await createInput({
      workspace,
      message: 'COG-CLAW CLI session started.',
      mode,
      model,
      conversation: [],
      attachments,
    }),
    model,
    mode,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  }
  let conversation: ConversationTurn[] = session.input.conversation ?? []
  session.input = {
    ...session.input,
    artifacts: attachments,
  }
  await saveCliSession(session)

  const runOne = async (message: string) => {
    route = await resolveModel(model)
    const result = await runTurn({
      workspace,
      route,
      model,
      mode,
      message,
      conversation,
      attachments,
    })
    conversation = [
      ...(result.input.conversation ?? []),
      result.assistant,
    ]
    if (conversation.length <= 2) {
      session.title = titleFromMessage(message, session.title)
    }
    session.workspace = workspace
    session.model = model
    session.mode = mode
    session.input = {
      ...result.input,
      artifacts: attachments,
      conversation,
    }
    session.updatedAt = new Date().toISOString()
    await persistCliSession(session)
  }

  const runCommand = async (line: string) => {
    const next = await handleCommand({
      command: line,
      workspace,
      model,
      mode,
      session,
      conversation,
      attachments,
    })
    session = next.session
    workspace = next.workspace
    model = next.model
    mode = next.mode
    conversation = next.conversation
    attachments = next.attachments
    route = await resolveModel(model)
    await saveCliSession(session)
  }

  if (options.once) {
    await runOne(options.once)
    return
  }

  if (!process.stdin.isTTY) {
    const piped = await new Promise<string>(resolveText => {
      let text = ''
      input.setEncoding('utf-8')
      input.on('data', chunk => {
        text += chunk
      })
      input.on('end', () => resolveText(text))
    })
    for (const raw of piped.split(/\r?\n/)) {
      const line = raw.trim()
      if (!line) continue
      if (line === '/exit' || line === '/quit') break
      console.log(`${color('cog', cyan)} ${color(shortPath(workspace.root), gray)} ${color('>', bold)} ${line}`)
      if (line.startsWith('/')) await runCommand(line)
      else await runOne(line)
    }
    return
  }

  const rl = createInterface({ input, output })
  try {
    while (true) {
      const prompt = `${color('cog', cyan)} ${color(shortPath(workspace.root), gray)} ${color('>', bold)} `
      let line = ''
      try {
        line = (await rl.question(prompt)).trim()
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ERR_USE_AFTER_CLOSE') break
        throw error
      }
      if (!line) continue
      if (line === '/exit' || line === '/quit') break
      if (line.startsWith('/')) {
        await runCommand(line)
        continue
      }
      await runOne(line)
    }
  } finally {
    rl.close()
  }
}

main().catch(error => {
  console.error(color(error instanceof Error ? error.stack ?? error.message : String(error), red))
  process.exitCode = 1
})
