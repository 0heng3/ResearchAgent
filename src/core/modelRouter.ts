import type { ContextGraph, ModelProfile, ResearchInput } from './types'

export const CLAW_MODELS: ModelProfile[] = [
  {
    id: 'frontier-controller',
    label: 'Frontier Controller',
    provider: 'configurable',
    role: 'controller',
    strengths: ['long-horizon planning', 'research synthesis', 'tool orchestration'],
    switchPolicy: 'Default for ambiguous or high-stakes research compilation.',
    enabled: true,
  },
  {
    id: 'code-repair',
    label: 'Code Repair Specialist',
    provider: 'configurable',
    role: 'coder',
    strengths: ['large diffs', 'test repair', 'repo migration'],
    switchPolicy: 'Use for implementation, refactors, failing tests and benchmark runners.',
    enabled: true,
  },
  {
    id: 'fresh-verifier',
    label: 'Fresh Verifier',
    provider: 'configurable',
    role: 'verifier',
    strengths: ['audit', 'bug finding', 'protocol mismatch detection'],
    switchPolicy: 'Use with isolated context before accepting results or SOTA claims.',
    enabled: true,
  },
  {
    id: 'browser-research',
    label: 'Browser Research Model',
    provider: 'configurable',
    role: 'browser',
    strengths: ['web evidence', 'docs reading', 'paper/source checking'],
    switchPolicy: 'Use when external sources must be fetched, cited and timestamped.',
    enabled: true,
  },
  {
    id: 'vision-context',
    label: 'Vision Context Model',
    provider: 'configurable',
    role: 'vision',
    strengths: ['images', 'figures', 'charts', 'multimodal inspection'],
    switchPolicy: 'Use when attached artifacts contain image, video or figure-heavy papers.',
    enabled: true,
  },
  {
    id: 'local-budget',
    label: 'Local Budget Model',
    provider: 'local',
    role: 'budget',
    strengths: ['cheap routing', 'file triage', 'low-risk summarization'],
    switchPolicy: 'Use for bulk indexing and low-risk scans when available.',
    enabled: false,
  },
]

export function selectModelForRun(
  input: ResearchInput,
  graph: ContextGraph,
  preferredModelId?: string,
) {
  const preferred = preferredModelId
    ? CLAW_MODELS.find(model => model.id === preferredModelId && model.enabled)
    : undefined
  if (preferred) return preferred

  if (preferredModelId) {
    const [channelId, ...modelParts] = preferredModelId.includes(':')
      ? preferredModelId.split(':')
      : ['runtime', preferredModelId]
    const modelId = modelParts.join(':') || preferredModelId
    return {
      id: preferredModelId,
      label: modelId,
      provider: `OpenAI-compatible runtime / ${channelId}`,
      role: 'controller',
      strengths: ['live endpoint selection', 'user-selected runtime model', `channel:${channelId}`],
      switchPolicy:
        `Selected by the user from channel ${channelId}; COG-CLAW still routes specialist work automatically.`,
      enabled: true,
    } satisfies ModelProfile
  }

  if (graph.coverage.modalities.some(modality => ['image', 'video'].includes(modality))) {
    return CLAW_MODELS.find(model => model.id === 'vision-context') ?? CLAW_MODELS[0]
  }

  if (graph.coverage.hasExecutableProject || input.mode === 'existing-project') {
    return CLAW_MODELS.find(model => model.id === 'code-repair') ?? CLAW_MODELS[0]
  }

  return CLAW_MODELS[0]
}
