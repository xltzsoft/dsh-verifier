/**
 * dsh-verifier — host-plane entry. Wraps Stanford's LLM-as-a-Verifier
 * framework (`llm-verifier` 0.2.0 at an audited upstream commit, unmodified)
 * in a Python sidecar
 * and owns the process-level infrastructure: the /api/verifier route
 * family (loopback, machine-readable API) and the sidecar lifecycle (stop
 * with the session's process).
 *
 * The model-facing half — the nine verifier_* tools and the judge-workflow
 * prompt section — lives in the ./tools subpath entry (`@linxin666/dsh-
 * verifier/tools`), which an agent preset (the `verifier` mode) mounts; no
 * other preset or the host composition picks it up. The sidecar does the
 * real scoring so algorithms, prefix-cache behavior, and token
 * accounting are the framework's own.
 */

import z from 'schemastery'
import { makeRoutes } from './routes.js'
import { sidecarManager } from './sidecar.js'
import { mountOnce } from './mount-once.js'
import { installBundledPreset } from './preset-installer.js'

/** Stable cordis plugin name. */
export const name = 'verifier'

/** Services required before the verifier surfaces can mount. */
export const inject = ['webServer']

/** Plugin config, validated by the same-named schemastery schema. */
export const Config = z.object({
  /** Master switch for the host surfaces (the /api/verifier routes). */
  enabled: z.boolean().default(true),
})
/**
 * Mount the host surfaces: the /api/verifier route family (gated by the
 * composition entry's `enabled` flag).
 * @param ctx - host plugin context carrying webServer.
 * @param config - resolved plugin config (schema defaults applied by the loader).
 */
export const apply = mountOnce('@linxin666/dsh-verifier', applyImpl)

function applyImpl(ctx, config = {}) {
  try {
    const preset = installBundledPreset()
    if (preset.status === 'installed') {
      ctx.logger.info(`verifier: installed preset at ${preset.destinationDirectory}`)
    } else if (preset.status === 'upgraded') {
      ctx.logger.info(
        `verifier: upgraded managed preset ${preset.fromVersion ?? 'unknown'} -> ${preset.version}`,
      )
    } else if (preset.status === 'preserved') {
      ctx.logger.warn(
        `verifier: preserved existing preset at ${preset.destinationDirectory} (${preset.reason}); package updates will not overwrite user files`,
      )
    }
  } catch (error) {
    ctx.logger.warn(`verifier: automatic preset install failed: ${String(error)}`)
  }

  const { routes } = makeRoutes()
  if (config.enabled ?? true) {
    ctx.effect(
      () => {
        const disposers = routes.map(route => ctx.webServer.register(route))
        return () => {
          for (const dispose of disposers) dispose()
        }
      },
      'verifier: routes',
    )
  }

  // Tear the sidecar down with the session (the venv stays on disk).
  ctx.effect(
    () => () => {
      try { sidecarManager.stop() } catch { /* already stopped */ }
    },
    'verifier: sidecar',
  )
}
