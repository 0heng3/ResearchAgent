import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'
import { runExperiment } from './researchRuntime'
import { safeJoinUnder, workspaceRelative } from './workspace'
import type { WorkspaceBinding } from './types'

function attemptPassed(attempt: unknown) {
  return Boolean(
    attempt &&
    typeof attempt === 'object' &&
    'passed' in attempt &&
    (attempt as { passed?: unknown }).passed === true,
  )
}

export async function runRepairLoop(args: {
  workspace: WorkspaceBinding
  command: string
  patchPath?: string
  oldString?: string
  newString?: string
  maxAttempts?: number
}) {
  const attempts = []
  const first = await runExperiment({
    workspace: args.workspace,
    command: args.command,
  })
  attempts.push(first)

  let patched: { path: string; replacements: number } | undefined
  if (!attemptPassed(first) && args.patchPath && args.oldString !== undefined && args.newString !== undefined) {
    const target = safeJoinUnder(args.workspace.root, args.patchPath)
    const original = await readFile(target, 'utf-8')
    if (!original.includes(args.oldString)) {
      throw new Error('repair oldString was not found')
    }
    const replacements = original.split(args.oldString).length - 1
    const updated = original.split(args.oldString).join(args.newString)
    await writeFile(target, updated)
    patched = {
      path: workspaceRelative(args.workspace.root, target),
      replacements,
    }
    const rerun = await runExperiment({
      workspace: args.workspace,
      command: args.command,
    })
    attempts.push(rerun)
  }

  const report = {
    command: args.command,
    createdAt: new Date().toISOString(),
    patched,
    attempts,
    finalStatus: attemptPassed(attempts.at(-1)) ? 'complete' : 'blocked',
  }
  const out = safeJoinUnder(args.workspace.artifactRoot, 'repairs', `repair-${Date.now().toString(36)}.json`)
  await mkdir(dirname(out), { recursive: true })
  await writeFile(out, JSON.stringify(report, null, 2))
  return { ...report, path: workspaceRelative(args.workspace.root, out) }
}
