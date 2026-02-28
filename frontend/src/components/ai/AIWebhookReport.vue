<template>
  <div class="ai-webhook-report space-y-4">
    <!-- Executive Summary (markdown portion) -->
    <div v-if="summary" class="prose dark:prose-invert prose-sm max-w-none">
      <AIReportRenderer :content="summary" />
    </div>

    <!-- Structured report from JSON -->
    <template v-if="report">
      <!-- Health Score + Confidence banner -->
      <div class="flex items-center gap-4 p-4 rounded-lg border border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-700/40">
        <div class="flex-shrink-0">
          <div class="relative w-16 h-16">
            <svg viewBox="0 0 36 36" class="w-16 h-16 -rotate-90">
              <circle cx="18" cy="18" r="15.5" fill="none" stroke-width="3"
                class="stroke-gray-200 dark:stroke-gray-600" />
              <circle cx="18" cy="18" r="15.5" fill="none" stroke-width="3"
                stroke-linecap="round"
                :class="healthColor"
                :stroke-dasharray="`${healthDash} 100`" />
            </svg>
            <div class="absolute inset-0 flex items-center justify-center">
              <span class="text-lg font-bold text-gray-900 dark:text-white">{{ report.health_score ?? '?' }}</span>
            </div>
          </div>
        </div>
        <div>
          <div class="text-sm font-semibold text-gray-900 dark:text-white">System Health</div>
          <div class="flex items-center gap-2 mt-0.5">
            <span class="text-xs px-2 py-0.5 rounded-full font-medium"
              :class="confidenceBadge(report.confidence)">
              {{ report.confidence || 'UNKNOWN' }} confidence
            </span>
          </div>
        </div>
      </div>

      <!-- Key Findings -->
      <div v-if="report.key_findings?.length" class="space-y-2">
        <h4 class="text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wider">Key Findings</h4>
        <div v-for="(f, i) in report.key_findings" :key="i"
          class="p-3 rounded-lg border text-sm"
          :class="severityBorder(f.severity)">
          <div class="flex items-start justify-between gap-2">
            <p class="font-medium text-gray-900 dark:text-gray-100">{{ f.finding }}</p>
            <span class="flex-shrink-0 text-xs px-1.5 py-0.5 rounded font-medium"
              :class="severityBadge(f.severity)">{{ f.severity }}</span>
          </div>
          <p v-if="f.evidence" class="mt-1 text-xs text-gray-500 dark:text-gray-400">{{ f.evidence }}</p>
        </div>
      </div>

      <!-- Conviction Diagnostics -->
      <div v-if="report.conviction_diagnostics" class="p-4 rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800">
        <h4 class="text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wider mb-3">Conviction Engine</h4>
        <div class="grid grid-cols-2 gap-3 mb-3">
          <div class="bg-gray-50 dark:bg-gray-700/50 rounded-lg p-3">
            <div class="text-xs text-gray-500 dark:text-gray-400">Conviction Useful?</div>
            <div class="text-sm font-bold mt-1" :class="report.conviction_diagnostics.is_conviction_useful === true ? 'text-green-600 dark:text-green-400' : report.conviction_diagnostics.is_conviction_useful === false ? 'text-red-600 dark:text-red-400' : 'text-amber-600 dark:text-amber-400'">
              {{ report.conviction_diagnostics.is_conviction_useful === true ? 'Yes' : report.conviction_diagnostics.is_conviction_useful === false ? 'No' : 'Unknown' }}
            </div>
          </div>
          <div v-if="report.conviction_diagnostics.recommended_bucket_test?.length" class="bg-gray-50 dark:bg-gray-700/50 rounded-lg p-3">
            <div class="text-xs text-gray-500 dark:text-gray-400">Bucket Test</div>
            <div class="flex flex-wrap gap-1 mt-1">
              <span v-for="b in report.conviction_diagnostics.recommended_bucket_test" :key="b"
                class="text-xs px-1.5 py-0.5 rounded bg-primary-100 dark:bg-primary-900/30 text-primary-700 dark:text-primary-300 font-mono">{{ b }}</span>
            </div>
          </div>
        </div>
        <p v-if="report.conviction_diagnostics.evidence" class="text-xs text-gray-600 dark:text-gray-400">{{ report.conviction_diagnostics.evidence }}</p>
        <div v-if="report.conviction_diagnostics.next_data_needed?.length" class="mt-2">
          <span class="text-xs text-gray-500 dark:text-gray-400">Needs: </span>
          <span v-for="(d, i) in report.conviction_diagnostics.next_data_needed" :key="i" class="text-xs text-amber-600 dark:text-amber-400">
            {{ d }}{{ i < report.conviction_diagnostics.next_data_needed.length - 1 ? ', ' : '' }}
          </span>
        </div>
      </div>

      <!-- Signal Quality -->
      <div v-if="report.signal_quality" class="p-4 rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800">
        <h4 class="text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wider mb-3">Signal Quality</h4>
        <div class="grid grid-cols-2 gap-4">
          <div v-if="report.signal_quality.best?.length">
            <div class="text-xs font-medium text-green-600 dark:text-green-400 mb-1.5">Best Performers</div>
            <div v-for="(b, i) in report.signal_quality.best" :key="i" class="mb-2">
              <div class="flex items-center gap-1.5">
                <span class="text-xs px-1.5 py-0.5 rounded bg-gray-100 dark:bg-gray-700 text-gray-600 dark:text-gray-300 font-mono">{{ b.dimension }}</span>
                <span class="text-sm font-medium text-gray-900 dark:text-gray-100">{{ b.name }}</span>
              </div>
              <p class="text-xs text-gray-500 dark:text-gray-400 mt-0.5">{{ b.why }}</p>
            </div>
          </div>
          <div v-if="report.signal_quality.worst?.length">
            <div class="text-xs font-medium text-red-600 dark:text-red-400 mb-1.5">Worst Performers</div>
            <div v-for="(w, i) in report.signal_quality.worst" :key="i" class="mb-2">
              <div class="flex items-center gap-1.5">
                <span class="text-xs px-1.5 py-0.5 rounded bg-gray-100 dark:bg-gray-700 text-gray-600 dark:text-gray-300 font-mono">{{ w.dimension }}</span>
                <span class="text-sm font-medium text-gray-900 dark:text-gray-100">{{ w.name }}</span>
              </div>
              <p class="text-xs text-gray-500 dark:text-gray-400 mt-0.5">{{ w.why }}</p>
            </div>
          </div>
        </div>
        <div v-if="report.signal_quality.concentration_risk" class="mt-3 pt-3 border-t border-gray-200 dark:border-gray-700">
          <div class="flex items-center gap-2">
            <span class="text-xs text-gray-500 dark:text-gray-400">Concentration Risk:</span>
            <span class="text-xs px-1.5 py-0.5 rounded font-medium" :class="severityBadge(report.signal_quality.concentration_risk.assessment)">
              {{ report.signal_quality.concentration_risk.assessment }}
            </span>
          </div>
          <p v-if="report.signal_quality.concentration_risk.evidence" class="text-xs text-gray-500 dark:text-gray-400 mt-1">{{ report.signal_quality.concentration_risk.evidence }}</p>
        </div>
      </div>

      <!-- Rejection Analysis -->
      <div v-if="report.rejection_analysis" class="p-4 rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800">
        <h4 class="text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wider mb-3">Rejection Analysis</h4>
        <div v-if="report.rejection_analysis.top_rejection_reasons?.length" class="mb-3">
          <div class="text-xs font-medium text-gray-700 dark:text-gray-300 mb-1.5">Top Rejection Reasons</div>
          <div class="space-y-1">
            <div v-for="(r, i) in report.rejection_analysis.top_rejection_reasons" :key="i"
              class="flex items-center justify-between text-sm">
              <span class="text-gray-700 dark:text-gray-300">{{ r.reason }}</span>
              <span class="font-mono text-xs text-gray-500 dark:text-gray-400">{{ r.count }}</span>
            </div>
          </div>
        </div>
        <div v-if="report.rejection_analysis.likely_false_rejections?.length">
          <div class="text-xs font-medium text-amber-600 dark:text-amber-400 mb-1.5">Potential False Rejections</div>
          <div v-for="(fr, i) in report.rejection_analysis.likely_false_rejections" :key="i" class="mb-2 p-2 rounded bg-amber-50 dark:bg-amber-900/10 border border-amber-200 dark:border-amber-800/40">
            <div class="text-sm font-medium text-gray-900 dark:text-gray-100">{{ fr.reason }}</div>
            <p class="text-xs text-gray-600 dark:text-gray-400 mt-0.5">{{ fr.why }}</p>
            <p v-if="fr.what_to_measure_next" class="text-xs text-amber-700 dark:text-amber-300 mt-1">Measure: {{ fr.what_to_measure_next }}</p>
          </div>
        </div>
      </div>

      <!-- Risk Management -->
      <div v-if="report.risk_management" class="p-4 rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800">
        <h4 class="text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wider mb-3">Risk Management</h4>
        <div class="grid grid-cols-2 gap-3 mb-3">
          <div class="bg-gray-50 dark:bg-gray-700/50 rounded-lg p-3">
            <div class="text-xs text-gray-500 dark:text-gray-400">Stop-Loss Quality</div>
            <div class="text-sm font-bold mt-1" :class="qualityColor(report.risk_management.stop_loss_quality)">
              {{ report.risk_management.stop_loss_quality || 'UNKNOWN' }}
            </div>
          </div>
          <div class="bg-gray-50 dark:bg-gray-700/50 rounded-lg p-3">
            <div class="text-xs text-gray-500 dark:text-gray-400">Position Sizing</div>
            <div class="text-sm font-bold mt-1" :class="qualityColor(report.risk_management.position_sizing_quality)">
              {{ report.risk_management.position_sizing_quality || 'UNKNOWN' }}
            </div>
          </div>
        </div>
        <p v-if="report.risk_management.evidence" class="text-xs text-gray-600 dark:text-gray-400">{{ report.risk_management.evidence }}</p>
      </div>

      <!-- Timing Patterns -->
      <div v-if="report.timing_patterns && (report.timing_patterns.best_hours?.length || report.timing_patterns.worst_hours?.length)"
        class="p-4 rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800">
        <h4 class="text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wider mb-3">Timing Patterns</h4>
        <div class="grid grid-cols-2 gap-4">
          <div v-if="report.timing_patterns.best_hours?.length">
            <div class="text-xs font-medium text-green-600 dark:text-green-400 mb-1.5">Best Hours</div>
            <div v-for="(h, i) in report.timing_patterns.best_hours" :key="i" class="text-sm mb-1">
              <span class="font-mono font-medium text-gray-900 dark:text-gray-100">{{ h.hour }}</span>
              <span class="text-gray-500 dark:text-gray-400 text-xs ml-1">${{ h.pnl }} ({{ h.trades }} trades)</span>
              <p v-if="h.note" class="text-xs text-gray-400 dark:text-gray-500">{{ h.note }}</p>
            </div>
          </div>
          <div v-if="report.timing_patterns.worst_hours?.length">
            <div class="text-xs font-medium text-red-600 dark:text-red-400 mb-1.5">Worst Hours</div>
            <div v-for="(h, i) in report.timing_patterns.worst_hours" :key="i" class="text-sm mb-1">
              <span class="font-mono font-medium text-gray-900 dark:text-gray-100">{{ h.hour }}</span>
              <span class="text-gray-500 dark:text-gray-400 text-xs ml-1">${{ h.pnl }} ({{ h.trades }} trades)</span>
              <p v-if="h.note" class="text-xs text-gray-400 dark:text-gray-500">{{ h.note }}</p>
            </div>
          </div>
        </div>
      </div>

      <!-- Prioritized Actions -->
      <div v-if="report.actions?.length" class="space-y-2">
        <h4 class="text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wider">Optimization Actions</h4>
        <div v-for="(a, i) in sortedActions" :key="i"
          class="p-3 rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800">
          <div class="flex items-start justify-between gap-2">
            <div class="flex items-center gap-2">
              <span class="flex-shrink-0 w-5 h-5 rounded-full bg-primary-100 dark:bg-primary-900/30 text-primary-700 dark:text-primary-300 text-xs font-bold flex items-center justify-center">{{ a.priority }}</span>
              <p class="text-sm font-medium text-gray-900 dark:text-gray-100">{{ a.action }}</p>
            </div>
            <span class="flex-shrink-0 text-xs px-1.5 py-0.5 rounded font-medium" :class="impactBadge(a.expected_impact)">{{ a.expected_impact }}</span>
          </div>
          <div class="ml-7 mt-1.5 space-y-1 text-xs text-gray-500 dark:text-gray-400">
            <p v-if="a.why"><span class="font-medium text-gray-600 dark:text-gray-300">Why:</span> {{ a.why }}</p>
            <p v-if="a.how_to_validate"><span class="font-medium text-gray-600 dark:text-gray-300">Validate:</span> {{ a.how_to_validate }}</p>
            <p v-if="a.guardrail"><span class="font-medium text-gray-600 dark:text-gray-300">Guardrail:</span> {{ a.guardrail }}</p>
          </div>
        </div>
      </div>

      <!-- Data Requests -->
      <div v-if="report.data_requests?.length" class="p-3 rounded-lg bg-blue-50 dark:bg-blue-900/10 border border-blue-200 dark:border-blue-800/40">
        <h4 class="text-xs font-semibold text-blue-700 dark:text-blue-300 uppercase tracking-wider mb-2">Data Needed for Deeper Analysis</h4>
        <ul class="space-y-1">
          <li v-for="(d, i) in report.data_requests" :key="i" class="text-xs text-blue-800 dark:text-blue-200 flex items-start gap-1.5">
            <span class="mt-0.5 flex-shrink-0">&#8226;</span>
            {{ d }}
          </li>
        </ul>
      </div>
    </template>

    <!-- Fallback: if no JSON was found, render the whole thing as markdown -->
    <div v-if="!report && !summary">
      <AIReportRenderer :content="content" />
    </div>
  </div>
</template>

<script setup>
import { computed } from 'vue'
import AIReportRenderer from './AIReportRenderer.vue'

const props = defineProps({
  content: {
    type: String,
    required: true
  }
})

/**
 * Extract JSON from the AI response. The response contains an executive summary
 * (markdown) followed by a JSON block.
 */
const parsed = computed(() => {
  if (!props.content) return { summary: '', report: null }

  const text = props.content

  // Try to find a JSON block: ```json ... ``` or raw { ... }
  let jsonStr = null
  let summaryText = text

  // Pattern 1: fenced code block
  const fencedMatch = text.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/)
  if (fencedMatch) {
    jsonStr = fencedMatch[1].trim()
    summaryText = text.slice(0, fencedMatch.index).trim()
  } else {
    // Pattern 2: find the first top-level { and match to the last }
    const firstBrace = text.indexOf('{')
    const lastBrace = text.lastIndexOf('}')
    if (firstBrace !== -1 && lastBrace > firstBrace) {
      const candidate = text.slice(firstBrace, lastBrace + 1)
      // Only treat as JSON if it looks like our schema (has health_score or key_findings)
      if (candidate.includes('"health_score"') || candidate.includes('"key_findings"') || candidate.includes('"actions"')) {
        jsonStr = candidate
        summaryText = text.slice(0, firstBrace).trim()
      }
    }
  }

  let report = null
  if (jsonStr) {
    try {
      report = JSON.parse(jsonStr)
    } catch {
      // JSON parse failed — try to fix common issues (trailing commas)
      try {
        const cleaned = jsonStr.replace(/,\s*([}\]])/g, '$1')
        report = JSON.parse(cleaned)
      } catch {
        // Give up on JSON parsing, fall back to markdown
        report = null
      }
    }
  }

  return { summary: summaryText || '', report }
})

const summary = computed(() => parsed.value.summary)
const report = computed(() => parsed.value.report)

const healthDash = computed(() => {
  const score = report.value?.health_score ?? 0
  return Math.max(0, Math.min(100, score))
})

const healthColor = computed(() => {
  const score = report.value?.health_score ?? 0
  if (score >= 70) return 'stroke-green-500'
  if (score >= 40) return 'stroke-amber-500'
  return 'stroke-red-500'
})

const sortedActions = computed(() => {
  if (!report.value?.actions) return []
  return [...report.value.actions].sort((a, b) => (a.priority || 99) - (b.priority || 99))
})

function confidenceBadge(level) {
  switch (level) {
    case 'HIGH': return 'bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-300'
    case 'MEDIUM': return 'bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-300'
    case 'LOW': return 'bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-300'
    default: return 'bg-gray-100 text-gray-600 dark:bg-gray-700 dark:text-gray-400'
  }
}

function severityBadge(level) {
  switch (level) {
    case 'HIGH': return 'bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-300'
    case 'MEDIUM': return 'bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-300'
    case 'LOW': return 'bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-300'
    default: return 'bg-gray-100 text-gray-600 dark:bg-gray-700 dark:text-gray-400'
  }
}

function severityBorder(level) {
  switch (level) {
    case 'HIGH': return 'border-red-200 dark:border-red-800/40 bg-red-50 dark:bg-red-900/10'
    case 'MEDIUM': return 'border-amber-200 dark:border-amber-800/40 bg-amber-50 dark:bg-amber-900/10'
    case 'LOW': return 'border-green-200 dark:border-green-800/40 bg-green-50 dark:bg-green-900/10'
    default: return 'border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800'
  }
}

function impactBadge(level) {
  switch (level) {
    case 'HIGH': return 'bg-primary-100 text-primary-800 dark:bg-primary-900/30 dark:text-primary-300'
    case 'MEDIUM': return 'bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-300'
    case 'LOW': return 'bg-gray-100 text-gray-600 dark:bg-gray-700 dark:text-gray-400'
    default: return 'bg-gray-100 text-gray-600 dark:bg-gray-700 dark:text-gray-400'
  }
}

function qualityColor(quality) {
  switch (quality) {
    case 'GOOD': return 'text-green-600 dark:text-green-400'
    case 'MIXED': return 'text-amber-600 dark:text-amber-400'
    case 'POOR': return 'text-red-600 dark:text-red-400'
    default: return 'text-gray-500 dark:text-gray-400'
  }
}
</script>
