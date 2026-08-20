/**
 * dsh-verifier — host single-instance guard (mirror of the dsh-web-ui shared
 * mount-once). The family bundle may mount the same package twice (standalone
 * + aggregator); the second apply becomes a no-op so route/tool/settings/
 * system-prompt registrations are never duplicated. The registry rides a
 * global symbol so npm-copy and repo-link installs share one verdict.
 */

const MOUNTED = Symbol.for('dsh-verifier.mounted-plugins')

function mountedSet() {
  const registry = globalThis
  if (!registry[MOUNTED]) registry[MOUNTED] = new Set()
  return registry[MOUNTED]
}

export function mountOnce(packageName, fn) {
  return (...args) => {
    const mounted = mountedSet()
    if (mounted.has(packageName)) return
    mounted.add(packageName)
    const ctx = args[0]
    if (ctx && typeof ctx.effect === 'function') {
      ctx.effect(() => () => {
        mounted.delete(packageName)
      })
    }
    return fn(...args)
  }
}
