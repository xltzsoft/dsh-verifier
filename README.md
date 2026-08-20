# Verifier Mode for DSH

`Verifier 模式` implements the automatic best-of-N control flow from the
official [TurboAgent](https://github.com/llm-as-a-verifier/TurboAgent) project
and adds the complete public API of Stanford/Berkeley's
[LLM-as-a-Verifier](https://github.com/llm-as-a-verifier/llm-as-a-verifier)
to a normal DSH coding session.

The plugin runs the unmodified official Python package at commit
`8db8a114355a9d7fdf9a8d1d5c87f6aeebd18770` (package version 0.2.0). Pinning
the commit, rather than the older PyPI artifact, includes the current
Terminal-Bench 2.0 path and vLLM/SGLang reasoning-logprob fixes.

## Automatic Agent pipeline

Every ordinary model step in a Verifier session is transparently wrapped as:

```text
optional context refinement -> N concurrent candidates -> exact majority shortcut
-> otherwise official Probabilistic Pivot Tournament -> replay the winner only
-> asynchronous progress verification
```

The interception happens at DSH's provider-neutral `llm/stream` boundary. It
does not rely on the main Agent voluntarily calling a verifier tool, and tool
calls from losing candidates are never executed. Session-preset gating leaves
all other DSH modes untouched.

By default the pipeline samples the model selected in the current DSH session
three times. `verifier_config.agent.models` may instead list heterogeneous DSH
`provider`/`model` routes with a `numCandidates` count for each; no generation
API keys are duplicated in this plugin's config. `agent.verifierModel` and the
top-level verifier backend/model independently select the scoring model.

## Install

```bash
git clone https://github.com/xltzsoft/dsh-verifier.git
cd dsh-verifier
mkdir -p ~/.dsh/.agent-presets/verifier
cp presets/verifier/*.yml ~/.dsh/.agent-presets/verifier/
npx @deepseek-ai/dsh plugin --profile web add "file:$PWD"
npx @deepseek-ai/dsh web
```

Create a session and select `Verifier 模式`. Runtime state and credentials are
kept outside the repository under `~/.dsh/`; no API keys belong in this checkout.

## Backend and model configuration

The scoring/verifier model is fully configurable:

- DeepSeek hosted API (`backend=deepseek`)
- Vertex AI (`backend=vertex`)
- Any OpenAI-compatible endpoint that returns token-level logprobs
  (`backend=openai`), including vLLM and SGLang
- A persistent model ID in `verifier_config`, or a different `model` on each
  compare/select/track/benchmark call

Example `verifier_config` patch:

```json
{
  "patch": {
    "backend": "openai",
    "openaiBaseURL": "http://127.0.0.1:8000/v1",
    "openaiApiKey": "EMPTY",
    "model": "Qwen/Qwen3.5-9B"
  }
}
```

With `backend=auto`, resolution order is OpenAI-compatible endpoint,
DeepSeek, then Vertex. Credentials may come from the config, process
environment, or `~/.dsh/.credentials.yaml`. Configuration is re-read before
each scoring operation, so no restart is needed after a change.

## DSH surface

Select `Verifier 模式` when creating a session. It contains the standard
coding-agent tools, the automatic pipeline above, plus these nine mode-scoped
tools for explicit external comparisons, tracking, and benchmarks:

- `verifier_status`, `verifier_config`, `verifier_usage`, `verifier_data`
- `verifier_compare`, `verifier_select`
- `verifier_track`, `verifier_tracker`
- `verifier_benchmark`

Host routes live at `/api/verifier/*`. Persistent state is stored under
`~/.dsh/verifier/`; configuration is `~/.dsh/verifier.json`; the preset is
`~/.dsh/.agent-presets/verifier/`.

## Fidelity and validation

Node sends one job payload to a loopback Python sidecar; the official package
then performs every prompt build, model request, logprob extraction, cache
operation, tournament, and aggregation itself. There is no JS port of the
scoring algorithm and no per-comparison host proxy. The local deterministic
integration suite verifies:

- exact pinned framework identity and official benchmark checkout;
- an arbitrary per-call model ID reaching every backend request;
- multimodal pairwise scoring and A-T reasoning-logprob extraction;
- best-of-N selection, zero-call score-cache replay, and bit-identical output
  between the sidecar and a direct `llm_verifier.select()` call;
- offline/online progress tracking and official Terminal-Bench 2.1 loading.
- preset gating, heterogeneous candidate routing, three-way PPT winner replay,
  and exact-majority short-circuiting in the automatic Agent pipeline.

Run it with:

```bash
npm run check
npm run test:agent
npm run test:integration
```

The suite uses a deterministic local OpenAI-compatible backend and makes no
paid API calls. Published benchmark accuracy requires the same model/settings
and a full paid benchmark run; the plugin intentionally does not claim that a
zero-cost smoke test reproduces those published scores.

Primary Chinese documentation: [README.zh.md](./README.zh.md).
