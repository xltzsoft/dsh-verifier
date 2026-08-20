# Verifier 模式：DSH 的 LLM-as-a-Verifier preset

这是一个可直接选择的 DSH 会话模式：保留标准编码代理的全部能力，同时实现官方
[TurboAgent](https://github.com/llm-as-a-verifier/TurboAgent) 的自动 best-of-N Agent 控制流，并接入
[LLM-as-a-Verifier](https://github.com/llm-as-a-verifier/llm-as-a-verifier)。原来拼写错误的
preset、包名和状态目录已经移除，统一改名为 `Verifier 模式`。

插件固定运行官方仓库提交
`8db8a114355a9d7fdf9a8d1d5c87f6aeebd18770`（包版本仍为 0.2.0），不是较旧的 PyPI
构建。这个提交包含当前上游对 Terminal-Bench 2.0 数据路径，以及 vLLM/SGLang
reasoning 字段与 logprob 解析的修复。Python 评分框架没有被改写；DSH 只负责工具、配置、生命周期和
`127.0.0.1` 回环 JSON 编排。

## 自动 Agent 管线

选择「Verifier 模式」后，每一个普通模型 step 都会自动执行：

```text
可选 context refinement → N 个候选（并行或逐路串行）→ 精确多数投票（命中时短路）
→ 否则由官方 Probabilistic Pivot Tournament 择优 → 只回放获胜候选 → 异步进度评分
```

这发生在 DSH 的 `llm/stream` 传输层，不依赖主 Agent 自觉调用 `verifier_*` 工具，也不要求用户先
提供多个候选。候选中的工具调用只有获胜后才会进入会话执行。普通 preset 会被 session 级选择状态严格
隔离，不会被这条管线拦截。

默认并行采样当前 DSH session 已选择的模型 3 次。也可以使用 DSH 中已经配置好的任意 provider/model，
包括混合模型：

```json
{
  "patch": {
    "agent": {
      "models": [
        { "provider": "deepseek", "model": "deepseek-chat", "numCandidates": 2 },
        { "provider": "local", "model": "Qwen/Qwen3.5-9B", "numCandidates": 1 }
      ],
      "candidateScheduling": "sequential",
      "majorityVoting": true,
      "pivots": 2,
      "nVerifications": 1,
      "progressMonitor": { "enabled": true, "nVerifications": 1 }
    }
  }
}
```

将 `agent.models` 设为 `[]` 即恢复“跟随当前 session 模型”。`agent.context` 可启用独立的上下文精炼
模型；`agent.verifierModel` 可单独覆盖评审模型。`agent.candidateScheduling` 支持 `parallel`（默认，
同时发出）和 `sequential`（候选 1 完整结束后才发候选 2）。也可以直接在 DSH
「设置 → Verifier」中切换调度模式和候选数量，下一次普通模型 step 即时生效。

### UI 实时控制台

对话页的 `Verifier` 标签会通过 SSE 实时显示：上下文精炼状态、并行/串行调度方式、每个候选的 provider/model、生成状态、
输出预览与 token 用量、精确多数票或 PPT 裁决方式、分数、胜者、比较次数、回退原因和异步 Progress
结果。进程重启后仍可从 `~/.dsh/verifier/pipeline/` 的审计日志查看本会话历史。

用户只需选择一次「Verifier 模式」并正常描述需求，不需要在提示词中要求 Agent 调用 verifier。准确边界是：

- 只拦截该 preset 发起的普通 LLM step；上下文精炼等带内部 `purpose` 的辅助调用不会递归套娃；
- `agent.enabled=false` 或候选总数小于等于 1 时按配置跳过；
- 命中精确多数时会按 TurboAgent 设计短路，不再花费 PPT 评审调用；
- PPT 不可用时会回退到第一个有效候选，并在 UI 中显式标黄，而不是假装验证成功；
- 自动择优不等于形式化正确性保证；获胜候选执行工具时仍遵循 DSH 的访问模式和权限确认。

## 完整能力

- A–T 20 个评分 token 的 logprob 期望，输出连续 `[0,1]` 奖励；
- 成对 `compare` 与 O(Nk) 的 Probabilistic Pivot Tournament `select`；
- Bradley–Terry 软胜率、完整 ranking、可复现 seed；
- 前缀缓存、磁盘 score cache、精确 input/cached/output/reasoning token 记账；
- 图片路径、URL、base64 的官方多模态评分路径；
- 已完成轨迹的 `track` 与不会偷看未来步骤的在线 `ProgressTracker`；
- 官方 `terminal_bench`、`terminal_bench_2.1`、`swe_bench`、`medagentbench`，以及
  `full` / `bo3` / `bo5` 配置。

## 评审后端与模型可以自定义

支持以下后端：

| backend | 用途 | 必要配置 |
| --- | --- | --- |
| `deepseek` | DeepSeek 托管 API | `DEEPSEEK_API_KEY` 或 `deepseekApiKey` |
| `vertex` | Vertex AI（原生 Gemini API 不提供所需 logprobs） | `VERTEX_API_KEY` 或 `vertexApiKey` |
| `openai` | 任意支持 token 级 `logprobs/top_logprobs` 的 OpenAI 兼容服务，包括 vLLM、SGLang | `openaiBaseURL`，可选 `openaiApiKey` |
| `auto` | 依次寻找 OpenAI 兼容端点、DeepSeek、Vertex | 默认值 |

这里配置的是 verifier 评审模型，与上面的候选生成模型相互独立。全局模型通过 `verifier_config` 持久化：

```json
{
  "patch": {
    "backend": "openai",
    "openaiBaseURL": "http://127.0.0.1:8000/v1",
    "openaiApiKey": "EMPTY",
    "model": "Qwen/Qwen3.5-9B",
    "maxTokens": 32768
  }
}
```

也可以在 `verifier_compare`、`verifier_select`、`verifier_track`、`verifier_tracker start`
或 `verifier_benchmark` 的 `model` 参数中临时覆盖，下一次调用仍使用全局值。配置优先级是：
`~/.dsh/verifier.json` 显式值 → 进程环境 → `~/.dsh/.credentials.yaml`。sidecar 每次评分前
都会重新读取配置，修改后无需重启。

## 九个工具

| 工具 | 作用 |
| --- | --- |
| `verifier_status` | 查看 venv、官方提交、sidecar、后端/model 与累计用量 |
| `verifier_config` | 查看或修改后端、模型、并发、token 上限、密钥和数据目录 |
| `verifier_compare` | 两个候选的细粒度对比，可传 criteria、图片、ground truth、model |
| `verifier_select` | N 个候选的 PPT 择优，返回 index、scores、ranking、比较次数 |
| `verifier_track` | 对完成轨迹的指定检查点生成进度曲线 |
| `verifier_tracker` | start/update/result/stop 在线进度跟踪 |
| `verifier_benchmark` | 运行四个官方 benchmark，支持 full/bo3/bo5 和自定义模型 |
| `verifier_usage` | 查看或清零 token/前缀缓存统计 |
| `verifier_data` | 检查或下载固定提交的官方 benchmark 数据 |

`criteria` 接受内置名、`.md` 路径、`{名称: 描述}` 字典或列表。候选与步骤可以直接传文本，
也可以传绝对路径/`~/` 路径；图片接受路径、URL 或 `{path|url|base64}`。

## 安装与运行

```bash
git clone https://github.com/xltzsoft/dsh-verifier.git
cd dsh-verifier
mkdir -p ~/.dsh/.agent-presets/verifier
cp presets/verifier/*.yml ~/.dsh/.agent-presets/verifier/
npx @deepseek-ai/dsh plugin --profile web add "file:$PWD"
npx @deepseek-ai/dsh web
```

启动后新建会话并选择「Verifier 模式」。首次调用会创建并校验私有 venv。运行时文件均保存在仓库之外：

- preset：`~/.dsh/.agent-presets/verifier/`
- 配置：`~/.dsh/verifier.json`（0600，API 返回时密钥会遮罩）
- 状态、缓存和结果：`~/.dsh/verifier/`
- DSH API：`/api/verifier/*`，仅允许回环请求

不要向本仓库提交 `.env`、`~/.dsh/verifier.json` 或任何 API key。

## 功能与性能验证

自动管线单测不调用外部模型；评分集成测试使用本地确定性的 OpenAI-compatible logprob 服务，不花真实
API token。已覆盖：

1. venv 与 benchmark checkout 都严格匹配固定提交；
2. `custom-model-42` 从 DSH 参数原样到达每一个后端请求；
3. 多模态 compare、reasoning 字段的 A–T logprob 恢复；
4. 三候选 PPT 第一次 24 个模型请求，第二次使用 score cache 为 0 个请求；
5. sidecar 与直接调用官方 `llm_verifier.select()` 的 index、scores、ranking 逐位一致；
6. 离线 track、在线 tracker 均通过；
7. Terminal-Bench 2.1 官方 loader 完整读到 89 个 task，零推理冒烟报告通过。
8. session preset 隔离、异构候选路由、三候选并行/串行调度、PPT 结果回放和多数投票短路均通过。

复跑命令：

```bash
cd dsh-verifier
npm run check
npm run test:agent
npm run test:integration
```

性能边界很明确：Node 到 Python 每个 job 只传一次 JSON，所有模型请求、并发、前缀缓存、score
cache 和数值聚合均在未修改的官方进程内完成，不存在“每次比较再绕回 Node”的开销。缓存重跑实测为
0 个后端调用。论文/README 公布的 SOTA 准确率仍需要使用相同模型与参数完整跑昂贵 benchmark；本地
零成本验证只证明功能、算法路径和缓存行为等价，不虚称已免费复现论文分数。

## Token 与故障提示

- 一个“比较”在 OpenAI-compatible 路径可能包含生成和 score-tag prefill 多个请求；以
  `verifier_usage` 的真实计量为准。
- 完整 benchmark 会产生大量付费调用；先用较小 `n_evaluations` / `bo3`，并使用独立 cache。
- 自建服务必须真的返回 token 级 top-logprobs；只兼容文本响应不够。
- `verifier_status` 会明确显示后端是否 ready、模型来源、官方提交与 sidecar 错误。
- venv 安装日志：`~/.dsh/verifier/venv.log`；benchmark 结果：`~/.dsh/verifier/results/`。
