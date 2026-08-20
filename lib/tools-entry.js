/**
 * dsh-verifier/tools — the agent-preset surface of the verifier capability.
 *
 * The host-plane entry (`@linxin666/dsh-verifier`) owns the sidecar/venv
 * infrastructure and the /api/verifier routes. This entry registers the
 * model-facing half — the nine verifier_* tools plus a
 * judge-workflow prompt section — into whatever scope mounts it, so an agent
 * preset (the `verifier` mode under ~/.dsh/.agent-presets) gets the verifier
 * toolkit without any other preset or the host picking it up.
 *
 * Tool objects come from ./tools.js, which drives the process-level
 * sidecarManager singleton from ./sidecar.js; the run-file handoff in
 * SidecarManager._adopt guarantees one sidecar even if both entries are
 * mounted in different ESM module instances.
 */

import { allTools } from './tools.js'
import { installAgentPipeline } from './agent-pipeline.js'
import { mountOnce } from './mount-once.js'

/** Stable cordis plugin name for this surface. */
export const name = 'verifier-tools'

/** Services the surface registers into (both are registries, host-owned). */
export const inject = ['tools', 'systemPrompt', 'llm', 'agents']

/** Name/order of the prompt section; the host entry no longer announces. */
const SECTION_NAME = 'plugin:verifier'
const SECTION_ORDER = 151

/**
 * Model-facing guidance for Verifier mode: the session is a judge session,
 * the tools are the interface, the numbers must come from the framework.
 */
export const VERIFIER_TOOLS_GUIDANCE =
  '当前会话处于 Verifier 模式（LLM-as-a-Verifier / TurboAgent 模式）：每个普通对话模型 step 都由传输层自动执行“可选 context refinement → N 个并发候选 → 多数投票或 PPT 评审 → 只返回最佳候选 → 异步进度评分”，不依赖主 Agent 主动调用工具。' +
  '本机 Python sidecar 运行未经修改的官方 llm-verifier 0.2.0（固定到已审计的最新上游提交）' +
  '（细粒度奖励 = A–T 20 分 token 的 logprob 期望；Bradley-Terry 软胜率；Probabilistic Pivot Tournament 锦标赛式 best-of-N；' +
  '前缀缓存预热；token/缓存命中精确计量），可用 9 个 verifier_* 工具。' +
  '工作流：拿到「任务 + 多个候选方案」时用 verifier_select 择优（返回最优 index、每候选 score、ranking、比较次数）；' +
  '两两对比用 verifier_compare（双方奖励与 p(a 胜)）；评估一条轨迹的推进过程用 verifier_track（离线检查点曲线）或 verifier_tracker（在线逐 step）；' +
  'backend/model 可由 verifier_config 全局设置，也可在每次工具调用时覆盖；有图像时必须通过 images 参数走官方多模态路径。' +
  '跑官方基准（terminal_bench / terminal_bench_2.1 / swe_bench / medagentbench，预设 full/bo3/bo5）用 verifier_benchmark，' +
  '首次需先 verifier_data 下载约 350MB 基准数据；verifier_status 看环境/后端/用量；verifier_usage 看累计 token；verifier_config 改后端配置。' +
  '所有分数、排名、胜率必须原样转述自工具输出，禁止自行估算或编造；向用户汇报时带上 score/ranking/n_comparisons 与本次 token 用量。' +
  '提醒：每次比较都是真实推理模型调用、消耗 API token，跑基准按美元计——先确认范围（n_evaluations、preset 规模）再跑。' +
  '用户提到「verifier / LLM 评审 / 裁判模型 / 打分 / 选最优 / 轨迹打分 / best-of-N」时即指本模式能力。'

export const apply = mountOnce('@linxin666/dsh-verifier/tools', applyImpl)

function applyImpl(ctx) {
  // Transparent model-step pipeline.  The listener is additionally gated by
  // the initiating session's latest agent-preset/selected event, because the
  // host LLM service itself is shared by every preset.
  ctx.effect(
    () => installAgentPipeline(ctx),
    'verifier-tools: automatic-agent-pipeline',
  )

  // Tools: all nine, one effect so preset teardown removes every one.
  ctx.effect(
    () => {
      const disposers = allTools().map(tool => ctx.tools.register(tool))
      return () => {
        for (const dispose of disposers) dispose()
      }
    },
    'verifier-tools: tools',
  )

  // Judge-workflow prompt section (fiber-scoped; torn down with the preset).
  ctx.effect(
    () => ctx.systemPrompt.section({
      name: SECTION_NAME,
      order: SECTION_ORDER,
      text: VERIFIER_TOOLS_GUIDANCE,
    }),
    'verifier-tools: guidance',
  )
}
