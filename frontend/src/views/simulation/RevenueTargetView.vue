<template>
  <div class="content-wrapper py-8">
    <!-- Header -->
    <div class="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-4 mb-6">
      <div>
        <h1 class="heading-page">Revenue Target</h1>
        <p class="mt-1 text-sm text-gray-500 dark:text-gray-400">
          Gate & sizer for SPY / QQQ / IWM — Account: Main — Scope: per account
        </p>
      </div>
      <div class="flex items-center gap-3">
        <span
          class="inline-flex items-center gap-2 px-3 py-1.5 rounded-full text-sm font-medium"
          :class="progress?.servicesHealthy !== false
            ? 'bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-400'
            : 'bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-400'"
        >
          <span class="w-2 h-2 rounded-full" :class="progress?.servicesHealthy !== false ? 'bg-green-500' : 'bg-amber-500'" />
          SPY {{ progress?.spyPrice ? formatNum(progress.spyPrice) : '—' }} — {{ progress?.servicesHealthy !== false ? 'Services healthy' : 'Services degraded' }}
        </span>
        <button
          @click="refreshAll"
          :disabled="loading"
          class="btn-secondary text-sm inline-flex items-center gap-2"
        >
          <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
          </svg>
          Refresh {{ refreshedAt }}
        </button>
      </div>
    </div>

    <!-- Tabs -->
    <div class="border-b border-gray-200 dark:border-gray-700 mb-6">
      <nav class="flex gap-1" aria-label="Tabs">
        <button
          v-for="t in tabs"
          :key="t.id"
          @click="activeTab = t.id"
          class="px-4 py-3 text-sm font-medium rounded-t-lg transition-colors"
          :class="activeTab === t.id
            ? 'bg-gray-100 dark:bg-gray-800 text-gray-900 dark:text-white border-b-2 border-primary-500 -mb-px'
            : 'text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-300'"
        >
          {{ t.label }}
        </button>
      </nav>
    </div>

    <!-- Overview Tab -->
    <div v-show="activeTab === 'overview'" class="space-y-6">
      <div class="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <!-- Realized Today (large card) -->
        <div class="lg:col-span-2 bg-white dark:bg-gray-800 rounded-lg p-6 shadow-sm border border-gray-200 dark:border-gray-700">
          <p class="text-xs text-gray-500 dark:text-gray-400 uppercase tracking-wide">Realized Today</p>
          <p
            class="text-4xl font-bold mt-1"
            :class="(progress?.realizedToday ?? 0) >= 0 ? 'text-green-600 dark:text-green-400' : 'text-red-600 dark:text-red-400'"
          >
            {{ (progress?.realizedToday ?? 0) >= 0 ? '+' : '' }}${{ formatNum(progress?.realizedToday ?? 0) }}
          </p>
          <div class="mt-4">
            <div class="flex justify-between text-xs text-gray-500 dark:text-gray-400 mb-1">
              <span>$0</span>
              <span v-if="progress?.target">Target ${{ formatNum(progress.target) }} {{ targetMet ? '✓' : '' }}</span>
            </div>
            <div class="h-3 bg-gray-200 dark:bg-gray-700 rounded-full overflow-hidden">
              <div
                class="h-full rounded-full transition-all"
                :class="targetMet ? 'bg-green-500' : 'bg-primary-500'"
                :style="{ width: progressBarWidth }"
              />
            </div>
          </div>
          <p class="text-sm text-gray-500 dark:text-gray-400 mt-2">
            {{ progress?.tradesCountToday ?? 0 }} of {{ config?.maxTradesPerDay ?? 3 }} trades used today
          </p>
          <p v-if="progress?.target != null" class="text-sm mt-1">
            <span :class="vsTarget >= 0 ? 'text-green-600 dark:text-green-400' : 'text-gray-600 dark:text-gray-400'">
              VS TARGET {{ vsTarget >= 0 ? '+' : '-' }}${{ formatNum(Math.abs(vsTarget)) }}
            </span>
            <span v-if="progress.target > 0 && progress.realizedToday >= progress.target" class="text-gray-500 dark:text-gray-400 ml-1">
              ({{ Math.round((progress.realizedToday / progress.target) * 100) }}x target)
            </span>
          </p>
        </div>

        <!-- Trade Limit card -->
        <div class="bg-white dark:bg-gray-800 rounded-lg p-6 shadow-sm border border-gray-200 dark:border-gray-700">
          <p class="text-xs text-gray-500 dark:text-gray-400 uppercase tracking-wide flex items-center gap-2">
            <span class="w-2 h-2 rounded-full bg-purple-500" />
            Trade Limit
          </p>
          <p class="text-sm font-medium text-gray-900 dark:text-white mt-2">
            {{ progress?.gateAllowed ? `Open — ${progress.tradesCountToday ?? 0}/${config?.maxTradesPerDay ?? 3} used` : 'Max trades per day reached (' + (progress?.tradesCountToday ?? 0) + '/' + (config?.maxTradesPerDay ?? 3) + ' used)' }}
          </p>
          <button
            v-if="!progress?.gateAllowed"
            @click="handleOverride"
            :disabled="overrideLoading"
            class="mt-4 w-full btn-secondary text-sm"
          >
            {{ overrideLoading ? 'Activating...' : 'Override gate for this session →' }}
          </button>
        </div>
      </div>

      <!-- Summary stats -->
      <div class="grid grid-cols-2 sm:grid-cols-4 gap-4">
        <div class="bg-white dark:bg-gray-800 rounded-lg p-4 shadow-sm border border-gray-200 dark:border-gray-700">
          <p class="text-xs text-gray-500 dark:text-gray-400 uppercase">Days Met</p>
          <p class="text-xl font-bold text-green-600 dark:text-green-400">{{ stats?.daysMet ?? 0 }}</p>
        </div>
        <div class="bg-white dark:bg-gray-800 rounded-lg p-4 shadow-sm border border-gray-200 dark:border-gray-700">
          <p class="text-xs text-gray-500 dark:text-gray-400 uppercase">On Track</p>
          <p class="text-xl font-bold text-blue-600 dark:text-blue-400">{{ stats?.daysOnTrack ?? 0 }}</p>
        </div>
        <div class="bg-white dark:bg-gray-800 rounded-lg p-4 shadow-sm border border-gray-200 dark:border-gray-700">
          <p class="text-xs text-gray-500 dark:text-gray-400 uppercase">Behind</p>
          <p class="text-xl font-bold text-red-600 dark:text-red-400">{{ stats?.daysBehind ?? 0 }}</p>
        </div>
        <div class="bg-white dark:bg-gray-800 rounded-lg p-4 shadow-sm border border-gray-200 dark:border-gray-700">
          <p class="text-xs text-gray-500 dark:text-gray-400 uppercase">Avg/Day</p>
          <p class="text-xl font-bold text-gray-900 dark:text-white">${{ formatNum(stats?.avgRealizedPerDay ?? 0) }}</p>
        </div>
      </div>
    </div>

    <!-- Decision Log Tab -->
    <div v-show="activeTab === 'decisions'" class="bg-white dark:bg-gray-800 rounded-lg shadow-sm border border-gray-200 dark:border-gray-700 overflow-hidden">
      <div class="px-6 py-4 border-b border-gray-200 dark:border-gray-700">
        <h2 class="text-lg font-semibold text-gray-900 dark:text-white">Trade Decision Log</h2>
        <p class="text-sm text-gray-500 dark:text-gray-400 mt-0.5">Revenue module decision for each trade — click to inspect pipeline</p>
      </div>
      <div v-if="decisions.length === 0" class="p-12 text-center text-gray-500 dark:text-gray-400 text-sm">
        No decisions yet. Decisions appear when webhooks are processed.
      </div>
      <div v-else class="overflow-x-auto">
        <table class="min-w-full divide-y divide-gray-200 dark:divide-gray-700">
          <thead class="bg-gray-50 dark:bg-gray-700">
            <tr>
              <th class="px-6 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase">Time</th>
              <th class="px-6 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase">Trade ID</th>
              <th class="px-6 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase">Instrument & Action</th>
              <th class="px-6 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase">Source</th>
              <th class="px-6 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase">Trade Type</th>
              <th class="px-6 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase">Reason</th>
              <th class="px-6 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase">Sizing</th>
              <th class="px-6 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase">Decision</th>
            </tr>
          </thead>
          <tbody class="divide-y divide-gray-200 dark:divide-gray-700">
            <tr v-for="d in decisions" :key="d.id" class="hover:bg-gray-50 dark:hover:bg-gray-700/50 cursor-pointer">
              <td class="px-6 py-3 text-sm text-gray-600 dark:text-gray-400">{{ formatTime(d.createdAt) }}</td>
              <td class="px-6 py-3 text-sm text-gray-600 dark:text-gray-400">{{ formatTradeId(d.tradeId) }}</td>
              <td class="px-6 py-3 text-sm font-medium text-gray-900 dark:text-white">
                {{ d.instrumentDesc || d.symbol }} {{ d.action }}
              </td>
              <td class="px-6 py-3 text-sm text-gray-600 dark:text-gray-400">
                <span v-if="d.webhookSource" class="inline-flex px-2 py-0.5 rounded text-xs font-medium bg-slate-100 text-slate-700 dark:bg-slate-700 dark:text-slate-300">
                  {{ d.webhookSource }}
                </span>
                <span v-else>—</span>
              </td>
              <td class="px-6 py-3 text-sm text-gray-600 dark:text-gray-400">{{ d.tradeType || '—' }}</td>
              <td class="px-6 py-3 text-sm text-gray-600 dark:text-gray-400">{{ d.reason || '—' }}</td>
              <td class="px-6 py-3">
                <span
                  class="text-sm font-medium"
                  :class="sizeClass(d.sizeMultiplier)"
                >
                  {{ d.sizeMultiplier != null ? d.sizeMultiplier + 'x' : '—' }}
                </span>
              </td>
              <td class="px-6 py-3">
                <span
                  class="inline-flex px-2.5 py-0.5 rounded text-xs font-medium"
                  :class="d.decision === 'ALLOWED'
                    ? 'bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-400'
                    : 'bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-400'"
                >
                  {{ d.decision }}
                </span>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>

    <!-- Settings Tab -->
    <div v-show="activeTab === 'settings'" class="bg-white dark:bg-gray-800 rounded-lg shadow-sm border border-gray-200 dark:border-gray-700">
      <div class="px-6 py-4 border-b border-gray-200 dark:border-gray-700">
        <h2 class="text-lg font-semibold text-gray-900 dark:text-white">Settings</h2>
        <p class="text-sm text-gray-500 dark:text-gray-400 mt-0.5">Gate, sizer, and account configuration.</p>
      </div>
      <form @submit.prevent="saveConfig" class="p-6 space-y-8">
        <div class="flex items-center justify-between">
          <span class="text-sm font-medium text-gray-700 dark:text-gray-300">Module enabled</span>
          <button
            type="button"
            @click="form.enabled = !form.enabled"
            class="relative inline-flex h-6 w-11 flex-shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors focus:outline-none focus:ring-2 focus:ring-primary-500 focus:ring-offset-2"
            :class="form.enabled ? 'bg-primary-600' : 'bg-gray-200 dark:bg-gray-600'"
          >
            <span class="pointer-events-none inline-block h-5 w-5 transform rounded-full bg-white shadow ring-0 transition-transform" :class="form.enabled ? 'translate-x-5' : 'translate-x-1'" />
          </button>
        </div>

        <div>
          <h3 class="text-sm font-semibold text-gray-900 dark:text-white mb-2">Gate Controls</h3>
          <p class="text-xs text-gray-500 dark:text-gray-400 mb-4">When to block new trade entries.</p>
          <div class="grid grid-cols-1 sm:grid-cols-3 gap-6">
            <div>
              <label class="block text-xs font-medium text-gray-500 dark:text-gray-400 mb-1">Daily Target ($)</label>
              <input v-model.number="form.dailyTarget" type="number" min="0" max="5000" step="1" class="input w-full" />
              <p class="text-xs text-gray-500 dark:text-gray-400 mt-1">0-5000. $0 closes gate immediately.</p>
            </div>
            <div>
              <label class="block text-xs font-medium text-gray-500 dark:text-gray-400 mb-1">Max Trades / Day</label>
              <input v-model.number="form.maxTradesPerDay" type="number" min="1" max="50" class="input w-full" />
              <p class="text-xs text-gray-500 dark:text-gray-400 mt-1">1-50. Hard trade count ceiling.</p>
            </div>
            <div>
              <label class="block text-xs font-medium text-gray-500 dark:text-gray-400 mb-1">Min Credit / Trade ($)</label>
              <input v-model.number="form.minCreditPerTrade" type="number" min="0" max="1000" class="input w-full" disabled />
              <p class="text-xs text-amber-600 dark:text-amber-400 mt-1">Coming soon — Reserved for Strike Optimizer</p>
            </div>
          </div>
        </div>

        <div>
          <h3 class="text-sm font-semibold text-gray-900 dark:text-white mb-2">Allowed Trade Types</h3>
          <p class="text-xs text-gray-500 dark:text-gray-400 mb-4">Only these trade types pass the revenue target gate. Others are blocked.</p>
          <div class="flex flex-wrap gap-4">
            <label class="inline-flex items-center gap-2 cursor-pointer">
              <input v-model="form.allowedTradeTypes" type="checkbox" value="CREDIT_SPREAD" class="rounded border-gray-300" />
              <span class="text-sm text-gray-700 dark:text-gray-300">Credit Spreads</span>
            </label>
            <label class="inline-flex items-center gap-2 cursor-pointer">
              <input v-model="form.allowedTradeTypes" type="checkbox" value="DEBIT_SPREAD" class="rounded border-gray-300" />
              <span class="text-sm text-gray-700 dark:text-gray-300">Debit Spreads</span>
            </label>
            <label class="inline-flex items-center gap-2 cursor-pointer">
              <input v-model="form.allowedTradeTypes" type="checkbox" value="LEAP" class="rounded border-gray-300" />
              <span class="text-sm text-gray-700 dark:text-gray-300">LEAPs (DTE ≥ 365)</span>
            </label>
          </div>
        </div>

        <div>
          <h3 class="text-sm font-semibold text-gray-900 dark:text-white mb-2">Close-Leg Exemption</h3>
          <div class="flex items-center justify-between">
            <p class="text-sm text-gray-600 dark:text-gray-400">Exempt close legs from gate. SELL/CLOSE orders bypass the gate even when closed.</p>
            <button
              type="button"
              @click="form.exemptCloseLegs = !form.exemptCloseLegs"
              class="relative inline-flex h-6 w-11 flex-shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors focus:outline-none"
              :class="form.exemptCloseLegs ? 'bg-purple-600' : 'bg-gray-200 dark:bg-gray-600'"
            >
              <span class="pointer-events-none inline-block h-5 w-5 transform rounded-full bg-white shadow ring-0 transition-transform" :class="form.exemptCloseLegs ? 'translate-x-5' : 'translate-x-1'" />
            </button>
          </div>
        </div>

        <div>
          <h3 class="text-sm font-semibold text-gray-900 dark:text-white mb-2">Sizer Thresholds</h3>
          <p class="text-xs text-gray-500 dark:text-gray-400 mb-4">Size multipliers applied at each progress level.</p>
          <div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-6">
            <div>
              <label class="block text-xs font-medium text-gray-500 dark:text-gray-400 mb-1">Scale-back 1 (%)</label>
              <input v-model.number="form.scaleBack1Pct" type="number" min="0" max="100" class="input w-full" />
              <p class="text-xs text-gray-500 dark:text-gray-400 mt-1">At this % of target → 0.5x size.</p>
            </div>
            <div>
              <label class="block text-xs font-medium text-gray-500 dark:text-gray-400 mb-1">Scale-back 2 (%)</label>
              <input v-model.number="form.scaleBack2Pct" type="number" min="0" max="100" class="input w-full" />
              <p class="text-xs text-gray-500 dark:text-gray-400 mt-1">At this % of target → 0.75x size.</p>
            </div>
            <div>
              <label class="block text-xs font-medium text-gray-500 dark:text-gray-400 mb-1">Aggressive Max</label>
              <input v-model.number="form.aggressiveMax" type="number" min="1" max="2" step="0.05" class="input w-full" />
              <p class="text-xs text-gray-500 dark:text-gray-400 mt-1">Size-up when behind in aggressive mode.</p>
            </div>
            <div>
              <label class="block text-xs font-medium text-gray-500 dark:text-gray-400 mb-1">Aggressive Cap</label>
              <input v-model.number="form.aggressiveCap" type="number" min="1" max="2" step="0.05" class="input w-full" />
              <p class="text-xs text-gray-500 dark:text-gray-400 mt-1">Hard ceiling on aggressive sizing.</p>
            </div>
          </div>
          <p class="text-xs text-gray-500 dark:text-gray-400 mt-4">
            Current sizer map: ≥{{ form.scaleBack1Pct }}% → 0.5x · ≥{{ form.scaleBack2Pct }}% → 0.75x · &lt;{{ form.scaleBack2Pct }}% normal → 1.0x · behind + aggressive → up to {{ form.aggressiveMax }}x (cap {{ form.aggressiveCap }}x)
          </p>
        </div>

        <div class="flex justify-end">
          <button type="submit" :disabled="saving" class="btn-primary">
            {{ saving ? 'Saving...' : 'Save settings' }}
          </button>
        </div>
      </form>
    </div>

    <!-- History Tab -->
    <div v-show="activeTab === 'history'" class="bg-white dark:bg-gray-800 rounded-lg shadow-sm border border-gray-200 dark:border-gray-700 overflow-hidden">
      <div class="px-6 py-4 border-b border-gray-200 dark:border-gray-700">
        <h2 class="text-lg font-semibold text-gray-900 dark:text-white">Daily History</h2>
        <p class="text-sm text-gray-500 dark:text-gray-400 mt-0.5">Last 14 days — timestamps in ET</p>
      </div>
      <div v-if="history.length === 0" class="p-12 text-center text-gray-500 dark:text-gray-400 text-sm">
        No daily history yet. Close some trades to build your progress.
      </div>
      <div v-else class="overflow-x-auto">
        <table class="min-w-full divide-y divide-gray-200 dark:divide-gray-700">
          <thead class="bg-gray-50 dark:bg-gray-700">
            <tr>
              <th class="px-6 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase">Date</th>
              <th class="px-6 py-3 text-right text-xs font-medium text-gray-500 dark:text-gray-400 uppercase">Target</th>
              <th class="px-6 py-3 text-right text-xs font-medium text-gray-500 dark:text-gray-400 uppercase">Realized</th>
              <th class="px-6 py-3 text-right text-xs font-medium text-gray-500 dark:text-gray-400 uppercase">Trades</th>
              <th class="px-6 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase">Override</th>
              <th class="px-6 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase">Status</th>
            </tr>
          </thead>
          <tbody class="divide-y divide-gray-200 dark:divide-gray-700">
            <tr v-for="row in history" :key="row.tradeDate" class="hover:bg-gray-50 dark:hover:bg-gray-700/50">
              <td class="px-6 py-3 text-sm text-gray-900 dark:text-white">{{ formatDate(row.tradeDate) }}</td>
              <td class="px-6 py-3 text-sm text-right text-gray-600 dark:text-gray-400">${{ formatNum(row.target) }}</td>
              <td
                class="px-6 py-3 text-sm text-right font-medium"
                :class="row.realized >= 0 ? 'text-green-600 dark:text-green-400' : 'text-red-600 dark:text-red-400'"
              >
                {{ row.realized >= 0 ? '+' : '' }}${{ formatNum(row.realized) }}
              </td>
              <td class="px-6 py-3 text-sm text-right text-gray-600 dark:text-gray-400">{{ row.tradesCount }}</td>
              <td class="px-6 py-3">
                <span v-if="row.overrideUsed" class="inline-flex px-2 py-0.5 rounded text-xs font-medium bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-400">Used</span>
                <span v-else class="text-gray-400">—</span>
              </td>
              <td class="px-6 py-3">
                <span class="inline-flex px-2 py-0.5 rounded text-xs font-medium" :class="statusClass(row.status)">
                  {{ row.status }}
                </span>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, computed, onMounted, watch } from 'vue'
import { format } from 'date-fns'
import { useSimulationStore } from '@/stores/simulation'

const store = useSimulationStore()
const loading = ref(false)
const saving = ref(false)
const overrideLoading = ref(false)
const activeTab = ref('overview')

const tabs = [
  { id: 'overview', label: 'Overview' },
  { id: 'decisions', label: 'Decision Log' },
  { id: 'settings', label: 'Settings' },
  { id: 'history', label: 'History' },
]

const config = computed(() => store.revenueTargetConfig)
const progress = computed(() => store.revenueTargetProgress)
const history = computed(() => store.revenueTargetHistory || [])
const stats = computed(() => store.revenueTargetStats)
const decisions = computed(() => store.revenueTargetDecisions || [])

const refreshedAt = computed(() => {
  const t = progress.value?.refreshedAt
  return t ? format(new Date(t), 'HH:mm:ss') + ' ET' : ''
})

const targetMet = computed(() => {
  const p = progress.value
  return p && p.target > 0 && (p.realizedToday ?? 0) >= p.target
})

const vsTarget = computed(() => {
  const p = progress.value
  if (!p || p.target == null) return 0
  return (p.realizedToday ?? 0) - p.target
})

const progressBarWidth = computed(() => {
  const p = progress.value
  if (!p || !p.target || p.target <= 0) return '0%'
  const ratio = Math.min(1, (p.realizedToday ?? 0) / p.target)
  return `${Math.round(ratio * 100)}%`
})

const form = ref({
  dailyTarget: 250,
  maxTradesPerDay: 3,
  minCreditPerTrade: 50,
  aggressionMode: 'balanced',
  enabled: true,
  exemptCloseLegs: true,
  allowedTradeTypes: ['CREDIT_SPREAD', 'DEBIT_SPREAD', 'LEAP'],
  scaleBack1Pct: 80,
  scaleBack2Pct: 50,
  aggressiveMax: 1.25,
  aggressiveCap: 1.5,
})

function formatNum(n) {
  if (n == null || isNaN(n)) return '0'
  return Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

function formatTime(iso) {
  if (!iso) return '—'
  return format(new Date(iso), 'HH:mm:ss')
}

function formatTradeId(id) {
  if (id == null) return '—'
  return 'TRD-' + String(id).padStart(4, '0')
}

function formatDate(dateStr) {
  if (!dateStr) return '—'
  try {
    return format(new Date(dateStr + 'T12:00:00'), 'MMM d, yyyy')
  } catch {
    return dateStr
  }
}

function sizeClass(mult) {
  if (mult == null) return 'text-gray-400'
  if (mult === 0) return 'text-red-600 dark:text-red-400'
  if (mult === 1) return 'text-green-600 dark:text-green-400'
  return 'text-amber-600 dark:text-amber-400'
}

function statusClass(status) {
  const map = {
    met: 'bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-400',
    on_track: 'bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-400',
    behind: 'bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-400',
    ahead: 'bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-400',
    pending: 'bg-gray-100 text-gray-800 dark:bg-gray-700 dark:text-gray-300',
  }
  return map[status] || map.pending
}

async function refreshAll() {
  loading.value = true
  try {
    await Promise.all([
      store.fetchRevenueTargetConfig(),
      store.fetchRevenueTargetProgress(),
      store.fetchRevenueTargetHistory(14),
      store.fetchRevenueTargetStats(14),
      store.fetchRevenueTargetDecisions(50),
    ])
  } finally {
    loading.value = false
  }
}

async function handleOverride() {
  overrideLoading.value = true
  try {
    await store.setRevenueTargetOverride(4)
  } catch (err) {
    console.error('Override failed:', err)
  } finally {
    overrideLoading.value = false
  }
}

async function saveConfig() {
  saving.value = true
  try {
    await store.updateRevenueTargetConfig({
      daily_target: form.value.dailyTarget,
      max_trades_per_day: form.value.maxTradesPerDay,
      min_credit_per_trade: form.value.minCreditPerTrade,
      aggression_mode: form.value.aggressionMode,
      enabled: form.value.enabled,
      exempt_close_legs: form.value.exemptCloseLegs,
      allowed_trade_types: Array.isArray(form.value.allowedTradeTypes) ? form.value.allowedTradeTypes : ['CREDIT_SPREAD', 'DEBIT_SPREAD', 'LEAP'],
      scale_back_1_pct: form.value.scaleBack1Pct,
      scale_back_2_pct: form.value.scaleBack2Pct,
      aggressive_max: form.value.aggressiveMax,
      aggressive_cap: form.value.aggressiveCap,
    })
    await store.fetchRevenueTargetProgress()
  } catch (err) {
    console.error('Save config failed:', err)
  } finally {
    saving.value = false
  }
}

watch(activeTab, (tab) => {
  if (tab === 'decisions') store.fetchRevenueTargetDecisions(50)
})

watch(config, (c) => {
  if (c) {
    form.value.dailyTarget = c.dailyTarget
    form.value.maxTradesPerDay = c.maxTradesPerDay
    form.value.minCreditPerTrade = c.minCreditPerTrade
    form.value.aggressionMode = c.aggressionMode
    form.value.enabled = c.enabled
    form.value.exemptCloseLegs = c.exemptCloseLegs ?? true
    form.value.allowedTradeTypes = Array.isArray(c.allowedTradeTypes) ? [...c.allowedTradeTypes] : ['CREDIT_SPREAD', 'DEBIT_SPREAD', 'LEAP']
    form.value.scaleBack1Pct = c.scaleBack1Pct ?? 80
    form.value.scaleBack2Pct = c.scaleBack2Pct ?? 50
    form.value.aggressiveMax = c.aggressiveMax ?? 1.25
    form.value.aggressiveCap = c.aggressiveCap ?? 1.5
  }
}, { immediate: true })

onMounted(() => {
  refreshAll()
})
</script>
