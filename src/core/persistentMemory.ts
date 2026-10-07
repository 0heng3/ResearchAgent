import { existsSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { buildContextGraph } from './contextGraph'
import { createSessionMemoryState } from './memoryManager'
import { safeJoinUnder, workspaceRelative } from './workspace'
import type { ResearchInput, SessionMemoryState, WorkspaceBinding } from './types'

export type PersistedMemoryRecord = {
  sessionId: string
  updatedAt: string
  memory: SessionMemoryState
  compactSummary: string
  hotTurnIds: string[]
  archivedTurnIds: string[]
}

function memoryPath(workspace: WorkspaceBinding, sessionId: string) {
  return safeJoinUnder(workspace.sessionRoot, sessionId, 'memory.json')
}

function summarizeMemory(memory: SessionMemoryState) {
  return memory.blocks
    .filter(block => block.priority === 'pinned' || block.kind === 'summary' || block.kind === 'evidence')
    .map(block => `[${block.priority}] ${block.title}: ${block.content.replace(/\s+/g, ' ').slice(0, 600)}`)
    .join('\n')
}

export async function persistSessionMemory(
  workspace: WorkspaceBinding,
  input: ResearchInput,
): Promise<PersistedMemoryRecord & { path: string; previous?: PersistedMemoryRecord }> {
  const graph = buildContextGraph(input)
  const memory = createSessionMemoryState(input, graph)
  const turns = input.conversation ?? []
  const target = memoryPath(workspace, memory.sessionId)
  let previous: PersistedMemoryRecord | undefined
  if (existsSync(target)) {
    try {
      previous = JSON.parse(await readFile(target, 'utf-8')) as PersistedMemoryRecord
    } catch {
      previous = undefined
    }
  }
  const record: PersistedMemoryRecord = {
    sessionId: memory.sessionId,
    updatedAt: new Date().toISOString(),
    memory,
    compactSummary: summarizeMemory(memory),
    hotTurnIds: memory.compact.retainedTurnIds,
    archivedTurnIds: turns
      .slice(0, Math.max(0, turns.length - memory.maxHotTurns))
      .map(turn => turn.id),
  }
  await mkdir(dirname(target), { recursive: true })
  await writeFile(target, JSON.stringify(record, null, 2))
  return {
    ...record,
    path: workspaceRelative(workspace.root, target),
    previous,
  }
}

export async function loadSessionMemory(workspace: WorkspaceBinding, sessionId: string) {
  const target = memoryPath(workspace, sessionId)
  const record = JSON.parse(await readFile(target, 'utf-8')) as PersistedMemoryRecord
  return {
    ...record,
    path: workspaceRelative(workspace.root, target),
  }
}
