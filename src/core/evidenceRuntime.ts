import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { safeJoinUnder, workspaceRelative } from './workspace'
import type { WorkspaceBinding } from './types'

function hash(value: string) {
  return createHash('sha256').update(value).digest('hex')
}

function ledgerPath(workspace: WorkspaceBinding) {
  return safeJoinUnder(workspace.artifactRoot, 'evidence', 'benchmark-ledger.json')
}

export type BenchmarkLedgerEntry = {
  id: string
  kind: 'dataset-split' | 'metric-script' | 'protocol' | 'seed' | 'config' | 'run' | 'claim'
  label: string
  value: string
  hash: string
  createdAt: string
  locked: boolean
}

export async function readBenchmarkLedger(workspace: WorkspaceBinding) {
  const target = ledgerPath(workspace)
  if (!existsSync(target)) {
    return { entries: [] as BenchmarkLedgerEntry[], path: workspaceRelative(workspace.root, target) }
  }
  const parsed = JSON.parse(await readFile(target, 'utf-8')) as { entries?: BenchmarkLedgerEntry[] }
  return {
    entries: parsed.entries ?? [],
    path: workspaceRelative(workspace.root, target),
  }
}

export async function recordBenchmarkEvidence(args: {
  workspace: WorkspaceBinding
  kind: BenchmarkLedgerEntry['kind']
  label: string
  value: string
  locked?: boolean
}) {
  const current = await readBenchmarkLedger(args.workspace)
  const entry: BenchmarkLedgerEntry = {
    id: `evidence-${Date.now().toString(36)}-${current.entries.length + 1}`,
    kind: args.kind,
    label: args.label,
    value: args.value,
    hash: hash(`${args.kind}:${args.label}:${args.value}`),
    createdAt: new Date().toISOString(),
    locked: args.locked ?? ['dataset-split', 'metric-script', 'protocol'].includes(args.kind),
  }
  const next = {
    updatedAt: new Date().toISOString(),
    entries: [entry, ...current.entries],
  }
  const target = ledgerPath(args.workspace)
  await mkdir(dirname(target), { recursive: true })
  await writeFile(target, JSON.stringify(next, null, 2))
  return { entry, path: workspaceRelative(args.workspace.root, target) }
}

export async function auditBenchmarkLedger(workspace: WorkspaceBinding) {
  const ledger = await readBenchmarkLedger(workspace)
  const kinds = new Set(ledger.entries.map(entry => entry.kind))
  const hardMissing = ['dataset-split', 'metric-script', 'protocol'].filter(kind => !kinds.has(kind as BenchmarkLedgerEntry['kind']))
  const claimWithoutRun = kinds.has('claim') && !kinds.has('run')
  return {
    ...ledger,
    hardMissing,
    claimWithoutRun,
    pass: hardMissing.length === 0 && !claimWithoutRun,
    notes: [
      hardMissing.length ? `Missing locked evidence: ${hardMissing.join(', ')}` : 'Core locked evidence is present.',
      claimWithoutRun ? 'Claims exist without a run record.' : 'No claim/run mismatch detected.',
    ],
  }
}
