import { exec } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { promisify } from 'node:util'
import { safeJoinUnder, sanitizePathSegment, workspaceRelative } from './workspace'
import type { WorkspaceBinding } from './types'

const execAsync = promisify(exec)

export async function createWorkerTask(args: {
  workspace: WorkspaceBinding
  title: string
  prompt: string
  owner?: string
  command?: string
  useWorktree?: boolean
  timeoutMs?: number
}) {
  const id = `worker-${Date.now().toString(36)}`
  const owner = sanitizePathSegment(args.owner || 'cogclaw')
  const workerRoot = safeJoinUnder(args.workspace.artifactRoot, 'workers', id)
  await mkdir(workerRoot, { recursive: true })

  let worktree: string | undefined
  let worktreeResult: { stdout: string; stderr: string; exitCode: number } | undefined
  if (args.useWorktree) {
    if (!existsSync(safeJoinUnder(args.workspace.root, '.git'))) {
      worktreeResult = {
        stdout: '',
        stderr: 'workspace has no direct .git metadata; worktree was not created',
        exitCode: 1,
      }
    } else {
      const worktreeDir = safeJoinUnder(args.workspace.artifactRoot, 'worktrees', id)
      const branch = `cogclaw/${id}`
      try {
        const result = await execAsync(`git worktree add -b ${branch} "${worktreeDir}"`, {
          cwd: args.workspace.root,
          timeout: 120_000,
          windowsHide: true,
          maxBuffer: 4 * 1024 * 1024,
        })
        worktree = worktreeDir
        worktreeResult = { stdout: result.stdout, stderr: result.stderr, exitCode: 0 }
      } catch (error) {
        const failure = error as { stdout?: string; stderr?: string; message?: string; code?: number }
        worktreeResult = {
          stdout: failure.stdout ?? '',
          stderr: failure.stderr || failure.message || 'git worktree failed',
          exitCode: typeof failure.code === 'number' ? failure.code : 1,
        }
      }
    }
  }

  let commandResult: { command: string; stdout: string; stderr: string; exitCode: number; cwd: string } | undefined
  if (args.command) {
    const cwd = worktree || args.workspace.root
    try {
      const result = await execAsync(args.command, {
        cwd,
        timeout: args.timeoutMs ?? 600_000,
        windowsHide: true,
        maxBuffer: 12 * 1024 * 1024,
      })
      commandResult = {
        command: args.command,
        cwd,
        stdout: result.stdout.slice(0, 20_000),
        stderr: result.stderr.slice(0, 12_000),
        exitCode: 0,
      }
    } catch (error) {
      const failure = error as { stdout?: string; stderr?: string; message?: string; code?: number }
      commandResult = {
        command: args.command,
        cwd,
        stdout: (failure.stdout ?? '').slice(0, 20_000),
        stderr: (failure.stderr || failure.message || 'worker command failed').slice(0, 12_000),
        exitCode: typeof failure.code === 'number' ? failure.code : 1,
      }
    }
  }

  const task = {
    id,
    title: args.title,
    owner,
    prompt: args.prompt,
    createdAt: new Date().toISOString(),
    status: commandResult
      ? commandResult.exitCode === 0 ? 'complete' : 'blocked'
      : 'queued',
    worktree: worktree ? workspaceRelative(args.workspace.root, worktree) : undefined,
    worktreeResult,
    commandResult,
  }
  const target = safeJoinUnder(workerRoot, 'task.json')
  await mkdir(dirname(target), { recursive: true })
  await writeFile(target, JSON.stringify(task, null, 2))
  return {
    ...task,
    path: workspaceRelative(args.workspace.root, target),
  }
}
