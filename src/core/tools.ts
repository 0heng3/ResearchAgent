import { z } from 'zod'
import { CLAW_CONSTITUTION, makeCoreVerificationGates } from './constitution'
import { ToolRegistry } from './toolRegistry'
import type {
  BlueprintModule,
  EvidenceItem,
  ExperimentStep,
  GeneratedFile,
  OptimizationCandidate,
  ResearchInput,
  ResearchSignal,
} from './types'

const researchInputSchema: z.ZodType<ResearchInput> = z.object({
  title: z.string(),
  mode: z.enum([
    'dataset',
    'follow-paper',
    'reference-code',
    'benchmark',
    'multimodal',
    'existing-project',
    'open-ended',
  ]),
  goal: z.string(),
  targetMetric: z.string(),
  preferredModelId: z.string().optional(),
  dataset: z
    .object({
      name: z.string(),
      path: z.string().optional(),
      modality: z.string(),
      sizeHint: z.string().optional(),
      knownIssues: z.array(z.string()).optional(),
    })
    .optional(),
  papers: z
    .array(
      z.object({
        title: z.string(),
        claim: z.string(),
        reusableIdeas: z.array(z.string()),
      }),
    )
    .optional(),
  referenceCode: z
    .array(
      z.object({
        name: z.string(),
        path: z.string(),
        usefulFor: z.string(),
      }),
    )
    .optional(),
  artifacts: z
    .array(
      z.object({
        id: z.string(),
        kind: z.enum([
          'conversation',
          'dataset',
          'benchmark',
          'project-code',
          'paper',
          'reference-code',
          'experiment-log',
          'image',
          'audio',
          'video',
          'table',
          'text',
          'config',
          'unknown',
        ]),
        modality: z.enum([
          'text',
          'tabular',
          'image',
          'audio',
          'video',
          'code',
          'graph',
          'mixed',
        ]),
        title: z.string(),
        uri: z.string().optional(),
        summary: z.string(),
        signals: z.array(z.string()),
        risks: z.array(z.string()),
        trust: z.number(),
        metadata: z.record(z.union([z.string(), z.number(), z.boolean()])).optional(),
      }),
    )
    .optional(),
  conversation: z
    .array(
      z.object({
        id: z.string(),
        role: z.enum(['user', 'assistant', 'system']),
        content: z.string(),
        artifactIds: z.array(z.string()).optional(),
        mode: z.enum(['chat', 'work']).optional(),
        modelId: z.string().optional(),
        toolCalls: z.array(z.any()).optional(),
        workTrace: z.array(z.any()).optional(),
      }),
    )
    .optional(),
  constraints: z.array(z.string()),
})

export function createClawToolRegistry() {
  const registry = new ToolRegistry()

  registry.register<ResearchInput, ResearchSignal[]>({
    name: 'context_ingest',
    description:
      'Normalize dataset, paper, reference-code and user constraints into research signals.',
    inputSchema: researchInputSchema,
    capabilityKind: 'tool',
    mcpCompatible: true,
    permissions: ['read'],
    isReadOnly: true,
    run(input) {
      return [
        {
          label: 'Research Mode',
          value: input.mode,
          confidence: 0.98,
        },
        {
          label: 'Primary Metric',
          value: input.targetMetric,
          confidence: 0.94,
        },
        {
          label: 'Dataset Modality',
          value: input.dataset?.modality ?? 'context-only',
          confidence: input.dataset ? 0.9 : 0.62,
        },
        {
          label: 'SOTA Pressure',
          value:
            input.mode === 'follow-paper'
              ? 'paper-guided reproduction + improvement'
              : 'from-scratch competitive project generation',
          confidence: 0.86,
        },
      ]
    },
  })

  registry.register<ResearchInput, EvidenceItem[]>({
    name: 'evidence_bootstrap',
    description:
      'Create the initial evidence ledger required before any optimization can be accepted.',
    inputSchema: researchInputSchema,
    capabilityKind: 'tool',
    mcpCompatible: true,
    permissions: ['read'],
    isReadOnly: true,
    run(input) {
      const evidence: EvidenceItem[] = [
        {
          id: 'constitution',
          label: 'CLAW constitution',
          source: 'system',
          status: 'verified',
          note: CLAW_CONSTITUTION.map(item => item.label).join(' / '),
        },
        {
          id: 'goal',
          label: 'User research goal',
          source: 'user',
          status: 'collected',
          note: input.goal,
        },
        {
          id: 'metric',
          label: 'Target metric',
          source: 'user',
          status: 'collected',
          note: input.targetMetric,
        },
      ]

      if (input.dataset) {
        evidence.push({
          id: 'dataset',
          label: input.dataset.name,
          source: input.dataset.path ?? 'dataset descriptor',
          status: 'required',
          note: `Need profile for ${input.dataset.modality}; known issues: ${
            input.dataset.knownIssues?.join(', ') || 'none declared'
          }`,
        })
      }

      for (const paper of input.papers ?? []) {
        evidence.push({
          id: `paper-${paper.title.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`,
          label: paper.title,
          source: 'paper context',
          status: 'collected',
          note: paper.claim,
        })
      }

      return evidence
    },
  })

  registry.register<
    { input: ResearchInput; signals: ResearchSignal[] },
    BlueprintModule[]
  >({
    name: 'sota_blueprint',
    description:
      'Synthesize a single-path SOTA-seeking project blueprint under truthfulness constraints.',
    inputSchema: z.object({
      input: researchInputSchema,
      signals: z.array(
        z.object({
          label: z.string(),
          value: z.string(),
          confidence: z.number(),
        }),
      ),
    }),
    capabilityKind: 'generator',
    mcpCompatible: true,
    permissions: ['read'],
    isReadOnly: true,
    run({ input }) {
      const issues = input.dataset?.knownIssues ?? []
      const paperIdeas = (input.papers ?? []).flatMap(paper => paper.reusableIdeas)

      return [
        {
          id: 'data',
          name: 'Evidence-first data pipeline',
          role: 'Produce reproducible splits, leakage checks, feature transforms and dataset cards.',
          decisions: [
            `Lock metric protocol for ${input.targetMetric}.`,
            `Generate deterministic train/validation/test manifests before modeling.`,
            issues.length
              ? `Add targeted mitigations for ${issues.join(', ')}.`
              : 'Run automated profiling before selecting augmentations.',
          ],
          risks: ['silent leakage', 'distribution drift', 'misreported sample counts'],
        },
        {
          id: 'model',
          name: 'SOTA candidate architecture',
          role: 'Translate dataset and paper context into one decisive model route.',
          decisions: [
            paperIdeas[0]
              ? `Start from paper-derived idea: ${paperIdeas[0]}.`
              : 'Use a strong modern baseline with task-specific inductive bias.',
            'Keep all enhancements behind ablation switches.',
            'Separate representation, objective and calibration modules.',
          ],
          risks: ['over-complexity', 'unproven module stacking'],
        },
        {
          id: 'training',
          name: 'Reproducible experiment engine',
          role: 'Run baselines, staged training, sweeps and failure logging.',
          decisions: [
            'Every run emits config, git hash, seed, metric trace and dataset manifest hash.',
            'Promotion requires clean-room rerun and anti-cheat gate pass.',
            'Use budget-aware search before architectural expansion.',
          ],
          risks: ['unstable gains', 'seed cherry-picking'],
        },
        {
          id: 'verification',
          name: 'Truthful SOTA gate',
          role: 'Reject fake, misaligned or irreproducible improvements before they affect score.',
          decisions: [
            'Treat cheating, leakage and task mismatch as hard failures.',
            'Require artifact lineage for all reported metrics.',
            'Attach audit summary to final project report.',
          ],
          risks: ['metric hacking', 'paper protocol drift'],
        },
        {
          id: 'autonomy',
          name: 'Self-extension layer',
          role: 'Install or scaffold missing skills, tools and MCP adapters when the project requires new capabilities.',
          decisions: [
            'Route each action through a declared capability manifest.',
            'Use browser fetch only with citation and source hashing.',
            'Use reproduction and repair loops only after runner commands are explicit.',
          ],
          risks: ['capability sprawl', 'unsafe tool permissions', 'uncited external evidence'],
        },
      ]
    },
  })

  registry.register<BlueprintModule[], GeneratedFile[]>({
    name: 'project_generate',
    description:
      'Generate a complete project skeleton from the approved research blueprint.',
    inputSchema: z.array(
      z.object({
        id: z.string(),
        name: z.string(),
        role: z.string(),
        decisions: z.array(z.string()),
        risks: z.array(z.string()),
      }),
    ),
    capabilityKind: 'generator',
    mcpCompatible: true,
    permissions: ['write'],
    run(blueprint) {
      const moduleList = blueprint
        .map(module => `- ${module.name}: ${module.role}`)
        .join('\n')

      return [
        {
          path: 'README.md',
          purpose: 'Project contract and reproducibility instructions.',
          contents: `# COG-CLAW Research Project\n\n${moduleList}\n\nAll reported metrics must pass CLAW hard gates.`,
        },
        {
          path: 'src/train.ts',
          purpose: 'Training entry with locked config, seeds and metric tracing.',
          contents:
            "export async function train() {\n  return { metricTrace: [], artifactHash: 'pending' }\n}\n",
        },
        {
          path: 'src/evaluate.ts',
          purpose: 'Protocol-faithful evaluation entry.',
          contents:
            "export async function evaluate() {\n  return { score: null, protocol: 'locked' }\n}\n",
        },
        {
          path: 'claw.config.json',
          purpose: 'Single source of truth for experiment protocol.',
          contents: JSON.stringify(
            {
              metricGate: 'hard',
              antiCheat: true,
              reproducibility: 'required',
              ablations: blueprint.map(module => module.id),
            },
            null,
            2,
          ),
        },
        {
          path: 'skills/reproduction-runner/SKILL.md',
          purpose: 'Installable skill contract for benchmark reproduction.',
          contents:
            '# Reproduction Runner\n\nUse when a generated project or benchmark must be installed, executed and audited.\n\nInputs: workspace, commands, resource budget.\nOutputs: logs, metric trace, artifact hashes.\nSafety: never mutate official metric scripts or test labels.\n',
        },
        {
          path: 'mcp/experiment-runner.json',
          purpose: 'MCP server manifest for future runner integration.',
          contents: JSON.stringify(
            {
              name: 'experiment-runner',
              transport: 'stdio',
              tools: ['install', 'train', 'evaluate', 'collect_logs'],
              guardrails: ['protocol_lock', 'immutable_logs', 'resource_limits'],
            },
            null,
            2,
          ),
        },
      ]
    },
  })

  registry.register<ResearchInput, ExperimentStep[]>({
    name: 'experiment_plan',
    description:
      'Create baseline, reproduction, optimization and clean-room verification experiments.',
    inputSchema: researchInputSchema,
    capabilityKind: 'runner',
    mcpCompatible: true,
    permissions: ['read', 'execute'],
    isReadOnly: true,
    run(input) {
      return [
        {
          id: 'baseline',
          name: 'Locked baseline',
          objective: `Establish honest ${input.targetMetric} reference under the final protocol.`,
          expectedSignal: 'stable metric trace and no leakage alerts',
          budget: '1x',
        },
        {
          id: 'paper-transfer',
          name: 'Paper/context transfer',
          objective:
            input.mode === 'follow-paper'
              ? 'Reproduce the paper-aligned route before improving it.'
              : 'Import only evidence-backed modern tricks.',
          expectedSignal: 'improvement over baseline with matching protocol',
          budget: '2x',
        },
        {
          id: 'ablation',
          name: 'Ablation ladder',
          objective: 'Prove each added module earns its complexity.',
          expectedSignal: 'monotonic or explainable contribution map',
          budget: '2x',
        },
        {
          id: 'clean-room',
          name: 'Clean-room rerun',
          objective: 'Reproduce the best candidate from clean workspace and locked seed set.',
          expectedSignal: 'metric within tolerance and artifact hashes recorded',
          budget: '1x',
        },
      ]
    },
  })

  registry.register<ResearchInput, ReturnType<typeof makeCoreVerificationGates>>({
    name: 'verify_truthfulness',
    description:
      'Run hard gates for no-cheating, protocol alignment, artifact lineage and complexity.',
    inputSchema: researchInputSchema,
    capabilityKind: 'verifier',
    mcpCompatible: true,
    permissions: ['read'],
    isReadOnly: true,
    run(input) {
      const artifacts = input.artifacts ?? []
      const hasBenchmark = artifacts.some(artifact => artifact.kind === 'benchmark')
      const hasDataset = Boolean(input.dataset) || artifacts.some(artifact => artifact.kind === 'dataset')
      const hasLogs = artifacts.some(artifact => artifact.kind === 'experiment-log')
      const hasExecutableProject =
        artifacts.some(artifact => artifact.kind === 'project-code') ||
        Boolean(input.referenceCode?.length)
      const hasConfig = artifacts.some(artifact => artifact.kind === 'config')
      return makeCoreVerificationGates({
        hasBenchmark,
        hasDataset,
        hasLogs,
        hasExecutableProject,
        hasConfig,
      })
    },
  })

  registry.register<
    { input: ResearchInput; gates: ReturnType<typeof makeCoreVerificationGates> },
    OptimizationCandidate[]
  >({
    name: 'metric_optimize',
    description:
      'Generate optimization candidates that are allowed only after hard verification gates pass.',
    inputSchema: z.object({
      input: researchInputSchema,
      gates: z.array(
        z.object({
          id: z.string(),
          label: z.string(),
          status: z.enum(['pass', 'warn', 'fail', 'pending']),
          severity: z.enum(['hard', 'soft']),
          detail: z.string(),
        }),
      ),
    }),
    capabilityKind: 'tool',
    mcpCompatible: true,
    permissions: ['read'],
    run({ input, gates }) {
      const allHardPassed = gates
        .filter(gate => gate.severity === 'hard')
        .every(gate => gate.status === 'pass')
      if (!allHardPassed) return []
      const gate = 'pass'
      return [
        {
          id: 'loss-search',
          change: 'Evaluate task-specific loss weighting and calibration schedule under locked protocol.',
          expectedImpact: `Improve ${input.targetMetric} without changing the evaluation protocol.`,
          evidenceNeeded: 'paired baseline comparison + clean-room rerun',
          gate,
        },
        {
          id: 'data-policy',
          change: 'Tune augmentation/sampling policy against profiled data failure modes.',
          expectedImpact: 'Improve robustness on minority or difficult regions.',
          evidenceNeeded: 'slice metrics + leakage audit',
          gate,
        },
        {
          id: 'architecture-swap',
          change: 'Try one paper-backed module swap behind ablation flag.',
          expectedImpact: 'Potential SOTA jump if contribution survives ablation.',
          evidenceNeeded: 'module-on/off ablation + complexity penalty report',
          gate,
        },
      ]
    },
  })

  return registry
}
