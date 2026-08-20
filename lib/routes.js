/**
 * dsh-verifier — the /api/verifier route family.
 *
 * Loopback-fenced proxy over the sidecar plus plugin-local management
 * (venv provisioning, sidecar lifecycle, config, run history). One route
 * per path, methods dispatched inside the handler (the webserver's route
 * registry is keyed by (kind, path)).
 */

import { writeJson, readJsonBody, queryParam } from './http-util.js'
import { isLoopbackRequest } from './loopback.js'
import {
  loadConfig, saveConfig, publicConfig, appendRun, listRuns, STATE_ROOT,
} from './store.js'
import { sidecarManager } from './sidecar.js'
import { venvManager } from './venv.js'
import { isDirectory } from './fs-util.js'
import {
  listPipelineHistory,
  pipelineSnapshot,
  subscribePipeline,
} from './pipeline-state.js'

const API = '/api/verifier'

/** Wrap a handler with the loopback fence + method check + error mapping. */
function guard(method, fn) {
  return async (req, res) => {
    if (!isLoopbackRequest(req)) {
      writeJson(res, 403, { error: 'forbidden: verifier endpoints are loopback-only' })
      return
    }
    if ((req.method ?? 'GET') !== method) {
      writeJson(res, 405, { error: `method not allowed: ${req.method}` })
      return
    }
    try {
      await fn(req, res)
    } catch (error) {
      const status = Number.isInteger(error?.status) ? error.status
        : /venv|sidecar|python|not ready|no verifier backend/i.test(String(error?.message)) ? 503
        : 500
      writeJson(res, status, {
        error: error?.message ?? String(error),
        detail: error?.detail,
        venv: venvManager.snapshot(),
        sidecar: sidecarManager.snapshot(),
      })
    }
  }
}

/** Start a sidecar job and poll it to completion (bounded). */
export async function runJobToCompletion(kind, args, { waitMs = 15 * 60_000, pollMs = 2_000 } = {}) {
  const started = await sidecarManager.call('POST', '/jobs', { kind, args }, 60_000)
  const deadline = Date.now() + waitMs
  for (;;) {
    const job = await sidecarManager.call(
      'GET', `/job?id=${encodeURIComponent(started.job_id)}`, null, 15_000)
    if (job.status === 'done' || job.status === 'error' || job.status === 'canceled') {
      return job
    }
    if (Date.now() > deadline) {
      return { ...job, status: 'timeout',
        note: 'still running; poll /api/verifier/job?id=' + started.job_id }
    }
    await new Promise(r => setTimeout(r, pollMs))
  }
}

/** A candidate/step that is an existing file path expands to its content. */
export async function expandText(value) {
  if (typeof value !== 'string') return value
  const s = value.trim()
  if (!s || !/^(\/|~\/|[A-Za-z]:[\\/])/.test(s) || s.length > 4096) return value
  const { readFile } = await import('node:fs/promises')
  const { homedir } = await import('node:os')
  const path = s.startsWith('~/') ? s.replace(/^~\//, homedir() + '/') : s
  try {
    return await readFile(path, 'utf8')
  } catch {
    return value
  }
}

/**
 * Run a scoring job through the sidecar, expanding file-path inputs and
 * appending a run-history record. Returns the final job snapshot.
 */
export async function runScoringJob(kind, args, { waitMs } = {}) {
  await sidecarManager.ensure()
  const expanded = { ...args }
  for (const key of ['candidate_a', 'candidate_b']) {
    if (typeof expanded[key] === 'string') expanded[key] = await expandText(expanded[key])
  }
  if (Array.isArray(expanded.candidates)) {
    expanded.candidates = await Promise.all(
      expanded.candidates.map(c => expandText(typeof c === 'string' ? c : (c?.text ?? ''))))
  }
  if (Array.isArray(expanded.steps)) {
    expanded.steps = await Promise.all(expanded.steps.map(s => expandText(s)))
  }
  if (typeof expanded.cache === 'string' && expanded.cache.startsWith('~/')) {
    const { homedir } = await import('node:os')
    expanded.cache = expanded.cache.replace(/^~\//, homedir() + '/')
  }
  const job = await runJobToCompletion(kind, expanded, { waitMs })
  if (['done', 'error', 'canceled'].includes(job.status)) {
    await appendRun({
      kind,
      jobId: job.id,
      status: job.status,
      summary: summarizeArgs(kind, args),
      result: job.result,
      usage: job.usage,
      error: job.error,
    }).catch(() => {})
  }
  return job
}

function summarizeArgs(kind, args) {
  const s = {}
  if (typeof args.problem === 'string') s.problem = args.problem.slice(0, 200)
  if (Array.isArray(args.candidates)) s.candidates = args.candidates.length
  if (Array.isArray(args.steps)) s.steps = args.steps.length
  if (typeof args.name === 'string') s.name = args.name
  if (args.preset) s.preset = args.preset
  if (args.n_evaluations) s.nEvaluations = args.n_evaluations
  if (args.pivots) s.pivots = args.pivots
  return s
}

/** Build the route table. */
export function makeRoutes() {
  const routes = [
    {
      kind: 'exact',
      path: `${API}/pipeline`,
      handler: guard('GET', async (req, res) => {
        const sessionId = queryParam(req, 'sessionId') || undefined
        const limit = Math.max(1, Math.min(Number(queryParam(req, 'limit')) || 20, 100))
        const live = pipelineSnapshot({ sessionId, limit })
        writeJson(res, 200, {
          ...live,
          history: await listPipelineHistory({ sessionId, limit }),
        })
      }),
    },
    {
      kind: 'exact',
      path: `${API}/pipeline/events`,
      handler: guard('GET', async (req, res) => {
        res.writeHead(200, {
          'content-type': 'text/event-stream; charset=utf-8',
          'cache-control': 'no-cache, no-transform',
          connection: 'keep-alive',
        })
        const push = event => res.write(`data: ${JSON.stringify(event)}\n\n`)
        const unsubscribe = subscribePipeline(push)
        const heartbeat = setInterval(() => res.write(': verifier-ping\n\n'), 15_000)
        const close = () => {
          clearInterval(heartbeat)
          unsubscribe()
        }
        req.once('close', close)
        res.once('close', close)
        push(pipelineSnapshot({ limit: 1 }))
      }),
    },
    {
      kind: 'exact',
      path: `${API}/status`,
      handler: guard('GET', async (req, res) => {
        const cfg = await loadConfig()
        let backend = null
        let usage = null
        if (sidecarManager.state === 'running') {
          try {
            backend = await sidecarManager.call('GET', '/backend', null, 5_000)
            usage = await sidecarManager.call('GET', '/usage', null, 5_000)
          } catch { /* sidecar mid-flap */ }
        }
        writeJson(res, 200, {
          plugin: 'verifier',
          version: 2,
          enabled: cfg.enabled !== false,
          venv: venvManager.snapshot(),
          sidecar: sidecarManager.snapshot(),
          backend,
          usage,
          config: publicConfig(cfg),
          stateRoot: STATE_ROOT,
        })
      }),
    },
    {
      kind: 'exact',
      path: `${API}/venv/provision`,
      handler: guard('POST', async (req, res) => {
        const body = await readJsonBody(req)
        const force = Boolean(body?.force)
        const pythonBin = typeof body?.python === 'string' ? body.python : undefined
        venvManager.provision({ force, pythonBin }).catch(error => {
          venvManager.error = error.message
        })
        writeJson(res, 202, { accepted: true, venv: venvManager.snapshot() })
      }),
    },
    {
      kind: 'exact',
      path: `${API}/venv/log`,
      handler: guard('GET', async (req, res) => {
        const lines = Number(queryParam(req, 'lines')) || 80
        const tail = await venvManager.tailLog(lines)
        writeJson(res, 200, { tail })
      }),
    },
    {
      kind: 'exact',
      path: `${API}/sidecar/stop`,
      handler: guard('POST', async (req, res) => {
        const snap = await sidecarManager.stop()
        writeJson(res, 200, snap)
      }),
    },
    {
      kind: 'exact',
      path: `${API}/config`,
      handler: guard('GET', async (req, res) => {
        writeJson(res, 200, publicConfig(await loadConfig()))
      }),
    },
    {
      kind: 'exact',
      path: `${API}/config/set`,
      handler: guard('POST', async (req, res) => {
        const body = await readJsonBody(req)
        if (!body || typeof body !== 'object' || Array.isArray(body)) {
          writeJson(res, 400, { error: 'config patch object required' })
          return
        }
        const next = await saveConfig(body)
        let backend = null
        if (sidecarManager.state === 'running') {
          try { backend = await sidecarManager.call('GET', '/backend', null, 5_000) } catch { /* ok */ }
        }
        writeJson(res, 200, { config: publicConfig(next), backend })
      }),
    },
    {
      kind: 'exact',
      path: `${API}/usage`,
      handler: guard('GET', async (req, res) => {
        await sidecarManager.ensure()
        writeJson(res, 200, await sidecarManager.call('GET', '/usage', null, 10_000))
      }),
    },
    {
      kind: 'exact',
      path: `${API}/usage/reset`,
      handler: guard('POST', async (req, res) => {
        await sidecarManager.ensure()
        writeJson(res, 200, await sidecarManager.call('POST', '/usage/reset', {}, 10_000))
      }),
    },
    {
      kind: 'exact',
      path: `${API}/criteria`,
      handler: guard('GET', async (req, res) => {
        const name = queryParam(req, 'name')
        if (name) {
          await sidecarManager.ensure()
          const preview = await sidecarManager.call(
            'GET', `/criteria?name=${encodeURIComponent(name)}`, null, 15_000)
          writeJson(res, 200, preview)
          return
        }
        await sidecarManager.ensure()
        const list = await sidecarManager.call('GET', '/criteria/list', null, 15_000)
        writeJson(res, 200, list)
      }),
    },
    {
      kind: 'exact',
      path: `${API}/benchmarks`,
      handler: guard('GET', async (req, res) => {
        if (sidecarManager.state === 'running') {
          try {
            const info = await sidecarManager.call('GET', '/benchmarks', null, 15_000)
            writeJson(res, 200, info)
            return
          } catch { /* fall through to disk view */ }
        }
        const cfg = await loadConfig()
        const dataDir = cfg.dataDir || STATE_ROOT + '/data'
        writeJson(res, 200, {
          dataDir,
          present: await isDirectory(dataDir),
          hasData: await isDirectory(dataDir + '/data'),
          sidecarUp: false,
        })
      }),
    },
    {
      kind: 'exact',
      path: `${API}/runs`,
      handler: guard('GET', async (req, res) => {
        writeJson(res, 200, { runs: await listRuns(200) })
      }),
    },
    {
      kind: 'exact',
      path: `${API}/jobs`,
      handler: guard('POST', async (req, res) => {
        const body = await readJsonBody(req)
        const kind = body?.kind
        if (!['compare', 'select', 'track', 'benchmark', 'data-download'].includes(kind)) {
          writeJson(res, 400, { error: `unknown job kind ${String(kind)}` })
          return
        }
        await sidecarManager.ensure()
        const started = await sidecarManager.call(
          'POST', '/jobs', { kind, args: body?.args ?? {} }, 60_000)
        writeJson(res, 202, started)
      }),
    },
    {
      kind: 'exact',
      path: `${API}/job`,
      handler: guard('GET', async (req, res) => {
        const id = queryParam(req, 'id')
        if (!id) {
          writeJson(res, 400, { error: 'missing job id' })
          return
        }
        await sidecarManager.ensure().catch(() => {})
        try {
          const job = await sidecarManager.call(
            'GET', `/job?id=${encodeURIComponent(id)}`, null, 10_000)
          writeJson(res, 200, job)
        } catch {
          writeJson(res, 404, { error: 'job unknown (sidecar may have restarted)' })
        }
      }),
    },
    {
      kind: 'exact',
      path: `${API}/jobs/list`,
      handler: guard('GET', async (req, res) => {
        await sidecarManager.ensure().catch(() => {})
        try {
          const jobs = await sidecarManager.call('GET', '/jobs', null, 10_000)
          writeJson(res, 200, jobs)
        } catch {
          writeJson(res, 200, { jobs: [] })
        }
      }),
    },
    {
      kind: 'exact',
      path: `${API}/job/cancel`,
      handler: guard('POST', async (req, res) => {
        const body = await readJsonBody(req)
        if (!body?.id) {
          writeJson(res, 400, { error: 'missing job id' })
          return
        }
        await sidecarManager.ensure().catch(() => {})
        try {
          const out = await sidecarManager.call('POST', '/job/cancel', { id: body.id }, 10_000)
          writeJson(res, 200, out)
        } catch (error) {
          writeJson(res, 404, { error: error.message })
        }
      }),
    },
    {
      kind: 'exact',
      path: `${API}/tracker/start`,
      handler: guard('POST', async (req, res) => {
        const body = await readJsonBody(req)
        if (!body?.problem) {
          writeJson(res, 400, { error: 'problem required' })
          return
        }
        await sidecarManager.ensure()
        const out = await sidecarManager.call('POST', '/tracker/start', body, 60_000)
        writeJson(res, 200, out)
      }),
    },
    {
      kind: 'exact',
      path: `${API}/tracker/update`,
      handler: guard('POST', async (req, res) => {
        const body = await readJsonBody(req)
        if (!body?.tracker_id || body?.step === undefined) {
          writeJson(res, 400, { error: 'tracker_id and step required' })
          return
        }
        await sidecarManager.ensure()
        const out = await sidecarManager.call('POST', '/tracker/update', body, 10 * 60_000)
        writeJson(res, 200, out)
      }),
    },
    {
      kind: 'exact',
      path: `${API}/tracker/result`,
      handler: guard('GET', async (req, res) => {
        const id = queryParam(req, 'tracker_id')
        if (!id) {
          writeJson(res, 400, { error: 'missing tracker_id' })
          return
        }
        await sidecarManager.ensure().catch(() => {})
        try {
          const out = await sidecarManager.call(
            'GET', `/tracker/result?tracker_id=${encodeURIComponent(id)}`, null, 15_000)
          writeJson(res, 200, out)
        } catch (error) {
          writeJson(res, 404, { error: error.message })
        }
      }),
    },
    {
      kind: 'exact',
      path: `${API}/tracker`,
      handler: guard('DELETE', async (req, res) => {
        const id = queryParam(req, 'tracker_id')
        if (!id) {
          writeJson(res, 400, { error: 'missing tracker_id' })
          return
        }
        await sidecarManager.ensure().catch(() => {})
        try {
          const out = await sidecarManager.call(
            'DELETE', `/tracker?tracker_id=${encodeURIComponent(id)}`, null, 15_000)
          writeJson(res, 200, out)
        } catch (error) {
          writeJson(res, 404, { error: error.message })
        }
      }),
    },
  ]
  return { routes }
}
