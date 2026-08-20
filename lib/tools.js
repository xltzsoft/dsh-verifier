/**
 * dsh-verifier — agent tools: the DSH-native counterpart of the
 * `llm-verifier` CLI. Every tool drives the same sidecar (the unmodified
 * LLM-as-a-Verifier framework) the web GUI uses, so a backend configured in
 * the GUI is immediately operable by any agent, and vice versa.
 */

import { loadConfig, publicConfig, saveConfig } from './store.js'
import { sidecarManager } from './sidecar.js'
import { venvManager } from './venv.js'
import { runScoringJob } from './routes.js'
import { agentPipelineSnapshot } from './agent-pipeline.js'

/**
 * Compile DSH's concise property-map schema into the registry's plain JSON
 * Schema shape. Keeping tool definitions as plain data avoids installing a
 * second @deepseek-ai/dsh-tools runtime into the web profile: that package
 * owns a private scheduler Symbol, so a duplicate copy can shadow the host
 * registry and make every preset tool fail before dispatch.
 */
function compileSchema(spec = {}) {
  const out = {}
  if (spec.description !== undefined) out.description = spec.description
  if (spec.title !== undefined) out.title = spec.title
  if (spec.default !== undefined) out.default = spec.default
  if (spec.examples !== undefined) out.examples = spec.examples
  if (spec.oneOf !== undefined) {
    out.oneOf = spec.oneOf.map(compileSchema)
    return out
  }
  if (spec.type !== undefined && spec.type !== 'json') out.type = spec.type
  if (spec.enum !== undefined) out.enum = [...spec.enum]
  if (spec.const !== undefined) out.const = spec.const
  if (spec.items !== undefined) out.items = compileSchema(spec.items)
  if (spec.properties !== undefined) {
    out.properties = {}
    const required = []
    for (const [name, property] of Object.entries(spec.properties)) {
      out.properties[name] = compileSchema(property)
      if (property.required === true) required.push(name)
    }
    if (required.length) out.required = required
  }
  if (spec.additionalProperties !== undefined) {
    out.additionalProperties = spec.additionalProperties
  }
  return out
}

function defineTool(options) {
  const properties = {}
  const required = []
  for (const [name, spec] of Object.entries(options.parameters ?? {})) {
    properties[name] = compileSchema(spec)
    if (spec.required === true) required.push(name)
  }
  return {
    name: options.name,
    description: options.description,
    parameters: {
      type: 'object',
      properties,
      ...(required.length ? { required } : {}),
    },
    output: {
      schema: compileSchema(options.output.schema),
      render: options.output.render,
    },
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
    execute: options.execute,
  }
}

/** One text content block (the only render shape these tools emit). */
function text(value) {
  return [{ type: 'text', text: value }]
}

const fmt = (v, digits = 4) => (typeof v === 'number' ? v.toFixed(digits) : String(v))

function usageLine(usage) {
  if (!usage) return ''
  return `usage: ${usage.calls} calls, in=${usage.input_tokens} (cached ${usage.cached_input_tokens}, hit ${(usage.cache_hit_rate * 100).toFixed(1)}%), out=${usage.output_tokens} (reasoning ${usage.reasoning_tokens})`
}

function jobError(job) {
  return [
    `[status: ${job.status}]`,
    job.error ? 'error: ' + job.error : '',
    usageLine(job.usage),
  ].filter(Boolean).join('\n')
}

/** Resolve criteria arg the way the framework does: bundled name, file
 *  path, {name: description} object, or list of strings. */
function criteriaArg(value) {
  if (value === undefined || value === null || value === '') return undefined
  if (typeof value === 'string') {
    const trimmed = value.trim()
    if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
      try { return JSON.parse(trimmed) } catch { /* treat it as a path/name */ }
    }
    return value
  }
  if (Array.isArray(value)) return value
  if (typeof value === 'object') return value
  return undefined
}

/** verifier_status — environment + backend + usage at a glance. */
export function verifierStatusTool() {
  return defineTool({
    name: 'verifier_status',
    description: 'Status of the dsh-verifier verifier (LLM-as-a-Verifier framework): python venv state, sidecar state, ' +
      'resolved verifier backend/model, token usage. Call this before first use or when a verifier call fails. ' +
      'Triggers: verifier, verifier, LLM-as-a-Verifier, 验证器.',
    timeoutMs: 30_000,
    parameters: {},
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          venv: { type: 'json', description: 'Python venv state snapshot (state, frameworkVersion?, error?).' },
          sidecar: { type: 'json', description: 'Sidecar state snapshot (state, port?, uptimeSec?, error?).' },
          backend: { type: 'json', description: 'Resolved verifier backend (backend, model, effort, key sources, ready); null when the sidecar is down.' },
          usage: { type: 'json', description: 'Process-wide token accounting; null when the sidecar is down.' },
          config: { type: 'json', description: 'Current config with secrets masked.' },
          agentPipeline: { type: 'json', description: 'Automatic TurboAgent pipeline counters and the most recent selection.' },
        },
      },
      render: (_args, v) => text([
        `venv: ${v.venv.state}${v.venv.frameworkVersion ? ' (llm-verifier ' + v.venv.frameworkVersion + ')' : ''}`,
        `sidecar: ${v.sidecar.state}${v.sidecar.port ? ' port=' + v.sidecar.port : ''}${v.sidecar.uptimeSec ? ' uptime=' + v.sidecar.uptimeSec + 's' : ''}`,
        v.sidecar.error ? 'sidecar error: ' + v.sidecar.error : '',
        v.venv.error ? 'venv error: ' + v.venv.error : '',
        v.backend
          ? `backend: ${v.backend.backend} model=${v.backend.model} effort=${v.backend.effort} key=${v.backend.deepseekKeySource || v.backend.openaiKeySource || v.backend.vertexKeySource} ready=${v.backend.ready}`
          : 'backend: sidecar not running',
        `agent pipeline: enabled=${v.config.agent?.enabled !== false} requests=${v.agentPipeline.requests} candidates=${v.agentPipeline.candidateCalls} selections=${v.agentPipeline.verifierSelections + v.agentPipeline.majoritySelections} fallbacks=${v.agentPipeline.fallbacks}`,
        v.agentPipeline.last
          ? `last pipeline: session=${v.agentPipeline.last.sessionId} status=${v.agentPipeline.last.status} method=${v.agentPipeline.last.method ?? '-'} best=${v.agentPipeline.last.bestIndex ?? '-'}`
          : '',
        v.usage ? usageLine(v.usage) : '',
      ].filter(Boolean).join('\n')),
    },
    async execute() {
      await venvManager.check().catch(() => {})
      const cfg = await loadConfig()
      let backend = null
      let usage = null
      if (sidecarManager.state === 'running') {
        try {
          backend = await sidecarManager.call('GET', '/backend', null, 5_000)
          usage = await sidecarManager.call('GET', '/usage', null, 5_000)
        } catch { /* ok */ }
      }
      return {
        venv: venvManager.snapshot(),
        sidecar: sidecarManager.snapshot(),
        backend,
        usage,
        config: publicConfig(cfg),
        agentPipeline: agentPipelineSnapshot(),
      }
    },
  })
}

/** verifier_compare — one directed pairwise fine-grained comparison. */
export function verifierCompareTool() {
  return defineTool({
    name: 'verifier_compare',
    description: 'Pairwise LLM-as-a-Verifier comparison of two candidates for one task (fine-grained logprob rewards in [0,1] ' +
      'plus Bradley-Terry win probability). Candidate values are inline text or paths to trajectory files. ' +
      'A failed verifier call raises; use verifier_select for best-of-N. Triggers: compare two solutions, 对比两个候选.',
    timeoutMs: 15 * 60_000,
    parameters: {
      problem: { type: 'string', required: true, description: 'The task description the candidates attempted.' },
      candidate_a: { type: 'string', required: true, description: 'Candidate A (inline text or a file path) in slot A.' },
      candidate_b: { type: 'string', required: true, description: 'Candidate B (inline text or a file path) in slot B.' },
      criteria: { type: 'json', description: 'Bundled criteria name, .md criteria path, {name: description}, or a list of criteria. Default: overall correctness.' },
      images: { type: 'array', items: { type: 'json' }, description: 'Optional multimodal context: image paths/URLs or {path|url|base64} objects.' },
      ground_truth_note: { type: 'string', description: 'Optional trusted ground-truth/context note shown on every evaluation.' },
      n_evaluations: { type: 'integer', description: 'Repeated verifications K per criterion (default 1).' },
      model: { type: 'string', description: 'Verifier model ID for this call; overrides verifier_config.model.' },
      max_workers: { type: 'integer', description: 'Maximum parallel verifier calls; default is backend-specific.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          status: { type: 'string', description: 'done | error | canceled | timeout.' },
          reward_a: { type: 'number', description: 'Fine-grained reward for candidate A in [0,1].' },
          reward_b: { type: 'number', description: 'Fine-grained reward for candidate B in [0,1].' },
          winner: { type: 'string', description: 'a | b | tie.' },
          p_a_wins: { type: 'number', description: 'Bradley-Terry probability that A beats B.' },
          usage: { type: 'json', description: 'Token accounting for this comparison.' },
          error: { oneOf: [{ type: 'string' }, { type: 'null' }], description: 'Error message when status is not done (null when still running at timeout).' },
        },
      },
      render: (_args, v) => v.status === 'done'
        ? text([
          `[status: done]`,
          `reward_a=${fmt(v.reward_a)}  reward_b=${fmt(v.reward_b)}`,
          `winner: ${v.winner}  p(a wins) = ${fmt(v.p_a_wins)}`,
          usageLine(v.usage),
        ].join('\n'))
        : text(jobError(v)),
    },
    async execute(args) {
      const payload = {
        problem: args.problem,
        candidate_a: args.candidate_a,
        candidate_b: args.candidate_b,
        criteria: criteriaArg(args.criteria),
        images: args.images,
        ground_truth_note: args.ground_truth_note,
        n_evaluations: args.n_evaluations ?? 1,
        model: args.model,
        max_workers: args.max_workers,
      }
      const job = await runScoringJob('compare', payload, { waitMs: 14 * 60_000 })
      if (job.status !== 'done') return { status: job.status, error: job.error, usage: job.usage }
      return { status: 'done', ...job.result }
    },
  })
}

/** verifier_select — best-of-N via the Probabilistic Pivot Tournament. */
export function verifierSelectTool() {
  return defineTool({
    name: 'verifier_select',
    description: 'Select the best of N agent trajectories for one task using the LLM-as-a-Verifier framework ' +
      '(fine-grained logprob reward + Probabilistic Pivot Tournament, O(Nk) comparisons). Candidate values are ' +
      'inline text or paths to trajectory files. Returns the ranking, per-candidate mean preference, and token usage. ' +
      'Identical inputs with the same seed run the identical tournament. Triggers: best of N, select best trajectory, 择优, 锦标赛.',
    timeoutMs: 30 * 60_000,
    parameters: {
      problem: { type: 'string', required: true, description: 'The task description the candidates attempted.' },
      candidates: { type: 'array', required: true, items: { type: 'string' }, description: 'N candidates (inline trajectories or file paths).' },
      criteria: { type: 'json', description: 'Bundled criteria name, .md criteria path, {name: description}, or a list. Default: overall correctness.' },
      images: { type: 'array', items: { type: 'json' }, description: 'Optional multimodal context: image paths/URLs or {path|url|base64} objects.' },
      ground_truth_note: { type: 'string', description: 'Optional trusted ground-truth/context note shown on every evaluation.' },
      n_evaluations: { type: 'integer', description: 'Repeated verifications K per criterion (default 4; the framework default).' },
      pivots: { type: 'integer', description: 'Pivot count k; cost grows as O(Nk) (default 2).' },
      seed: { type: 'integer', description: 'Ring-pass RNG seed (default 0; fixed seed = reproducible tournament).' },
      model: { type: 'string', description: 'Verifier model ID for this call; overrides verifier_config.model.' },
      max_workers: { type: 'integer', description: 'Maximum parallel verifier calls; default is backend-specific.' },
      cache: { type: 'string', description: 'Optional JSON score-cache path. Identical directed comparisons are reused.' },
      on_error: { type: 'string', enum: ['tie', 'raise'], description: 'Verifier-failure policy: tie (default) or raise.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          status: { type: 'string', description: 'done | error | canceled | timeout.' },
          index: { type: 'integer', description: '0-based index of the chosen candidate.' },
          scores: { type: 'array', items: { type: 'number' }, description: 'Bradley-Terry score per candidate, in input order.' },
          ranking: { type: 'array', items: { type: 'integer' }, description: 'Candidate indices ordered best-first.' },
          n_comparisons: { type: 'integer', description: 'Verifier comparisons actually run.' },
          criteria: { type: 'array', items: { type: 'string' }, description: 'Criteria ids used.' },
          usage: { type: 'json', description: 'Token accounting for this selection.' },
          error: { oneOf: [{ type: 'string' }, { type: 'null' }], description: 'Error message when status is not done.' },
        },
      },
      render: (_args, v) => v.status === 'done'
        ? text([
          `[status: done] best = candidate #${v.index} (1-based ${v.index + 1})`,
          'ranking: ' + v.ranking.map(i => `#${i + 1}(${fmt(v.scores[i], 3)})`).join(' > '),
          `comparisons: ${v.n_comparisons}  criteria: ${v.criteria.join(',')}`,
          usageLine(v.usage),
        ].join('\n'))
        : text(jobError(v)),
    },
    async execute(args) {
      const payload = {
        problem: args.problem,
        candidates: args.candidates,
        criteria: criteriaArg(args.criteria),
        images: args.images,
        ground_truth_note: args.ground_truth_note,
        n_evaluations: args.n_evaluations ?? 4,
        pivots: args.pivots ?? 2,
        seed: args.seed ?? 0,
        model: args.model,
        max_workers: args.max_workers,
        cache: args.cache,
        on_error: args.on_error ?? 'tie',
      }
      const job = await runScoringJob('select', payload, { waitMs: 28 * 60_000 })
      if (job.status !== 'done') return { status: job.status, error: job.error, usage: job.usage }
      return { status: 'done', ...job.result }
    },
  })
}

/** verifier_track — offline progress tracking over checkpoints. */
export function verifierTrackTool() {
  return defineTool({
    name: 'verifier_track',
    description: 'Offline progress tracking: score how the trajectory\'s state would satisfy the task at each checkpoint step ' +
      '(A=0%..T=100% letter scale decoded from logprob expectations; a continuous 0..1 progress curve). Steps are inline ' +
      'text or file paths. For live step-by-step tracking while an agent runs, use verifier_tracker instead. ' +
      'Triggers: progress curve, 进度跟踪, 每一步完成度.',
    timeoutMs: 20 * 60_000,
    parameters: {
      problem: { type: 'string', required: true, description: 'The task description.' },
      steps: { type: 'array', required: true, items: { type: 'string' }, description: 'The agent steps (inline text or file paths), in order.' },
      images: { type: 'array', items: { type: 'json' }, description: 'Optional multimodal task context: image paths/URLs or {path|url|base64} objects.' },
      checkpoint_steps: { type: 'array', items: { type: 'integer' }, description: '1-based step numbers to score; default follows the official framework.' },
      n_evaluations: { type: 'integer', description: 'Repeated verifications K per checkpoint (default 1).' },
      model: { type: 'string', description: 'Verifier model ID for this call; overrides verifier_config.model.' },
      max_workers: { type: 'integer', description: 'Maximum parallel verifier calls; default is backend-specific.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          status: { type: 'string', description: 'done | error | canceled | timeout.' },
          steps: { type: 'array', items: { type: 'integer' }, description: '1-based step numbers scored.' },
          scores: { type: 'array', items: { type: 'number' }, description: 'Progress score per step, in [0,1].' },
          per_rep_scores: { type: 'json', description: 'Per-evaluation repeat scores keyed by step.' },
          final: { type: 'number', description: 'Final progress score.' },
          usage: { type: 'json', description: 'Token accounting for this tracking run.' },
          error: { oneOf: [{ type: 'string' }, { type: 'null' }], description: 'Error message when status is not done.' },
        },
      },
      render: (_args, v) => v.status === 'done'
        ? text([
          `[status: done]`,
          'curve: ' + v.steps.map((s, i) => `step${s}=${fmt(v.scores[i], 3)}`).join(' '),
          `final=${fmt(v.final)}`,
          usageLine(v.usage),
        ].join('\n'))
        : text(jobError(v)),
    },
    async execute(args) {
      const payload = {
        problem: args.problem,
        steps: args.steps,
        images: args.images,
        checkpoint_steps: args.checkpoint_steps,
        n_evaluations: args.n_evaluations ?? 1,
        model: args.model,
        max_workers: args.max_workers,
      }
      const job = await runScoringJob('track', payload, { waitMs: 18 * 60_000 })
      if (job.status !== 'done') return { status: job.status, error: job.error, usage: job.usage }
      return { status: 'done', ...job.result }
    },
  })
}

/** verifier_tracker — online ProgressTracker (start / update / result / stop). */
export function verifierTrackerTool() {
  const trackerCall = async (method, path, body, timeoutMs) => {
    await sidecarManager.ensure()
    return sidecarManager.call(method, path, body, timeoutMs)
  }
  return defineTool({
    name: 'verifier_tracker',
    description: 'Online progress tracking with a persistent ProgressTracker: start for a problem, then feed each agent step ' +
      'as it happens (the verifier only sees the prefix, so it cannot peek at the future); result for the final curve; stop to ' +
      'release. Use verifier_track for a finished trajectory instead. Triggers: live progress, 实时进度.',
    timeoutMs: 10 * 60_000,
    parameters: {
      action: { type: 'string', enum: ['start', 'update', 'result', 'stop'], required: true, description: 'Tracker lifecycle action.' },
      problem: { type: 'string', description: 'Task description (action=start only).' },
      tracker_id: { type: 'string', description: 'Tracker id from start (update/result/stop).' },
      step: { type: 'string', description: 'The next agent step (action=update).' },
      images: { type: 'array', items: { type: 'json' }, description: 'Task images on start, or per-step images on update.' },
      n_evaluations: { type: 'integer', description: 'K repeats per step (start, default 1).' },
      model: { type: 'string', description: 'Verifier model ID (start only); overrides verifier_config.model.' },
      max_workers: { type: 'integer', description: 'Maximum parallel verifier calls (start only).' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', description: 'false when the action failed.' },
          action: { type: 'string', description: 'The action that was requested: start | update | result | stop.' },
          tracker_id: { type: 'string', description: 'Tracker id (start only).' },
          step: { type: 'integer', description: 'Step number just scored (update only).' },
          score: { type: 'number', description: 'Progress score for the step (update only).' },
          steps: { type: 'array', items: { type: 'integer' }, description: 'Step numbers scored (result only).' },
          scores: { type: 'array', items: { type: 'number' }, description: 'Progress score per step (result only).' },
          per_rep_scores: { type: 'json', description: 'Raw score curves for each repeat (result only).' },
          final: { type: 'number', description: 'Final progress score (result only).' },
          usage: { type: 'json', description: 'Token accounting for the update (update only).' },
          error: { type: 'string', description: 'Error message when ok is false.' },
        },
      },
      render: (_args, v) => text(v.ok === false
        ? `[status: error] ${v.error}`
        : v.action === 'start'
          ? `[status: started] tracker_id=${v.tracker_id}`
          : v.action === 'update'
            ? `[status: step ${v.step}] score=${fmt(v.score)}`
            : v.action === 'result'
              ? `[status: result] final=${fmt(v.final)} curve: ` + (v.steps ?? []).map((s, i) => `${s}=${fmt(v.scores[i], 3)}`).join(' ')
              : '[status: stopped]'),
    },
    async execute(args) {
      try {
        if (args.action === 'start') {
          if (!args.problem) throw new Error('problem is required for start')
          const out = await trackerCall('POST', '/tracker/start', {
            problem: args.problem,
            images: args.images,
            n_evaluations: args.n_evaluations ?? 1,
            model: args.model,
            max_workers: args.max_workers,
          }, 60_000)
          return { ok: true, action: args.action, tracker_id: out.tracker_id }
        }
        if (!args.tracker_id) throw new Error('tracker_id is required for this action')
        if (args.action === 'update') {
          if (typeof args.step !== 'string') throw new Error('step is required for update')
          const out = await trackerCall('POST', '/tracker/update', {
            tracker_id: args.tracker_id,
            step: args.step,
            images: args.images,
          }, 9 * 60_000)
          return { ok: true, action: args.action, step: out.step, score: out.score, usage: out.usage }
        }
        if (args.action === 'result') {
          const out = await trackerCall('GET', `/tracker/result?tracker_id=${encodeURIComponent(args.tracker_id)}`, null, 30_000)
          return {
            ok: true, action: args.action, steps: out.steps, scores: out.scores,
            per_rep_scores: out.per_rep_scores, final: out.final,
          }
        }
        if (args.action === 'stop') {
          await trackerCall('DELETE', `/tracker?tracker_id=${encodeURIComponent(args.tracker_id)}`, null, 30_000)
          return { ok: true, action: args.action }
        }
        throw new Error(`unknown action ${args.action}`)
      } catch (error) {
        return { ok: false, action: args.action, error: error.message }
      }
    },
  })
}

/** verifier_benchmark — run one of the bundled benchmark evaluations. */
export function verifierBenchmarkTool() {
  return defineTool({
    name: 'verifier_benchmark',
    description: 'Run a bundled LLM-as-a-Verifier benchmark evaluation (terminal_bench 2.0, terminal_bench_2.1, swe_bench, ' +
      'medagentbench) with presets full|bo3|bo5 (bo3/bo5 = the paper\'s best-of-3/5 reproduction settings). Requires the ' +
      'benchmark data (verifier_data download). Reports Pass@1 vs LLM-as-a-Verifier vs Oracle, per-task winners, and token usage. ' +
      'Expensive: makes real verifier calls for every swing task. Triggers: run benchmark, 跑基准, SWE-Bench, Terminal-Bench.',
    timeoutMs: 60 * 60_000,
    parameters: {
      name: { type: 'string', enum: ['terminal_bench', 'terminal_bench_2.1', 'swe_bench', 'medagentbench'], required: true, description: 'Official bundled benchmark.' },
      preset: { type: 'string', enum: ['full', 'bo3', 'bo5'], description: 'Reproduction preset (default full).' },
      n_trials: { type: 'integer', description: 'Truncate to the first N trials per task (overrides preset).' },
      n_evaluations: { type: 'integer', description: 'Repeated verifications K (overrides preset).' },
      pivots: { type: 'integer', description: 'Pivot count k (overrides preset).' },
      seed: { type: 'integer', description: 'Ring-pass RNG seed (default: the benchmark\'s own).' },
      model: { type: 'string', description: 'Verifier model ID for this run; overrides verifier_config.model.' },
      max_workers: { type: 'integer', description: 'Maximum parallel verifier calls; default is benchmark/backend-specific.' },
      on_error: { type: 'string', enum: ['tie', 'raise'], description: 'Verifier-failure policy (default tie).' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          status: { type: 'string', description: 'done | error | canceled | timeout.' },
          benchmark: { type: 'string', description: 'Benchmark key (e.g. terminal_bench).' },
          title: { type: 'string', description: 'Human-readable benchmark name.' },
          model: { type: 'string', description: 'Configured verifier model for the run.' },
          preset: { type: 'string', description: 'Preset used: full | bo3 | bo5.' },
          n_tasks: { type: 'integer', description: 'Total tasks in the benchmark.' },
          n_runs: { type: 'integer', description: 'Trials per task.' },
          n_swing: { type: 'integer', description: 'Tasks where the best trial was not trivially the only pass.' },
          pass1: { type: 'json', description: 'Pass@1 as {count, rate}.' },
          verifier: { type: 'json', description: 'LLM-as-a-Verifier as {count, rate}.' },
          oracle: { type: 'json', description: 'Oracle (best-of-N) as {count, rate}.' },
          avg_comparisons_per_task: { type: 'number', description: 'Mean verifier comparisons per task.' },
          comparisons: { type: 'integer', description: 'Total verifier comparisons run.' },
          per_task: { type: 'json', description: 'Per-task winner details (task, n_trials, best, winner_trial, hit, mean_preference, pivots).' },
          report: { type: 'string', description: 'Formatted plain-text report.' },
          results_file: { type: 'string', description: 'Path of the persisted results file.' },
          usage: { type: 'json', description: 'Token accounting for the run.' },
          error: { oneOf: [{ type: 'string' }, { type: 'null' }], description: 'Error message when status is not done.' },
        },
      },
      render: (_args, v) => v.status === 'done'
        ? text([
          `[status: done] ${v.title ?? v.benchmark}`,
          `Pass@1 ${v.pass1.rate.toFixed(1)}%   LLM-as-a-Verifier ${v.verifier.rate.toFixed(1)}%   Oracle ${v.oracle.rate.toFixed(1)}%`,
          `tasks=${v.n_tasks} swing=${v.n_swing} N=${v.n_runs} avg comparisons/task=${v.avg_comparisons_per_task}`,
          'winners: ' + (v.per_task ?? []).map(t =>
            `${t.task}: trial#${t.best + 1}${t.hit ? ' (hit)' : ' (miss)'}`).join('; ').slice(0, 1200),
          usageLine(v.usage),
        ].join('\n'))
        : text(jobError(v)),
    },
    async execute(args) {
      const payload = {
        name: args.name,
        preset: args.preset ?? 'full',
        n_trials: args.n_trials,
        n_evaluations: args.n_evaluations,
        pivots: args.pivots,
        seed: args.seed,
        model: args.model,
        max_workers: args.max_workers,
        on_error: args.on_error ?? 'tie',
      }
      const job = await runScoringJob('benchmark', payload, { waitMs: 55 * 60_000 })
      if (job.status !== 'done') return { status: job.status, error: job.error, usage: job.usage }
      return { status: 'done', ...job.result }
    },
  })
}

/** verifier_usage — token accounting snapshot / reset. */
export function verifierUsageTool() {
  return defineTool({
    name: 'verifier_usage',
    description: 'Token accounting for the verifier sidecar (process-wide: input / cached-input / output / reasoning tokens ' +
      'and the prefix-cache hit rate). Pass reset=true to zero the counters. Triggers: verifier token usage, 验证器 token 用量.',
    timeoutMs: 30_000,
    parameters: {
      reset: { type: 'boolean', description: 'Reset the counters after reading (default false).' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          usage: { type: 'json', description: 'Token accounting (calls, input/cached/uncached, output, reasoning tokens, cache_hit_rate).' },
        },
      },
      render: (_args, v) => text(`[status: ok]` + '\n' + usageLine(v.usage)),
    },
    async execute(args) {
      await sidecarManager.ensure()
      let usage = await sidecarManager.call('GET', '/usage', null, 10_000)
      if (args.reset) usage = await sidecarManager.call('POST', '/usage/reset', {}, 10_000)
      return { usage }
    },
  })
}

/** verifier_config — read / patch the verifier configuration. */
export function verifierConfigTool() {
  return defineTool({
    name: 'verifier_config',
    description: 'Read or patch the verifier configuration. backend is auto|deepseek|openai|vertex; model is any backend model ID. ' +
      'agent configures the automatic TurboAgent path: enabled, numCandidates, optional heterogeneous DSH models ' +
      '[{provider,model,numCandidates,reasoningEffort,temperature,maxTokens}], majorityVoting, pivots, nVerifications, ' +
      'criteria, verifierModel, progressMonitor, and optional context refinement. Also supports effort, ' +
      'maxTokens, openaiBaseURL/openaiApiKey/deepseekApiKey/vertexApiKey and dataDir. Keys may also come from the environment ' +
      'or ~/.dsh/.credentials.yaml; an explicit patch value wins. Patches apply to the next verifier call, no restart needed. ' +
      'Triggers: verifier backend, 配置验证器.',
    timeoutMs: 30_000,
    parameters: {
      patch: { type: 'object', additionalProperties: true, description: 'Partial config to merge (omit to only read).' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          config: { type: 'json', description: 'Config with secrets masked.' },
          backend: { type: 'json', description: 'Resolved verifier backend; null when the sidecar is down.' },
        },
      },
      render: (_args, v) => text([
        `[status: ok] config (secrets masked):`,
        JSON.stringify(v.config, null, 1),
        v.backend ? `resolved backend: ${v.backend.backend} model=${v.backend.model} ready=${v.backend.ready}` : '',
      ].filter(Boolean).join('\n')),
    },
    async execute(args) {
      const next = args.patch ? await saveConfig(args.patch) : await loadConfig()
      let backend = null
      if (sidecarManager.state === 'running') {
        try { backend = await sidecarManager.call('GET', '/backend', null, 5_000) } catch { /* ok */ }
      }
      return { config: publicConfig(next), backend }
    },
  })
}

/** verifier_data — benchmark data download / status. */
export function verifierDataTool() {
  return defineTool({
    name: 'verifier_data',
    description: 'Benchmark data for the bundled evaluations (the framework repo, ~350 MB one-time git clone to ' +
      '~/.dsh/verifier/data). action=status reports presence; action=download starts the clone job and waits. ' +
      'Triggers: benchmark data, 下载基准数据.',
    timeoutMs: 30 * 60_000,
    parameters: {
      action: { type: 'string', enum: ['status', 'download'], required: true, description: 'Inspect or download the pinned benchmark checkout.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          status: { type: 'string', description: 'ok | done | error | timeout | canceled.' },
          dataDir: { oneOf: [{ type: 'string' }, { type: 'null' }], description: 'Benchmark data directory (absent when the download failed before starting).' },
          hasData: { type: 'boolean', description: 'Whether the benchmark data is present (status/download success).' },
          exactCheckout: { type: 'boolean', description: 'Whether data matches the pinned upstream commit.' },
          commit: { oneOf: [{ type: 'string' }, { type: 'null' }], description: 'Framework checkout commit when available.' },
          note: { type: 'string', description: 'Extra note, e.g. sidecar-down fallback for status.' },
          error: { oneOf: [{ type: 'string' }, { type: 'null' }], description: 'Error message when status is not ok/done.' },
        },
      },
      render: (_args, v) => v.status === 'done' || v.status === 'ok'
        ? text(`[status: ${v.status}] dataDir=${v.dataDir} hasData=${v.hasData}`)
        : text(`[status: ${v.status}] ${v.error ?? ''}`),
    },
    async execute(args) {
      if (args.action === 'status') {
        await sidecarManager.ensure().catch(() => {})
        try {
          const info = await sidecarManager.call('GET', '/benchmarks', null, 10_000)
          return {
            status: 'ok', dataDir: info.dataDir, hasData: Boolean(info.hasData),
            exactCheckout: Boolean(info.exactCheckout), commit: info.checkoutCommit ?? null,
          }
        } catch {
          const cfg = await loadConfig()
          const dir = cfg.dataDir || '~/.dsh/verifier/data'
          return {
            status: 'ok', dataDir: dir, hasData: false, exactCheckout: false,
            commit: null, note: 'sidecar down; dataDir as configured',
          }
        }
      }
      if (args.action === 'download') {
        const job = await runScoringJob('data-download', {}, { waitMs: 28 * 60_000 })
        if (job.status !== 'done') return { status: job.status, error: job.error }
        return {
          status: 'done', dataDir: job.result?.dataDir ?? null, hasData: true,
          exactCheckout: true, commit: job.result?.commit ?? null,
        }
      }
      return { status: 'error', error: `unknown action ${args.action}` }
    },
  })
}

/** All verifier tools, in registration order. */
export function allTools() {
  return [
    verifierStatusTool(),
    verifierCompareTool(),
    verifierSelectTool(),
    verifierTrackTool(),
    verifierTrackerTool(),
    verifierBenchmarkTool(),
    verifierUsageTool(),
    verifierConfigTool(),
    verifierDataTool(),
  ]
}
