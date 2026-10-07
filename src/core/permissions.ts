import { existsSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { safeJoinUnder, workspaceRelative } from './workspace'
import type { WorkspaceBinding } from './types'

export type PermissionDecision = {
  id: string
  tool: string
  behavior: 'allow' | 'deny' | 'ask'
  reason: string
  createdAt: string
  source: 'runtime' | 'user' | 'policy'
}

function permissionPath(workspace: WorkspaceBinding) {
  return safeJoinUnder(workspace.artifactRoot, 'permissions', 'decisions.json')
}

export async function readPermissionDecisions(workspace: WorkspaceBinding): Promise<PermissionDecision[]> {
  const target = permissionPath(workspace)
  if (!existsSync(target)) return []
  return JSON.parse(await readFile(target, 'utf-8')) as PermissionDecision[]
}

export async function recordPermissionDecision(
  workspace: WorkspaceBinding,
  decision: Omit<PermissionDecision, 'id' | 'createdAt'>,
) {
  const target = permissionPath(workspace)
  const decisions = await readPermissionDecisions(workspace)
  const next: PermissionDecision = {
    ...decision,
    id: `perm-${Date.now().toString(36)}-${decisions.length + 1}`,
    createdAt: new Date().toISOString(),
  }
  await mkdir(dirname(target), { recursive: true })
  await writeFile(target, JSON.stringify([next, ...decisions].slice(0, 200), null, 2))
  return {
    ...next,
    path: workspaceRelative(workspace.root, target),
  }
}
