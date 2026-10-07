export type ClawSkill = {
  id: string
  name: string
  trigger: string
  purpose: string
  outputs: string[]
}

export const CLAW_SKILLS: ClawSkill[] = [
  {
    id: 'repo-adaptation',
    name: 'Repository Adaptation',
    trigger: 'COG-CLAW enters a new or unfamiliar repository/workspace.',
    purpose:
      'Infer language, package manager, tests, build scripts, ownership boundaries and safe artifact locations before acting.',
    outputs: ['workspace map', 'build/test matrix', 'risk boundaries', 'safe edit scope'],
  },
  {
    id: 'long-horizon-work',
    name: 'Long-Horizon Work',
    trigger: 'A task requires sustained autonomous progress across many tool calls or sessions.',
    purpose:
      'Keep a resumable loop with compact summaries, pinned goals, verification checkpoints and observable progress.',
    outputs: ['resume point', 'compact summary', 'progress ledger', 'next action queue'],
  },
  {
    id: 'mcp-authoring',
    name: 'MCP Authoring',
    trigger: 'A needed tool should become an MCP adapter or existing MCP should be connected.',
    purpose:
      'Create a declarative MCP manifest, permission model, environment contract and smoke test for reusable tool access.',
    outputs: ['MCP manifest', 'permission contract', 'env schema', 'smoke test plan'],
  },
  {
    id: 'skill-installer',
    name: 'Skill Installer',
    trigger: 'COG-CLAW needs a missing reusable workflow or the user asks to install, author or update a skill.',
    purpose:
      'Discover existing skills, scaffold workspace-scoped SKILL.md directories, define triggers, allowed tools, tests and safety contracts, then register the capability.',
    outputs: ['installed skill', 'SKILL.md', 'allowed tool policy', 'smoke test plan'],
  },
  {
    id: 'permission-policy',
    name: 'Permission Policy',
    trigger: 'A tool, skill, MCP adapter or shell command crosses read/write/network/execute or destructive boundaries.',
    purpose:
      'Classify tool risk, apply workspace trust rules, require approval for risky actions and preserve denied permission context.',
    outputs: ['permission decision', 'risk summary', 'blocked action note', 'safe alternative'],
  },
  {
    id: 'context-graphing',
    name: 'Context Graphing',
    trigger: 'New conversation turns, files, datasets, papers, logs or media are attached.',
    purpose:
      'Normalize every input into a traceable artifact graph with source, modality, risk and trust metadata.',
    outputs: ['artifact graph', 'coverage matrix', 'risk register', 'missing evidence'],
  },
  {
    id: 'dataset-analysis',
    name: 'Dataset Analysis',
    trigger: 'The user provides a dataset path, sample bundle, manifest or data description.',
    purpose:
      'Profile modalities, labels, splits, duplicates, leakage risks, drift and baseline-ready loaders.',
    outputs: ['dataset card', 'split audit', 'slice metrics plan', 'loader contract'],
  },
  {
    id: 'benchmark-takeover',
    name: 'Benchmark Takeover',
    trigger: 'A benchmark runner, leaderboard protocol or existing project is provided.',
    purpose:
      'Lock the official runner and metric boundary before any implementation or optimization is accepted.',
    outputs: ['entrypoint map', 'protocol lock', 'baseline run', 'safe edit plan'],
  },
  {
    id: 'paper-following',
    name: 'Paper Following',
    trigger: 'The task asks to follow, reproduce or extend a paper.',
    purpose:
      'Compile paper claims into reproducible modules, deltas, ablations and protocol constraints.',
    outputs: ['method map', 'reproduction matrix', 'implementation deltas', 'ablation plan'],
  },
  {
    id: 'browser-research',
    name: 'Browser Research',
    trigger: 'A dependency, benchmark, paper page, issue, model card or dataset page must be checked.',
    purpose:
      'Fetch external evidence through a browser-capable adapter and record citations, hashes and timestamps.',
    outputs: ['source notes', 'download plan', 'citation ledger', 'risk flags'],
  },
  {
    id: 'reproduction-runner',
    name: 'Reproduction Runner',
    trigger: 'A project, benchmark or generated artifact needs execution.',
    purpose:
      'Run install, baseline, evaluation and clean-room commands through a declared runner contract.',
    outputs: ['runner log', 'exit status', 'metric trace', 'artifact hashes'],
  },
  {
    id: 'repair-loop',
    name: 'Repair Loop',
    trigger: 'Builds, tests, benchmarks or reproductions fail.',
    purpose:
      'Map failure evidence to minimal patches, rerun affected checks and keep repair history attached.',
    outputs: ['failure map', 'patch plan', 'rerun commands', 'regression notes'],
  },
  {
    id: 'sota-blueprint',
    name: 'SOTA Blueprint',
    trigger: 'The system has enough context to produce a project route.',
    purpose:
      'Generate one executable SOTA-seeking project blueprint under hard truthfulness constraints.',
    outputs: ['architecture', 'training plan', 'loss design', 'ablation plan', 'optimization bounds'],
  },
  {
    id: 'fresh-verifier',
    name: 'Fresh Verifier',
    trigger: 'A result, patch, report or optimization candidate is about to be accepted.',
    purpose:
      'Independently audit diffs, logs, configs, metrics and artifact lineage before promotion.',
    outputs: ['verdict', 'gate failures', 'rerun requirements', 'audit report'],
  },
  {
    id: 'skill-authoring',
    name: 'Skill Authoring',
    trigger: 'A needed capability does not exist yet or should become reusable.',
    purpose:
      'Scaffold a skill or MCP adapter with manifest, trigger, permissions, tests and usage contract.',
    outputs: ['skill manifest', 'adapter skeleton', 'test contract', 'install plan'],
  },
]
