import { primaryModalities } from './contextGraph'
import type { AutonomousPlanStep, ContextGraph, ResearchInput } from './types'

function hasRichMedia(graph: ContextGraph) {
  const modalities = primaryModalities(graph)
  return modalities.some(modality =>
    ['image', 'audio', 'video', 'tabular', 'mixed'].includes(modality),
  )
}

export function createAutonomousPlan(
  input: ResearchInput,
  graph: ContextGraph,
): AutonomousPlanStep[] {
  const plan: AutonomousPlanStep[] = [
    {
      id: 'context-map',
      title: 'Build context graph',
      intent:
        'Turn conversation, datasets, papers, benchmark code, logs and media into one traceable graph.',
      requiredTools: ['context_ingest', 'evidence_bootstrap'],
      requiredEvidence: ['goal', 'metric', 'constraints'],
      successCriteria: 'Every input has an artifact id, source, modality, risk and trust score.',
      autonomy: 'automatic',
    },
  ]

  if (graph.coverage.hasDataset || hasRichMedia(graph)) {
    plan.push({
      id: 'multimodal-profile',
      title: 'Profile multimodal data',
      intent:
        'Detect modality coverage, label quality, split risks, drift, missingness and loader constraints.',
      requiredTools: ['profile_dataset', 'sample_inspector', 'leakage_scan'],
      requiredEvidence: ['dataset manifest', 'sample slices', 'split protocol'],
      successCriteria: 'Produce a dataset card, risk register and baseline-ready loader contract.',
      autonomy: 'background',
    })
  }

  if (graph.coverage.hasBenchmark || input.mode === 'benchmark') {
    plan.push({
      id: 'benchmark-adapter',
      title: 'Take over benchmark',
      intent:
        'Read runner commands, config, metric scripts and leaderboard protocol without mutating the evaluation boundary.',
      requiredTools: ['project_scan', 'benchmark_runner_probe', 'protocol_lock'],
      requiredEvidence: ['runner command', 'metric script', 'expected output contract'],
      successCriteria: 'Run the baseline under the official protocol and record raw results.',
      autonomy: 'automatic',
    })
  }

  if (graph.coverage.hasExecutableProject || input.mode === 'existing-project') {
    plan.push({
      id: 'codebase-understanding',
      title: 'Understand existing codebase',
      intent:
        'Build module, dependency and entrypoint maps before refactoring or repairing the project.',
      requiredTools: ['code_index', 'dependency_graph', 'entrypoint_runner'],
      requiredEvidence: ['project tree', 'entrypoints', 'dependency lockfile'],
      successCriteria: 'Produce a takeover report and safe edit plan.',
      autonomy: 'automatic',
    })
  }

  if (graph.coverage.hasPaper || input.mode === 'follow-paper') {
    plan.push({
      id: 'paper-to-system',
      title: 'Compile paper route',
      intent:
        'Translate claims, modules and protocol details into executable code modules and ablations.',
      requiredTools: ['paper_following', 'method_extractor', 'ablation_builder'],
      requiredEvidence: ['paper claims', 'method deltas', 'reproduction protocol'],
      successCriteria: 'Separate reproduction, improvement and replacement decisions.',
      autonomy: 'automatic',
    })
  }

  plan.push(
    {
      id: 'browser-evidence',
      title: 'Fetch external evidence',
      intent:
        'Use browser or web-fetch adapters only when current source evidence is needed for papers, datasets, issues or docs.',
      requiredTools: ['browser_fetch', 'source_snapshot', 'citation_ledger'],
      requiredEvidence: ['source url', 'timestamp', 'content hash'],
      successCriteria: 'External claims are cited, hashed and attached to the evidence ledger.',
      autonomy: 'needs-human-approval',
    },
    {
      id: 'blueprint',
      title: 'Compile SOTA blueprint',
      intent:
        'Generate one executable project route that directly serves the target metric and task constraints.',
      requiredTools: ['sota_blueprint'],
      requiredEvidence: ['context graph', 'risk register', 'metric protocol'],
      successCriteria: `Blueprint maps to ${input.targetMetric} and includes training, evaluation, ablation and optimization boundaries.`,
      autonomy: 'automatic',
    },
    {
      id: 'project-compile',
      title: 'Generate project workspace',
      intent:
        'Create source files, configs, runners, report templates and reproducibility contracts.',
      requiredTools: ['project_generate', 'experiment_plan'],
      requiredEvidence: ['blueprint', 'locked config', 'artifact lineage schema'],
      successCriteria: 'Project can install, run baseline, evaluate and emit reproducibility artifacts.',
      autonomy: 'background',
    },
    {
      id: 'reproduce-repair',
      title: 'Reproduce and repair',
      intent:
        'Run baseline, capture failures, apply minimal patches and rerun affected checks until the route is executable.',
      requiredTools: ['reproduction_runner', 'repair_loop', 'test_runner'],
      requiredEvidence: ['runner logs', 'exit code', 'patch diff'],
      successCriteria: 'The generated or imported project has a clean baseline execution path.',
      autonomy: 'background',
    },
    {
      id: 'truth-gates',
      title: 'Verify hard gates',
      intent:
        'Audit cheating, leakage, protocol drift, fake logs, task mismatch and irreproducible artifacts before optimization.',
      requiredTools: ['verify_truthfulness', 'fresh_verifier', 'clean_room_runner'],
      requiredEvidence: ['logs', 'config', 'dataset hash', 'metric script'],
      successCriteria: 'Hard gates pass before any candidate is allowed into the SOTA loop.',
      autonomy: 'automatic',
    },
    {
      id: 'sota-loop',
      title: 'Optimize under evidence',
      intent:
        'Run sweeps, data policies, architecture swaps and paper-derived improvements with ablation and clean-room reruns.',
      requiredTools: ['metric_optimize', 'sweep_runner', 'ablation_runner'],
      requiredEvidence: ['paired experiments', 'slice metrics', 'clean-room rerun'],
      successCriteria:
        'Keep only improvements that are truthful, reproducible, task-aligned and worth their complexity.',
      autonomy: 'background',
    },
  )

  return plan
}
