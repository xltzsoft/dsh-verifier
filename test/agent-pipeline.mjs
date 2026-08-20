import assert from 'node:assert/strict'
import {
  candidateEntries,
  formatAction,
  formatHistory,
  isVerifierAgent,
  turboAgentStream,
} from '../lib/agent-pipeline.js'

function response(text) {
  return (async function* () {
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text }
    yield { type: 'block-end', index: 0, block: { type: 'text', text } }
    yield { type: 'usage', usage: { inputTokens: 10, outputTokens: 2 } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  })()
}

function fakeContext(texts) {
  let calls = 0
  return {
    llm: {
      stream() {
        const text = texts[calls++]
        return response(text)
      },
    },
    get calls() { return calls },
  }
}

const original = {
  provider: 'test-provider',
  model: 'test-model',
  system: 'system prompt',
  messages: [{
    id: 'm1',
    role: 'user',
    content: [{ type: 'text', text: 'solve it' }],
    source: { kind: 'user' },
  }],
  sessionId: 'session-1',
}

assert.equal(formatHistory(original), 'SYSTEM: system prompt\n\nUSER: solve it')
assert.equal(formatAction([
  { type: 'block-end', index: 0, block: { type: 'text', text: 'thinking done' } },
  { type: 'block-end', index: 1, block: { type: 'tool-call', name: 'bash', arguments: '{"cmd":"true"}' } },
]), 'thinking done\n[tool_call: bash({"cmd":"true"})]')

assert.deepEqual(candidateEntries(original, {
  models: [
    { provider: 'a', model: 'm1', numCandidates: 2 },
    { provider: 'b', model: 'm2', numCandidates: 1, reasoningEffort: 'high' },
  ],
}), [
  { provider: 'a', model: 'm1', repeat: 0 },
  { provider: 'a', model: 'm1', repeat: 1 },
  { provider: 'b', model: 'm2', reasoningEffort: 'high', repeat: 0 },
])

assert.equal(isVerifierAgent({
  session: {
    header: { agentPreset: 'code' },
    events: [{ type: 'agent-preset/selected', data: { agentPreset: 'verifier' } }],
  },
}), true)

{
  const ctx = fakeContext(['candidate A', 'candidate B', 'candidate C'])
  let payload
  const chunks = []
  for await (const chunk of turboAgentStream(ctx, original, { id: 'session-1' },
    () => { throw new Error('original next must be intercepted') }, {
      config: {
        agent: {
          enabled: true,
          numCandidates: 3,
          majorityVoting: false,
          pivots: 2,
          nVerifications: 1,
          criteria: { 'Task Success': 'Pick the best.' },
          progressMonitor: { enabled: false },
          context: { enabled: false },
        },
      },
      select: async value => {
        payload = value
        return {
          status: 'done',
          result: {
            index: 1,
            scores: [0.2, 0.9, 0.4],
            ranking: [1, 2, 0],
            n_comparisons: 6,
            criteria: ['Task Success'],
            usage: {},
          },
        }
      },
      saveLog: false,
    })) chunks.push(chunk)

  assert.equal(ctx.calls, 3)
  assert.deepEqual(payload.candidates, ['candidate A', 'candidate B', 'candidate C'])
  assert.equal(formatAction(chunks), 'candidate B')
}

{
  const ctx = fakeContext(['same', 'same', 'different'])
  const chunks = []
  for await (const chunk of turboAgentStream(ctx, original, { id: 'session-1' },
    () => { throw new Error('original next must be intercepted') }, {
      config: {
        agent: {
          enabled: true,
          numCandidates: 3,
          majorityVoting: true,
          progressMonitor: { enabled: false },
          context: { enabled: false },
        },
      },
      select: async () => { throw new Error('majority must skip verifier') },
      saveLog: false,
    })) chunks.push(chunk)
  assert.equal(formatAction(chunks), 'same')
}

console.log('agent pipeline tests passed')
