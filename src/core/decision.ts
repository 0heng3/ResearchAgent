import { buildContextGraph } from './contextGraph'
import type { AgentDecision, ContextArtifact, ResearchInput } from './types'

function latestUserText(input: ResearchInput) {
  return (
    [...(input.conversation ?? [])]
      .reverse()
      .find(turn => turn.role === 'user' && turn.content.trim())?.content ?? ''
  )
}

function includesAny(value: string, patterns: RegExp[]) {
  return patterns.some(pattern => pattern.test(value))
}

function terms(...escapedTerms: string[]) {
  return new RegExp(escapedTerms.join('|'), 'i')
}

const multilingualSignals = {
  dataset: terms(
    '\\u6570\\u636e\\u96c6',
    '\\u6570\\u636e',
    '\\u6837\\u672c',
    '\\u8868\\u683c',
  ),
  benchmark: terms(
    '\\u57fa\\u51c6',
    '\\u8bc4\\u6d4b',
    '\\u8bc4\\u4ef7',
    '\\u6392\\u884c\\u699c',
    '\\u699c\\u5355',
    '\\u6307\\u6807',
    '\\u5206\\u6570',
    '\\u534f\\u8bae',
  ),
  paper: terms(
    '\\u8bba\\u6587',
    '\\u6587\\u732e',
    '\\u590d\\u73b0',
    '\\u8ddf\\u8bba\\u6587',
  ),
  researchPressure: terms(
    '\\u79d1\\u7814',
    '\\u8bad\\u7ec3',
    '\\u5b9e\\u9a8c',
    '\\u6d88\\u878d',
    '\\u4f18\\u5316',
    '\\u5237\\u699c',
    '\\u9879\\u76ee\\u4ea7\\u51fa',
    '\\u4ece0',
    '\\u4ece\\u96f6',
    '\\u6700\\u4f18',
  ),
  agentWork: terms(
    '\\u4fee\\u590d',
    '\\u8c03\\u8bd5',
    '\\u5b9e\\u73b0',
    '\\u91cd\\u6784',
    '\\u6784\\u5efa',
    '\\u6d4b\\u8bd5',
    '\\u8fd0\\u884c',
    '\\u626b\\u63cf',
    '\\u5b89\\u88c5',
    '\\u4ed3\\u5e93',
    '\\u4ee3\\u7801',
    '\\u9879\\u76ee',
    '\\u8865\\u4e01',
    '\\u5de5\\u4f5c\\u533a',
  ),
  capability: terms(
    '\\u5de5\\u5177',
    '\\u80fd\\u529b',
    '\\u63d2\\u4ef6',
    '\\u6269\\u5c55',
  ),
  browse: terms(
    '\\u641c\\u7d22',
    '\\u6d4f\\u89c8',
    '\\u6293\\u53d6',
    '\\u6587\\u6863',
  ),
}

function artifactSignals(artifacts: ContextArtifact[]) {
  const signals: string[] = []
  if (artifacts.length) signals.push('attached-artifacts')
  if (artifacts.some(item => item.kind === 'dataset' || item.modality === 'tabular')) {
    signals.push('dataset-or-table')
  }
  if (artifacts.some(item => item.kind === 'benchmark' || /benchmark|leaderboard|eval/i.test(item.title))) {
    signals.push('benchmark-protocol')
  }
  if (artifacts.some(item => item.kind === 'paper' || /\.pdf$/i.test(item.title))) {
    signals.push('paper-context')
  }
  if (artifacts.some(item => item.kind === 'project-code' || item.modality === 'code')) {
    signals.push('codebase-context')
  }
  if (artifacts.some(item => ['image', 'audio', 'video', 'mixed'].includes(item.modality))) {
    signals.push('multimodal-context')
  }
  if (artifacts.some(item => item.kind === 'experiment-log')) signals.push('execution-logs')
  return signals
}

export function decideAgentLoop(input: ResearchInput): AgentDecision {
  const graph = buildContextGraph(input)
  const latest = latestUserText(input)
  const text = `${input.goal}\n${input.targetMetric}\n${latest}`.toLowerCase()
  const artifacts = input.artifacts ?? []
  const signals = new Set<string>(artifactSignals(artifacts))

  if (graph.coverage.hasDataset) signals.add('dataset')
  if (graph.coverage.hasBenchmark) signals.add('benchmark')
  if (graph.coverage.hasPaper) signals.add('paper')
  if (graph.coverage.hasExecutableProject) signals.add('executable-project')
  if (input.mode !== 'open-ended') signals.add(`mode:${input.mode}`)

  if (includesAny(text, [
    /\b(dataset|data\s*set|csv|parquet|jsonl|training\s+data|sample|table)\b/i,
    multilingualSignals.dataset,
  ])) {
    signals.add('dataset')
  }
  if (includesAny(text, [
    /\b(benchmark|leaderboard|eval|evaluation|metric|score|protocol|baseline)\b/i,
    multilingualSignals.benchmark,
  ])) {
    signals.add('benchmark')
  }
  if (includesAny(text, [
    /\b(paper|arxiv|reproduce|reproduction|follow\s*paper|literature|citation)\b/i,
    multilingualSignals.paper,
  ])) {
    signals.add('paper')
  }
  if (includesAny(text, [
    /\b(sota|state[-\s]?of[-\s]?the[-\s]?art|train|evaluate|experiment|ablation|optimi[sz]e|rerun)\b/i,
    multilingualSignals.researchPressure,
  ])) {
    signals.add('research-pressure')
  }
  if (includesAny(text, [
    /\b(fix|debug|implement|refactor|build|test|run|scan|install|repo|workspace|codebase|patch)\b/i,
    multilingualSignals.agentWork,
  ])) {
    signals.add('agent-work')
  }
  if (includesAny(text, [
    /\b(mcp|skill|tool|capability|plugin|extension)\b/i,
    multilingualSignals.capability,
  ])) {
    signals.add('capability-extension')
  }

  const researchScore = [
    'dataset',
    'dataset-or-table',
    'benchmark',
    'benchmark-protocol',
    'paper',
    'paper-context',
    'execution-logs',
    'research-pressure',
  ].filter(signal => signals.has(signal)).length
  const workScore = [
    'agent-work',
    'codebase-context',
    'executable-project',
    'multimodal-context',
    'capability-extension',
    'attached-artifacts',
  ].filter(signal => signals.has(signal)).length

  const cogRecommended = researchScore >= 2 || (researchScore >= 1 && artifacts.length > 0)
  const loop = cogRecommended ? 'cog-research' : workScore >= 1 ? 'agent-work' : 'conversation'
  const autonomy =
    loop === 'cog-research'
      ? 'long-horizon'
      : loop === 'agent-work'
        ? artifacts.length || includesAny(text, [
            /\b(run|fix|build|test|install|write|edit|patch)\b/i,
            terms('\\u8fd0\\u884c', '\\u4fee\\u590d', '\\u6784\\u5efa', '\\u6d4b\\u8bd5', '\\u5b89\\u88c5', '\\u5199\\u5165', '\\u7f16\\u8f91', '\\u4fee\\u6539'),
          ])
          ? 'act'
          : 'inspect'
        : 'respond'

  const risks: string[] = []
  if (cogRecommended) risks.push('research claims need hard evidence before promotion')
  if (graph.coverage.hasBenchmark) risks.push('benchmark protocol must stay locked')
  if (graph.coverage.hasDataset) risks.push('dataset split, leakage and lineage must be audited')
  if (signals.has('capability-extension')) risks.push('new skills or MCP adapters need workspace-scoped manifests')

  const requiredCapabilities = new Set<string>()
  const recommendedTools = new Set<string>()
  if (loop !== 'conversation') {
    requiredCapabilities.add('tool-workspace-manager')
    recommendedTools.add('Read')
    recommendedTools.add('Grep')
    recommendedTools.add('TodoWrite')
  }
  if (signals.has('capability-extension')) {
    requiredCapabilities.add('skill-skill-installer')
    requiredCapabilities.add('mcp-mcp-installer')
    recommendedTools.add('Skill')
    recommendedTools.add('MCP')
  }
  if (cogRecommended) {
    requiredCapabilities.add('tool-fresh-verifier')
    requiredCapabilities.add('skill-benchmark-takeover')
    recommendedTools.add('context_ingest')
    recommendedTools.add('verify_truthfulness')
    recommendedTools.add('fresh_verifier')
  }
  if (graph.coverage.hasDataset || graph.coverage.modalities.some(modality => modality !== 'text')) {
    requiredCapabilities.add('skill-dataset-analysis')
    recommendedTools.add('sample_inspector')
  }
  if (graph.coverage.hasPaper || includesAny(text, [
    /\b(fetch|browse|search|paper|docs?)\b/i,
    multilingualSignals.browse,
  ])) {
    requiredCapabilities.add('skill-browser-research')
    recommendedTools.add('WebFetch')
    recommendedTools.add('WebSearch')
  }

  return {
    id: `decision-${Date.now().toString(36)}`,
    loop,
    confidence: Math.min(0.98, 0.56 + Math.max(researchScore, workScore) * 0.1),
    autonomy,
    reason:
      loop === 'cog-research'
        ? 'The turn contains evidence-bearing research, benchmark, dataset, paper or experiment pressure; COG-CLAW should use the COG research loop as the best current work strategy.'
        : loop === 'agent-work'
          ? 'The turn asks for real workspace or tool work, so COG-CLAW should operate like a Claude-Code-style agent without forcing the research loop.'
          : 'The turn can be answered as continuous conversation while preserving session and workspace state.',
    signals: [...signals],
    risks,
    requiredCapabilities: [...requiredCapabilities],
    recommendedTools: [...recommendedTools],
    verification:
      loop === 'cog-research'
        ? 'research-hard-gates'
        : loop === 'agent-work'
          ? 'light'
          : 'none',
    cogLoop: {
      recommended: cogRecommended,
      entered: cogRecommended,
      rationale: cogRecommended
        ? 'Autonomous decision: evidence-bearing research/project work benefits from the COG inspect-plan-act-verify-optimize loop.'
        : 'Autonomous decision: keep the Claude-Code-style conversation/work loop; do not enter COG research mode unless evidence pressure appears.',
    },
  }
}
