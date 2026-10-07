import { COG_CLAW_IDENTITY } from './identity'
import type {
  CompactOperation,
  ContextGraph,
  ConversationTurn,
  KVCacheSegment,
  MemoryBlock,
  ResearchInput,
  SessionMemoryState,
} from './types'

const DEFAULT_MAX_HOT_TURNS = 12
const DEFAULT_TOKEN_BUDGET = 96_000

function estimateTokens(text: string) {
  return Math.max(1, Math.ceil(text.length / 3.6))
}

function sessionId(input: ResearchInput) {
  const base = `${input.title}:${input.goal}:${input.targetMetric}`
  let hash = 0
  for (let index = 0; index < base.length; index += 1) {
    hash = (hash * 31 + base.charCodeAt(index)) >>> 0
  }
  return `session-${hash.toString(36)}`
}

function summarizeTurns(turns: ConversationTurn[]) {
  if (!turns.length) return 'No archived conversation yet.'
  return turns
    .map(turn => `${turn.role}: ${turn.content.replace(/\s+/g, ' ').slice(0, 180)}`)
    .join('\n')
}

function createBlocks(
  input: ResearchInput,
  graph: ContextGraph,
  hotTurns: ConversationTurn[],
  archivedTurns: ConversationTurn[],
): MemoryBlock[] {
  const blocks: MemoryBlock[] = [
    {
      id: 'memory-identity',
      kind: 'system',
      title: 'COG-CLAW identity and hard laws',
      priority: 'pinned',
      tokenEstimate: 900,
      sourceIds: ['identity', 'constitution'],
      content: `${COG_CLAW_IDENTITY.name} is ${COG_CLAW_IDENTITY.role}. Anti-cheat, reproducibility and task alignment are pinned constraints.`,
    },
    {
      id: 'memory-goal',
      kind: 'session',
      title: 'Current research contract',
      priority: 'pinned',
      tokenEstimate: estimateTokens(`${input.goal}\n${input.targetMetric}`),
      sourceIds: ['goal', 'metric'],
      content: `Goal: ${input.goal}\nMetric: ${input.targetMetric}`,
    },
  ]

  if (archivedTurns.length) {
    const content = summarizeTurns(archivedTurns)
    blocks.push({
      id: 'memory-compact-summary',
      kind: 'summary',
      title: 'Compacted conversation summary',
      priority: 'warm',
      tokenEstimate: estimateTokens(content),
      sourceIds: archivedTurns.map(turn => turn.id),
      content,
    })
  }

  for (const turn of hotTurns) {
    blocks.push({
      id: `memory-turn-${turn.id}`,
      kind: 'session',
      title: `${turn.role} turn`,
      priority: turn.role === 'system' ? 'pinned' : 'hot',
      tokenEstimate: estimateTokens(turn.content),
      sourceIds: [turn.id, ...(turn.artifactIds ?? [])],
      content: turn.content,
    })
  }

  const importantArtifacts = (input.artifacts ?? [])
    .filter(artifact => artifact.trust >= 0.7 || ['benchmark', 'dataset', 'project-code'].includes(artifact.kind))
    .slice(-10)

  for (const artifact of importantArtifacts) {
    blocks.push({
      id: `memory-artifact-${artifact.id}`,
      kind: 'artifact',
      title: artifact.title,
      priority:
        artifact.kind === 'benchmark' || artifact.kind === 'dataset' ? 'hot' : 'warm',
      tokenEstimate: estimateTokens(`${artifact.summary}\n${artifact.signals.join('\n')}`),
      sourceIds: [artifact.id],
      content: `${artifact.kind}/${artifact.modality}: ${artifact.summary}`,
    })
  }

  blocks.push({
    id: 'memory-graph-coverage',
    kind: 'evidence',
    title: 'Context graph coverage',
    priority: 'hot',
    tokenEstimate: 220,
    sourceIds: graph.nodes.map(node => node.id).slice(0, 24),
    content: `${graph.nodes.length} nodes, ${graph.edges.length} edges, modalities: ${
      graph.coverage.modalities.join(', ') || 'text'
    }.`,
  })

  return blocks
}

function createCompactOperation(
  turns: ConversationTurn[],
  hotTurns: ConversationTurn[],
  archivedTurns: ConversationTurn[],
): CompactOperation {
  if (!archivedTurns.length) {
    return {
      id: 'compact-current',
      trigger: `turns <= ${DEFAULT_MAX_HOT_TURNS}`,
      inputTurnIds: [],
      outputBlockId: 'memory-compact-summary',
      retainedTurnIds: hotTurns.map(turn => turn.id),
      status: 'not-needed',
    }
  }

  return {
    id: 'compact-current',
    trigger: `${turns.length} turns exceed hot window ${DEFAULT_MAX_HOT_TURNS}`,
    inputTurnIds: archivedTurns.map(turn => turn.id),
    outputBlockId: 'memory-compact-summary',
    retainedTurnIds: hotTurns.map(turn => turn.id),
    status: 'applied',
  }
}

function createKVCacheSegments(
  input: ResearchInput,
  hotTurns: ConversationTurn[],
  blocks: MemoryBlock[],
): KVCacheSegment[] {
  const artifactIds = (input.artifacts ?? []).map(artifact => artifact.id)

  return [
    {
      id: 'kv-identity',
      scope: 'identity',
      policy: 'pin',
      sourceIds: ['identity', 'constitution'],
      tokenEstimate: 900,
      invalidatesOn: ['system prompt version change'],
    },
    {
      id: 'kv-goal',
      scope: 'goal',
      policy: 'refresh',
      sourceIds: ['goal', 'metric', ...input.constraints.map((_, index) => `constraint-${index + 1}`)],
      tokenEstimate: blocks.find(block => block.id === 'memory-goal')?.tokenEstimate ?? 0,
      invalidatesOn: ['goal edit', 'metric edit', 'constraint edit'],
    },
    {
      id: 'kv-hot-conversation',
      scope: 'conversation',
      policy: hotTurns.length ? 'reuse' : 'evict',
      sourceIds: hotTurns.map(turn => turn.id),
      tokenEstimate: hotTurns.reduce((sum, turn) => sum + estimateTokens(turn.content), 0),
      invalidatesOn: ['new user turn', 'manual session reset'],
    },
    {
      id: 'kv-artifacts',
      scope: 'artifact',
      policy: artifactIds.length ? 'reuse' : 'evict',
      sourceIds: artifactIds.slice(-16),
      tokenEstimate: Math.min(12_000, artifactIds.length * 320),
      invalidatesOn: ['artifact added', 'artifact deleted', 'source hash changed'],
    },
    {
      id: 'kv-verification',
      scope: 'verification',
      policy: 'refresh',
      sourceIds: ['verification gates', 'evidence ledger'],
      tokenEstimate: 1_200,
      invalidatesOn: ['new run', 'new metric trace', 'new patch diff'],
    },
  ]
}

export function createSessionMemoryState(
  input: ResearchInput,
  graph: ContextGraph,
): SessionMemoryState {
  const turns = input.conversation ?? []
  const hotTurns = turns.slice(-DEFAULT_MAX_HOT_TURNS)
  const archivedTurns = turns.slice(0, Math.max(0, turns.length - DEFAULT_MAX_HOT_TURNS))
  const blocks = createBlocks(input, graph, hotTurns, archivedTurns)
  const estimatedTokens = blocks.reduce((sum, block) => sum + block.tokenEstimate, 0)

  return {
    sessionId: sessionId(input),
    activeTurnCount: hotTurns.length,
    archivedTurnCount: archivedTurns.length,
    maxHotTurns: DEFAULT_MAX_HOT_TURNS,
    tokenBudget: DEFAULT_TOKEN_BUDGET,
    estimatedTokens,
    blocks,
    compact: createCompactOperation(turns, hotTurns, archivedTurns),
    kvCache: createKVCacheSegments(input, hotTurns, blocks),
  }
}
