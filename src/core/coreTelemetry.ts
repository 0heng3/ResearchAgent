import type {
  ContextGraph,
  CoreTelemetry,
  ExtensionPlan,
  OptimizationCandidate,
  ResearchInput,
  SessionMemoryState,
  VerificationGate,
} from './types'

function clamp01(value: number) {
  return Math.max(0, Math.min(1, value))
}

function choosePhase(args: {
  input: ResearchInput
  gates: VerificationGate[]
  extensions: ExtensionPlan[]
  optimization: OptimizationCandidate[]
}) : CoreTelemetry['phase'] {
  const hardFailed = args.gates.some(gate => gate.severity === 'hard' && gate.status === 'fail')
  if (hardFailed) return 'blocked'
  if (args.gates.some(gate => gate.status === 'pending')) return 'ingesting'
  if (args.gates.some(gate => gate.status === 'warn')) return 'verifying'
  if (args.extensions.some(plan => plan.status === 'needs-approval')) return 'extending'
  if (args.optimization.some(candidate => candidate.gate === 'pass')) return 'optimizing'
  if ((args.input.artifacts ?? []).length > 0) return 'planning'
  return 'ingesting'
}

function explainPhase(phase: CoreTelemetry['phase']) {
  switch (phase) {
    case 'ingesting':
      return 'Core motion is reading the session, workspace signals, files and available capability context.'
    case 'planning':
      return 'Core motion follows the context graph while COG-CLAW links artifacts, goal, metric and constraints.'
    case 'generating':
      return 'Core motion expands outward while project files and reproducibility contracts are generated.'
    case 'verifying':
      return 'Core motion tightens because hard gates are auditing protocol, leakage and lineage.'
    case 'extending':
      return 'Core motion branches toward installable skills, tools and MCP adapters.'
    case 'optimizing':
      return 'Core motion accelerates only after verification allows stronger candidates or longer work loops.'
    case 'blocked':
      return 'Core motion is high-tension because a hard gate blocks optimization.'
  }
}

export function deriveCoreTelemetry(args: {
  input: ResearchInput
  graph: ContextGraph
  memory: SessionMemoryState
  gates: VerificationGate[]
  extensions: ExtensionPlan[]
  optimization: OptimizationCandidate[]
}): CoreTelemetry {
  const phase = choosePhase({
    input: args.input,
    gates: args.gates,
    extensions: args.extensions,
    optimization: args.optimization,
  })
  const artifactDelta = args.input.artifacts?.length ?? 0
  const memoryPressure = clamp01(args.memory.estimatedTokens / args.memory.tokenBudget)
  const reusable = args.memory.kvCache.filter(segment =>
    ['pin', 'reuse'].includes(segment.policy),
  ).length
  const cacheReuse = clamp01(reusable / Math.max(1, args.memory.kvCache.length))
  const gatePressure = clamp01(
    args.gates.filter(gate => gate.status === 'warn').length * 0.35 +
      args.gates.filter(gate => gate.status === 'fail').length,
  )
  const optimizationOpen =
    !args.gates.some(gate => gate.severity === 'hard' && gate.status === 'fail') &&
    args.optimization.some(candidate => candidate.gate === 'pass')

  const focusNodeIds = [
    'goal',
    'metric',
    ...args.graph.nodes
      .filter(node => ['dataset', 'benchmark', 'project-code', 'paper'].includes(String(node.kind)))
      .slice(-8)
      .map(node => node.id),
  ]

  const phaseSpeed = {
    ingesting: 0.6,
    planning: 0.9,
    generating: 1.05,
    verifying: 0.75,
    extending: 1.15,
    optimizing: 1.35,
    blocked: 0.35,
  }[phase]

  return {
    phase,
    focusNodeIds,
    artifactDelta,
    memoryPressure,
    cacheReuse,
    gatePressure,
    optimizationOpen,
    motion: {
      orbitSpeed: phaseSpeed + artifactDelta * 0.015 + cacheReuse * 0.12,
      pulse: 0.35 + memoryPressure * 0.45 + gatePressure * 0.35,
      tension: phase === 'blocked' ? 1 : gatePressure + (optimizationOpen ? 0.15 : 0),
    },
    explanation: explainPhase(phase),
  }
}
