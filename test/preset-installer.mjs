import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { installBundledPreset, resolveDshHome } from '../lib/preset-installer.js'

const scratch = mkdtempSync(join(tmpdir(), 'dsh-verifier-preset-'))

try {
  const packageDirectory = join(scratch, 'package')
  const sourceDirectory = join(packageDirectory, 'presets', 'verifier')
  const presetRoot = join(scratch, 'dsh-home', '.agent-presets')
  mkdirSync(sourceDirectory, { recursive: true })
  writeFileSync(join(packageDirectory, 'package.json'), '{"version":"1.0.0"}\n')
  writeFileSync(join(sourceDirectory, 'preset.yml'), 'name: Verifier\n')
  writeFileSync(join(sourceDirectory, 'agent.cordis.yml'), '[]\n')

  assert.equal(
    resolveDshHome({ DSH_HOME: `  ${join(scratch, 'custom')}  ` }, scratch),
    join(scratch, 'custom'),
  )
  assert.equal(resolveDshHome({}, scratch), join(scratch, '.dsh'))

  const first = installBundledPreset({ packageDirectory, presetRoot })
  assert.equal(first.status, 'installed')
  assert.equal(
    readFileSync(join(presetRoot, 'verifier', 'preset.yml'), 'utf8'),
    'name: Verifier\n',
  )
  assert.equal(
    installBundledPreset({ packageDirectory, presetRoot }).status,
    'current',
  )

  writeFileSync(join(packageDirectory, 'package.json'), '{"version":"1.1.0"}\n')
  writeFileSync(join(sourceDirectory, 'preset.yml'), 'name: Verifier 1.1\n')
  const upgraded = installBundledPreset({ packageDirectory, presetRoot })
  assert.equal(upgraded.status, 'upgraded')
  assert.equal(upgraded.fromVersion, '1.0.0')
  assert.equal(
    readFileSync(join(presetRoot, 'verifier', 'preset.yml'), 'utf8'),
    'name: Verifier 1.1\n',
  )

  writeFileSync(join(presetRoot, 'verifier', 'agent.cordis.yml'), '# user edit\n[]\n')
  writeFileSync(join(packageDirectory, 'package.json'), '{"version":"1.2.0"}\n')
  writeFileSync(join(sourceDirectory, 'agent.cordis.yml'), '- id: next\n')
  const preserved = installBundledPreset({ packageDirectory, presetRoot })
  assert.deepEqual(
    { status: preserved.status, reason: preserved.reason },
    { status: 'preserved', reason: 'modified' },
  )
  assert.equal(
    readFileSync(join(presetRoot, 'verifier', 'agent.cordis.yml'), 'utf8'),
    '# user edit\n[]\n',
  )

  const unmanagedRoot = join(scratch, 'unmanaged')
  mkdirSync(join(unmanagedRoot, 'verifier'), { recursive: true })
  writeFileSync(join(unmanagedRoot, 'verifier', 'preset.yml'), 'name: Mine\n')
  const unmanaged = installBundledPreset({ packageDirectory, presetRoot: unmanagedRoot })
  assert.deepEqual(
    { status: unmanaged.status, reason: unmanaged.reason },
    { status: 'preserved', reason: 'unmanaged' },
  )

  console.log('preset installer tests OK')
} finally {
  rmSync(scratch, { recursive: true, force: true })
}
