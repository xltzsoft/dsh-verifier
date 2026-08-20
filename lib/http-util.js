/**
 * dsh-verifier — tiny HTTP helpers for the route family.
 */

/** One JSON response. */
export function writeJson(res, status, body) {
  const payload = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'referrer-policy': 'no-referrer',
  })
  res.end(payload)
}

/** Cap on JSON request bodies (trajectories can be large). */
const MAX_JSON_BODY_BYTES = 64 * 1024 * 1024

/** Read a JSON request body (undefined when too large or unparseable). */
export async function readJsonBody(req) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > MAX_JSON_BODY_BYTES) return undefined
    chunks.push(chunk)
  }
  if (chunks.length === 0) return {}
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    return undefined
  }
}

/** One query-string parameter (or null). */
export function queryParam(req, name) {
  try {
    return new URL(req.url ?? '/', 'http://localhost').searchParams.get(name)
  } catch {
    return null
  }
}
