import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import {
  createSessionWorkspaceBinding,
  ensureWorkspaceBinding,
  normalizeWorkspaceBinding,
  workspaceBindingFromRoot,
} from './workspace'
import type { WorkspaceBinding } from './types'

export type WorkspaceRegistry = {
  workspaces: WorkspaceBinding[]
}

export function workspaceRegistryPath(root = process.cwd()) {
  return resolve(root, 'artifacts', 'workspace-registry.json')
}

export async function readWorkspaceRegistry(root = process.cwd()): Promise<WorkspaceRegistry> {
  const defaultBinding = workspaceBindingFromRoot(root, true)
  try {
    const parsed = JSON.parse(await readFile(workspaceRegistryPath(root), 'utf-8')) as WorkspaceRegistry
    const workspaces = parsed.workspaces?.length ? parsed.workspaces : [defaultBinding]
    const seen = new Set<string>()
    return {
      workspaces: workspaces
        .filter(workspace => workspace?.root)
        .map(workspace => normalizeWorkspaceBinding(workspace))
        .filter(workspace => {
          if (seen.has(workspace.id)) return false
          seen.add(workspace.id)
          return true
        }),
    }
  } catch {
    return { workspaces: [defaultBinding] }
  }
}

export async function writeWorkspaceRegistry(registry: WorkspaceRegistry, root = process.cwd()) {
  const target = workspaceRegistryPath(root)
  await mkdir(dirname(target), { recursive: true })
  await writeFile(target, JSON.stringify(registry, null, 2))
}

export async function upsertWorkspace(binding: WorkspaceBinding, root = process.cwd()) {
  const ensured = await ensureWorkspaceBinding(normalizeWorkspaceBinding(binding))
  const registry = await readWorkspaceRegistry(root)
  const next = [
    ensured,
    ...registry.workspaces.filter(workspace => workspace.id !== ensured.id),
  ].slice(0, 40)
  await writeWorkspaceRegistry({ workspaces: next }, root)
  return ensured
}

export async function createRegisteredSessionWorkspace(args: {
  sessionId: string
  root?: string
  name?: string
  shared?: boolean
  registryRoot?: string
}) {
  const binding = createSessionWorkspaceBinding({
    sessionId: args.sessionId,
    preferredRoot: args.root,
    shared: args.shared ?? Boolean(args.root),
  })
  return upsertWorkspace({
    ...binding,
    name: args.name || binding.name,
  }, args.registryRoot)
}
