/** dsh-verifier — small filesystem predicates. */

import { stat } from 'node:fs/promises'

/** True when `path` exists and is a directory. */
export async function isDirectory(path) {
  try {
    return (await stat(path)).isDirectory()
  } catch {
    return false
  }
}

/** True when `path` exists and is a file. */
export async function isFile(path) {
  try {
    return (await stat(path)).isFile()
  } catch {
    return false
  }
}
