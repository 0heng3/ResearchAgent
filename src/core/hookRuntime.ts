import { exec } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { promisify } from 'node:util'
import { safeJoinUnder, sanitizePathSegment, workspaceRelative } from './workspace'
import type { WorkspaceBinding } from './types'

const execAsync = promisify(exec)

export type HookRegistration = {
  id: string
  event: string
  command?: string
  note?: string
  enabled: boolean
}

function hooksRoot(workspace: WorkspaceBinding) {
  return safeJoinUnder(workspace.root, '.cogclaw', 'hooks')
}

export async function listHooks(workspace: WorkspaceBinding) {
  const root = hooksRoot(workspace)
  if (!existsSync(root)) return []
  const files = await readdir(root).catch(() => [])
  const hooks = []
  for (const file of files.filter(file => file.endsWith('.json'))) {
    const target = safeJoinUnder(root, file)
    try {
      hooks.push({
        ...JSON.parse(await readFile(target, 'utf-8')),
        path: workspaceRelative(workspace.root, target),
      } as HookRegistration & { path: string })
    } catch {
      hooks.push({
        id: file.replace(/\.json$/i, ''),
        event: 'invalid',
        enabled: false,
        note: 'invalid hook json',
        path: workspaceRelative(workspace.root, target),
      })
    }
  }
  return hooks
}

export async function registerHook(workspace: WorkspaceBinding, hook: Omit<HookRegistration, 'id'> & { id?: string }) {
  const id = sanitizePathSegment(hook.id || `${hook.event}-${Date.now().toString(36)}`).toLowerCase()
  const target = safeJoinUnder(hooksRoot(workspace), `${id}.json`)
  const record: HookRegistration = {
    id,
    event: hook.event,
    command: hook.command,
    note: hook.note,
    enabled: hook.enabled,
  }
  await mkdir(dirname(target), { recursive: true })
  await writeFile(target, JSON.stringify(record, null, 2))
  return { ...record, path: workspaceRelative(workspace.root, target) }
}

export async function emitHook(workspace: WorkspaceBinding, event: string, payload: Record<string, unknown>) {
  const hooks = (await listHooks(workspace)).filter(hook => hook.enabled && hook.event === event)
  const results = []
  for (const hook of hooks) {
    if (!hook.command) {
      results.push({ id: hook.id, skipped: true, reason: 'no command' })
      continue
    }
    try {
      const result = await execAsync(hook.command, {
        cwd: workspace.root,
        env: {
          ...process.env,
          COG_CLAW_HOOK_EVENT: event,
          COG_CLAW_HOOK_PAYLOAD: JSON.stringify(payload),
        },
        timeout: 60_000,
        windowsHide: true,
        maxBuffer: 4 * 1024 * 1024,
      })
      results.push({
        id: hook.id,
        command: hook.command,
        stdout: result.stdout.slice(0, 4000),
        stderr: result.stderr.slice(0, 2000),
        exitCode: 0,
      })
    } catch (error) {
      const failure = error as { stdout?: string; stderr?: string; message?: string; code?: number }
      results.push({
        id: hook.id,
        command: hook.command,
        stdout: (failure.stdout ?? '').slice(0, 4000),
        stderr: (failure.stderr || failure.message || 'hook failed').slice(0, 2000),
        exitCode: typeof failure.code === 'number' ? failure.code : 1,
      })
    }
  }
  const target = safeJoinUnder(workspace.artifactRoot, 'hooks', `${event}-${Date.now().toString(36)}.json`)
  const record = { event, payload, results, createdAt: new Date().toISOString() }
  await mkdir(dirname(target), { recursive: true })
  await writeFile(target, JSON.stringify(record, null, 2))
  return { ...record, path: workspaceRelative(workspace.root, target) }
}
