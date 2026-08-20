/**
 * DSH-native TurboAgent pipeline.
 *
 * The upstream TurboAgent proxy wraps every model step as:
 *   optional context refinement -> N parallel/sequential completions -> majority vote
 *   or llm-verifier PPT selection -> selected response -> async progress score.
 *
 * This module implements the same control flow at DSH's provider-neutral
 * `llm/stream` seam.  Candidate generation therefore keeps DSH's native tool
 * schemas, multimodal messages, retry policy, provider routing and streaming
 * chunk vocabulary; scoring is still delegated to the pinned, unmodified
 * upstream llm-verifier process.
 */

import { randomUUID } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { loadConfig, STATE_ROOT } from './store.js'
import { runScoringJob } from './routes.js'
import {
  actionPreview,
  pipelineCandidateUpdate,
  pipelineSnapshot,
  pipelineStart,
  pipelineUpdate,
} from './pipeline-state.js'

const PIPELINE_LOG_DIR = join(STATE_ROOT, 'pipeline')
const BYPASS_SYMBOL = Symbol.for('dsh-verifier.agent-pipeline-bypass')
const bypass = globalThis[BYPASS_SYMBOL] ??= new WeakSet()

const statistics = {
  requests: 0,
  candidateCalls: 0,
  verifierSelections: 0,
  majoritySelections: 0,
  fallbacks: 0,
  last: null,
}

function integer(value, fallback, minimum = 1) {
  const n = Number(value)
  return Number.isInteger(n) && n >= minimum ? n : fallback
}

function currentPreset(agent) {
  const events = agent?.session?.events ?? []
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]
    if (event?.type === 'agent-preset/selected' && event.data?.agentPreset) {
      return event.data.agentPreset
    }
  }
  return agent?.session?.header?.agentPreset
}

export function isVerifierAgent(agent) {
  return currentPreset(agent) === 'verifier'
}

function blockText(block) {
  if (!block || typeof block !== 'object') return ''
  if (block.type === 'text') return block.text ?? ''
  if (block.type === 'tool-result') {
    const text = (block.content ?? []).map(blockText).filter(Boolean).join('\n')
    return `[tool_result: ${text}]`
  }
  return ''
}

function messageText(message) {
  return (message?.content ?? []).map(blockText).filter(Boolean).join('\n')
}

/** Match TurboAgent Backend.format_history, including DSH's separate system slot. */
export function formatHistory(options) {
  const parts = []
  if (options.system) parts.push(`SYSTEM: ${options.system}`)
  for (const message of options.messages ?? []) {
    const content = messageText(message)
    if (content) parts.push(`${String(message.role ?? 'unknown').toUpperCase()}: ${content}`)
  }
  return parts.join('\n\n')
}

function endedBlocks(chunks) {
  return chunks
    .filter(chunk => chunk?.type === 'block-end' && chunk.block)
    .sort((a, b) => a.index - b.index)
    .map(chunk => chunk.block)
}

/** Match TurboAgent Backend.format_action: visible text plus serialized tool calls. */
export function formatAction(chunks) {
  const parts = []
  for (const block of endedBlocks(chunks)) {
    if (block.type === 'text' && block.text) parts.push(block.text)
    if (block.type === 'tool-call') {
      parts.push(`[tool_call: ${block.name ?? ''}(${block.arguments ?? ''})]`)
    }
  }
  return parts.join('\n') || '(empty response)'
}

function finishOf(chunks) {
  for (let index = chunks.length - 1; index >= 0; index -= 1) {
    if (chunks[index]?.type === 'finish') return chunks[index]
  }
  return null
}

function usageOf(chunks) {
  for (let index = chunks.length - 1; index >= 0; index -= 1) {
    if (chunks[index]?.type === 'usage') return chunks[index].usage
  }
  return null
}

async function collect(stream, entry) {
  const chunks = []
  try {
    for await (const chunk of stream) chunks.push(chunk)
    const finish = finishOf(chunks)
    const failed = !finish || ['error', 'aborted'].includes(finish.reason?.kind)
    return {
      entry,
      chunks,
      blocks: endedBlocks(chunks),
      action: formatAction(chunks),
      usage: usageOf(chunks),
      finish: finish?.reason ?? null,
      valid: !failed,
      error: failed ? finish?.reason?.failure?.message ?? 'candidate stream did not finish' : null,
    }
  } catch (error) {
    return {
      entry,
      chunks,
      blocks: endedBlocks(chunks),
      action: formatAction(chunks),
      usage: usageOf(chunks),
      finish: null,
      valid: false,
      error: `${error?.name ?? 'Error'}: ${error?.message ?? String(error)}`,
    }
  }
}

export function candidateEntries(options, agentConfig) {
  const configured = Array.isArray(agentConfig.models) ? agentConfig.models.filter(Boolean) : []
  const models = configured.length > 0
    ? configured
    : [{
      provider: options.provider,
      model: options.model,
      numCandidates: integer(agentConfig.numCandidates, 3),
      ...(agentConfig.reasoningEffort === undefined ? {} : { reasoningEffort: agentConfig.reasoningEffort }),
      ...(agentConfig.temperature === undefined ? {} : { temperature: agentConfig.temperature }),
      ...(agentConfig.maxTokens === undefined ? {} : { maxTokens: agentConfig.maxTokens }),
    }]
  const entries = []
  for (const spec of models) {
    const count = integer(spec.numCandidates, configured.length > 0 ? 1 : 3)
    for (let repeat = 0; repeat < count; repeat += 1) {
      entries.push({
        provider: spec.provider || options.provider,
        model: spec.model || options.model,
        ...((spec.reasoningEffort ?? agentConfig.reasoningEffort) === undefined ? {}
          : { reasoningEffort: spec.reasoningEffort ?? agentConfig.reasoningEffort }),
        ...((spec.temperature ?? agentConfig.temperature) === undefined ? {}
          : { temperature: spec.temperature ?? agentConfig.temperature }),
        ...((spec.maxTokens ?? agentConfig.maxTokens) === undefined ? {}
          : { maxTokens: spec.maxTokens ?? agentConfig.maxTokens }),
        repeat,
      })
    }
  }
  return entries
}

function candidateRequest(options, entry) {
  const request = {
    ...options,
    provider: entry.provider,
    model: entry.model,
  }
  for (const key of ['reasoningEffort', 'temperature', 'maxTokens']) {
    if (entry[key] !== undefined && entry[key] !== null) request[key] = entry[key]
    else if (entry[key] === null) delete request[key]
  }
  bypass.add(request)
  return request
}

async function callOnce(ctx, request, entry) {
  return collect(ctx.llm.stream(request), entry)
}

function majority(actions) {
  const counts = new Map()
  for (const action of actions) counts.set(action, (counts.get(action) ?? 0) + 1)
  let bestAction = ''
  let bestCount = 0
  for (const [action, count] of counts) {
    if (count > bestCount) [bestAction, bestCount] = [action, count]
  }
  if (bestCount <= actions.length / 2) return null
  return {
    index: actions.indexOf(bestAction),
    scores: actions.map(action => action === bestAction ? 1 : 0),
    count: bestCount,
  }
}

function plainConfig(agentConfig) {
  return JSON.parse(JSON.stringify(agentConfig))
}

function schedulingMode(agentConfig) {
  return agentConfig.candidateScheduling === 'sequential' ? 'sequential' : 'parallel'
}

async function savePipelineLog(log) {
  await mkdir(PIPELINE_LOG_DIR, { recursive: true })
  const path = join(PIPELINE_LOG_DIR, `${log.id}.json`)
  await writeFile(path, JSON.stringify(log, null, 2) + '\n', 'utf8')
  return path
}

async function updatePipelineLog(path, patch) {
  try {
    const log = JSON.parse(await readFile(path, 'utf8'))
    await writeFile(path, JSON.stringify({ ...log, ...patch }, null, 2) + '\n', 'utf8')
  } catch {
    // Observability must never change the selected model response.
  }
}

function selectedChunks(candidate, original) {
  if (candidate.entry.provider === original.provider && candidate.entry.model === original.model) {
    return candidate.chunks
  }
  // Replay state is adapter-private.  A heterogeneous winner cannot safely
  // attach one provider's opaque replay envelope to the original DSH route.
  return candidate.chunks.map(chunk => chunk?.type === 'finish' && chunk.replayState !== undefined
    ? { type: 'finish', reason: chunk.reason }
    : chunk)
}

function refinerRequest(options, model, prompt) {
  const request = {
    provider: model.provider || options.provider,
    model: model.model || options.model,
    messages: [{
      id: `verifier-context-${randomUUID()}`,
      role: 'user',
      content: [{ type: 'text', text: prompt }],
      source: { kind: 'user' },
    }],
    signal: options.signal,
    ...(model.reasoningEffort === undefined ? {} : { reasoningEffort: model.reasoningEffort }),
    ...(model.maxTokens === undefined ? {} : { maxTokens: model.maxTokens }),
  }
  bypass.add(request)
  return request
}

async function refineContext(ctx, options, contextConfig) {
  if (!contextConfig?.enabled || !contextConfig.model) return { options, log: { enabled: false } }
  const context = formatHistory(options)
  const prompt = String(contextConfig.prompt ?? '').replace('{context}', context)
  const result = await collect(
    ctx.llm.stream(refinerRequest(options, contextConfig.model, prompt)),
    contextConfig.model,
  )
  if (!result.valid || result.action === '(empty response)') {
    return { options, log: { enabled: true, error: result.error ?? 'empty refinement' } }
  }
  return {
    options: {
      ...options,
      system: `${result.action}\n\n${options.system ?? ''}`.trim(),
    },
    log: { enabled: true, model: contextConfig.model, refined: result.action, usage: result.usage },
  }
}

function spawnProgress(deps, problem, candidate, agentConfig, logPath, requestId) {
  const progress = agentConfig.progressMonitor
  if (!progress?.enabled) return
  pipelineUpdate(requestId, {
    progressMonitor: { enabled: true, status: 'running' },
  })
  const payload = {
    problem,
    steps: [candidate.action],
    n_evaluations: integer(progress.nVerifications, 1),
    ...(progress.model ? { model: progress.model } : {}),
    ...(agentConfig.maxWorkers ? { max_workers: agentConfig.maxWorkers } : {}),
  }
  Promise.resolve()
    .then(() => deps.track(payload))
    .then(job => {
      const result = job.status === 'done'
        ? { enabled: true, ...job.result }
        : { enabled: true, status: job.status, error: job.error }
      pipelineUpdate(requestId, { progressMonitor: result })
      if (logPath) return updatePipelineLog(logPath, { progressMonitor: result })
    })
    .catch(error => {
      const result = { enabled: true, status: 'error', error: error?.message ?? String(error) }
      pipelineUpdate(requestId, { progressMonitor: result })
      if (logPath) return updatePipelineLog(logPath, { progressMonitor: result })
    })
}

export function agentPipelineSnapshot() {
  return {
    ...JSON.parse(JSON.stringify(statistics)),
    pipeline: pipelineSnapshot(),
  }
}

/**
 * Execute one automatic TurboAgent-equivalent selection.  `deps` is injectable
 * so deterministic tests can prove orchestration without spending model tokens.
 */
export async function* turboAgentStream(ctx, original, agent, next, deps = {}) {
  const config = deps.config ?? await loadConfig()
  const agentConfig = config.agent ?? {}
  if (agentConfig.enabled === false || original.purpose) {
    yield* next()
    return
  }

  const entries = candidateEntries(original, agentConfig)
  if (entries.length <= 1) {
    yield* next()
    return
  }

  const select = deps.select ?? (payload => runScoringJob('select', payload, { waitMs: 28 * 60_000 }))
  const track = deps.track ?? (payload => runScoringJob('track', payload, { waitMs: 18 * 60_000 }))
  const saveLog = deps.saveLog === false ? null : (deps.saveLog ?? savePipelineLog)
  const now = Date.now()
  const requestId = `${now}-${randomUUID().slice(0, 8)}`
  const sessionId = String(agent?.id ?? original.sessionId ?? 'unknown')
  const scheduling = schedulingMode(agentConfig)
  statistics.requests += 1
  statistics.candidateCalls += entries.length
  statistics.last = { requestId, sessionId, status: 'generating', candidates: entries.length, startedAt: now }
  pipelineStart({
    id: requestId,
    sessionId,
    status: agentConfig.context?.enabled ? 'refining' : 'generating',
    scheduling,
    candidatesExpected: entries.length,
    candidates: entries.map((entry, index) => ({
      index,
      provider: entry.provider,
      model: entry.model,
      repeat: entry.repeat,
      reasoningEffort: entry.reasoningEffort,
      status: 'pending',
    })),
    contextRefinement: { enabled: Boolean(agentConfig.context?.enabled), status: 'pending' },
    selection: null,
    bestIndex: null,
    progressMonitor: {
      enabled: Boolean(agentConfig.progressMonitor?.enabled),
      status: agentConfig.progressMonitor?.enabled ? 'pending' : 'disabled',
    },
  })

  original.signal?.throwIfAborted?.()
  const refined = await refineContext(ctx, original, agentConfig.context)
  pipelineUpdate(requestId, {
    status: 'generating',
    contextRefinement: {
      ...refined.log,
      status: refined.log.error ? 'failed' : refined.log.enabled ? 'done' : 'disabled',
      refinedPreview: actionPreview(refined.log.refined),
      refined: undefined,
    },
  })
  const base = refined.options
  const generateCandidate = (entry, index) => {
    pipelineCandidateUpdate(requestId, index, { status: 'running', startedAt: Date.now() })
    return callOnce(ctx, candidateRequest(base, entry), entry).then(candidate => {
      pipelineCandidateUpdate(requestId, index, {
        status: candidate.valid ? 'done' : 'failed',
        valid: candidate.valid,
        actionPreview: actionPreview(candidate.action),
        usage: candidate.usage,
        error: candidate.error,
        finishedAt: Date.now(),
      })
      return candidate
    })
  }
  let candidates
  if (scheduling === 'sequential') {
    candidates = []
    for (const [index, entry] of entries.entries()) {
      original.signal?.throwIfAborted?.()
      candidates.push(await generateCandidate(entry, index))
    }
  } else {
    candidates = await Promise.all(entries.map(generateCandidate))
  }
  original.signal?.throwIfAborted?.()

  const valid = candidates.filter(candidate => candidate.valid)
  if (valid.length === 0) {
    statistics.fallbacks += 1
    statistics.last = { ...statistics.last, status: 'all-candidates-failed' }
    pipelineUpdate(requestId, {
      status: 'failed',
      error: 'All candidate streams failed.',
      elapsedMs: Date.now() - now,
    })
    // Preserve the first provider failure so the normal DSH retry/error path sees it.
    for (const chunk of candidates[0]?.chunks ?? []) yield chunk
    return
  }

  const problem = formatHistory(base)
  let bestIndex = 0
  let selection
  pipelineUpdate(requestId, { status: 'voting', validCandidates: valid.length })
  const voted = agentConfig.majorityVoting === false ? null : majority(valid.map(candidate => candidate.action))
  if (voted) {
    bestIndex = voted.index
    statistics.majoritySelections += 1
    selection = {
      method: 'majority',
      index: bestIndex,
      scores: voted.scores,
      count: voted.count,
      nComparisons: 0,
    }
  } else if (valid.length > 1) {
    pipelineUpdate(requestId, { status: 'verifying' })
    const payload = {
      problem,
      candidates: valid.map(candidate => candidate.action),
      criteria: agentConfig.criteria,
      ground_truth_note: agentConfig.note,
      n_evaluations: integer(agentConfig.nVerifications, 1),
      pivots: integer(agentConfig.pivots, 2),
      seed: Number.isInteger(agentConfig.seed) ? agentConfig.seed : 0,
      on_error: 'tie',
      ...(agentConfig.verifierModel ? { model: agentConfig.verifierModel } : {}),
      ...(agentConfig.maxWorkers ? { max_workers: agentConfig.maxWorkers } : {}),
    }
    try {
      const job = await select(payload)
      if (job.status !== 'done') throw new Error(job.error ?? `verifier job ${job.status}`)
      bestIndex = Number.isInteger(job.result?.index) ? job.result.index : 0
      if (bestIndex < 0 || bestIndex >= valid.length) bestIndex = 0
      statistics.verifierSelections += 1
      selection = { method: 'pivot_tournament', ...job.result }
    } catch (error) {
      statistics.fallbacks += 1
      bestIndex = 0
      selection = { method: 'fallback-first', error: error?.message ?? String(error) }
    }
  } else {
    selection = { method: 'single-success', index: 0, scores: [1], nComparisons: 0 }
  }

  const winner = valid[bestIndex]
  const elapsedMs = Date.now() - now
  const winnerIndex = candidates.indexOf(winner)
  const candidateScores = candidates.map(candidate => {
    const validIndex = valid.indexOf(candidate)
    return validIndex < 0 ? null : selection.scores?.[validIndex] ?? null
  })
  const log = {
    id: requestId,
    timestamp: new Date(now).toISOString(),
    sessionId,
    scheduling,
    config: plainConfig(agentConfig),
    contextRefinement: refined.log,
    responses: candidates.map((candidate, index) => ({
      index,
      model: candidate.entry,
      action: candidate.action,
      blocks: candidate.blocks,
      usage: candidate.usage,
      finish: candidate.finish,
      valid: candidate.valid,
      error: candidate.error,
    })),
    verifier: selection,
    bestIndex: winnerIndex,
    bestModel: winner.entry,
    elapsedMs,
    progressMonitor: {
      enabled: Boolean(agentConfig.progressMonitor?.enabled),
      status: agentConfig.progressMonitor?.enabled ? 'pending' : 'disabled',
    },
  }
  let logPath = ''
  try { if (saveLog) logPath = await saveLog(log) } catch { /* observability only */ }
  pipelineUpdate(requestId, {
    status: 'replaying',
    validCandidates: valid.length,
    selection,
    candidateScores,
    bestIndex: winnerIndex,
    bestModel: winner.entry,
    elapsedMs,
    logPath,
  })
  spawnProgress({ track }, problem, winner, agentConfig, logPath, requestId)

  statistics.last = {
    requestId,
    sessionId,
    status: 'selected',
    candidates: entries.length,
    validCandidates: valid.length,
    method: selection.method,
    scheduling,
    bestIndex: winnerIndex,
    elapsedMs,
    logPath,
    startedAt: now,
  }

  try {
    for (const chunk of selectedChunks(winner, original)) yield chunk
  } finally {
    pipelineUpdate(requestId, {
      status: selection.method === 'fallback-first' ? 'fallback' : 'complete',
      completedAt: Date.now(),
    })
  }
}

/** Register the transparent pipeline and fence it to the active verifier preset. */
export function installAgentPipeline(ctx) {
  return ctx.on('llm/stream', (options, next) => {
    if (bypass.has(options)) return next()
    let agent
    try { agent = ctx.agents.currentInitiator() } catch { return next() }
    if (!agent || String(options.sessionId ?? '') !== String(agent.id) || !isVerifierAgent(agent)) {
      return next()
    }
    return turboAgentStream(ctx, options, agent, next)
  })
}
