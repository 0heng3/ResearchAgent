export type ResearchMode =
  | 'dataset'
  | 'follow-paper'
  | 'reference-code'
  | 'benchmark'
  | 'multimodal'
  | 'existing-project'
  | 'open-ended'

export type EvidenceStatus = 'required' | 'collected' | 'verified' | 'rejected'

export type GateStatus = 'pass' | 'warn' | 'fail' | 'pending'

export type StageState = 'queued' | 'running' | 'complete' | 'blocked'

export type AgentLoopKind = 'conversation' | 'agent-work' | 'cog-research'

export type RuntimePermissionMode = 'plan' | 'auto' | 'bypassPermissions' | 'noGate'

export type AgentDecision = {
  id: string
  loop: AgentLoopKind
  confidence: number
  autonomy: 'respond' | 'inspect' | 'act' | 'long-horizon'
  reason: string
  signals: string[]
  risks: string[]
  requiredCapabilities: string[]
  recommendedTools: string[]
  verification: 'none' | 'light' | 'full' | 'research-hard-gates'
  cogLoop: {
    recommended: boolean
    entered: boolean
    rationale: string
  }
}

export type WorkspaceGitState = {
  initialized: boolean
  branch: string
  commit: string
  remote: string
  dirty: boolean
  userName?: string
  userEmail?: string
}

export type WorkspaceBinding = {
  id: string
  name: string
  root: string
  artifactRoot: string
  capabilityRoot: string
  sessionRoot: string
  shared: boolean
  createdAt?: string
  git?: WorkspaceGitState
}

export type CapabilityKind =
  | 'skill'
  | 'mcp'
  | 'tool'
  | 'model'
  | 'browser'
  | 'runner'
  | 'generator'
  | 'verifier'

export type CapabilityStatus = 'built-in' | 'installed' | 'available' | 'planned' | 'blocked'

export type ArtifactKind =
  | 'conversation'
  | 'dataset'
  | 'benchmark'
  | 'project-code'
  | 'paper'
  | 'reference-code'
  | 'experiment-log'
  | 'image'
  | 'audio'
  | 'video'
  | 'table'
  | 'text'
  | 'config'
  | 'unknown'

export type ArtifactModality =
  | 'text'
  | 'tabular'
  | 'image'
  | 'audio'
  | 'video'
  | 'code'
  | 'graph'
  | 'mixed'

export type ContextArtifact = {
  id: string
  kind: ArtifactKind
  modality: ArtifactModality
  title: string
  uri?: string
  summary: string
  signals: string[]
  risks: string[]
  trust: number
  metadata?: Record<string, string | number | boolean>
}

export type ConversationTurn = {
  id: string
  role: 'user' | 'assistant' | 'system'
  content: string
  artifactIds?: string[]
  mode?: 'chat' | 'work'
  modelId?: string
  toolCalls?: ToolCallTrace[]
  workTrace?: WorkTraceStep[]
}

export type ToolCallTrace = {
  id: string
  name: string
  capabilityKind: CapabilityKind
  status: 'running' | 'complete' | 'blocked' | 'error'
  summary: string
  inputSummary: string
  outputSummary: string
  permissions: Array<'read' | 'write' | 'network' | 'execute'>
  mcpCompatible: boolean
  durationMs: number
}

export type WorkTraceStep = {
  id: string
  title: string
  status: 'queued' | 'running' | 'complete' | 'blocked'
  detail: string
  toolIds: string[]
}

export type ResearchInput = {
  title: string
  mode: ResearchMode
  permissionMode?: RuntimePermissionMode
  goal: string
  targetMetric: string
  preferredModelId?: string
  workspace?: WorkspaceBinding
  dataset?: {
    name: string
    path?: string
    modality: string
    sizeHint?: string
    knownIssues?: string[]
  }
  papers?: Array<{
    title: string
    claim: string
    reusableIdeas: string[]
  }>
  referenceCode?: Array<{
    name: string
    path: string
    usefulFor: string
  }>
  artifacts?: ContextArtifact[]
  conversation?: ConversationTurn[]
  constraints: string[]
}

export type ResearchSignal = {
  label: string
  value: string
  confidence: number
}

export type ContextNode = {
  id: string
  label: string
  kind: ArtifactKind | 'goal' | 'metric' | 'constraint'
  weight: number
}

export type ContextEdge = {
  from: string
  to: string
  relation: 'supports' | 'constrains' | 'risks' | 'requires' | 'derived-from'
  strength: number
}

export type ContextGraph = {
  nodes: ContextNode[]
  edges: ContextEdge[]
  coverage: {
    modalities: ArtifactModality[]
    hasBenchmark: boolean
    hasExecutableProject: boolean
    hasDataset: boolean
    hasPaper: boolean
    hasLogs: boolean
  }
}

export type EvidenceItem = {
  id: string
  label: string
  source: string
  status: EvidenceStatus
  note: string
}

export type BlueprintModule = {
  id: string
  name: string
  role: string
  decisions: string[]
  risks: string[]
}

export type GeneratedFile = {
  path: string
  purpose: string
  contents: string
}

export type ExperimentStep = {
  id: string
  name: string
  objective: string
  expectedSignal: string
  budget: string
}

export type AutonomousPlanStep = {
  id: string
  title: string
  intent: string
  requiredTools: string[]
  requiredEvidence: string[]
  successCriteria: string
  autonomy: 'automatic' | 'needs-human-approval' | 'background'
}

export type VerificationGate = {
  id: string
  label: string
  status: GateStatus
  severity: 'hard' | 'soft'
  detail: string
}

export type OptimizationCandidate = {
  id: string
  change: string
  expectedImpact: string
  evidenceNeeded: string
  gate: GateStatus
}

export type CapabilityManifest = {
  id: string
  kind: CapabilityKind
  name: string
  status: CapabilityStatus
  trigger: string
  purpose: string
  autonomy: 'automatic' | 'approval-required' | 'manual'
  inputs: string[]
  outputs: string[]
  safety: string[]
  installable?: boolean
}

export type ModelProfile = {
  id: string
  label: string
  provider: string
  role:
    | 'controller'
    | 'planner'
    | 'coder'
    | 'verifier'
    | 'browser'
    | 'vision'
    | 'budget'
  strengths: string[]
  switchPolicy: string
  enabled: boolean
}

export type MCPServerManifest = {
  id: string
  name: string
  status: 'configured' | 'discoverable' | 'planned'
  transport: 'stdio' | 'http' | 'sse'
  exposes: string[]
  trustBoundary: string
}

export type ExtensionPlan = {
  id: string
  title: string
  reason: string
  installs: string[]
  guardrail: string
  status: 'ready' | 'needs-approval' | 'blocked'
}

export type MemoryBlock = {
  id: string
  kind: 'system' | 'session' | 'artifact' | 'summary' | 'evidence' | 'cache'
  title: string
  priority: 'pinned' | 'hot' | 'warm' | 'cold'
  tokenEstimate: number
  sourceIds: string[]
  content: string
  expiresAt?: string
}

export type CompactOperation = {
  id: string
  trigger: string
  inputTurnIds: string[]
  outputBlockId: string
  retainedTurnIds: string[]
  status: 'not-needed' | 'planned' | 'applied'
}

export type KVCacheSegment = {
  id: string
  scope: 'identity' | 'goal' | 'conversation' | 'artifact' | 'tool' | 'verification'
  policy: 'pin' | 'reuse' | 'refresh' | 'evict'
  sourceIds: string[]
  tokenEstimate: number
  invalidatesOn: string[]
}

export type SessionMemoryState = {
  sessionId: string
  activeTurnCount: number
  archivedTurnCount: number
  maxHotTurns: number
  tokenBudget: number
  estimatedTokens: number
  blocks: MemoryBlock[]
  compact: CompactOperation
  kvCache: KVCacheSegment[]
}

export type CoreTelemetry = {
  phase:
    | 'ingesting'
    | 'planning'
    | 'generating'
    | 'verifying'
    | 'extending'
    | 'optimizing'
    | 'blocked'
  focusNodeIds: string[]
  artifactDelta: number
  memoryPressure: number
  cacheReuse: number
  gatePressure: number
  optimizationOpen: boolean
  motion: {
    orbitSpeed: number
    pulse: number
    tension: number
  }
  explanation: string
}

export type AutonomyLoopState = {
  mode: 'idle' | 'conversing' | 'working' | 'blocked' | 'verifying'
  currentAction: string
  queue: Array<{
    id: string
    title: string
    status: 'queued' | 'running' | 'complete' | 'blocked'
  }>
  checkpoints: string[]
  resumePoint: string
  stopConditions: string[]
  workspacePolicy: string
}

export type RuntimeConfiguration = {
  generatedAt: string
  workspace: string
  workspaceBinding?: WorkspaceBinding
  workspaces?: WorkspaceBinding[]
  artifactRoot: string
  dashboardRuntimePath: string
  nodeVersion: string
  packageName?: string
  packageVersion?: string
  packageScripts: Record<string, string>
  permissionMode?: RuntimePermissionMode
  git: {
    branch: string
    commit: string
    remote: string
    dirty: boolean
  }
  models: Array<{
    id: string
    provider: string
    configured: boolean
    source: string
  }>
  storage: {
    inbox: string
    runs: string
    capabilities: string
  }
  capabilityConfig?: {
    path: string
    enabled: string[]
    hidden: string[]
    approvalRequired: string[]
    autoInstall: string[]
  }
}

export type RunEvidenceSummary = {
  inputArtifacts: number
  executionLogs: number
  benchmarkProtocols: number
  generatedArtifacts: number
  verifiedGates: number
  pendingGates: number
  isEmpty: boolean
}

export type PipelineStage = {
  id: string
  title: string
  state: StageState
  summary: string
  outputs: string[]
}

export type ClawRun = {
  id: string
  input: ResearchInput
  decision: AgentDecision
  mission: string
  graph: ContextGraph
  signals: ResearchSignal[]
  evidence: EvidenceItem[]
  autonomousPlan: AutonomousPlanStep[]
  blueprint: BlueprintModule[]
  files: GeneratedFile[]
  experiments: ExperimentStep[]
  verification: VerificationGate[]
  optimization: OptimizationCandidate[]
  capabilities: CapabilityManifest[]
  models: ModelProfile[]
  selectedModel: ModelProfile
  mcpServers: MCPServerManifest[]
  extensionPlan: ExtensionPlan[]
  memory: SessionMemoryState
  core: CoreTelemetry
  autonomy: AutonomyLoopState
  evidenceSummary: RunEvidenceSummary
  runtime?: RuntimeConfiguration
  stages: PipelineStage[]
  toolCalls: ToolCallTrace[]
  workTrace: WorkTraceStep[]
  scorecard: {
    truthfulness: number | null
    reproducibility: number | null
    sotaReadiness: number | null
    engineeringIntegrity: number | null
  }
}
