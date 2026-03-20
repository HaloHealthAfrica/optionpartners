<template>
  <div class="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
    <!-- Header -->
    <div class="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-4 mb-6">
      <div>
        <h1 class="text-2xl font-bold text-gray-900 dark:text-white">Data Provider Validation</h1>
        <p class="mt-1 text-sm text-gray-500 dark:text-gray-400">
          Scheduled pulls: Tradier · Tastytrade · Internal Proxy
        </p>
      </div>
      <div class="flex items-center gap-3">
        <span
          v-if="alerts.length > 0"
          class="inline-flex items-center gap-2 px-3 py-1.5 rounded-full text-sm font-medium bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-400"
        >
          <span class="w-2 h-2 rounded-full bg-red-500" />
          {{ alerts.length }} alert{{ alerts.length !== 1 ? 's' : '' }}
        </span>
        <span class="text-sm text-gray-500 dark:text-gray-400">
          {{ formatET(new Date()) }} — {{ formatDateShort(new Date()) }}
        </span>
        <button
          @click="refreshAll"
          :disabled="loading"
          class="btn-secondary text-sm inline-flex items-center gap-2"
        >
          <ArrowPathIcon class="h-4 w-4" :class="{ 'animate-spin': loading }" />
          Refresh
        </button>
      </div>
    </div>

    <!-- Alert Banners -->
    <div v-if="alerts.length > 0" class="space-y-3 mb-6">
      <div
        v-for="a in alerts"
        :key="a.id"
        class="flex items-center justify-between rounded-lg px-4 py-3 border"
        :class="a.severity === 'error'
          ? 'bg-red-50 dark:bg-red-900/20 border-red-200 dark:border-red-800'
          : 'bg-amber-50 dark:bg-amber-900/20 border-amber-200 dark:border-amber-800'"
      >
        <p class="text-sm font-medium" :class="a.severity === 'error' ? 'text-red-800 dark:text-red-200' : 'text-amber-800 dark:text-amber-200'">
          {{ a.message }}
        </p>
        <div class="flex items-center gap-3">
          <span class="text-xs text-gray-500 dark:text-gray-400">{{ formatET(a.triggered_at) }}</span>
          <button
            @click="dismissAlert(a.id)"
            class="text-gray-400 hover:text-gray-600 dark:hover:text-gray-300"
            aria-label="Dismiss"
          >
            <XMarkIcon class="h-5 w-5" />
          </button>
        </div>
      </div>
    </div>

    <!-- Freshness Strip -->
    <div class="grid grid-cols-2 sm:grid-cols-4 gap-4 mb-6">
      <div
        v-for="f in freshness"
        :key="f.dataType"
        class="bg-white dark:bg-gray-800 rounded-lg p-4 border border-gray-200 dark:border-gray-700"
      >
        <div class="text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wide mb-1">
          {{ f.label }}
        </div>
        <div class="flex items-center gap-2">
          <span
            class="text-lg font-semibold"
            :class="f.stale ? 'text-amber-600 dark:text-amber-400' : 'text-green-600 dark:text-green-400'"
          >
            {{ f.lastSuccessAt ? formatET(f.lastSuccessAt) : '—' }}
          </span>
          <span
            v-if="f.stale"
            class="inline-flex px-2 py-0.5 rounded text-xs font-bold bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-400"
          >
            STALE
          </span>
        </div>
        <div class="text-xs text-gray-500 dark:text-gray-400 mt-0.5">{{ formatProvider(f.provider) }}</div>
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
          <span v-if="t.id === 'alerts' && alerts.length > 0" class="ml-1.5 text-xs">({{ alerts.length }})</span>
        </button>
      </nav>
    </div>

    <!-- Today's Runs Tab -->
    <div v-show="activeTab === 'today'" class="space-y-4">
      <div class="flex flex-wrap items-center gap-4 mb-4">
        <div class="flex items-center gap-2">
          <span class="text-sm text-gray-500 dark:text-gray-400">Filter:</span>
          <select
            v-model="filterStatus"
            class="rounded border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 text-gray-900 dark:text-white text-sm py-1.5 px-2"
          >
            <option value="all">All statuses</option>
            <option value="pending">Pending</option>
            <option value="running">Running</option>
            <option value="passed">Passed</option>
            <option value="partial">Partial</option>
            <option value="failed">Failed</option>
          </select>
          <select
            v-model="filterProvider"
            class="rounded border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 text-gray-900 dark:text-white text-sm py-1.5 px-2"
          >
            <option value="all">All providers</option>
            <option value="tradier">Tradier</option>
            <option value="tastytrade">Tastytrade</option>
            <option value="internal_proxy">Internal Proxy</option>
          </select>
        </div>
        <span class="text-sm text-gray-500 dark:text-gray-400">
          {{ filteredRuns.length }} of {{ runs.length }} runs
        </span>
      </div>

      <div class="bg-white dark:bg-gray-800 rounded-lg shadow overflow-hidden border border-gray-200 dark:border-gray-700">
        <table class="min-w-full divide-y divide-gray-200 dark:divide-gray-700">
          <thead class="bg-gray-50 dark:bg-gray-700">
            <tr>
              <th class="px-4 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-300 uppercase">Time</th>
              <th class="px-4 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-300 uppercase">Status</th>
              <th class="px-4 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-300 uppercase">Jobs</th>
              <th class="px-4 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-300 uppercase">Records</th>
              <th class="px-4 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-300 uppercase">Avg Lat</th>
              <th class="px-4 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-300 uppercase">Ran At</th>
              <th class="px-4 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-300 uppercase">Action</th>
            </tr>
          </thead>
          <tbody class="divide-y divide-gray-200 dark:divide-gray-700">
            <template v-for="run in filteredRuns" :key="run.id">
              <tr
                @click="toggleExpand(run.id)"
                class="hover:bg-gray-50 dark:hover:bg-gray-700/50 cursor-pointer transition-colors"
              >
                <td class="px-4 py-3 text-sm font-medium text-gray-900 dark:text-white">{{ formatTime(run.scheduledAt) }} ET</td>
                <td class="px-4 py-3">
                  <span :class="statusClass(run.status)" class="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-xs font-medium">
                    <span class="w-1.5 h-1.5 rounded-full" :class="statusDotClass(run.status)" />
                    {{ run.status }}
                  </span>
                </td>
                <td class="px-4 py-3 text-xs text-gray-600 dark:text-gray-300">
                  <div class="flex flex-wrap gap-1">
                    <span
                      v-for="j in run.jobs"
                      :key="j.id"
                      :class="j.success ? 'text-green-600 dark:text-green-400' : 'text-red-600 dark:text-red-400'"
                    >
                      {{ jobLabel(j.jobType) }}{{ j.success ? '' : ' ✕' }}
                    </span>
                  </div>
                </td>
                <td class="px-4 py-3 text-sm text-gray-600 dark:text-gray-400">{{ formatNum(run.totalRecords) }} rec.</td>
                <td class="px-4 py-3">
                  <span :class="latencyClass(run.avgLatencyMs)" class="font-mono text-sm">
                    {{ run.avgLatencyMs != null ? run.avgLatencyMs + 'ms' : '—' }}
                  </span>
                </td>
                <td class="px-4 py-3 text-sm text-gray-600 dark:text-gray-400">{{ run.ranAt ? formatTime(run.ranAt) + ' ET' : '—' }}</td>
                <td class="px-4 py-3">
                  <button
                    @click.stop="runNow(run)"
                    :disabled="runNowLoading === run.id"
                    class="inline-flex items-center gap-1 px-2 py-1 rounded text-xs font-medium bg-primary-100 text-primary-700 dark:bg-primary-900/30 dark:text-primary-400 hover:bg-primary-200 dark:hover:bg-primary-800"
                  >
                    <PlayIcon class="h-3.5 w-3.5" />
                    Run
                  </button>
                </td>
              </tr>
              <tr v-if="expandedRun === run.id" class="bg-gray-50 dark:bg-gray-800/80">
                <td colspan="7" class="px-4 py-4">
                  <div class="space-y-3">
                    <div
                      v-for="j in run.jobs"
                      :key="j.id"
                      class="rounded-lg p-4 border"
                      :class="j.success ? 'bg-white dark:bg-gray-800 border-gray-200 dark:border-gray-700' : 'bg-red-50 border-red-200 dark:bg-red-900/20 dark:border-red-800'"
                    >
                      <div class="flex items-center justify-between mb-2">
                        <span class="font-medium text-gray-900 dark:text-white">{{ jobLabel(j.jobType) }} — {{ formatProvider(j.provider) }}</span>
                        <span :class="j.success ? 'text-green-600 dark:text-green-400' : 'text-red-600 dark:text-red-400'" class="text-sm font-medium">
                          {{ j.success ? 'Passed' : 'Failed' }}
                        </span>
                      </div>
                      <div class="flex flex-wrap gap-4 text-sm text-gray-600 dark:text-gray-400">
                        <span>{{ j.recordsPulled ?? 0 }} records</span>
                        <span v-if="j.symbols">Symbols: {{ j.symbols }}</span>
                        <span :class="latencyClass(j.latencyMs)">Latency: {{ j.latencyMs ?? '—' }}ms</span>
                        <span v-if="j.retryCount > 0">Retries: {{ j.retryCount }}</span>
                        <span
                          v-if="j.errorType"
                          :class="errorBadgeClass(j.errorType)"
                          class="inline-flex px-2 py-0.5 rounded text-xs font-medium"
                        >
                          {{ formatErrorType(j.errorType) }}
                        </span>
                      </div>
                      <pre v-if="j.rawError" class="mt-2 p-2 bg-gray-100 dark:bg-gray-900 rounded text-xs overflow-x-auto text-red-700 dark:text-red-300">{{ j.rawError }}</pre>
                    </div>
                  </div>
                </td>
              </tr>
            </template>
          </tbody>
        </table>
        <div v-if="filteredRuns.length === 0" class="p-12 text-center text-gray-500 dark:text-gray-400">
          No runs yet. {{ runs.length === 0 ? 'Ensure slots are created and refresh.' : 'No runs match the current filters.' }}
        </div>
      </div>
    </div>

    <!-- 7-Day History Tab -->
    <div v-show="activeTab === 'history'" class="space-y-6">
      <div class="bg-white dark:bg-gray-800 rounded-lg p-6 border border-gray-200 dark:border-gray-700">
        <h3 class="text-lg font-semibold text-gray-900 dark:text-white mb-4">7-Day Run Heatmap</h3>
        <div class="overflow-x-auto">
          <div class="grid gap-1 grid-cols-11 min-w-max">
            <div class="text-xs font-medium text-gray-500 dark:text-gray-400 py-2">Time</div>
            <div v-for="slot in heatmapSlots" :key="slot" class="text-xs font-medium text-gray-500 dark:text-gray-400 py-2 text-center">{{ slot }}</div>
            <template v-for="day in heatmapDays" :key="day">
              <div class="text-xs font-medium text-gray-500 dark:text-gray-400 py-2">{{ day }}</div>
              <div
                v-for="slot in heatmapSlots"
                :key="`${day}-${slot}`"
                class="w-8 h-8 rounded"
                :class="heatmapCellClass(day, slot)"
                :title="heatmapCellTitle(day, slot)"
              />
            </template>
          </div>
        </div>
        <div class="flex gap-4 mt-4 text-xs text-gray-500 dark:text-gray-400">
          <span class="flex items-center gap-1.5"><span class="w-3 h-3 rounded bg-green-500" /> Passed</span>
          <span class="flex items-center gap-1.5"><span class="w-3 h-3 rounded bg-amber-500" /> Partial</span>
          <span class="flex items-center gap-1.5"><span class="w-3 h-3 rounded bg-red-500" /> Failed</span>
          <span class="flex items-center gap-1.5"><span class="w-3 h-3 rounded bg-blue-500" /> Running</span>
          <span class="flex items-center gap-1.5"><span class="w-3 h-3 rounded bg-gray-400" /> Pending</span>
        </div>
      </div>

      <div class="bg-white dark:bg-gray-800 rounded-lg p-6 border border-gray-200 dark:border-gray-700">
        <h3 class="text-lg font-semibold text-gray-900 dark:text-white mb-4">Provider Reliability (7 days)</h3>
        <div class="space-y-4">
          <div
            v-for="p in reliability"
            :key="p.provider"
            class="flex items-center gap-4"
          >
            <span class="w-28 text-sm font-medium text-gray-900 dark:text-white">{{ formatProvider(p.provider) }}</span>
            <div class="flex-1 h-4 rounded-full bg-gray-200 dark:bg-gray-700 overflow-hidden">
              <div
                class="h-full rounded-full transition-all"
                :class="p.passRate >= 90 ? 'bg-green-500' : p.passRate >= 70 ? 'bg-amber-500' : 'bg-red-500'"
                :style="{ width: p.passRate + '%' }"
              />
            </div>
            <span class="text-sm text-gray-600 dark:text-gray-400">{{ p.pass }} ✔ {{ p.partial }} – {{ p.fail }} ❌ {{ p.passRate }}%</span>
          </div>
        </div>
      </div>
    </div>

    <!-- Alerts Tab -->
    <div v-show="activeTab === 'alerts'" class="space-y-4">
      <div class="bg-white dark:bg-gray-800 rounded-lg p-6 border border-gray-200 dark:border-gray-700">
        <h3 class="text-lg font-semibold text-gray-900 dark:text-white mb-4">All Alerts — Today</h3>
        <p class="text-sm text-gray-500 dark:text-gray-400 mb-4">Triggered when pulls fail or data is stale &gt;2h</p>
        <div v-if="alerts.length === 0" class="py-12 text-center text-gray-500 dark:text-gray-400">
          No active alerts.
        </div>
        <div v-else class="space-y-3">
          <div
            v-for="a in alerts"
            :key="a.id"
            class="flex items-center justify-between rounded-lg px-4 py-3 border"
            :class="a.severity === 'error'
              ? 'bg-red-50 dark:bg-red-900/20 border-red-200 dark:border-red-800'
              : 'bg-amber-50 dark:bg-amber-900/20 border-amber-200 dark:border-amber-800'"
          >
            <div class="flex items-center gap-3">
              <span
                v-if="a.severity"
                class="inline-flex px-2 py-0.5 rounded text-xs font-bold"
                :class="a.severity === 'error' ? 'bg-red-200 text-red-800 dark:bg-red-800 dark:text-red-200' : 'bg-amber-200 text-amber-800 dark:bg-amber-800 dark:text-amber-200'"
              >
                {{ a.severity.toUpperCase() }}
              </span>
              <span class="text-sm text-gray-800 dark:text-gray-200">{{ a.message }}</span>
            </div>
            <div class="flex items-center gap-3">
              <span class="text-xs text-gray-500 dark:text-gray-400">{{ formatET(a.triggered_at) }}</span>
              <button @click="dismissAlert(a.id)" class="text-gray-400 hover:text-gray-600 dark:hover:text-gray-300">
                <XMarkIcon class="h-5 w-5" />
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, computed, onMounted, watch } from 'vue'
import { ArrowPathIcon, XMarkIcon, PlayIcon } from '@heroicons/vue/24/outline'
import api from '@/services/api'

const loading = ref(false)
const runNowLoading = ref(null)
const activeTab = ref('today')
const filterStatus = ref('all')
const filterProvider = ref('all')
const expandedRun = ref(null)

const freshness = ref([])
const runs = ref([])
const alerts = ref([])
const historyRuns = ref([])
const reliability = ref([])

const tabs = [
  { id: 'today', label: "Today's Runs" },
  { id: 'history', label: '7-Day History' },
  { id: 'alerts', label: 'Alerts' },
]

const filteredRuns = computed(() => {
  let list = runs.value
  if (filterStatus.value !== 'all') list = list.filter((r) => r.status === filterStatus.value)
  if (filterProvider.value !== 'all') {
    list = list.filter((r) => r.jobs?.some((j) => j.provider === filterProvider.value))
  }
  return list
})

const heatmapSlots = ['06:00', '08:00', '09:00', '10:00', '11:00', '12:00', '13:00', '14:00', '15:00', '16:00', '16:30']
const heatmapDays = computed(() => {
  const days = []
  const tz = 'America/New_York'
  for (let i = 6; i >= 0; i--) {
    const x = new Date()
    x.setDate(x.getDate() - i)
    days.push(x.toLocaleDateString('en-US', { timeZone: tz, weekday: 'short', month: 'short', day: 'numeric' }))
  }
  return days
})

const heatmapData = computed(() => {
  const map = {}
  const tz = 'America/New_York'
  for (const r of historyRuns.value) {
    const d = new Date(r.scheduled_at)
    const day = d.toLocaleDateString('en-US', { timeZone: tz, weekday: 'short', month: 'short', day: 'numeric' })
    const parts = d.toLocaleTimeString('en-US', { timeZone: tz, hour: '2-digit', minute: '2-digit', hour12: false }).split(':')
    const slot = `${String(parseInt(parts[0], 10)).padStart(2, '0')}:${String(parseInt(parts[1] || 0, 10)).padStart(2, '0')}`
    const key = `${day}_${slot}`
    map[key] = r.status
  }
  return map
})

function heatmapCellClass(day, slot) {
  const key = `${day}_${slot}`
  const status = heatmapData.value[key]
  if (!status) return 'bg-gray-100 dark:bg-gray-700'
  if (status === 'passed') return 'bg-green-500'
  if (status === 'partial') return 'bg-amber-500'
  if (status === 'failed') return 'bg-red-500'
  if (status === 'running') return 'bg-blue-500'
  return 'bg-gray-400'
}

function heatmapCellTitle(day, slot) {
  const key = `${day}_${slot}`
  const status = heatmapData.value[key]
  return status ? `${day} ${slot}: ${status}` : `${day} ${slot}: —`
}

function formatET(iso) {
  if (!iso) return '—'
  const d = new Date(iso)
  return d.toLocaleTimeString('en-US', { timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit', hour12: false }) + ' ET'
}

function formatDateShort(d) {
  return d.toLocaleDateString('en-US', { timeZone: 'America/New_York', weekday: 'short', month: 'short', day: 'numeric' })
}

function formatTime(iso) {
  if (!iso) return '—'
  const d = new Date(iso)
  return d.toLocaleTimeString('en-US', { timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit', hour12: false })
}

function formatProvider(p) {
  const map = { tradier: 'Tradier', tastytrade: 'Tastytrade', internal_proxy: 'Internal Proxy' }
  return map[p] || p
}

function jobLabel(jobType) {
  const map = {
    quotes_greeks: 'Quotes & Greeks',
    options_chains: 'Options Chains',
    account_state: 'Account State',
    regime_vol: 'Regime/ Vol Data',
  }
  return map[jobType] || jobType
}

function formatErrorType(type) {
  const map = { provider_down: 'Provider Down', empty_response: 'Empty Response', parse_error: 'Parse Error', timeout: 'Timeout' }
  return map[type] || type
}

function formatNum(n) {
  if (n == null || isNaN(n)) return '—'
  return Number(n).toLocaleString()
}

function statusClass(s) {
  const map = {
    pending: 'bg-gray-100 text-gray-800 dark:bg-gray-700 dark:text-gray-300',
    running: 'bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-400',
    passed: 'bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-400',
    partial: 'bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-400',
    failed: 'bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-400',
  }
  return map[s] || map.pending
}

function statusDotClass(s) {
  const map = {
    pending: 'bg-gray-400',
    running: 'bg-blue-500',
    passed: 'bg-green-500',
    partial: 'bg-amber-500',
    failed: 'bg-red-500',
  }
  return map[s] || 'bg-gray-400'
}

function latencyClass(ms) {
  if (ms == null) return ''
  if (ms < 200) return 'text-green-600 dark:text-green-400'
  if (ms <= 500) return 'text-amber-600 dark:text-amber-400'
  return 'text-red-600 dark:text-red-400'
}

function errorBadgeClass(type) {
  const map = {
    provider_down: 'bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-400',
    empty_response: 'bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-400',
    parse_error: 'bg-orange-100 text-orange-800 dark:bg-orange-900/30 dark:text-orange-400',
    timeout: 'bg-purple-100 text-purple-800 dark:bg-purple-900/30 dark:text-purple-400',
  }
  return map[type] || 'bg-gray-100 text-gray-800 dark:bg-gray-700 dark:text-gray-300'
}

function toggleExpand(runId) {
  expandedRun.value = expandedRun.value === runId ? null : runId
}

async function fetchFreshness() {
  const { data } = await api.get('/data-validation/freshness')
  freshness.value = data
}

async function fetchTodayRuns() {
  const { data } = await api.get('/data-validation/today')
  runs.value = data.runs || []
}

async function fetchAlerts() {
  const { data } = await api.get('/data-validation/alerts')
  alerts.value = data || []
}

async function fetchHistory() {
  const { data } = await api.get('/data-validation/history')
  historyRuns.value = data.heatmap || []
  reliability.value = data.reliability || []
}

async function ensureSlots() {
  await api.post('/data-validation/ensure-slots')
}

async function refreshAll() {
  loading.value = true
  try {
    await ensureSlots()
    await Promise.all([fetchFreshness(), fetchTodayRuns(), fetchAlerts(), fetchHistory()])
  } finally {
    loading.value = false
  }
}

async function runNow(run) {
  runNowLoading.value = run.id
  try {
    await api.post('/data-validation/run-now', { runId: run.id })
    await refreshAll()
  } finally {
    runNowLoading.value = null
  }
}

async function dismissAlert(id) {
  await api.post(`/data-validation/alerts/${id}/dismiss`)
  alerts.value = alerts.value.filter((a) => a.id !== id)
}

watch(activeTab, (tab) => {
  if (tab === 'history' && historyRuns.value.length === 0) fetchHistory()
})

onMounted(() => {
  refreshAll()
})
</script>
