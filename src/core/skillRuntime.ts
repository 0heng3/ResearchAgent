import { exec } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { promisify } from 'node:util'
import { discoverWorkspaceCapabilities, workspaceCapabilityRoots } from './capabilityRuntime'
import { safeJoinUnder, sanitizePathSegment, workspaceRelative } from './workspace'
import type { WorkspaceBinding } from './types'

const execAsync = promisify(exec)

type SkillRegistry = {
  disabled: string[]
  versions: Record<string, string>
  smoke: Record<string, {
    command?: string
    passed: boolean
    stdout?: string
    stderr?: string
    error?: string
    checkedAt: string
  }>
}

function registryPath(workspace: WorkspaceBinding) {
  return safeJoinUnder(workspaceCapabilityRoots(workspace).skills, 'registry.json')
}

async function readRegistry(workspace: WorkspaceBinding): Promise<SkillRegistry> {
  const target = registryPath(workspace)
  if (!existsSync(target)) {
    return { disabled: [], versions: {}, smoke: {} }
  }
  const parsed = JSON.parse(await readFile(target, 'utf-8')) as Partial<SkillRegistry>
  return {
    disabled: parsed.disabled ?? [],
    versions: parsed.versions ?? {},
    smoke: parsed.smoke ?? {},
  }
}

async function writeRegistry(workspace: WorkspaceBinding, registry: SkillRegistry) {
  const target = registryPath(workspace)
  await mkdir(dirname(target), { recursive: true })
  await writeFile(target, JSON.stringify(registry, null, 2))
  return workspaceRelative(workspace.root, target)
}

function unique(values: string[]) {
  return [...new Set(values.map(value => sanitizePathSegment(value).toLowerCase()).filter(Boolean))]
}

export async function manageSkill(args: {
  workspace: WorkspaceBinding
  action: 'list' | 'enable' | 'disable' | 'version' | 'smoke'
  id?: string
  version?: string
  command?: string
}) {
  const registry = await readRegistry(args.workspace)
  const id = args.id ? sanitizePathSegment(args.id).toLowerCase() : ''

  if (args.action === 'enable') {
    if (!id) throw new Error('skill id is required')
    registry.disabled = registry.disabled.filter(item => item !== id)
    const path = await writeRegistry(args.workspace, registry)
    return { action: args.action, id, enabled: true, path }
  }

  if (args.action === 'disable') {
    if (!id) throw new Error('skill id is required')
    registry.disabled = unique([...registry.disabled, id])
    const path = await writeRegistry(args.workspace, registry)
    return { action: args.action, id, enabled: false, path }
  }

  if (args.action === 'version') {
    if (!id) throw new Error('skill id is required')
    if (args.version) registry.versions[id] = args.version
    const path = await writeRegistry(args.workspace, registry)
    return { action: args.action, id, version: registry.versions[id] ?? 'unspecified', path }
  }

  if (args.action === 'smoke') {
    if (!id) throw new Error('skill id is required')
    const checkedAt = new Date().toISOString()
    if (!args.command) {
      const skills = await discoverWorkspaceCapabilities(args.workspace)
      const skill = skills.skills.find(item => item.id === id)
      registry.smoke[id] = {
        passed: Boolean(skill),
        error: skill ? undefined : 'skill not found',
        checkedAt,
      }
      const path = await writeRegistry(args.workspace, registry)
      return { action: args.action, id, ...registry.smoke[id], path }
    }
    try {
      const result = await execAsync(args.command, {
        cwd: args.workspace.root,
        timeout: 120_000,
        windowsHide: true,
        maxBuffer: 4 * 1024 * 1024,
      })
      registry.smoke[id] = {
        command: args.command,
        passed: true,
        stdout: result.stdout.slice(0, 4000),
        stderr: result.stderr.slice(0, 2000),
        checkedAt,
      }
    } catch (error) {
      const failure = error as { stdout?: string; stderr?: string; message?: string }
      registry.smoke[id] = {
        command: args.command,
        passed: false,
        stdout: (failure.stdout ?? '').slice(0, 4000),
        stderr: (failure.stderr ?? '').slice(0, 2000),
        error: failure.message ?? 'skill smoke command failed',
        checkedAt,
      }
    }
    const path = await writeRegistry(args.workspace, registry)
    return { action: args.action, id, ...registry.smoke[id], path }
  }

  const discovery = await discoverWorkspaceCapabilities(args.workspace)
  return {
    action: 'list',
    registry: {
      ...registry,
      disabled: unique(registry.disabled),
      path: workspaceRelative(args.workspace.root, registryPath(args.workspace)),
    },
    skills: discovery.skills.map(skill => ({
      id: skill.id,
      name: skill.name,
      description: skill.description,
      path: skill.path,
      enabled: skill.userInvocable,
      version: registry.versions[skill.id] ?? skill.version ?? 'unspecified',
      smoke: registry.smoke[skill.id],
      allowedTools: skill.allowedTools,
    })),
  }
}
