/**
 * Live, process-local observability for the automatic verifier pipeline.
 *
 * Candidate prompts and complete responses intentionally stay out of this
 * state object.  The browser receives bounded action previews and public
 * selection metadata only; complete audit logs remain on the local disk.
 */

import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { STATE_ROOT } from './store.js'

const PIPELINE_LOG_DIR = join(STATE_ROOT, 'pipeline')
const MAX_ACTIVITIES = 50
const MAX_PREVIEW = 4_000
const activities = new Map()
const listeners = new Set()
let revision = 0

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value))
}

export function actionPreview(value, limit = MAX_PREVIEW) {
  const text = String(value ?? '')
  return text.length <= limit ? text : `${text.slice(0, limit)}\n…`
}

function emit() {
  revision += 1
  for (const listener of listeners) {
    try { listener({ revision }) } catch { /* observers cannot affect execution */ }
  }
}

function trim() {
  if (activities.size <= MAX_ACTIVITIES) return
  const oldest = [...activities.values()]
    .sort((a, b) => (a.updatedAt ?? 0) - (b.updatedAt ?? 0))
    .slice(0, activities.size - MAX_ACTIVITIES)
  for (const activity of oldest) activities.delete(activity.id)
}

export function pipelineStart(activity) {
  const now = Date.now()
  const next = {
    ...clone(activity),
    startedAt: activity.startedAt ?? now,
    updatedAt: now,
  }
  activities.set(next.id, next)
  trim()
  emit()
  return clone(next)
}

export function pipelineUpdate(id, patch) {
  const current = activities.get(id)
  if (!current) return null
  const next = {
    ...current,
    ...clone(patch),
    updatedAt: Date.now(),
  }
  activities.set(id, next)
  emit()
  return clone(next)
}

export function pipelineCandidateUpdate(id, index, patch) {
  const current = activities.get(id)
  if (!current) return null
  const candidates = (current.candidates ?? []).map(candidate =>
    candidate.index === index ? { ...candidate, ...clone(patch) } : candidate)
  return pipelineUpdate(id, { candidates })
}

export function pipelineSnapshot({ sessionId, limit = 20 } = {}) {
  const cap = Math.max(1, Math.min(Number(limit) || 20, MAX_ACTIVITIES))
  const list = [...activities.values()]
    .filter(activity => !sessionId || String(activity.sessionId) === String(sessionId))
    .sort((a, b) => (b.startedAt ?? 0) - (a.startedAt ?? 0))
    .slice(0, cap)
  return { revision, activities: clone(list) }
}

export function subscribePipeline(listener) {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

function modelSummary(model) {
  if (!model || typeof model !== 'object') return model ?? null
  return {
    provider: model.provider,
    model: model.model,
    repeat: model.repeat,
    reasoningEffort: model.reasoningEffort,
  }
}

function normalizeLog(log) {
  const selection = clone(log.verifier ?? {})
  const validResponses = (log.responses ?? []).filter(response => response.valid)
  const candidateScores = (log.responses ?? []).map(response => {
    const validIndex = validResponses.indexOf(response)
    return validIndex < 0 ? null : selection.scores?.[validIndex] ?? null
  })
  return {
    id: log.id,
    timestamp: log.timestamp,
    sessionId: log.sessionId,
    scheduling: log.scheduling ?? log.config?.candidateScheduling ?? 'parallel',
    status: selection.method === 'fallback-first' ? 'fallback' : 'complete',
    contextRefinement: {
      enabled: Boolean(log.contextRefinement?.enabled),
      model: modelSummary(log.contextRefinement?.model),
      error: log.contextRefinement?.error,
    },
    candidatesExpected: log.responses?.length ?? 0,
    candidates: (log.responses ?? []).map((response, index) => ({
      index: Number.isInteger(response.index) ? response.index : index,
      ...modelSummary(response.model),
      status: response.valid ? 'done' : 'failed',
      valid: Boolean(response.valid),
      actionPreview: actionPreview(response.action),
      usage: response.usage,
      error: response.error,
    })),
    selection,
    candidateScores,
    bestIndex: log.bestIndex,
    bestModel: modelSummary(log.bestModel),
    elapsedMs: log.elapsedMs,
    progressMonitor: clone(log.progressMonitor),
  }
}

export async function listPipelineHistory({ sessionId, limit = 20 } = {}) {
  const cap = Math.max(1, Math.min(Number(limit) || 20, 100))
  let names
  try {
    names = (await readdir(PIPELINE_LOG_DIR))
      .filter(name => name.endsWith('.json'))
      .sort((a, b) => b.localeCompare(a))
  } catch {
    return []
  }

  const history = []
  for (const name of names.slice(0, 500)) {
    try {
      const log = JSON.parse(await readFile(join(PIPELINE_LOG_DIR, name), 'utf8'))
      if (sessionId && String(log.sessionId) !== String(sessionId)) continue
      history.push(normalizeLog(log))
      if (history.length >= cap) break
    } catch { /* skip partial or manually edited log files */ }
  }
  return history
}
