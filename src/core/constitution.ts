import type { GateStatus, VerificationGate } from './types'

export const CLAW_CONSTITUTION = [
  {
    id: 'no-cheating',
    label: 'No Cheating',
    rule:
      'Never accept hardcoded metrics, test-set leakage, fake logs, protocol bypasses or hidden failure filtering.',
  },
  {
    id: 'reproducible',
    label: 'Reproducible First',
    rule:
      'Every claim must trace to data, config, code revision, seed, logs, runner command and metric script.',
  },
  {
    id: 'task-aligned',
    label: 'Task Aligned',
    rule:
      'Implementation must preserve the user objective, dataset definition, benchmark protocol, paper constraints and target metric.',
  },
  {
    id: 'sota-seeking',
    label: 'Truthful SOTA',
    rule:
      'Performance optimization is allowed only after truthfulness, alignment and reproducibility gates pass.',
  },
]

export function hardGateScore(gates: VerificationGate[]): GateStatus {
  if (gates.some(gate => gate.severity === 'hard' && gate.status === 'fail')) {
    return 'fail'
  }
  if (gates.some(gate => gate.status === 'pending')) {
    return 'pending'
  }
  if (gates.some(gate => gate.status === 'warn')) {
    return 'warn'
  }
  return 'pass'
}

export function makeCoreVerificationGates(args: {
  hasBenchmark: boolean
  hasDataset: boolean
  hasLogs: boolean
  hasExecutableProject: boolean
  hasConfig?: boolean
}): VerificationGate[] {
  const hasFullLineage =
    args.hasBenchmark &&
    args.hasDataset &&
    args.hasLogs &&
    args.hasExecutableProject &&
    Boolean(args.hasConfig)

  return [
    {
      id: 'anti-cheat',
      label: 'Anti-cheat Audit',
      status: args.hasLogs ? 'pass' : 'pending',
      severity: 'hard',
      detail:
        args.hasLogs
          ? 'Execution logs are present and can be audited for metric fabrication or leakage.'
          : 'Pending: no real run logs or metric traces have been provided yet.',
    },
    {
      id: 'protocol',
      label: 'Protocol Lock',
      status: args.hasBenchmark ? 'pass' : 'pending',
      severity: 'hard',
      detail:
        args.hasBenchmark
          ? 'Benchmark protocol artifact is present and can be locked.'
          : 'Pending: no benchmark runner or official metric protocol is present.',
    },
    {
      id: 'artifact-lineage',
      label: 'Artifact Lineage',
      status: hasFullLineage
        ? 'pass'
        : args.hasDataset || args.hasExecutableProject || args.hasLogs
          ? 'warn'
          : 'pending',
      severity: 'hard',
      detail:
        hasFullLineage
          ? 'Dataset, benchmark protocol, executable project, config and run logs are all present.'
          : args.hasDataset || args.hasExecutableProject || args.hasLogs
          ? 'Some source artifacts exist, but full data/config/log lineage is not complete yet.'
          : 'Pending: no dataset, benchmark project, config, or run artifact has been supplied.',
    },
    {
      id: 'complexity',
      label: 'Complexity Budget',
      status: 'pending',
      severity: 'soft',
      detail:
        'Pending: no real optimization candidate has been produced or ablated.',
    },
  ]
}
