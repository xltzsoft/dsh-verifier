(() => {
// DSH serves the same package client bundle for both the host entry and the
// preset-scoped `./tools` entry. Register under the URL's requested module id;
// the tools face is deliberately a client no-op so the host owns one UI tab.
const verifierClientPath = new URL(document.currentScript.src).pathname
const verifierClientId = decodeURIComponent(verifierClientPath
  .replace(/^\/plugins\//, '')
  .replace(/\/client\.js$/, ''))

window.__ModuleLoader__.load({
  id: verifierClientId,
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    const React = require('react')
    const h = React.createElement
    const { useEffect, useMemo, useState } = React
    const STYLE_ID = 'dsh-verifier-client-style'

    const styles = `
      .vf-root{box-sizing:border-box;height:100%;min-height:0;overflow:auto;padding:20px 24px 40px;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font-family:var(--dsw-font-family);}
      .vf-shell{width:min(1120px,100%);margin:0 auto;display:flex;flex-direction:column;gap:16px;}
      .vf-hero{display:flex;align-items:flex-start;justify-content:space-between;gap:20px;padding:20px;border:1px solid var(--dsw-alias-border-l1);border-radius:16px;background:linear-gradient(135deg,color-mix(in srgb,var(--dsw-alias-bg-layer-2) 82%,#635bff 18%),var(--dsw-alias-bg-layer-2));}
      .vf-title{margin:0 0 7px;font-size:20px;line-height:1.2;letter-spacing:-.02em}.vf-subtitle{margin:0;max-width:720px;color:var(--dsw-alias-label-secondary);font-size:13px;line-height:1.65}
      .vf-mode{display:inline-flex;align-items:center;gap:7px;flex:none;padding:7px 10px;border-radius:999px;font-size:12px;font-weight:700;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-base)}
      .vf-mode:before,.vf-dot{content:'';width:7px;height:7px;border-radius:50%;background:#16a56a;box-shadow:0 0 0 3px color-mix(in srgb,#16a56a 18%,transparent)}.vf-mode[data-off]:before{background:#e29b28;box-shadow:0 0 0 3px color-mix(in srgb,#e29b28 18%,transparent)}
      .vf-stagebar{display:grid;grid-template-columns:repeat(5,minmax(0,1fr));gap:8px}.vf-stage{position:relative;min-width:0;padding:12px;border:1px solid var(--dsw-alias-border-l1);border-radius:12px;background:var(--dsw-alias-bg-layer-2)}
      .vf-stage-num{display:flex;align-items:center;justify-content:center;width:23px;height:23px;margin-bottom:8px;border-radius:50%;font-size:11px;font-weight:800;color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-interactive-bg-hover)}.vf-stage-name{font-size:12px;font-weight:700;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.vf-stage-note{margin-top:3px;color:var(--dsw-alias-label-tertiary);font-size:10px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
      .vf-stage[data-state='active']{border-color:#6d63e8;background:color-mix(in srgb,var(--dsw-alias-bg-layer-2) 88%,#6d63e8 12%)}.vf-stage[data-state='active'] .vf-stage-num{color:white;background:#6d63e8;animation:vf-pulse 1.6s ease-in-out infinite}.vf-stage[data-state='done'] .vf-stage-num{color:white;background:#16a56a}.vf-stage[data-state='warn']{border-color:#d89a35}.vf-stage[data-state='warn'] .vf-stage-num{color:white;background:#d89a35}
      @keyframes vf-pulse{50%{box-shadow:0 0 0 6px color-mix(in srgb,#6d63e8 12%,transparent)}}
      .vf-card{border:1px solid var(--dsw-alias-border-l1);border-radius:14px;background:var(--dsw-alias-bg-layer-2);overflow:hidden}.vf-card-head{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:14px 16px;border-bottom:1px solid var(--dsw-alias-border-l1)}.vf-card-title{margin:0;font-size:14px}.vf-meta{display:flex;align-items:center;gap:8px;flex-wrap:wrap;color:var(--dsw-alias-label-tertiary);font-size:11px}.vf-pill{display:inline-flex;align-items:center;gap:5px;padding:4px 8px;border-radius:999px;color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-interactive-bg-hover);font-size:11px;font-weight:650}.vf-pill[data-tone='good']{color:#087c4d;background:color-mix(in srgb,#16a56a 14%,var(--dsw-alias-bg-base))}.vf-pill[data-tone='warn']{color:#9c6512;background:color-mix(in srgb,#e29b28 17%,var(--dsw-alias-bg-base))}.vf-pill[data-tone='live']{color:#5348ce;background:color-mix(in srgb,#6d63e8 14%,var(--dsw-alias-bg-base))}
      .vf-selection{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:1px;background:var(--dsw-alias-border-l1);border-bottom:1px solid var(--dsw-alias-border-l1)}.vf-stat{padding:13px 16px;background:var(--dsw-alias-bg-layer-2)}.vf-stat-label{color:var(--dsw-alias-label-tertiary);font-size:10px;text-transform:uppercase;letter-spacing:.06em}.vf-stat-value{margin-top:5px;font-size:13px;font-weight:700;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
      .vf-candidates{display:grid;grid-template-columns:repeat(auto-fit,minmax(250px,1fr));gap:10px;padding:14px}.vf-candidate{min-width:0;border:1px solid var(--dsw-alias-border-l1);border-radius:11px;background:var(--dsw-alias-bg-base);overflow:hidden}.vf-candidate[data-winner]{border-color:#16a56a;box-shadow:inset 0 3px #16a56a}.vf-candidate[data-failed]{border-color:color-mix(in srgb,#d74b4b 45%,var(--dsw-alias-border-l1))}.vf-candidate-head{display:flex;align-items:flex-start;justify-content:space-between;gap:8px;padding:11px 12px 8px}.vf-candidate-name{font-size:12px;font-weight:750;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.vf-candidate-sub{margin-top:3px;color:var(--dsw-alias-label-tertiary);font-size:10px}.vf-candidate-body{padding:0 12px 12px}.vf-preview{margin:0;max-height:128px;overflow:auto;white-space:pre-wrap;word-break:break-word;color:var(--dsw-alias-label-secondary);font:11px/1.55 var(--dsw-font-family);scrollbar-width:thin}.vf-empty-preview{color:var(--dsw-alias-label-tertiary);font-size:11px;font-style:italic}.vf-error{margin-top:8px;color:#c23e3e;font-size:10px;word-break:break-word}
      .vf-history{display:flex;flex-direction:column}.vf-run{border-top:1px solid var(--dsw-alias-border-l1)}.vf-run:first-child{border-top:0}.vf-run summary{display:grid;grid-template-columns:minmax(160px,1fr) minmax(130px,.7fr) 90px 90px;align-items:center;gap:12px;padding:12px 16px;cursor:pointer;font-size:12px;list-style:none}.vf-run summary::-webkit-details-marker{display:none}.vf-run summary:hover{background:var(--dsw-alias-interactive-bg-hover)}.vf-run-title{font-weight:700;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.vf-run-detail{padding:0 14px 14px}.vf-muted{color:var(--dsw-alias-label-tertiary)}
      .vf-empty{padding:38px 20px;text-align:center;border:1px dashed var(--dsw-alias-border-l2);border-radius:14px;color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-bg-layer-2)}.vf-empty strong{display:block;margin-bottom:7px;color:var(--dsw-alias-label-primary)}.vf-loading{padding:30px;text-align:center;color:var(--dsw-alias-label-secondary)}
      @media(max-width:800px){.vf-root{padding:14px 12px 30px}.vf-hero{flex-direction:column}.vf-stagebar{grid-template-columns:repeat(2,minmax(0,1fr))}.vf-selection{grid-template-columns:repeat(2,minmax(0,1fr))}.vf-run summary{grid-template-columns:1fr 90px}.vf-run summary>*:nth-child(2),.vf-run summary>*:nth-child(4){display:none}}
      @media(prefers-reduced-motion:reduce){.vf-stage[data-state='active'] .vf-stage-num{animation:none}}
    `

    const statusText = {
      refining: '正在精炼上下文', generating: '正在并发生成', voting: '正在检查多数票',
      verifying: 'PPT 正在裁决', replaying: '正在回放胜者', complete: '已完成',
      fallback: '已回退', failed: '失败', pending: '等待', running: '运行中',
      done: '完成', disabled: '未启用',
    }
    const methodText = {
      majority: '精确多数票', pivot_tournament: 'PPT 锦标赛',
      'fallback-first': '验证失败，回退首个', 'single-success': '唯一成功候选',
    }

    function ensureStyles() {
      if (document.getElementById(STYLE_ID)) return
      const style = document.createElement('style')
      style.id = STYLE_ID
      style.textContent = styles
      document.head.appendChild(style)
    }

    function fmtDuration(ms) {
      if (!Number.isFinite(ms)) return '—'
      return ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)} s`
    }

    function fmtTime(value) {
      if (!value) return '—'
      const date = new Date(value)
      return Number.isNaN(date.getTime()) ? '—' : date.toLocaleString([], { hour12: false })
    }

    function modelName(candidate) {
      return [candidate?.provider, candidate?.model].filter(Boolean).join(' / ') || '默认模型'
    }

    function methodName(activity) {
      const method = activity?.selection?.method
      return methodText[method] || method || '等待裁决'
    }

    function progressLabel(progress) {
      if (!progress?.enabled) return '未启用'
      if (progress.error) return '评估失败'
      if (progress.score !== undefined) return `得分 ${Number(progress.score).toFixed(2)}`
      if (progress.status === 'pending') return '等待回放'
      if (progress.status === 'running') return '异步评估中'
      return progress.status || '完成'
    }

    function stageState(activity, step) {
      if (!activity) return 'pending'
      const status = activity.status
      if (step === 0) {
        if (!activity.contextRefinement?.enabled) return 'done'
        return status === 'refining' ? 'active' : activity.contextRefinement?.error ? 'warn' : 'done'
      }
      if (step === 1) {
        if (status === 'refining') return 'pending'
        if (status === 'generating') return 'active'
        return activity.candidates?.some(candidate => candidate.status === 'failed') && !activity.validCandidates ? 'warn' : 'done'
      }
      if (step === 2) {
        if (['voting', 'verifying'].includes(status)) return 'active'
        if (!activity.selection) return ['failed', 'refining', 'generating'].includes(status) ? 'pending' : 'active'
        return activity.selection.method === 'fallback-first' ? 'warn' : 'done'
      }
      if (step === 3) {
        if (status === 'replaying') return 'active'
        if (['complete', 'fallback'].includes(status)) return 'done'
        return status === 'failed' ? 'warn' : 'pending'
      }
      if (!activity.progressMonitor?.enabled) return ['complete', 'fallback'].includes(status) ? 'done' : 'pending'
      if (activity.progressMonitor.error) return 'warn'
      if (activity.progressMonitor.status === 'running') return 'active'
      if (activity.progressMonitor.status === 'pending') return 'pending'
      return 'done'
    }

    function StageBar({ activity }) {
      const candidates = activity?.candidatesExpected ?? activity?.candidates?.length ?? 0
      const stages = [
        ['上下文', activity?.contextRefinement?.enabled ? '自动精炼' : '按配置跳过'],
        ['并发候选', candidates ? `${candidates} 路生成` : 'Best-of-N'],
        ['Verifier', activity?.selection ? methodName(activity) : '多数票 / PPT'],
        ['胜者回放', Number.isInteger(activity?.bestIndex) ? `候选 #${activity.bestIndex + 1}` : '仅执行胜者'],
        ['Progress', progressLabel(activity?.progressMonitor)],
      ]
      return h('div', { className: 'vf-stagebar', 'aria-label': 'Verifier 自动流程' },
        stages.map((stage, index) => h('div', {
          className: 'vf-stage', key: stage[0], 'data-state': stageState(activity, index),
        },
        h('div', { className: 'vf-stage-num' }, stageState(activity, index) === 'done' ? '✓' : String(index + 1)),
        h('div', { className: 'vf-stage-name' }, stage[0]),
        h('div', { className: 'vf-stage-note' }, stage[1]))))
    }

    function CandidateCard({ candidate, activity }) {
      const winner = candidate.index === activity.bestIndex
      const score = activity.candidateScores?.[candidate.index]
      const tokens = (candidate.usage?.inputTokens ?? 0) + (candidate.usage?.outputTokens ?? 0)
      return h('div', {
        className: 'vf-candidate',
        'data-winner': winner ? '' : undefined,
        'data-failed': candidate.status === 'failed' ? '' : undefined,
      },
      h('div', { className: 'vf-candidate-head' },
        h('div', { style: { minWidth: 0 } },
          h('div', { className: 'vf-candidate-name' }, `#${candidate.index + 1} · ${modelName(candidate)}`),
          h('div', { className: 'vf-candidate-sub' }, [
            statusText[candidate.status] || candidate.status || '等待',
            tokens ? `${tokens} tokens` : null,
          ].filter(Boolean).join(' · '))),
        winner
          ? h('span', { className: 'vf-pill', 'data-tone': 'good' }, '胜者')
          : score !== null && score !== undefined
            ? h('span', { className: 'vf-pill' }, `分数 ${Number(score).toFixed(2)}`)
            : null),
      h('div', { className: 'vf-candidate-body' },
        candidate.actionPreview
          ? h('pre', { className: 'vf-preview' }, candidate.actionPreview)
          : h('div', { className: 'vf-empty-preview' }, candidate.status === 'running' ? '候选流生成中…' : '尚无输出'),
        candidate.error ? h('div', { className: 'vf-error' }, candidate.error) : null))
    }

    function ActivityCard({ activity, live, compact = false }) {
      const candidates = activity.candidates ?? []
      const comparisons = activity.selection?.nComparisons ?? activity.selection?.n_comparisons
      return h('section', { className: 'vf-card' },
        h('div', { className: 'vf-card-head' },
          h('div', null,
            h('h3', { className: 'vf-card-title' }, live ? '当前自动验证' : '最近一次验证'),
            h('div', { className: 'vf-meta', style: { marginTop: '5px' } },
              h('span', null, fmtTime(activity.startedAt ?? activity.timestamp)),
              h('span', null, activity.id ? `ID ${String(activity.id).slice(-8)}` : ''))),
          h('span', {
            className: 'vf-pill',
            'data-tone': live && !['complete', 'fallback', 'failed'].includes(activity.status) ? 'live'
              : activity.status === 'fallback' || activity.status === 'failed' ? 'warn' : 'good',
          }, live && !['complete', 'fallback', 'failed'].includes(activity.status)
            ? h(React.Fragment, null, h('span', { className: 'vf-dot' }), statusText[activity.status] || activity.status)
            : statusText[activity.status] || activity.status || '已记录')),
        h('div', { className: 'vf-selection' },
          h('div', { className: 'vf-stat' }, h('div', { className: 'vf-stat-label' }, '裁决方式'), h('div', { className: 'vf-stat-value' }, methodName(activity))),
          h('div', { className: 'vf-stat' }, h('div', { className: 'vf-stat-label' }, '候选'), h('div', { className: 'vf-stat-value' }, `${activity.validCandidates ?? candidates.filter(item => item.valid).length}/${activity.candidatesExpected ?? candidates.length} 有效`)),
          h('div', { className: 'vf-stat' }, h('div', { className: 'vf-stat-label' }, '比较次数'), h('div', { className: 'vf-stat-value' }, comparisons ?? '0')),
          h('div', { className: 'vf-stat' }, h('div', { className: 'vf-stat-label' }, '耗时'), h('div', { className: 'vf-stat-value' }, fmtDuration(activity.elapsedMs)))),
        !compact && candidates.length
          ? h('div', { className: 'vf-candidates' }, candidates.map(candidate => h(CandidateCard, { key: candidate.index, candidate, activity })))
          : null,
        activity.selection?.error ? h('div', { className: 'vf-error', style: { padding: '0 16px 14px' } }, `Verifier 回退原因：${activity.selection.error}`) : null)
    }

    function History({ runs }) {
      if (!runs.length) return null
      return h('section', { className: 'vf-card' },
        h('div', { className: 'vf-card-head' }, h('h3', { className: 'vf-card-title' }, '本会话历史')),
        h('div', { className: 'vf-history' }, runs.map(run => h('details', { className: 'vf-run', key: run.id },
          h('summary', null,
            h('span', { className: 'vf-run-title' }, methodName(run)),
            h('span', { className: 'vf-muted' }, modelName(run.bestModel)),
            h('span', null, `${run.candidatesExpected ?? run.candidates?.length ?? 0} 候选`),
            h('span', { className: 'vf-muted' }, fmtDuration(run.elapsedMs))),
          h('div', { className: 'vf-run-detail' }, h(ActivityCard, { activity: run, compact: false, live: false }))))))
    }

    function VerifierView({ sessionId, isVerifierMode }) {
      const [data, setData] = useState(null)
      const [error, setError] = useState('')

      useEffect(() => {
        let alive = true
        let loading = false
        const load = async () => {
          if (loading) return
          loading = true
          try {
            const response = await fetch(`/api/verifier/pipeline?sessionId=${encodeURIComponent(sessionId)}&limit=30`, { cache: 'no-store' })
            if (!response.ok) throw new Error(`HTTP ${response.status}`)
            const next = await response.json()
            if (alive) { setData(next); setError('') }
          } catch (reason) {
            if (alive) setError(reason?.message || String(reason))
          } finally { loading = false }
        }
        load()
        const events = new EventSource('/api/verifier/pipeline/events')
        events.onmessage = load
        const timer = setInterval(load, 5_000)
        return () => { alive = false; clearInterval(timer); events.close() }
      }, [sessionId])

      const view = useMemo(() => {
        const liveRuns = data?.activities ?? []
        const history = data?.history ?? []
        const activity = liveRuns[0] ?? history[0] ?? null
        const ids = new Set(liveRuns.map(run => run.id))
        return { activity, live: Boolean(liveRuns[0]), history: history.filter(run => run.id !== activity?.id && !ids.has(run.id)) }
      }, [data])

      return h('div', { className: 'vf-root' }, h('div', { className: 'vf-shell' },
        h('header', { className: 'vf-hero' },
          h('div', null,
            h('h2', { className: 'vf-title' }, 'LLM-as-a-Verifier 控制台'),
            h('p', { className: 'vf-subtitle' }, isVerifierMode
              ? '普通模型步骤会被自动接管：并发生成候选，先检查精确多数票，否则交给 PPT 裁决，只回放胜者。你只需描述需求，不需要在提示词里人工引导 verifier。'
              : '当前会话未选择 Verifier 模式。切换到 Verifier 模式后，普通模型步骤才会进入自动验证管线。')),
          h('span', { className: 'vf-mode', 'data-off': isVerifierMode ? undefined : '' }, isVerifierMode ? '全自动管线已接管' : '当前未接管')),
        h(StageBar, { activity: view.activity }),
        error ? h('div', { className: 'vf-empty' }, h('strong', null, '暂时无法读取流程状态'), error) : null,
        !data && !error ? h('div', { className: 'vf-loading' }, '正在连接 Verifier 状态流…') : null,
        data && !view.activity ? h('div', { className: 'vf-empty' },
          h('strong', null, isVerifierMode ? '还没有验证记录' : '请选择 Verifier 模式'),
          isVerifierMode ? '直接在“对话”里提出任务；第一步模型调用开始后，这里会实时出现所有候选和裁决阶段。' : '模式切换后无需额外提示词，下一条普通请求会自动进入流程。') : null,
        view.activity ? h(ActivityCard, { activity: view.activity, live: view.live }) : null,
        h(History, { runs: view.history })) )
    }

    const isToolsSurface = verifierClientId.endsWith('/tools')
    const inject = isToolsSurface ? [] : ['slots', 'sessions']
    function apply(ctx) {
      if (isToolsSurface) return
      ensureStyles()
      ctx.slots.inject('conversation.view', () => ctx.slots.register({
        name: 'conversation.view',
        id: 'verifier',
        order: 20,
        label: () => 'Verifier',
        inject: (sessionId) => ({
          isVerifierMode: ctx.sessions.list.getSnapshot().byId[sessionId]?.agentPreset === 'verifier',
        }),
      }, VerifierView))
    }

    exports.apply = apply
    exports.inject = inject
    return module.exports
  },
})
})()
