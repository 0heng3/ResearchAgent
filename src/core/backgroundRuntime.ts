import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { safeJoinUnder, sanitizePathSegment, workspaceRelative } from './workspace'
import type { WorkspaceBinding } from './types'

const processes = new Map<string, ReturnType<typeof spawn>>()

function tasksRoot(workspace: WorkspaceBinding) {
  return safeJoinUnder(workspace.artifactRoot, 'background')
}

async function writeTask(workspace: WorkspaceBinding, id: string, record: Record<string, unknown>) {
  const target = safeJoinUnder(tasksRoot(workspace), `${id}.json`)
  await mkdir(dirname(target), { recursive: true })
  await writeFile(target, JSON.stringify(record, null, 2))
  return workspaceRelative(workspace.root, target)
}

export async function startBackgroundTask(args: {
  workspace: WorkspaceBinding
  name: string
  command: string
}) {
  const id = `bg-${Date.now().toString(36)}-${sanitizePathSegment(args.name).slice(0, 24)}`
  const child = spawn(args.command, {
    cwd: args.workspace.root,
    shell: true,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let stdout = ''
  let stderr = ''
  child.stdout.on('data', chunk => { stdout += String(chunk).slice(0, 20_000) })
  child.stderr.on('data', chunk => { stderr += String(chunk).slice(0, 20_000) })
  const record = {
    id,
    name: args.name,
    command: args.command,
    pid: child.pid,
    status: 'running',
    startedAt: new Date().toISOString(),
  }
  processes.set(id, child)
  const path = await writeTask(args.workspace, id, record)
  child.on('exit', async code => {
    processes.delete(id)
    await writeTask(args.workspace, id, {
      ...record,
      status: code === 0 ? 'complete' : 'blocked',
      exitCode: code,
      finishedAt: new Date().toISOString(),
      stdout: stdout.slice(-20_000),
      stderr: stderr.slice(-12_000),
    }).catch(() => undefined)
  })
  return { ...record, path }
}

export async function listBackgroundTasks(workspace: WorkspaceBinding) {
  const root = tasksRoot(workspace)
  if (!existsSync(root)) return []
  const files = await readdir(root).catch(() => [])
  const tasks = []
  for (const file of files.filter(file => file.endsWith('.json'))) {
    const target = safeJoinUnder(root, file)
    try {
      const record = JSON.parse(await readFile(target, 'utf-8'))
      tasks.push({
        ...record,
        live: processes.has(record.id),
        path: workspaceRelative(workspace.root, target),
      })
    } catch {
      tasks.push({ id: file.replace(/\.json$/i, ''), status: 'invalid' })
    }
  }
  return tasks
}

export async function stopBackgroundTask(workspace: WorkspaceBinding, id: string) {
  const task = processes.get(id)
  if (!task) return { id, stopped: false, reason: 'task is not live in this runtime process' }
  task.kill()
  processes.delete(id)
  await writeTask(workspace, id, {
    id,
    status: 'stopped',
    stoppedAt: new Date().toISOString(),
  })
  return { id, stopped: true }
}
