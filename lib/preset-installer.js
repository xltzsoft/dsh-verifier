/**
 * Install the package-owned Verifier preset into DSH's user preset root.
 *
 * DSH currently forces the preset service's configured roots back to its own
 * shipped root at boot, so a bundle cannot add a package-relative preset root
 * through cordis.patch.yml.  The user root is intentionally discovered on
 * every list/resolve call, which makes a guarded first-run copy both reliable
 * and visible without restarting a second time.
 */

import { createHash } from 'node:crypto'
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const PACKAGE_NAME = '@linxin666/dsh-verifier'
const PRESET_ID = 'verifier'
const PRESET_FILES = ['preset.yml', 'agent.cordis.yml']
const MARKER_FILE = '.dsh-verifier-managed.json'
const MARKER_SCHEMA_VERSION = 1

function sha256(value) {
  return createHash('sha256').update(value).digest('hex')
}

function readJson(filename) {
  return JSON.parse(readFileSync(filename, 'utf8'))
}

function fileHashes(directory) {
  return Object.fromEntries(
    PRESET_FILES.map(filename => [
      filename,
      sha256(readFileSync(join(directory, filename))),
    ]),
  )
}

function hashesEqual(left, right) {
  return PRESET_FILES.every(filename => (
    typeof left?.[filename] === 'string'
    && left[filename] === right?.[filename]
  ))
}

function writeAtomic(filename, value) {
  const temporary = join(
    dirname(filename),
    `.${PRESET_ID}-${process.pid}-${Date.now()}.tmp`,
  )
  try {
    writeFileSync(temporary, value)
    renameSync(temporary, filename)
  } finally {
    if (existsSync(temporary)) unlinkSync(temporary)
  }
}
function copyPresetFiles(sourceDirectory, destinationDirectory) {
  for (const filename of PRESET_FILES) {
    copyFileSync(join(sourceDirectory, filename), join(destinationDirectory, filename))
  }
}

function markerDocument(version, hashes) {
  return `${JSON.stringify({
    schemaVersion: MARKER_SCHEMA_VERSION,
    package: PACKAGE_NAME,
    version,
    files: hashes,
  }, null, 2)}\n`
}

/** Resolve DSH_HOME with the same precedence as the official helper. */
export function resolveDshHome(env = process.env, userHome = homedir()) {
  const configured = env.DSH_HOME?.trim()
  return configured ? resolve(configured) : join(userHome, '.dsh')
}

/**
 * Ensure the bundled Verifier preset exists in DSH's user preset directory.
 *
 * A marker records the exact hashes installed by this package. Updates are
 * applied only while both managed files still match those hashes. A directory
 * without our marker, a symlink, a malformed marker, or any edited/missing
 * file is treated as user-owned and never overwritten.
 */
export function installBundledPreset(options = {}) {
  const packageDirectory = options.packageDirectory
    ?? fileURLToPath(new URL('..', import.meta.url))
  const sourceDirectory = options.sourceDirectory
    ?? join(packageDirectory, 'presets', PRESET_ID)
  const packageJson = options.packageJson
    ?? join(packageDirectory, 'package.json')
  const presetRoot = options.presetRoot
    ?? join(resolveDshHome(options.env, options.userHome), '.agent-presets')
  const destinationDirectory = join(presetRoot, PRESET_ID)
  const markerPath = join(destinationDirectory, MARKER_FILE)
  const version = readJson(packageJson).version
  const bundledHashes = fileHashes(sourceDirectory)

  mkdirSync(presetRoot, { recursive: true })

  if (!existsSync(destinationDirectory)) {
    mkdirSync(destinationDirectory)
    try {
      copyPresetFiles(sourceDirectory, destinationDirectory)
      writeAtomic(markerPath, markerDocument(version, bundledHashes))
    } catch (error) {
      // Leave any created directory visible rather than deleting a path that
      // another boot may already have adopted. The next run will preserve it
      // as unmanaged and report the incomplete install.
      throw error
    }
    return { status: 'installed', destinationDirectory, version }
  }

  if (lstatSync(destinationDirectory).isSymbolicLink()) {
    return { status: 'preserved', destinationDirectory, reason: 'symlink' }
  }

  if (!existsSync(markerPath)) {
    return { status: 'preserved', destinationDirectory, reason: 'unmanaged' }
  }

  let marker
  try {
    marker = readJson(markerPath)
  } catch {
    return { status: 'preserved', destinationDirectory, reason: 'invalid-marker' }
  }

  if (
    marker.schemaVersion !== MARKER_SCHEMA_VERSION
    || marker.package !== PACKAGE_NAME
  ) {
    return { status: 'preserved', destinationDirectory, reason: 'foreign-marker' }
  }

  let installedHashes
  try {
    installedHashes = fileHashes(destinationDirectory)
  } catch {
    return { status: 'preserved', destinationDirectory, reason: 'modified' }
  }

  if (!hashesEqual(marker.files, installedHashes)) {
    return { status: 'preserved', destinationDirectory, reason: 'modified' }
  }

  if (marker.version === version && hashesEqual(marker.files, bundledHashes)) {
    return { status: 'current', destinationDirectory, version }
  }

  copyPresetFiles(sourceDirectory, destinationDirectory)
  writeAtomic(markerPath, markerDocument(version, bundledHashes))
  return {
    status: 'upgraded',
    destinationDirectory,
    fromVersion: marker.version,
    version,
  }
}
