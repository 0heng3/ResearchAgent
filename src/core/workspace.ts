import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import { basename, isAbsolute, relative, resolve } from 'node:path'
import type { WorkspaceBinding, WorkspaceGitState } from './types'

export type WorkspacePolicy = {
  id: string
  name: string
  root: string
  artifactRoot: string
  capabilityRoot: string
  sessionRoot: string
  shared: boolean
}

function safeExec(root: string, args: string[]) {
  try {
    return execFileSync('git', args, {
      cwd: root,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 2500,
    }).trim()
  } catch {
    return ''
  }
}

function createWorkspaceId(root: string) {
  let hash = 0
  for (const char of resolve(root)) {
    hash = (hash * 31 + char.charCodeAt(0)) >>> 0
  }
  return `workspace-${hash.toString(36)}`
}

export function resolveWorkspaceRoot(root = process.env.COG_CLAW_WORKSPACE ?? process.cwd()) {
  return resolve(root)
}

export function createWorkspacePolicy(root = resolveWorkspaceRoot()): WorkspacePolicy {
  const workspace = resolve(root)
  return {
    id: createWorkspaceId(workspace),
    name: basename(workspace) || 'workspace',
    root: workspace,
    artifactRoot: safeWorkspaceResolve(workspace, 'artifacts'),
    capabilityRoot: safeWorkspaceResolve(workspace, 'artifacts', 'capabilities'),
    sessionRoot: safeWorkspaceResolve(workspace, 'artifacts', 'sessions'),
    shared: true,
  }
}

export function workspaceBindingFromRoot(root = resolveWorkspaceRoot(), shared = true): WorkspaceBinding {
  const policy = createWorkspacePolicy(root)
  return {
    id: policy.id,
    name: policy.name,
    root: policy.root,
    artifactRoot: policy.artifactRoot,
    capabilityRoot: policy.capabilityRoot,
    sessionRoot: policy.sessionRoot,
    shared,
    git: readWorkspaceGitState(policy.root),
  }
}

export function normalizeWorkspaceBinding(binding: WorkspaceBinding): WorkspaceBinding {
  const root = resolveWorkspaceRoot(binding.root)
  const policy = createWorkspacePolicy(root)
  return {
    ...policy,
    name: binding.name || policy.name,
    shared: binding.shared,
    createdAt: binding.createdAt,
    git: readWorkspaceGitState(policy.root),
  }
}

export function createSessionWorkspaceBinding(args: {
  sessionId: string
  baseRoot?: string
  preferredRoot?: string
  shared?: boolean
}): WorkspaceBinding {
  const root = args.preferredRoot
    ? resolve(args.preferredRoot)
    : resolve(args.baseRoot ?? process.env.COG_CLAW_WORKSPACES_ROOT ?? process.cwd(), 'artifacts', 'workspaces', args.sessionId)
  return {
    ...workspaceBindingFromRoot(root, args.shared ?? Boolean(args.preferredRoot)),
    createdAt: new Date().toISOString(),
  }
}

export function createWorkspacePolicyForBinding(binding?: WorkspaceBinding): WorkspacePolicy {
  if (!binding) return createWorkspacePolicy()
  const root = resolveWorkspaceRoot(binding.root)
  return {
    id: createWorkspaceId(root),
    name: binding.name || basename(root) || 'workspace',
    root,
    artifactRoot: safeWorkspaceResolve(root, 'artifacts'),
    capabilityRoot: safeWorkspaceResolve(root, 'artifacts', 'capabilities'),
    sessionRoot: safeWorkspaceResolve(root, 'artifacts', 'sessions'),
    shared: binding.shared,
  }
}

export async function ensureWorkspaceBinding(binding: WorkspaceBinding) {
  const normalized = normalizeWorkspaceBinding(binding)
  await mkdir(normalized.root, { recursive: true })
  await mkdir(normalized.artifactRoot, { recursive: true })
  await mkdir(normalized.capabilityRoot, { recursive: true })
  await mkdir(normalized.sessionRoot, { recursive: true })
  return {
    ...normalized,
    git: readWorkspaceGitState(normalized.root),
  }
}

function hasDirectGitMetadata(root: string) {
  return existsSync(resolve(root, '.git'))
}

export function readWorkspaceGitState(root: string): WorkspaceGitState {
  const workspace = resolveWorkspaceRoot(root)
  if (!hasDirectGitMetadata(workspace)) {
    return {
      initialized: false,
      branch: '',
      commit: '',
      remote: '',
      dirty: false,
    }
  }
  const status = safeExec(workspace, ['--no-optional-locks', 'status', '--short'])
  return {
    initialized: true,
    branch: safeExec(workspace, ['branch', '--show-current']) || '(detached)',
    commit: safeExec(workspace, ['rev-parse', '--short', 'HEAD']),
    remote: safeExec(workspace, ['remote', 'get-url', 'origin']),
    dirty: Boolean(status),
    userName: safeExec(workspace, ['config', 'user.name']) || undefined,
    userEmail: safeExec(workspace, ['config', 'user.email']) || undefined,
  }
}

export function initializeWorkspaceGit(root: string, identity?: { name?: string; email?: string }) {
  const workspace = resolve(root)
  if (!existsSync(workspace)) {
    throw new Error(`Workspace does not exist: ${workspace}`)
  }
  if (!hasDirectGitMetadata(workspace)) {
    safeExec(workspace, ['init'])
  }
  if (identity?.name) safeExec(workspace, ['config', 'user.name', identity.name])
  if (identity?.email) safeExec(workspace, ['config', 'user.email', identity.email])
  return readWorkspaceGitState(workspace)
}

export function isInsideWorkspace(root: string, target: string) {
  const base = resolve(root)
  const resolved = resolve(target)
  const rel = relative(base, resolved)
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

export function safeWorkspaceResolve(root: string, ...segments: string[]) {
  const base = resolve(root)
  const target = resolve(base, ...segments)
  if (!isInsideWorkspace(base, target)) {
    throw new Error(`Path escapes workspace: ${target}`)
  }
  return target
}

export function safeJoinUnder(root: string, ...segments: string[]) {
  const base = resolve(root)
  const target = resolve(base, ...segments)
  if (!isInsideWorkspace(base, target)) {
    throw new Error(`Path escapes scope: ${target}`)
  }
  return target
}

export function sanitizePathSegment(value: string) {
  const clean = value
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, '_')
    .replace(/^\.+$/g, '_')
    .trim()
  return clean || 'untitled'
}

export function workspaceRelative(root: string, target: string) {
  const rel = relative(resolve(root), resolve(target))
  return rel || '.'
}
