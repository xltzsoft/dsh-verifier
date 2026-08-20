/**
 * dsh-verifier — config + run-history store (~/.dsh/verifier.json).
 *
 * One flat JSON document, 0600, atomic replace. It holds the verifier
 * backend configuration (secrets included — same policy as
 * ~/.dsh/dsh-ssh.json: user home, owner-only) plus the plugin switches.
 * The Python sidecar re-reads this file before every scoring call, so a
 * save here is picked up by a running sidecar without a restart.
 */

import { constants as fsConstants } from 'node:fs'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

/** DSH home root (~/.dsh, overridable via DSH_HOME). */
export const DSH_HOME = process.env.DSH_HOME ?? join(homedir(), '.dsh')

/** The plugin state directory (venv, sidecar data, caches, run history). */
export const STATE_ROOT = join(DSH_HOME, 'verifier')

/** The configuration document path. */
export const CONFIG_FILE = join(DSH_HOME, 'verifier.json')

/** The run-history ledger (JSONL, appended by the host). */
export const RUNS_FILE = join(STATE_ROOT, 'runs.jsonl')

/** Defaults for every config field (the sidecar mirrors these). */
export const CONFIG_DEFAULTS = {
  /** backend: auto | deepseek | openai | vertex */
  backend: 'auto',
  /** verifier model name; empty = the backend's own default */
  model: '',
  /** DEEPSEEK_EFFORT: off | low | high | max */
  effort: 'high',
  /** DEEPSEEK_MAX_TOKENS output budget */
  maxTokens: 32768,
  /** OpenAI-compatible endpoint (vLLM / SGLang / DeepSeek / custom) */
  openaiBaseURL: '',
  openaiApiKey: '',
  deepseekApiKey: '',
  vertexApiKey: '',
  /** framework checkout with data/ for benchmark runs; empty = <STATE_ROOT>/data */
  dataDir: '',
  /** master switch for the plugin (routes, tools, prompt section) */
  enabled: true,
  /** announce the plugin to every agent in the system prompt */
  announceToAgent: true,
  /**
   * TurboAgent-equivalent model-step pipeline.  `models: []` means "sample
   * the model selected by this DSH session"; explicit entries can mix any
   * provider/model routes already configured in DSH without duplicating API
   * keys in verifier.json.
   */
  agent: {
    enabled: true,
    numCandidates: 3,
    temperature: 1,
    models: [],
    majorityVoting: true,
    pivots: 2,
    nVerifications: 1,
    seed: 0,
    note: 'There is no reference solution available. Judge each trajectory purely on how plausibly it solved the task correctly.',
    criteria: {
      'Task Success': 'How likely the agent correctly and completely solved the task. The strongest signal is the agent verifying its solution against the task specific requirements. Trajectory length, number of steps, and apparent confidence do not predict correctness.',
    },
    verifierModel: '',
    maxWorkers: null,
    progressMonitor: {
      enabled: true,
      nVerifications: 1,
      model: '',
    },
    context: {
      enabled: false,
      model: null,
      prompt: 'Your goal is to construct clearer context for another LLM to solve the problem. Read the context below thoroughly and produce a more specific, helpful framing.\n\n{context}\n\nThe constructed context is:',
    },
  },
}

function mergeAgent(value = {}) {
  const defaults = CONFIG_DEFAULTS.agent
  const input = value && typeof value === 'object' && !Array.isArray(value) ? value : {}
  return {
    ...defaults,
    ...input,
    models: Array.isArray(input.models) ? input.models : [...defaults.models],
    criteria: input.criteria && typeof input.criteria === 'object'
      ? input.criteria : { ...defaults.criteria },
    progressMonitor: {
      ...defaults.progressMonitor,
      ...(input.progressMonitor && typeof input.progressMonitor === 'object' ? input.progressMonitor : {}),
    },
    context: {
      ...defaults.context,
      ...(input.context && typeof input.context === 'object' ? input.context : {}),
    },
  }
}

/** Read the config document (defaults layered over a missing/broken file). */
export async function loadConfig() {
  const out = { ...CONFIG_DEFAULTS, agent: mergeAgent() }
  try {
    const raw = await readFile(CONFIG_FILE, 'utf8')
    const stored = JSON.parse(raw)
    for (const key of Object.keys(CONFIG_DEFAULTS)) {
      if (stored[key] !== undefined && stored[key] !== null) {
        out[key] = key === 'agent' ? mergeAgent(stored[key]) : stored[key]
      }
    }
  } catch {
    // missing or unreadable: pure defaults
  }
  return out
}

/** Persist a config patch (JSON-compatible values only). Returns the new doc. */
export async function saveConfig(patch) {
  const current = await loadConfig()
  const next = { ...current }
  for (const [key, value] of Object.entries(patch)) {
    if (key in CONFIG_DEFAULTS && value !== undefined && value !== null) {
      next[key] = key === 'agent' ? mergeAgent({ ...current.agent, ...value }) : value
    }
  }
  await mkdir(dirname(CONFIG_FILE), { recursive: true })
  const tmp = `${CONFIG_FILE}.tmp`
  await writeFile(tmp, JSON.stringify(next, null, 2) + '\n', 'utf8')
  await rename(tmp, CONFIG_FILE)
  await tryChmod0600(CONFIG_FILE)
  return next
}

async function tryChmod0600(path) {
  try {
    await import('node:fs/promises').then(m => m.chmod(path, fsConstants.S_IWUSR | fsConstants.S_IRUSR))
  } catch { /* best effort */ }
}

/** Mask a secret for wire display (keep 4 trailing chars). */
export function maskSecret(value) {
  if (!value) return ''
  const s = String(value)
  if (s.length <= 4) return '*'.repeat(s.length)
  return `${s.slice(0, 2)}${'*'.repeat(s.length - 6)}${s.slice(-4)}`
}

/** The config with secrets masked (what the GUI/tools see). */
export function publicConfig(cfg) {
  const out = { ...cfg }
  for (const key of ['openaiApiKey', 'deepseekApiKey', 'vertexApiKey']) {
    out[key] = maskSecret(cfg[key])
  }
  return out
}

/**
 * Append one run record to the ledger. Records stay small: metadata plus a
 * compact result summary, never the full trajectories.
 */
export async function appendRun(record) {
  const entry = { at: Date.now(), ...record }
  const line = JSON.stringify(entry) + '\n'
  await mkdir(STATE_ROOT, { recursive: true })
  await import('node:fs/promises').then(m => m.appendFile(RUNS_FILE, line, 'utf8'))
}

/** The most recent run records (newest first). */
export async function listRuns(limit = 100) {
  const m = await import('node:fs/promises')
  let raw
  try {
    raw = await m.readFile(RUNS_FILE, 'utf8')
  } catch {
    return []
  }
  const out = []
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue
    try {
      out.push(JSON.parse(line))
    } catch { /* skip torn line */ }
  }
  return out.reverse().slice(0, limit)
}
