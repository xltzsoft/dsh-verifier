/**
 * dsh-verifier — sidecar supervisor.
 *
 * Boots `assets/sidecar.py` inside the provisioned venv on a random
 * loopback port (the sidecar prints `{"ready": true, "port": N}` as its
 * first stdout line), polls /health every 15 s, and restarts on crash
 * with a bounded retry window. The sidecar owns the live framework
 * process state (token-usage counters, online progress trackers,
 * in-flight jobs); the host only owns its lifecycle.
 */

import { spawn } from 'node:child_process'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { STATE_ROOT } from './store.js'
import { FRAMEWORK_COMMIT, venvManager } from './venv.js'

const RUN_FILE = join(STATE_ROOT, 'sidecar.json')
const HEALTH_INTERVAL_MS = 15_000
const START_TIMEOUT_MS = 120_000
const MAX_RESTARTS = 5
const RESTART_WINDOW_MS = 5 * 60_000

/** The plugin assets directory (sidecar.py + bundled criteria). */
export function assetsDir() {
  const here = dirname(fileURLToPath(import.meta.url))
  return join(here, '..', 'assets')
}

export class SidecarManager {
  constructor() {
    this.state = 'stopped'     // stopped|starting|running|error
    this.port = null
    this.pid = null
    this.version = null
    this.frameworkCommit = null
    this.uptimeStartedAt = null
    this.error = null
    this._stderrTail = ''
    this._restarts = []
    this._child = null
    this._healthTimer = null
    this._closing = false
    this._readyPromise = null
    this._listeners = new Set()
    // True only while WE spawned the current child. An adopted sidecar (see
    // _adopt) belongs to another mount of this same package — we mirror its
    // state passively and never kill it or delete its run file.
    this._owned = false
  }

  subscribe(fn) {
    this._listeners.add(fn)
    fn(this.snapshot())
    return () => this._listeners.delete(fn)
  }

  _emit() {
    const snap = this.snapshot()
    for (const fn of this._listeners) {
      try { fn(snap) } catch { /* contained */ }
    }
  }

  snapshot() {
    return {
      state: this.state,
      port: this.port,
      pid: this.pid,
      version: this.version,
      frameworkCommit: this.frameworkCommit,
      uptimeSec: this.uptimeStartedAt
        ? Math.round((Date.now() - this.uptimeStartedAt) / 1000) : null,
      error: this.error,
    }
  }

  baseUrl() {
    return this.port ? `http://127.0.0.1:${this.port}` : null
  }

  ping() {
    return this._http('GET', '/health', null, 3_000)
      .then(body => body && body.ok === true)
      .catch(() => false)
  }

  /**
   * Ensure the sidecar is running (auto-provisions the venv first when
   * needed). Returns a snapshot; throws with a diagnostic when it cannot
   * be brought up.
   */
  async ensure({ autoProvision = true } = {}) {
    if (this.state === 'starting' && this._readyPromise) {
      try { await this._readyPromise } catch { /* fall through to state */ }
      if (this.state === 'running') return this.snapshot()
    }
    if (this.state === 'running' && (await this.ping())) {
      return this.snapshot()
    }
    // This package can be mounted on two planes in one process (the host
    // composition and an agent preset); if ESM module identity is per mount
    // that means two managers. The run file is the on-disk handoff: adopt the
    // other manager's live sidecar instead of spawning a second one.
    if (await this._adopt()) {
      return this.snapshot()
    }
    const venv = await venvManager.check()
    if (venv.state !== 'ready') {
      if (!autoProvision) {
        throw new Error('python venv not ready (state=' + venv.state + '): '
          + (venv.error ?? 'run venv provision first'))
      }
      await venvManager.provision()
    }
    await this._spawn()
    return this.snapshot()
  }

  /**
   * Adopt a live sidecar recorded in the run file by another mount of this
   * package (host-plane and preset-plane managers within one process, or a
   * previous dsh process whose sidecar survived a restart). Mirrors its
   * port/pid passively: no child, no health watch, no run-file writes — the
   * owning manager still restarts on crash, and every adoption attempt
   * re-reads the run file, so we follow owner restarts on the next ensure().
   */
  async _adopt() {
    let info
    try { info = JSON.parse(await readFile(RUN_FILE, 'utf8')) } catch { return false }
    if (!info || !Number.isInteger(info.pid) || !Number.isInteger(info.port)) return false
    try { process.kill(info.pid, 0) } catch { return false } // pid not alive
    const prevPort = this.port
    this.port = info.port
    let health
    try { health = await this._http('GET', '/health', null, 3_000) } catch { /* stale */ }
    if (!health?.ok || health?.framework?.commit !== FRAMEWORK_COMMIT) {
      this.port = prevPort
      return false
    }
    this.state = 'running'
    this.pid = info.pid
    this.version = health.version ?? null
    this.frameworkCommit = health.framework?.commit ?? null
    this.uptimeStartedAt = Number.isInteger(info.startedAt) ? info.startedAt : Date.now()
    this.error = null
    this._owned = false
    this._emit()
    return true
  }

  _spawn() {
    if (this._child && this._readyPromise) return this._readyPromise
    this.state = 'starting'
    this.error = null
    this._emit()
    const python = venvManager.venvPython()
    const sidecar = join(assetsDir(), 'sidecar.py')
    const child = spawn(python, [sidecar, '--root', assetsDir()], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, PYTHONUNBUFFERED: '1' },
    })
    this._child = child

    const ready = new Promise((resolve, reject) => {
      let buffered = ''
      let settled = false
      const timer = setTimeout(() => {
        if (!settled) {
          settled = true
          reject(new Error(`sidecar did not report ready within ${START_TIMEOUT_MS} ms`))
        }
      }, START_TIMEOUT_MS)
      const onLine = line => {
        if (settled) return
        let parsed
        try { parsed = JSON.parse(line) } catch { return }
        if (parsed && parsed.ready === true && parsed.port) {
          settled = true
          clearTimeout(timer)
          this.port = parsed.port
          this.pid = child.pid
          this.version = parsed.framework ?? null
          this.frameworkCommit = parsed.framework_commit ?? null
          this.uptimeStartedAt = Date.now()
          this.state = 'running'
          this._owned = true
          this._restarts = []
          this._persist()
          this._startHealthWatch()
          this._emit()
          resolve()
        }
      }
      child.stdout.on('data', d => {
        buffered += d.toString('utf8')
        let idx
        while ((idx = buffered.indexOf('\n')) >= 0) {
          const line = buffered.slice(0, idx).trim()
          buffered = buffered.slice(idx + 1)
          if (line) onLine(line)
        }
      })
      child.stderr.on('data', d => {
        this._stderrTail = ((this._stderrTail ?? '') + d.toString('utf8')).slice(-4000)
      })
      child.on('error', error => {
        if (!settled) {
          settled = true
          clearTimeout(timer)
          reject(new Error('sidecar spawn failed: ' + error.message))
        }
      })
      child.on('close', () => this._onExit())
    })
    this._readyPromise = ready.catch(error => {
      this._failStart(error.message)
      throw error
    })
    return this._readyPromise
  }

  _failStart(message) {
    this.state = 'error'
    this.error = message + (this._stderrTail ? `\n${this._stderrTail.slice(-1500)}` : '')
    this._clearChild()
    this._emit()
  }

  _clearChild() {
    if (this._child) {
      const c = this._child
      this._child = null
      try { c.stdout?.removeAllListeners() } catch { /* ok */ }
      try { c.stderr?.removeAllListeners() } catch { /* ok */ }
      try { c.kill('SIGTERM') } catch { /* ok */ }
    }
    this._readyPromise = null
  }

  _onExit() {
    const wasRunning = this.state === 'running'
    this._child = null
    this._readyPromise = null
    this.port = null
    this.pid = null
    this.version = null
    this.frameworkCommit = null
    this._stopHealthWatch()
    this._removeRunFile()
    if (this._closing) {
      this.state = 'stopped'
      this._emit()
      return
    }
    if (wasRunning) {
      // crashed: bounded auto-restart
      const now = Date.now()
      this._restarts = this._restarts.filter(t => now - t < RESTART_WINDOW_MS)
      this._restarts.push(now)
      if (this._restarts.length > MAX_RESTARTS) {
        this.state = 'error'
        this.error = `sidecar exited repeatedly (${this._restarts.length} restarts in 5 min); giving up`
          + (this._stderrTail ? `\n${this._stderrTail.slice(-1500)}` : '')
        this._emit()
        return
      }
      this.state = 'error'
      this.error = 'sidecar exited unexpectedly; auto-restarting '
        + `(${this._restarts.length}/${MAX_RESTARTS})`
      this._emit()
      setTimeout(() => {
        if (this._closing || this.state === 'running') return
        this._spawn().catch(() => {})
      }, 2_000)
      return
    }
    this.state = 'stopped'
    this._emit()
  }

  _startHealthWatch() {
    this._stopHealthWatch()
    this._healthTimer = setInterval(async () => {
      if (this.state !== 'running') return
      const ok = await this.ping()
      if (!ok && this._child) {
        try { this._child.kill('SIGKILL') } catch { /* ok */ }
      }
    }, HEALTH_INTERVAL_MS)
    if (typeof this._healthTimer.unref === 'function') this._healthTimer.unref()
  }

  _stopHealthWatch() {
    if (this._healthTimer) {
      clearInterval(this._healthTimer)
      this._healthTimer = null
    }
  }

  _persist() {
    mkdir(STATE_ROOT, { recursive: true }).then(() => writeFile(RUN_FILE, JSON.stringify({
      pid: this.pid, port: this.port, startedAt: this.uptimeStartedAt,
      frameworkCommit: this.frameworkCommit,
    }, null, 2))).catch(() => {})
  }

  _removeRunFile() {
    rm(RUN_FILE, { force: true }).catch(() => {})
  }

  /** Graceful stop (plugin unload). */
  async stop() {
    this._closing = true
    const child = this._owned ? this._child : null
    const wasOwned = this._owned
    this._stopHealthWatch()
    if (child) {
      await new Promise(resolve => {
        const timer = setTimeout(() => {
          try { child.kill('SIGKILL') } catch { /* ok */ }
          resolve()
        }, 5_000)
        child.once('close', () => {
          clearTimeout(timer)
          resolve()
        })
        try { child.kill('SIGTERM') } catch {
          clearTimeout(timer)
          resolve()
        }
      })
    }
    this._clearChild()
    this._closing = false
    this.state = 'stopped'
    this.port = null
    this.pid = null
    this.version = null
    this.frameworkCommit = null
    this.uptimeStartedAt = null
    this.error = null
    this._owned = false
    if (wasOwned) this._removeRunFile()
    else this._removeRunFileIfStale()
    this._emit()
    return this.snapshot()
  }

  /** An adopted manager leaves the owner's run file intact, but drops a
   *  stale one (dead pid) so the next ensure() starts clean. */
  _removeRunFileIfStale() {
    readFile(RUN_FILE, 'utf8').then(raw => {
      const info = JSON.parse(raw)
      if (!info || !Number.isInteger(info.pid)) { this._removeRunFile(); return }
      try { process.kill(info.pid, 0) } catch { this._removeRunFile() }
    }).catch(() => {})
  }

  /**
   * Call a sidecar endpoint. Long scoring calls should use the job API
   * (POST /jobs + GET /job?id=) instead of a blocking endpoint.
   */
  async _http(method, path, body, timeoutMs = 30_000) {
    if (!this.port) throw new Error('sidecar not running')
    const url = `http://127.0.0.1:${this.port}${path}`
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    try {
      const res = await fetch(url, {
        method,
        signal: controller.signal,
        headers: body ? { 'content-type': 'application/json' } : undefined,
        body: body ? JSON.stringify(body) : undefined,
      })
      const text = await res.text()
      let parsed
      try { parsed = JSON.parse(text) } catch { parsed = text }
      if (!res.ok) {
        const message = parsed && typeof parsed === 'object' && parsed.error
          ? (typeof parsed.error === 'string' ? parsed.error : JSON.stringify(parsed.error))
          : `HTTP ${res.status}`
        const error = new Error(message)
        error.status = res.status
        error.detail = parsed && typeof parsed === 'object' ? parsed.detail : undefined
        error.trace = parsed && typeof parsed === 'object' ? parsed.trace : undefined
        throw error
      }
      return parsed
    } finally {
      clearTimeout(timer)
    }
  }

  /** Public call for the agent tools / routes. */
  async call(method, path, body, timeoutMs) {
    return this._http(method, path, body, timeoutMs)
  }
}

/** Shared singleton for the plugin instance. */
export const sidecarManager = new SidecarManager()
