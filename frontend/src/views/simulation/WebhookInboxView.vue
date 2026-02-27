<template>
  <div class="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
    <div class="flex items-center justify-between mb-6">
      <div>
        <h1 class="text-2xl font-bold text-gray-900 dark:text-white">Webhook Inbox</h1>
        <p class="mt-1 text-sm text-gray-500 dark:text-gray-400">TradingView webhook events and processing pipeline status</p>
      </div>
      <div class="flex items-center gap-3">
        <label class="flex items-center gap-2 text-sm text-gray-500 dark:text-gray-400 cursor-pointer select-none">
          <input type="checkbox" v-model="autoRefresh" class="rounded border-gray-300 dark:border-gray-600 text-primary-600 focus:ring-primary-500" />
          Auto-refresh
        </label>
        <button
          @click="refresh"
          :disabled="refreshing"
          class="btn-secondary text-sm flex items-center gap-1.5"
        >
          <ArrowPathIcon class="h-4 w-4" :class="{ 'animate-spin': refreshing }" />
          Refresh
        </button>
        <button
          @click="processAll"
          :disabled="processing || stats.RECEIVED === 0"
          class="btn-primary text-sm flex items-center gap-2"
        >
          <BoltIcon class="h-4 w-4" />
          Process Pending
          <span v-if="stats.RECEIVED > 0" class="bg-white/20 px-1.5 py-0.5 rounded text-xs">{{ stats.RECEIVED }}</span>
        </button>
      </div>
    </div>

    <!-- Stats summary cards -->
    <div class="grid grid-cols-2 sm:grid-cols-4 gap-4 mb-6">
      <div class="bg-white dark:bg-gray-800 rounded-lg p-4 border border-gray-200 dark:border-gray-700">
        <div class="text-2xl font-bold text-gray-900 dark:text-white">{{ stats.total || 0 }}</div>
        <div class="text-xs text-gray-500 dark:text-gray-400 mt-1">Total Events</div>
      </div>
      <div class="bg-white dark:bg-gray-800 rounded-lg p-4 border border-blue-200 dark:border-blue-800">
        <div class="text-2xl font-bold text-blue-600 dark:text-blue-400">{{ stats.RECEIVED || 0 }}</div>
        <div class="text-xs text-gray-500 dark:text-gray-400 mt-1">Queued</div>
      </div>
      <div class="bg-white dark:bg-gray-800 rounded-lg p-4 border border-green-200 dark:border-green-800">
        <div class="text-2xl font-bold text-green-600 dark:text-green-400">{{ stats.PROCESSED || 0 }}</div>
        <div class="text-xs text-gray-500 dark:text-gray-400 mt-1">Processed</div>
      </div>
      <div class="bg-white dark:bg-gray-800 rounded-lg p-4 border border-red-200 dark:border-red-800">
        <div class="text-2xl font-bold text-red-600 dark:text-red-400">{{ stats.REJECTED || 0 }}</div>
        <div class="text-xs text-gray-500 dark:text-gray-400 mt-1">Rejected</div>
      </div>
    </div>

    <!-- Status filter tabs -->
    <div class="flex gap-2 mb-6">
      <button
        v-for="tab in statusTabs"
        :key="tab.value"
        @click="filterByStatus(tab.value)"
        class="px-4 py-2 rounded-lg text-sm font-medium transition-all"
        :class="activeStatus === tab.value
          ? 'bg-primary-100 text-primary-700 dark:bg-primary-900/30 dark:text-primary-300 ring-1 ring-primary-300 dark:ring-primary-700'
          : 'text-gray-600 hover:bg-gray-100 dark:text-gray-400 dark:hover:bg-gray-700'"
      >
        {{ tab.label }}
        <span v-if="tab.count > 0" class="ml-1.5 text-xs opacity-75 bg-gray-200 dark:bg-gray-600 px-1.5 py-0.5 rounded-full">{{ tab.count }}</span>
      </button>
    </div>

    <!-- Events table -->
    <div class="bg-white dark:bg-gray-800 shadow rounded-lg overflow-hidden">
      <div v-if="store.loading && !refreshing" class="p-8 text-center text-gray-500">
        <ArrowPathIcon class="h-8 w-8 animate-spin mx-auto mb-2" />
        Loading webhook events...
      </div>
      <div v-else-if="store.webhookEvents.length === 0" class="p-8 text-center text-gray-500 dark:text-gray-400">
        <InboxIcon class="h-12 w-12 mx-auto mb-3 opacity-40" />
        <p class="font-medium">No webhook events found</p>
        <p class="text-sm mt-1">Configure your TradingView alerts to send webhooks to:</p>
        <code class="text-xs mt-2 inline-block bg-gray-100 dark:bg-gray-700 px-3 py-1.5 rounded">{{ webhookUrl }}</code>
      </div>
      <table v-else class="min-w-full divide-y divide-gray-200 dark:divide-gray-700">
        <thead class="bg-gray-50 dark:bg-gray-700">
          <tr>
            <th class="px-4 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-300 uppercase">Time</th>
            <th class="px-4 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-300 uppercase">Indicator</th>
            <th class="px-4 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-300 uppercase">Symbol</th>
            <th class="px-4 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-300 uppercase">Direction</th>
            <th class="px-4 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-300 uppercase">Status</th>
            <th class="px-4 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-300 uppercase">Processed</th>
            <th class="px-4 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-300 uppercase">Details</th>
          </tr>
        </thead>
        <tbody class="divide-y divide-gray-200 dark:divide-gray-700">
          <tr
            v-for="event in store.webhookEvents"
            :key="event.id"
            @click="selectedEvent = event"
            class="hover:bg-gray-50 dark:hover:bg-gray-700/50 cursor-pointer transition-colors"
          >
            <td class="px-4 py-3 text-sm text-gray-900 dark:text-gray-200 whitespace-nowrap">
              {{ formatTime(event.received_at) }}
            </td>
            <td class="px-4 py-3">
              <span class="inline-flex items-center gap-1.5 text-xs font-medium" :class="indicatorClass(detectSource(event.raw_payload))">
                <span class="w-1.5 h-1.5 rounded-full" :class="indicatorDotClass(detectSource(event.raw_payload))"></span>
                {{ formatSource(detectSource(event.raw_payload)) }}
              </span>
            </td>
            <td class="px-4 py-3 text-sm font-semibold text-gray-900 dark:text-gray-200">
              {{ event.raw_payload?.ticker || event.raw_payload?.symbol || '-' }}
            </td>
            <td class="px-4 py-3">
              <span v-if="getDirection(event.raw_payload)" class="text-xs font-medium" :class="directionClass(getDirection(event.raw_payload))">
                {{ getDirection(event.raw_payload) }}
              </span>
              <span v-else class="text-xs text-gray-400">-</span>
            </td>
            <td class="px-4 py-3">
              <span
                class="inline-flex px-2 py-0.5 rounded-full text-xs font-medium"
                :class="statusClass(event.status)"
              >
                {{ event.status }}
              </span>
            </td>
            <td class="px-4 py-3 text-xs text-gray-500 dark:text-gray-400 whitespace-nowrap">
              <template v-if="event.processed_at">
                {{ formatTime(event.processed_at) }}
                <span class="text-gray-400 ml-1">({{ processingDelay(event) }})</span>
              </template>
              <span v-else class="text-gray-400">-</span>
            </td>
            <td class="px-4 py-3 text-sm max-w-xs truncate" :class="event.error_message ? 'text-red-600 dark:text-red-400' : 'text-green-600 dark:text-green-400'">
              {{ getDetailSummary(event) }}
            </td>
          </tr>
        </tbody>
      </table>

      <!-- Pagination -->
      <div v-if="store.webhookPagination.total > store.webhookPagination.limit" class="px-4 py-3 border-t border-gray-200 dark:border-gray-700 flex items-center justify-between">
        <p class="text-sm text-gray-500 dark:text-gray-400">
          Showing {{ (store.webhookPagination.page - 1) * store.webhookPagination.limit + 1 }} -
          {{ Math.min(store.webhookPagination.page * store.webhookPagination.limit, store.webhookPagination.total) }}
          of {{ store.webhookPagination.total }}
        </p>
        <div class="flex gap-2">
          <button
            @click="changePage(-1)"
            :disabled="store.webhookPagination.page <= 1"
            class="px-3 py-1 rounded text-sm border border-gray-300 dark:border-gray-600 disabled:opacity-50"
          >Previous</button>
          <button
            @click="changePage(1)"
            :disabled="store.webhookPagination.page * store.webhookPagination.limit >= store.webhookPagination.total"
            class="px-3 py-1 rounded text-sm border border-gray-300 dark:border-gray-600 disabled:opacity-50"
          >Next</button>
        </div>
      </div>
    </div>

    <!-- Event detail modal -->
    <div v-if="selectedEvent" class="fixed inset-0 z-50 flex items-center justify-center bg-black/50" @click.self="selectedEvent = null">
      <div class="bg-white dark:bg-gray-800 rounded-lg shadow-xl max-w-3xl w-full mx-4 max-h-[85vh] overflow-y-auto">
        <div class="p-6">
          <div class="flex items-center justify-between mb-4">
            <div>
              <h3 class="text-lg font-semibold text-gray-900 dark:text-white">Webhook Event Detail</h3>
              <p class="text-xs text-gray-500 dark:text-gray-400 mt-0.5 font-mono">{{ selectedEvent.id }}</p>
            </div>
            <button @click="selectedEvent = null" class="text-gray-400 hover:text-gray-600 dark:hover:text-gray-300">
              <XMarkIcon class="h-5 w-5" />
            </button>
          </div>

          <!-- Status + timing row -->
          <div class="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-4">
            <div class="bg-gray-50 dark:bg-gray-700/50 rounded-lg p-3">
              <div class="text-xs text-gray-500 dark:text-gray-400">Status</div>
              <span :class="statusClass(selectedEvent.status)" class="inline-flex px-2 py-0.5 rounded-full text-xs font-medium mt-1">{{ selectedEvent.status }}</span>
            </div>
            <div class="bg-gray-50 dark:bg-gray-700/50 rounded-lg p-3">
              <div class="text-xs text-gray-500 dark:text-gray-400">Indicator</div>
              <div class="text-sm font-medium text-gray-900 dark:text-gray-200 mt-1">{{ formatSource(detectSource(selectedEvent.raw_payload)) }}</div>
            </div>
            <div class="bg-gray-50 dark:bg-gray-700/50 rounded-lg p-3">
              <div class="text-xs text-gray-500 dark:text-gray-400">Received</div>
              <div class="text-sm text-gray-900 dark:text-gray-200 mt-1">{{ formatTime(selectedEvent.received_at) }}</div>
            </div>
            <div class="bg-gray-50 dark:bg-gray-700/50 rounded-lg p-3">
              <div class="text-xs text-gray-500 dark:text-gray-400">Processed</div>
              <div class="text-sm text-gray-900 dark:text-gray-200 mt-1">
                <template v-if="selectedEvent.processed_at">{{ formatTime(selectedEvent.processed_at) }} <span class="text-xs text-gray-400">({{ processingDelay(selectedEvent) }})</span></template>
                <span v-else class="text-gray-400">Pending</span>
              </div>
            </div>
          </div>

          <!-- Signal summary for SIGNALS type -->
          <div v-if="detectSource(selectedEvent.raw_payload) === 'SIGNALS'" class="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-4">
            <div class="bg-gray-50 dark:bg-gray-700/50 rounded-lg p-3">
              <div class="text-xs text-gray-500 dark:text-gray-400">Symbol</div>
              <div class="text-sm font-bold text-gray-900 dark:text-gray-200 mt-1">{{ selectedEvent.raw_payload?.ticker }}</div>
            </div>
            <div class="bg-gray-50 dark:bg-gray-700/50 rounded-lg p-3">
              <div class="text-xs text-gray-500 dark:text-gray-400">Direction</div>
              <div class="text-sm font-medium mt-1" :class="directionClass(selectedEvent.raw_payload?.signal?.type)">{{ selectedEvent.raw_payload?.signal?.type }}</div>
            </div>
            <div class="bg-gray-50 dark:bg-gray-700/50 rounded-lg p-3">
              <div class="text-xs text-gray-500 dark:text-gray-400">Score</div>
              <div class="text-sm font-medium text-gray-900 dark:text-gray-200 mt-1">{{ selectedEvent.raw_payload?.score }}</div>
            </div>
            <div class="bg-gray-50 dark:bg-gray-700/50 rounded-lg p-3">
              <div class="text-xs text-gray-500 dark:text-gray-400">Timeframe</div>
              <div class="text-sm font-medium text-gray-900 dark:text-gray-200 mt-1">{{ selectedEvent.raw_payload?.timeframe }}m</div>
            </div>
          </div>

          <div v-if="selectedEvent.error_message" class="mb-4">
            <span class="text-xs text-gray-500 dark:text-gray-400 block mb-1">Error / Rejection Reason</span>
            <div class="p-2.5 bg-red-50 dark:bg-red-900/20 rounded-lg text-red-700 dark:text-red-300 text-sm">{{ selectedEvent.error_message }}</div>
          </div>

          <div>
            <span class="text-xs text-gray-500 dark:text-gray-400 block mb-1">Raw Payload</span>
            <pre class="p-3 bg-gray-100 dark:bg-gray-900 rounded-lg text-xs overflow-x-auto text-gray-800 dark:text-gray-300 max-h-80">{{ JSON.stringify(selectedEvent.raw_payload, null, 2) }}</pre>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, computed, onMounted, onUnmounted, watch } from 'vue'
import { useSimulationStore } from '@/stores/simulation'
import { ArrowPathIcon, XMarkIcon, BoltIcon, InboxIcon } from '@heroicons/vue/24/outline'
import api from '@/services/api'

const store = useSimulationStore()
const selectedEvent = ref(null)
const processing = ref(false)
const refreshing = ref(false)
const activeStatus = ref('')
const autoRefresh = ref(true)
const stats = ref({ total: 0, RECEIVED: 0, PROCESSED: 0, REJECTED: 0 })
let refreshTimer = null

const webhookUrl = computed(() => {
  const host = window.location.origin
  return `${host}/api/webhooks/tradingview`
})

const statusTabs = computed(() => [
  { label: 'All', value: '', count: stats.value.total },
  { label: 'Received', value: 'RECEIVED', count: stats.value.RECEIVED },
  { label: 'Processed', value: 'PROCESSED', count: stats.value.PROCESSED },
  { label: 'Rejected', value: 'REJECTED', count: stats.value.REJECTED },
])

function detectSource(payload) {
  if (!payload) return 'UNKNOWN'
  const metaSource = (payload.meta?.source || '').toUpperCase()
  const metaIndicator = (payload.meta?.indicator || '').toUpperCase()
  const metaEngine = payload.meta?.engine
  const journalEngine = payload.journal?.engine

  if (metaSource === 'MARKET_CONTEXT' || metaIndicator.includes('MARKET CONTEXT')) return 'MARKET_CONTEXT'
  if (metaEngine === 'SATY_PO') return 'SATY_PHASE'
  if (journalEngine === 'STRAT_V6_FULL') return 'STRAT'
  if (payload.source === 'MTF_BIAS_ENGINE_V3' && payload.event_id_raw) return 'MTF_BIAS'
  if (payload.timeframes && payload.bias && payload.ticker) return 'TREND'
  if (payload.signal && typeof payload.signal === 'object') {
    const hasScore = typeof payload.score === 'number' || typeof payload.score_breakdown?.total === 'number'
    const hasTrend = payload.trend || payload.trend_data
    if (hasScore && hasTrend) return 'SIGNALS'
  }
  return 'UNKNOWN'
}

function formatSource(source) {
  const labels = {
    SIGNALS: 'Signals',
    MARKET_CONTEXT: 'Market Context',
    TREND: 'Trend Dots',
    SATY_PHASE: 'SATY Phase',
    MTF_BIAS: 'MTF Bias',
    STRAT: 'Strat Setup',
    ORB: 'ORB',
    UNKNOWN: 'Unknown',
  }
  return labels[source] || source
}

function indicatorClass(source) {
  const classes = {
    SIGNALS: 'text-purple-700 dark:text-purple-300',
    MARKET_CONTEXT: 'text-cyan-700 dark:text-cyan-300',
    TREND: 'text-amber-700 dark:text-amber-300',
    SATY_PHASE: 'text-indigo-700 dark:text-indigo-300',
    MTF_BIAS: 'text-emerald-700 dark:text-emerald-300',
    STRAT: 'text-orange-700 dark:text-orange-300',
  }
  return classes[source] || 'text-gray-600 dark:text-gray-400'
}

function indicatorDotClass(source) {
  const classes = {
    SIGNALS: 'bg-purple-500',
    MARKET_CONTEXT: 'bg-cyan-500',
    TREND: 'bg-amber-500',
    SATY_PHASE: 'bg-indigo-500',
    MTF_BIAS: 'bg-emerald-500',
    STRAT: 'bg-orange-500',
  }
  return classes[source] || 'bg-gray-400'
}

function getDirection(payload) {
  if (!payload) return null
  const signal = typeof payload.signal === 'object' ? payload.signal : null
  return payload.direction || payload.bias || signal?.type || payload.trend || null
}

function directionClass(dir) {
  if (!dir) return ''
  const d = String(dir).toUpperCase()
  if (['LONG', 'BUY', 'BULLISH', 'BULL'].includes(d)) return 'text-green-600 dark:text-green-400'
  if (['SHORT', 'SELL', 'BEARISH', 'BEAR'].includes(d)) return 'text-red-600 dark:text-red-400'
  return 'text-gray-500 dark:text-gray-400'
}

function statusClass(status) {
  switch (status) {
    case 'RECEIVED': return 'bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-300'
    case 'PROCESSED': return 'bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-300'
    case 'REJECTED': return 'bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-300'
    case 'TEST_PING': return 'bg-yellow-100 text-yellow-800 dark:bg-yellow-900/30 dark:text-yellow-300'
    default: return 'bg-gray-100 text-gray-800 dark:bg-gray-700 dark:text-gray-300'
  }
}

function formatTime(ts) {
  if (!ts) return '-'
  const d = new Date(ts)
  return d.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }) +
    ' ' + d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
}

function processingDelay(event) {
  if (!event.processed_at || !event.received_at) return ''
  const ms = new Date(event.processed_at) - new Date(event.received_at)
  if (ms < 1000) return `${ms}ms`
  return `${(ms / 1000).toFixed(1)}s`
}

function getDetailSummary(event) {
  if (event.error_message) return event.error_message
  if (event.status === 'PROCESSED') {
    const source = detectSource(event.raw_payload)
    if (source === 'SIGNALS') {
      const p = event.raw_payload
      return `${p?.signal?.type || ''} score=${p?.score || ''} tf=${p?.timeframe || ''}m`
    }
    if (source === 'MARKET_CONTEXT') {
      return `${event.raw_payload?.event || ''} regime=${event.raw_payload?.regime?.current || '-'}`
    }
    if (source === 'TREND') {
      return `${event.raw_payload?.bias || ''} align=${event.raw_payload?.alignment_score || '-'}`
    }
    return 'Processed'
  }
  if (event.status === 'RECEIVED') return 'Queued for processing'
  return ''
}

async function fetchStats() {
  try {
    const { data } = await api.get('/webhooks/stats')
    stats.value = data
  } catch { /* ignore */ }
}

function filterByStatus(status) {
  activeStatus.value = status
  store.filters.webhookStatus = status
  store.webhookPagination.page = 1
  store.fetchWebhookEvents()
}

function changePage(delta) {
  store.webhookPagination.page += delta
  store.fetchWebhookEvents()
}

async function refresh() {
  refreshing.value = true
  try {
    await Promise.all([store.fetchWebhookEvents(), fetchStats()])
  } finally {
    refreshing.value = false
  }
}

async function processAll() {
  processing.value = true
  try {
    await store.processPending()
    await Promise.all([store.fetchWebhookEvents(), fetchStats()])
  } finally {
    processing.value = false
  }
}

function startAutoRefresh() {
  stopAutoRefresh()
  refreshTimer = setInterval(() => {
    if (autoRefresh.value && !document.hidden) {
      refresh()
    }
  }, 10000)
}

function stopAutoRefresh() {
  if (refreshTimer) {
    clearInterval(refreshTimer)
    refreshTimer = null
  }
}

watch(autoRefresh, (val) => {
  if (val) startAutoRefresh()
  else stopAutoRefresh()
})

onMounted(async () => {
  await Promise.all([store.fetchWebhookEvents(), fetchStats()])
  if (autoRefresh.value) startAutoRefresh()
})

onUnmounted(() => {
  stopAutoRefresh()
})
</script>
