/**
 * dsh-verifier — Python environment provisioning.
 *
 * The sidecar runs the unmodified `llm-verifier` package inside a private
 * venv under ~/.dsh/verifier/venv. This module creates the venv on demand
 * (python3 from PATH or the configured interpreter), upgrades pip, and
 * installs the audited upstream Git commit, streaming output to
 * ~/.dsh/verifier/venv.log. Pinning the commit matters because upstream kept
 * the 0.2.0 version number while landing correctness fixes after the PyPI
 * artifact was published.
 *
 * States: unknown -> checking -> ready | missing | outdated -> provisioning
 * -> ready|error. Readiness requires both an importable package and the exact
 * audited upstream commit.
 */

import { spawn } from 'node:child_process'
import { readFile, stat, appendFile } from 'node:fs/promises'
import { join } from 'node:path'
import { STATE_ROOT } from './store.js'

export const VENV_DIR = join(STATE_ROOT, 'venv')
export const VENV_LOG = join(STATE_ROOT, 'venv.log')
export const FRAMEWORK_VERSION = '0.2.0'
export const FRAMEWORK_COMMIT = '8db8a114355a9d7fdf9a8d1d5c87f6aeebd18770'
const FRAMEWORK_SPEC = `git+https://github.com/llm-as-a-verifier/llm-as-a-verifier.git@${FRAMEWORK_COMMIT}`

/** The interpreter that would build the venv (config override first). */
export function resolvePythonBin(override) {
  return override || process.env.VERIFIER_PYTHON || 'python3'
}

export class VenvManager {
  constructor() {
    this.state = 'unknown'       // unknown|checking|ready|missing|outdated|provisioning|error
    this.pythonBin = null
    this.frameworkVersion = null
    this.frameworkCommit = null
    this.error = null
    this._job = null
    this._listeners = new Set()
  }

  pythonDir() {
    return join(VENV_DIR, process.platform === 'win32' ? 'Scripts' : 'bin')
  }

  venvPython() {
    return join(this.pythonDir(), process.platform === 'win32' ? 'python.exe' : 'python')
  }

  subscribe(fn) {
    this._listeners.add(fn)
    fn(this.snapshot())
    return () => this._listeners.delete(fn)
  }

  _emit() {
    const snap = this.snapshot()
    for (const fn of this._listeners) {
      try { fn(snap) } catch { /* listener errors are contained */ }
    }
  }

  snapshot() {
    return {
      state: this.state,
      venvDir: VENV_DIR,
      pythonBin: this.pythonBin,
      frameworkVersion: this.frameworkVersion,
      frameworkCommit: this.frameworkCommit,
      requiredFrameworkVersion: FRAMEWORK_VERSION,
      requiredFrameworkCommit: FRAMEWORK_COMMIT,
      error: this.error,
      provisioning: this._job ? {
        phase: this._job.phase,
        startedAt: this._job.startedAt,
      } : null,
    }
  }

  /** Probe the venv; returns a snapshot. Cheap; safe to call often. */
  async check(pythonBin) {
    if (this._job) return this.snapshot()      // provisioning already in flight
    if (pythonBin) this.pythonBin = pythonBin
    this.state = 'checking'
    this._emit()
    const ok = await this._probe()
    const metadata = ok ? await this._metadata().catch(() => null) : null
    this.frameworkVersion = metadata?.version ?? null
    this.frameworkCommit = metadata?.commit ?? null
    const exact = metadata?.version === FRAMEWORK_VERSION
      && metadata?.commit === FRAMEWORK_COMMIT
    this.state = !ok ? 'missing' : exact ? 'ready' : 'outdated'
    this.error = this.state === 'outdated'
      ? `installed llm-verifier ${this.frameworkVersion ?? 'unknown'} (${this.frameworkCommit ?? 'untracked source'}); required ${FRAMEWORK_VERSION} (${FRAMEWORK_COMMIT})`
      : null
    this._emit()
    return this.snapshot()
  }

  async _probe() {
    try {
      await stat(this.venvPython())
    } catch {
      return false
    }
    return this._run(this.venvPython(), ['-c', 'import llm_verifier'], 30_000).then(
      () => true,
      () => false,
    )
  }

  async _metadata() {
    const script = [
      'import importlib.metadata as m, json',
      'd=m.distribution("llm-verifier")',
      'u=json.loads(d.read_text("direct_url.json") or "{}")',
      'print(json.dumps({"version":d.version,"commit":u.get("vcs_info",{}).get("commit_id")}))',
    ].join(';')
    const out = await this._run(this.venvPython(), ['-c', script], 15_000)
    return JSON.parse(out.trim().split('\n').pop())
  }

  /**
   * Provision (or re-provision) the venv. Idempotent; concurrent callers
   * share one job. `force` rebuilds from scratch.
   */
  async provision({ force = false, pythonBin } = {}) {
    if (pythonBin) this.pythonBin = pythonBin
    if (this._job) return this.snapshot()
    if (!force) {
      const snap = await this.check()
      if (snap.state === 'ready') return snap
    }
    const hostBin = resolvePythonBin(this.pythonBin)
    this.pythonBin = hostBin
    this.state = 'provisioning'
    this.error = null
    const job = { phase: 'venv', startedAt: Date.now() }
    this._job = job
    this._emit()

    const step = async (phase, bin, args, timeoutMs) => {
      job.phase = phase
      this._emit()
      try {
        await this._runStreaming(bin, args, timeoutMs)
      } catch (error) {
        const tail = (await this.tailLog(40)).trim()
        this.state = 'error'
        this.error = `${phase} failed: ${error.message}${tail ? `\n${tail}` : ''}`
        this._job = null
        this._emit()
        throw new Error(this.error)
      }
    }

    try {
      await appendFile(VENV_LOG, `\n=== provision ${new Date().toISOString()} (force=${force}) ===\n`)
      if (force) await this._removeVenv()
      await step('venv', hostBin, ['-m', 'venv', VENV_DIR], 300_000)
      await step('pip-upgrade', this.venvPython(), ['-m', 'pip', 'install', '--upgrade', 'pip'], 600_000)
      await step('install', this.venvPython(), [
        '-m', 'pip', 'install', '--upgrade', '--force-reinstall', FRAMEWORK_SPEC,
      ], 1_800_000)
      const ok = await this._probe()
      if (!ok) throw new Error('post-install probe failed: import llm_verifier')
      const metadata = await this._metadata()
      this.frameworkVersion = metadata.version
      this.frameworkCommit = metadata.commit
      if (metadata.version !== FRAMEWORK_VERSION || metadata.commit !== FRAMEWORK_COMMIT) {
        throw new Error(`post-install identity mismatch: ${metadata.version} (${metadata.commit})`)
      }
      this.state = 'ready'
    } catch (error) {
      if (this.state !== 'error') {
        this.state = 'error'
        this.error = error.message
        this._emit()
      }
      throw error
    } finally {
      this._job = null
      this._emit()
    }
    return this.snapshot()
  }

  async _removeVenv() {
    const { rm } = await import('node:fs/promises')
    await rm(VENV_DIR, { recursive: true, force: true })
  }

  /** Run a child and capture output (resolved stdout, rejects on non-zero). */
  _run(bin, args, timeoutMs) {
    return new Promise((resolve, reject) => {
      const child = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] })
      let out = ''
      let err = ''
      const timer = setTimeout(() => {
        child.kill('SIGKILL')
        reject(new Error(`${bin} ${args[0] ?? ''} timed out after ${timeoutMs} ms`))
      }, timeoutMs)
      child.stdout.on('data', d => { out += d })
      child.stderr.on('data', d => { err += d })
      child.on('error', error => {
        clearTimeout(timer)
        reject(error)
      })
      child.on('close', code => {
        clearTimeout(timer)
        if (code === 0) resolve(out)
        else reject(new Error(`${bin} exited ${code}: ${err.slice(-500)}`))
      })
    })
  }

  /** Run a child streaming stdout+stderr into the venv log. */
  _runStreaming(bin, args, timeoutMs) {
    return new Promise((resolve, reject) => {
      const child = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] })
      const pump = d => appendFile(VENV_LOG, d).catch(() => {})
      const timer = setTimeout(() => {
        child.kill('SIGKILL')
        reject(new Error(`${bin} ${args[0] ?? ''} timed out after ${timeoutMs} ms`))
      }, timeoutMs)
      child.stdout.on('data', pump)
      child.stderr.on('data', pump)
      child.on('error', error => {
        clearTimeout(timer)
        reject(error)
      })
      child.on('close', code => {
        clearTimeout(timer)
        if (code === 0) resolve()
        else reject(new Error(`${bin} ${args.join(' ')} exited ${code}`))
      })
    })
  }

  /** Tail the provisioning log for the UI. */
  async tailLog(lines = 60) {
    try {
      const raw = await readFile(VENV_LOG, 'utf8')
      return raw.split('\n').slice(-lines).join('\n')
    } catch {
      return ''
    }
  }
}

/** Shared singleton for the plugin instance. */
export const venvManager = new VenvManager()
