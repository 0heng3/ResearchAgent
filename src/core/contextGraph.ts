import type {
  ArtifactKind,
  ArtifactModality,
  ContextArtifact,
  ContextEdge,
  ContextGraph,
  ContextNode,
  ResearchInput,
  ResearchSignal,
} from './types'

function slug(value: string) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fa5]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 56)
}

function artifactFromDataset(input: ResearchInput): ContextArtifact | undefined {
  if (!input.dataset) return undefined
  return {
    id: `dataset-${slug(input.dataset.name)}`,
    kind: 'dataset',
    modality: input.dataset.modality.includes('image')
      ? 'image'
      : input.dataset.modality.includes('audio')
        ? 'audio'
        : input.dataset.modality.includes('video')
          ? 'video'
          : input.dataset.modality.includes('table')
            ? 'tabular'
            : 'mixed',
    title: input.dataset.name,
    uri: input.dataset.path,
    summary: `${input.dataset.sizeHint ?? 'unknown size'} ${input.dataset.modality} dataset.`,
    signals: [
      input.dataset.modality,
      ...(input.dataset.knownIssues ?? []),
      input.dataset.sizeHint ?? 'size unknown',
    ],
    risks: input.dataset.knownIssues ?? ['unprofiled dataset'],
    trust: 0.82,
  }
}

function artifactFromPaper(title: string, claim: string, ideas: string[]): ContextArtifact {
  return {
    id: `paper-${slug(title)}`,
    kind: 'paper',
    modality: 'text',
    title,
    summary: claim,
    signals: ideas,
    risks: ['paper protocol may not match local dataset', 'reported gains require reproduction'],
    trust: 0.74,
  }
}

function artifactFromReferenceCode(name: string, path: string, usefulFor: string): ContextArtifact {
  return {
    id: `code-${slug(name)}`,
    kind: 'reference-code',
    modality: 'code',
    title: name,
    uri: path,
    summary: usefulFor,
    signals: [usefulFor, 'implementation prior'],
    risks: ['stale dependencies', 'hidden protocol assumptions'],
    trust: 0.68,
  }
}

export function normalizeArtifacts(input: ResearchInput): ContextArtifact[] {
  const declared = input.artifacts ?? []
  const derived = [
    artifactFromDataset(input),
    ...(input.papers ?? []).map(paper =>
      artifactFromPaper(paper.title, paper.claim, paper.reusableIdeas),
    ),
    ...(input.referenceCode ?? []).map(item =>
      artifactFromReferenceCode(item.name, item.path, item.usefulFor),
    ),
  ].filter(Boolean) as ContextArtifact[]

  const seen = new Set<string>()
  return [...declared, ...derived].filter(artifact => {
    if (seen.has(artifact.id)) return false
    seen.add(artifact.id)
    return true
  })
}

function nodeForArtifact(artifact: ContextArtifact): ContextNode {
  return {
    id: artifact.id,
    label: artifact.title,
    kind: artifact.kind,
    weight: Math.max(0.2, Math.min(1, artifact.trust)),
  }
}

function relationForKind(kind: ArtifactKind): ContextEdge['relation'] {
  if (kind === 'experiment-log') return 'derived-from'
  if (kind === 'config' || kind === 'benchmark') return 'constrains'
  if (kind === 'dataset' || kind === 'paper' || kind === 'reference-code') return 'supports'
  return 'requires'
}

export function buildContextGraph(input: ResearchInput): ContextGraph {
  const artifacts = normalizeArtifacts(input)
  const nodes: ContextNode[] = [
    { id: 'goal', label: input.goal, kind: 'goal', weight: 1 },
    { id: 'metric', label: input.targetMetric, kind: 'metric', weight: 1 },
    ...input.constraints.map((constraint, index) => ({
      id: `constraint-${index + 1}`,
      label: constraint,
      kind: 'constraint' as const,
      weight: 0.92,
    })),
    ...artifacts.map(nodeForArtifact),
  ]

  const edges: ContextEdge[] = [
    { from: 'metric', to: 'goal', relation: 'constrains', strength: 1 },
    ...input.constraints.map((_, index) => ({
      from: `constraint-${index + 1}`,
      to: 'goal',
      relation: 'constrains' as const,
      strength: 0.86,
    })),
    ...artifacts.map(artifact => ({
      from: artifact.id,
      to: artifact.kind === 'experiment-log' ? 'metric' : 'goal',
      relation: relationForKind(artifact.kind),
      strength: artifact.trust,
    })),
  ]

  const modalities = [...new Set(artifacts.map(item => item.modality))]
  return {
    nodes,
    edges,
    coverage: {
      modalities,
      hasBenchmark: artifacts.some(item => item.kind === 'benchmark'),
      hasExecutableProject: artifacts.some(item => item.kind === 'project-code'),
      hasDataset: artifacts.some(item => item.kind === 'dataset'),
      hasPaper: artifacts.some(item => item.kind === 'paper'),
      hasLogs: artifacts.some(item => item.kind === 'experiment-log'),
    },
  }
}

export function signalsFromGraph(graph: ContextGraph): ResearchSignal[] {
  const modalitySummary = graph.coverage.modalities.length
    ? graph.coverage.modalities.join(' + ')
    : 'text-only'

  return [
    {
      label: 'Context Coverage',
      value: `${graph.nodes.length} nodes / ${graph.edges.length} edges`,
      confidence: 0.97,
    },
    {
      label: 'Modalities',
      value: modalitySummary,
      confidence: graph.coverage.modalities.length ? 0.91 : 0.55,
    },
    {
      label: 'Executable Prior',
      value: graph.coverage.hasExecutableProject || graph.coverage.hasBenchmark ? 'available' : 'not provided',
      confidence: graph.coverage.hasExecutableProject || graph.coverage.hasBenchmark ? 0.88 : 0.61,
    },
    {
      label: 'Evidence Depth',
      value: graph.coverage.hasLogs ? 'includes experiment logs' : 'pre-experiment',
      confidence: graph.coverage.hasLogs ? 0.9 : 0.7,
    },
  ]
}

export function primaryModalities(graph: ContextGraph): ArtifactModality[] {
  return graph.coverage.modalities.length ? graph.coverage.modalities : ['text']
}
