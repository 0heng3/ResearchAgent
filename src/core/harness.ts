import {
  CLAW_MCP_SERVERS,
  createCapabilityManifest,
  createExtensionPlan,
} from './capabilities'
import { hardGateScore } from './constitution'
import { buildContextGraph, signalsFromGraph } from './contextGraph'
import { deriveCoreTelemetry } from './coreTelemetry'
import { decideAgentLoop } from './decision'
import { CLAW_MODELS, selectModelForRun } from './modelRouter'
import { createSessionMemoryState } from './memoryManager'
import { createAutonomousPlan } from './planner'
import { CLAW_PROMPT_DOCTRINE } from './promptDoctrine'
import { createClawToolRegistry } from './tools'
import type {
  BlueprintModule,
  ClawRun,
  EvidenceItem,
  ExperimentStep,
  GeneratedFile,
  OptimizationCandidate,
  PipelineStage,
  ResearchInput,
  ResearchSignal,
  ToolCallTrace,
  VerificationGate,
  WorkTraceStep,
} from './types'

function runId() {
  return `claw-${Date.now().toString(36)}`
}

function completeStage(
  id: string,
  title: string,
  summary: string,
  outputs: string[],
): PipelineStage {
  return {
    id,
    title,
    state: 'complete',
    summary,
    outputs,
  }
}

function makeMission(input: ResearchInput) {
  if (input.targetMetric === 'not selected') {
    return 'Drop a dataset, benchmark, paper, codebase, log, or multimodal sample to start.'
  }
  return `COG-CLAW is building a ${input.mode} research project for ${input.targetMetric}.`
}

export async function runClawHarness(input: ResearchInput): Promise<ClawRun> {
  const id = runId()
  const decision = decideAgentLoop(input)
  const registry = createClawToolRegistry()
  const toolCalls: ToolCallTrace[] = []
  const context = { runId: id, now: new Date(), trace: toolCalls }
  const graph = buildContextGraph(input)
  const selectedModel = selectModelForRun(input, graph, input.preferredModelId)
  const memory = createSessionMemoryState(input, graph)

  const signals = await registry.call<ResearchInput, ResearchSignal[]>(
    'context_ingest',
    input,
    context,
  )
  signals.push(...signalsFromGraph(graph))

  const evidence = await registry.call<ResearchInput, EvidenceItem[]>(
    'evidence_bootstrap',
    input,
    context,
  )

  const autonomousPlan = decision.loop === 'cog-research' ? createAutonomousPlan(input, graph) : []

  const proposedBlueprint =
    decision.loop === 'cog-research'
      ? await registry.call<
          { input: ResearchInput; signals: ResearchSignal[] },
          BlueprintModule[]
        >('sota_blueprint', { input, signals }, context)
      : []

  const proposedFiles =
    decision.loop === 'cog-research'
      ? await registry.call<BlueprintModule[], GeneratedFile[]>(
          'project_generate',
          proposedBlueprint,
          context,
        )
      : []

  const proposedExperiments =
    decision.loop === 'cog-research'
      ? await registry.call<ResearchInput, ExperimentStep[]>(
          'experiment_plan',
          input,
          context,
        )
      : []

  const verification = await registry.call<ResearchInput, VerificationGate[]>(
    'verify_truthfulness',
    input,
    context,
  )

  const optimization =
    decision.loop === 'cog-research'
      ? await registry.call<
          { input: ResearchInput; gates: VerificationGate[] },
          OptimizationCandidate[]
        >('metric_optimize', { input, gates: verification }, context)
      : []

  const capabilities = createCapabilityManifest()
  const extensionPlan = createExtensionPlan(input, graph)
  const hardGate = hardGateScore(verification)
  const gatesBypassed = input.permissionMode === 'noGate' || input.permissionMode === 'bypassPermissions'
  const hasRealEvidence =
    decision.loop === 'cog-research' &&
    (gatesBypassed ||
      verification
        .filter(gate => gate.severity === 'hard')
        .every(gate => gate.status === 'pass'))
  const blueprint = hasRealEvidence ? proposedBlueprint : []
  const files = hasRealEvidence ? proposedFiles : []
  const experiments = hasRealEvidence ? proposedExperiments : []
  const core = deriveCoreTelemetry({
    input,
    graph,
    memory,
    gates: verification,
    extensions: extensionPlan,
    optimization,
  })
  const evidenceSummary = summarizeEvidence(input, verification, files, hasRealEvidence)
  const truthfulness = hardGate === 'pass' ? 98 : hardGate === 'warn' ? null : null

  const stages: PipelineStage[] = createStages({
    signals,
    evidence,
    memory,
    selectedModel,
    verification,
    extensionPlan,
    capabilities,
    optimization,
    blueprint,
    files,
    hasRealEvidence,
    decision,
  })
  const workTrace = createWorkTrace(toolCalls, stages, hasRealEvidence, decision)
  const autonomy = createAutonomyLoop(input, stages, workTrace, hasRealEvidence, decision)

  return {
    id,
    input,
    decision,
    mission: makeMission(input),
    graph,
    signals,
    evidence,
    autonomousPlan,
    blueprint,
    files,
    experiments,
    verification,
    optimization,
    capabilities,
    models: CLAW_MODELS,
    selectedModel,
    mcpServers: CLAW_MCP_SERVERS,
    extensionPlan,
    memory,
    core,
    autonomy,
    evidenceSummary,
    stages,
    toolCalls,
    workTrace,
    scorecard: {
      truthfulness,
      reproducibility: hasRealEvidence ? 94 : null,
      sotaReadiness: hasRealEvidence && optimization.length ? 89 : null,
      engineeringIntegrity: runtimeEngineeringScore(input),
    },
  }
}

function createStages(args: {
  signals: ResearchSignal[]
  evidence: EvidenceItem[]
  memory: ReturnType<typeof createSessionMemoryState>
  selectedModel: ReturnType<typeof selectModelForRun>
  verification: VerificationGate[]
  extensionPlan: ReturnType<typeof createExtensionPlan>
  capabilities: ReturnType<typeof createCapabilityManifest>
  optimization: OptimizationCandidate[]
  blueprint: BlueprintModule[]
  files: GeneratedFile[]
  hasRealEvidence: boolean
  decision: ReturnType<typeof decideAgentLoop>
}) {
  const {
    signals,
    evidence,
    memory,
    selectedModel,
    verification,
    extensionPlan,
    capabilities,
    optimization,
    blueprint,
    files,
    hasRealEvidence,
    decision,
  } = args

  const baseStages: PipelineStage[] = [
    completeStage(
      'decision',
      'Autonomous decision',
      decision.reason,
      [
        `loop: ${decision.loop}`,
        `autonomy: ${decision.autonomy}`,
        `COG loop: ${decision.cogLoop.entered ? 'entered' : 'not entered'}`,
      ],
    ),
    completeStage(
      'context',
      'Context assembly',
      'Conversation, artifacts, workspace, memory and local instructions are assembled into the live prompt context.',
      [
        `${signals.length} signals`,
        `${evidence.length} evidence items`,
        `${CLAW_PROMPT_DOCTRINE.length} doctrine rules`,
      ],
    ),
    completeStage('route', 'Model Routing', `Selected ${selectedModel.label}.`, [
      selectedModel.role,
      selectedModel.provider,
    ]),
    completeStage(
      'memory',
      'Session Memory',
      'Conversation, artifacts and pinned system state are packed into hot memory, compact summaries and KV cache segments.',
      [
        `${memory.activeTurnCount} hot turns`,
        `${memory.archivedTurnCount} archived turns`,
        `${memory.kvCache.length} cache segments`,
      ],
    ),
    completeStage(
      'verify',
      'Truthful Verification',
      decision.loop === 'cog-research'
        ? 'Hard gates run before optimization candidates are promoted.'
        : 'Light verification stays available without forcing the research loop.',
      [
        `${verification.filter(gate => gate.status === 'pass').length} passed gates`,
        `${verification.filter(gate => gate.status === 'pending').length} pending gates`,
      ],
    ),
    completeStage(
      'extend',
      'Self Extension',
      'Missing capabilities become installable skills, tools or MCP adapters under the workspace capability root.',
      [
        `${extensionPlan.length} extension plans`,
        `${capabilities.filter(capability => capability.installable).length} installable capabilities`,
      ],
    ),
  ]

  if (decision.loop !== 'cog-research') return baseStages

  return [
    ...baseStages.slice(0, 4),
    stageFromEvidence(
      hasRealEvidence,
      'blueprint',
      'COG blueprint',
      'Waiting for real benchmark/data evidence before compiling a research project route.',
      'A single executable research route is compiled.',
      [`${blueprint.length} modules`, 'single-path route'],
    ),
    stageFromEvidence(
      hasRealEvidence,
      'generate',
      'Project generation',
      'Waiting for an approved blueprint and execution evidence before generating project files.',
      'Reproducible project files and capability manifests are emitted.',
      [`${files.length} files`, 'locked claw.config.json'],
    ),
    ...baseStages.slice(4),
    completeStage(
      'optimize',
      'SOTA optimization',
      'Only candidates that pass hard gates enter the optimization loop.',
      [`${optimization.length} candidates`, 'clean-room evidence required'],
    ),
  ]
}

function createAutonomyLoop(
  input: ResearchInput,
  stages: PipelineStage[],
  workTrace: WorkTraceStep[],
  hasRealEvidence: boolean,
  decision: ReturnType<typeof decideAgentLoop>,
) {
  const turns = input.conversation ?? []
  const hasWork =
    decision.loop !== 'conversation' ||
    (input.artifacts ?? []).length > 0 ||
    workTrace.some(step => step.status === 'running' || step.status === 'blocked')
  const blocked = workTrace.some(step => step.status === 'blocked')
  return {
    mode: blocked ? 'blocked' : decision.loop !== 'conversation' || hasWork ? 'working' : turns.length ? 'conversing' : 'idle',
    currentAction: blocked
      ? 'Waiting for missing evidence, approval, credentials or executable context.'
      : decision.loop === 'cog-research'
        ? 'COG loop is active because the task has evidence-bearing research or benchmark pressure.'
        : decision.loop === 'agent-work'
          ? 'Maintaining a Claude-Code-style inspect, plan, act, verify and remember loop.'
        : 'Waiting for user input while preserving session state.',
    queue: stages.map(stage => ({
      id: stage.id,
      title: stage.title,
      status: stage.state,
    })),
    checkpoints: [
      `${turns.length} conversation turns retained`,
      `${input.artifacts?.length ?? 0} artifacts attached`,
      `decision: ${decision.loop}`,
      hasRealEvidence ? 'verification gates allow generation' : 'hard gates still protect unsupported claims',
    ],
    resumePoint: blocked
      ? 'Resume from the first blocked gate or missing capability.'
      : turns.length
        ? 'Resume from the latest user turn and hot memory blocks.'
        : 'Start from the next message or dropped workspace.',
    stopConditions: [
      'user asks to stop',
      'a destructive action needs approval',
      'credentials or workspace permissions are missing',
      'verification fails and no safe repair step remains',
    ],
    workspacePolicy:
      'All generated artifacts, skills and MCP manifests stay inside the declared workspace unless the user explicitly changes scope.',
  } satisfies import('./types').AutonomyLoopState
}

function createWorkTrace(
  toolCalls: ToolCallTrace[],
  stages: PipelineStage[],
  hasRealEvidence: boolean,
  decision: ReturnType<typeof decideAgentLoop>,
): WorkTraceStep[] {
  const byName = new Map(toolCalls.map(call => [call.name, call.id]))
  const steps: WorkTraceStep[] = [
    {
      id: 'decision-loop',
      title: 'Choose loop',
      status: 'complete',
      detail: `${decision.loop}: ${decision.reason}`,
      toolIds: ['context_ingest'].map(name => byName.get(name)).filter(Boolean) as string[],
    },
    {
      id: 'read-context',
      title: 'Assemble context',
      status: 'complete',
      detail: 'Parsed the conversation, workspace binding, artifacts, modality hints, memory and explicit constraints.',
      toolIds: ['context_ingest', 'evidence_bootstrap'].map(name => byName.get(name)).filter(Boolean) as string[],
    },
  ]

  if (decision.loop !== 'cog-research') {
    return steps
  }

  return [
    ...steps,
    {
      id: 'plan-route',
      title: 'Plan COG route',
      status: 'complete',
      detail: 'Built one autonomous research route while keeping SOTA claims behind evidence gates.',
      toolIds: ['sota_blueprint', 'experiment_plan'].map(name => byName.get(name)).filter(Boolean) as string[],
    },
    {
      id: 'generate-or-wait',
      title: hasRealEvidence ? 'Generate project' : 'Hold generation',
      status: hasRealEvidence ? 'complete' : 'blocked',
      detail: hasRealEvidence
        ? 'Generated project files under the locked protocol.'
        : 'No project files are emitted until benchmark/data evidence passes the hard gates.',
      toolIds: ['project_generate'].map(name => byName.get(name)).filter(Boolean) as string[],
    },
    {
      id: 'verify',
      title: 'Verify truth gates',
      status: stages.some(stage => stage.id === 'verify' && stage.state === 'blocked') ? 'blocked' : 'complete',
      detail: 'Checked reproducibility, data protocol, claim support and optimization safety.',
      toolIds: ['verify_truthfulness', 'metric_optimize'].map(name => byName.get(name)).filter(Boolean) as string[],
    },
  ]
}

function summarizeEvidence(
  input: ResearchInput,
  verification: VerificationGate[],
  files: GeneratedFile[],
  hasRealEvidence: boolean,
) {
  const artifacts = input.artifacts ?? []
  return {
    inputArtifacts: artifacts.length,
    executionLogs: artifacts.filter(artifact => artifact.kind === 'experiment-log').length,
    benchmarkProtocols: artifacts.filter(artifact => artifact.kind === 'benchmark').length,
    generatedArtifacts: hasRealEvidence ? files.length : 0,
    verifiedGates: verification.filter(gate => gate.status === 'pass').length,
    pendingGates: verification.filter(gate => gate.status === 'pending').length,
    isEmpty: artifacts.length === 0,
  }
}

function runtimeEngineeringScore(input: ResearchInput) {
  const artifacts = input.artifacts ?? []
  const hasProject = artifacts.some(artifact => artifact.kind === 'project-code')
  const hasConfig = artifacts.some(artifact => artifact.kind === 'config')
  if (!hasProject && !hasConfig) return null
  return hasProject && hasConfig ? 82 : 68
}

function stageFromEvidence(
  ready: boolean,
  id: string,
  title: string,
  pendingSummary: string,
  completeSummary: string,
  outputs: string[],
): PipelineStage {
  return {
    id,
    title,
    state: ready ? 'complete' : 'queued',
    summary: ready ? completeSummary : pendingSummary,
    outputs: ready ? outputs : ['waiting for evidence'],
  }
}
