<template>
  <div class="min-h-screen bg-slate-950 text-slate-100">
    <!-- Header -->
    <div class="border-b border-slate-800 bg-slate-900/50 backdrop-blur">
      <div class="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-6">
        <div class="flex items-center justify-between">
          <div>
            <h1 class="text-2xl font-bold tracking-tight text-white font-mono">
              Webhook Pipeline Observatory
            </h1>
            <p class="mt-1 text-sm text-slate-400">
              End-to-end visibility: ingestion → processing → trade
            </p>
          </div>
          <div class="flex items-center gap-3">
            <label class="flex items-center gap-2 text-sm text-slate-400 cursor-pointer select-none">
              <input
                v-model="autoRefresh"
                type="checkbox"
                class="rounded border-slate-600 bg-slate-800 text-emerald-500 focus:ring-emerald-500"
              />
              Auto-refresh
            </label>
            <button
              @click="refresh"
              :disabled="loading"
              class="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-slate-800 hover:bg-slate-700 border border-slate-700 text-sm font-medium transition-colors disabled:opacity-50"
            >
              <ArrowPathIcon class="h-4 w-4" :class="{ 'animate-spin': loading }" />
              Refresh
            </button>
            <router-link
              to="/sim/webhooks"
              class="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white text-sm font-medium transition-colors"
            >
              Webhook Inbox
            </router-link>
          </div>
        </div>
      </div>
    </div>

    <div class="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
      <div v-if="error" class="mb-6 p-4 rounded-lg bg-red-900/30 border border-red-800 text-red-200">
        {{ error }}
      </div>

      <!-- System Gates -->
      <section class="mb-8">
        <h2 class="text-sm font-semibold text-slate-400 uppercase tracking-wider mb-4">System Gates</h2>
        <div class="grid grid-cols-2 md:grid-cols-4 gap-4">
          <div class="rounded-xl bg-slate-900/80 border border-slate-800 p-4">
            <div class="text-xs text-slate-500 uppercase tracking-wider mb-2">Processor</div>
            <div class="flex items-center gap-2">
              <span
                class="w-2 h-2 rounded-full shrink-0"
                :class="data?.processor?.running ? 'bg-emerald-500' : 'bg-red-500'"
              />
              <span class="font-mono font-medium">{{ processorStatus }}</span>
            </div>
          </div>
          <div class="rounded-xl bg-slate-900/80 border border-slate-800 p-4">
            <div class="text-xs text-slate-500 uppercase tracking-wider mb-2">Kill Switch</div>
            <div class="flex items-center gap-2">
              <span
                class="w-2 h-2 rounded-full shrink-0"
                :class="!data?.gates?.killSwitchActive ? 'bg-emerald-500' : 'bg-red-500'"
              />
              <span class="font-mono font-medium">{{ killSwitchStatus }}</span>
            </div>
          </div>
          <div class="rounded-xl bg-slate-900/80 border border-slate-800 p-4">
            <div class="text-xs text-slate-500 uppercase tracking-wider mb-2">Positions</div>
            <div class="flex items-center gap-2">
              <span
                class="w-2 h-2 rounded-full shrink-0"
                :class="!data?.gates?.atPositionLimit ? 'bg-emerald-500' : 'bg-red-500'"
              />
              <span class="font-mono font-medium">{{ positionsStatus }}</span>
            </div>
            <div class="mt-2 text-sm text-slate-400 font-mono">
              {{ data?.gates?.openPositions ?? 0 }} / {{ data?.gates?.maxPositions ?? 5 }}
            </div>
          </div>
          <div class="rounded-xl bg-slate-900/80 border border-slate-800 p-4">
            <div class="text-xs text-slate-500 uppercase tracking-wider mb-2">Data Service</div>
            <div class="flex items-center gap-2">
              <span
                class="w-2 h-2 rounded-full shrink-0"
                :class="data?.connectivity?.state === 'HEALTHY' ? 'bg-emerald-500' : 'bg-amber-500'"
              />
              <span class="font-mono font-medium">{{ connectivityStatus }}</span>
            </div>
          </div>
        </div>
      </section>

      <!-- Pipeline Flow -->
      <section class="mb-8">
        <h2 class="text-sm font-semibold text-slate-400 uppercase tracking-wider mb-4">Pipeline Flow</h2>
        <div class="flex flex-wrap items-center gap-2 md:gap-4 py-4 px-6 rounded-xl bg-slate-900/80 border border-slate-800">
          <div class="flex flex-col items-center justify-center px-4 py-2 rounded-lg min-w-[80px] bg-slate-800">
            <span class="text-xs text-slate-400 uppercase">Ingest</span>
            <span class="font-mono font-bold text-lg mt-1">{{ data?.webhookStats?.total ?? 0 }}</span>
          </div>
          <div class="text-slate-600 hidden md:block">→</div>
          <div class="flex flex-col items-center justify-center px-4 py-2 rounded-lg min-w-[80px] bg-blue-900/50 border border-blue-700">
            <span class="text-xs text-slate-400 uppercase">Received</span>
            <span class="font-mono font-bold text-lg mt-1">{{ data?.webhookStats?.received ?? 0 }}</span>
          </div>
          <div class="text-slate-600 hidden md:block">→</div>
          <div class="flex flex-col items-center justify-center px-4 py-2 rounded-lg min-w-[80px] bg-emerald-900/50 border border-emerald-700">
            <span class="text-xs text-slate-400 uppercase">Processed</span>
            <span class="font-mono font-bold text-lg mt-1">{{ data?.webhookStats?.processed ?? 0 }}</span>
          </div>
          <div class="text-slate-600 hidden md:block">→</div>
          <div class="flex flex-col items-center justify-center px-4 py-2 rounded-lg min-w-[80px] bg-red-900/50 border border-red-700">
            <span class="text-xs text-slate-400 uppercase">Rejected</span>
            <span class="font-mono font-bold text-lg mt-1">{{ data?.webhookStats?.rejected ?? 0 }}</span>
          </div>
        </div>
      </section>

      <!-- Queue Health & Retry -->
      <div class="grid grid-cols-1 lg:grid-cols-2 gap-6 mb-8">
        <section class="rounded-xl bg-slate-900/80 border border-slate-800 p-6">
          <h2 class="text-sm font-semibold text-slate-400 uppercase tracking-wider mb-4">Queue Health</h2>
          <div class="space-y-4">
            <div class="flex justify-between items-center">
              <span class="text-slate-300">Pending</span>
              <span class="font-mono font-medium">{{ data?.queueHealth?.pending ?? 0 }}</span>
            </div>
            <div class="flex justify-between items-center">
              <span class="text-slate-300">Stuck</span>
              <span class="font-mono font-medium" :class="(data?.queueHealth?.stuck_pending ?? 0) > 0 ? 'text-amber-400' : ''">
                {{ data?.queueHealth?.stuck_pending ?? 0 }}
              </span>
            </div>
            <div class="flex justify-between items-center">
              <span class="text-slate-300">Health Score</span>
              <span
                class="font-mono font-medium px-2 py-0.5 rounded"
                :class="queueHealthClass"
              >
                {{ data?.queueHealth?.healthScore ?? '-' }}
              </span>
            </div>
            <div class="flex justify-between items-center">
              <span class="text-slate-300">Oldest Pending</span>
              <span class="font-mono text-sm text-slate-400">
                {{ formatTime(data?.queueHealth?.oldest_pending) }}
              </span>
            </div>
          </div>
        </section>

        <section class="rounded-xl bg-slate-900/80 border border-slate-800 p-6">
          <h2 class="text-sm font-semibold text-slate-400 uppercase tracking-wider mb-4">Retry & Dead Letter</h2>
          <div class="space-y-4">
            <div class="flex justify-between items-center">
              <span class="text-slate-300">Retryable</span>
              <span class="font-mono font-medium text-amber-400">{{ data?.retry?.retryable ?? 0 }}</span>
            </div>
            <div class="flex justify-between items-center">
              <span class="text-slate-300">Exhausted</span>
              <span class="font-mono font-medium text-red-400">{{ data?.retry?.exhausted ?? 0 }}</span>
            </div>
          </div>
        </section>
      </div>

      <!-- Rate Limit -->
      <section class="mb-8">
        <h2 class="text-sm font-semibold text-slate-400 uppercase tracking-wider mb-4">Rate Limiting</h2>
        <div class="rounded-xl bg-slate-900/80 border border-slate-800 p-6">
          <div class="grid grid-cols-1 md:grid-cols-3 gap-6">
            <div>
              <div class="text-xs text-slate-500 mb-1">IP Limit</div>
              <div class="font-mono text-sm">
                {{ data?.rateLimit?.limits?.ip?.maxRequests ?? '-' }} / min
              </div>
            </div>
            <div>
              <div class="text-xs text-slate-500 mb-1">API Key Limit</div>
              <div class="font-mono text-sm">
                {{ data?.rateLimit?.limits?.api_key?.maxRequests ?? '-' }} / min
              </div>
            </div>
            <div>
              <div class="text-xs text-slate-500 mb-1">Current Status</div>
              <div
                class="font-mono text-sm"
                :class="(data?.rateLimit?.currentRateLimit?.remainingRequests ?? 1) === 0 ? 'text-amber-400' : 'text-emerald-400'"
              >
                {{ (data?.rateLimit?.currentRateLimit?.remainingRequests ?? 1) === 0 ? 'Throttled' : 'OK' }}
              </div>
              <div v-if="data?.rateLimit?.currentRateLimit" class="text-xs text-slate-500 mt-0.5">
                {{ data.rateLimit.currentRateLimit.currentCount ?? 0 }} / {{ data.rateLimit.currentRateLimit.maxRequests ?? '-' }} used
              </div>
            </div>
          </div>
        </div>
      </section>

      <!-- Symbol State Freshness -->
      <section class="mb-8" v-if="freshnessRows?.length">
        <h2 class="text-sm font-semibold text-slate-400 uppercase tracking-wider mb-4">Symbol State Freshness</h2>
        <div class="rounded-xl bg-slate-900/80 border border-slate-800 overflow-hidden">
          <table class="min-w-full divide-y divide-slate-800">
            <thead>
              <tr>
                <th class="px-4 py-3 text-left text-xs font-medium text-slate-500 uppercase">Symbol</th>
                <th class="px-4 py-3 text-left text-xs font-medium text-slate-500 uppercase">Last Macro Update</th>
                <th class="px-4 py-3 text-left text-xs font-medium text-slate-500 uppercase">Stale</th>
              </tr>
            </thead>
            <tbody class="divide-y divide-slate-800">
              <tr v-for="row in freshnessRows" :key="row.symbol" class="hover:bg-slate-800/50">
                <td class="px-4 py-3 font-mono text-sm">{{ row.symbol }}</td>
                <td class="px-4 py-3 text-sm text-slate-400">{{ formatTime(row.macro_updated_at) }}</td>
                <td class="px-4 py-3">
                  <span
                    class="text-xs font-medium px-2 py-0.5 rounded"
                    :class="row.stale_minutes > 120 ? 'bg-amber-900/50 text-amber-400' : 'bg-slate-800 text-slate-400'"
                  >
                    {{ formatStale(row.stale_minutes) }}
                  </span>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </section>

      <!-- Processing Latency -->
      <section class="mb-8" v-if="latencyRows?.length">
        <h2 class="text-sm font-semibold text-slate-400 uppercase tracking-wider mb-4">Processing Latency</h2>
        <div class="rounded-xl bg-slate-900/80 border border-slate-800 overflow-hidden">
          <table class="min-w-full divide-y divide-slate-800">
            <thead>
              <tr>
                <th class="px-4 py-3 text-left text-xs font-medium text-slate-500 uppercase">Stage</th>
                <th class="px-4 py-3 text-left text-xs font-medium text-slate-500 uppercase">Success</th>
                <th class="px-4 py-3 text-left text-xs font-medium text-slate-500 uppercase">Avg (ms)</th>
                <th class="px-4 py-3 text-left text-xs font-medium text-slate-500 uppercase">Min / Max</th>
              </tr>
            </thead>
            <tbody class="divide-y divide-slate-800">
              <tr v-for="row in latencyRows" :key="`${row.stage}-${row.success}`" class="hover:bg-slate-800/50">
                <td class="px-4 py-3 font-mono text-sm">{{ row.stage }}</td>
                <td class="px-4 py-3">
                  <span
                    class="text-xs font-medium px-2 py-0.5 rounded"
                    :class="row.success ? 'bg-emerald-900/50 text-emerald-400' : 'bg-red-900/50 text-red-400'"
                  >
                    {{ row.success ? 'Yes' : 'No' }}
                  </span>
                </td>
                <td class="px-4 py-3 font-mono text-sm">{{ row.avg_latency_ms ?? '-' }}</td>
                <td class="px-4 py-3 font-mono text-sm text-slate-400">
                  {{ row.min_latency_ms ?? '-' }} / {{ row.max_latency_ms ?? '-' }}
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </section>

      <!-- Connectivity Reset -->
      <section class="mb-8">
        <h2 class="text-sm font-semibold text-slate-400 uppercase tracking-wider mb-4">Actions</h2>
        <div class="flex flex-wrap gap-4">
          <button
            v-if="data?.connectivity?.state !== 'HEALTHY'"
            @click="resetConnectivity"
            :disabled="resetting"
            class="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-amber-600 hover:bg-amber-500 text-white text-sm font-medium transition-colors disabled:opacity-50"
          >
            <ArrowPathIcon class="h-4 w-4" :class="{ 'animate-spin': resetting }" />
            Reset Connectivity Gate
          </button>
          <router-link
            to="/sim/webhooks"
            class="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-slate-800 hover:bg-slate-700 border border-slate-700 text-sm font-medium transition-colors"
          >
            Process Pending
          </router-link>
        </div>
      </section>

      <p class="text-xs text-slate-500">
        Last updated: {{ data?.timestamp ? formatTime(data.timestamp) : '-' }} · {{ data?.timeRangeHours ?? 24 }}h window
      </p>
    </div>
  </div>
</template>

<script setup>
import { ref, computed, onMounted, onUnmounted, watch } from 'vue'
import { ArrowPathIcon } from '@heroicons/vue/24/outline'
import api from '@/services/api'

const data = ref(null)
const loading = ref(false)
const error = ref(null)
const autoRefresh = ref(true)
const resetting = ref(false)
let refreshInterval = null

const processorStatus = computed(() =>
  data.value?.processor?.running ? 'Running' : 'Stopped'
)
const killSwitchStatus = computed(() =>
  data.value?.gates?.killSwitchActive ? 'Active' : 'Inactive'
)
const positionsStatus = computed(() =>
  data.value?.gates?.atPositionLimit
    ? `${data.value.gates.openPositions}/${data.value.gates.maxPositions}`
    : 'Capacity'
)
const connectivityStatus = computed(() =>
  data.value?.connectivity?.state ?? 'Unknown'
)

const queueHealthClass = computed(() => {
  const score = data.value?.queueHealth?.healthScore
  if (score == null) return 'text-slate-400'
  if (score >= 80) return 'bg-emerald-900/50 text-emerald-400'
  if (score >= 60) return 'bg-amber-900/50 text-amber-400'
  return 'bg-red-900/50 text-red-400'
})

const freshnessRows = computed(() => data.value?.symbolFreshness ?? [])
const latencyRows = computed(() => data.value?.processing?.latency ?? [])

async function fetch() {
  loading.value = true
  error.value = null
  try {
    const { data: res } = await api.get('/sim/pipeline-observatory', {
      params: { timeRangeHours: 24 },
    })
    data.value = res
  } catch (err) {
    error.value = err.response?.data?.error || err.message
  } finally {
    loading.value = false
  }
}

function refresh() {
  return fetch()
}

function formatTime(ts) {
  if (!ts) return '-'
  const d = new Date(ts)
  return d.toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  })
}

function formatStale(minutes) {
  if (minutes == null) return '-'
  if (minutes < 60) return `${Math.round(minutes)}m`
  if (minutes < 1440) return `${(minutes / 60).toFixed(1)}h`
  return `${(minutes / 1440).toFixed(1)}d`
}

async function resetConnectivity() {
  resetting.value = true
  try {
    await api.post('/sim/connectivity/reset')
    await fetch()
  } catch (err) {
    error.value = err.response?.data?.error || err.message
  } finally {
    resetting.value = false
  }
}

onMounted(() => {
  fetch()
  if (autoRefresh.value) {
    refreshInterval = setInterval(fetch, 15000)
  }
})

onUnmounted(() => {
  if (refreshInterval) clearInterval(refreshInterval)
})

watch(autoRefresh, (v) => {
  if (v && !refreshInterval) {
    refreshInterval = setInterval(fetch, 15000)
  } else if (!v && refreshInterval) {
    clearInterval(refreshInterval)
    refreshInterval = null
  }
})
</script>
