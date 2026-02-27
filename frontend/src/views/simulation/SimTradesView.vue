<template>
  <div class="content-wrapper py-8">
    <div class="flex flex-col sm:flex-row sm:items-center sm:justify-between mb-6">
      <div>
        <h1 class="heading-page">Sim Trades</h1>
        <p class="mt-1 text-sm text-gray-500 dark:text-gray-400">Simulated trades from webhook signals</p>
      </div>
      <div class="flex items-center gap-3 text-sm">
        <button @click="refreshData" :disabled="store.loading" class="btn-secondary text-sm">
          <svg v-if="store.loading" class="animate-spin -ml-1 mr-2 h-4 w-4 inline" fill="none" viewBox="0 0 24 24">
            <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4" />
            <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
          </svg>
          Refresh
        </button>
        <span class="text-gray-500 dark:text-gray-400">Total P&L:</span>
        <span
          class="text-lg font-bold"
          :class="store.totalPnL >= 0 ? 'text-green-600 dark:text-green-400' : 'text-red-600 dark:text-red-400'"
        >
          {{ store.totalPnL >= 0 ? '+' : '' }}${{ formatNum(store.totalPnL) }}
        </span>
      </div>
    </div>

    <!-- Error Banner -->
    <div v-if="initError" class="mb-6 bg-yellow-50 dark:bg-yellow-900/20 border border-yellow-200 dark:border-yellow-800 rounded-lg p-4">
      <div class="flex">
        <svg class="h-5 w-5 text-yellow-400 mr-3 mt-0.5 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-2.5L13.732 4c-.77-.833-1.964-.833-2.732 0L4.082 16.5c-.77.833.192 2.5 1.732 2.5z" />
        </svg>
        <div>
          <h3 class="text-sm font-medium text-yellow-800 dark:text-yellow-200">Simulation Engine Setup Required</h3>
          <p class="mt-1 text-sm text-yellow-700 dark:text-yellow-300">
            {{ initError }}. Make sure database migrations have been run and the simulation engine is enabled
            (<code class="px-1 py-0.5 bg-yellow-100 dark:bg-yellow-900/40 rounded text-xs">ENABLE_WEBHOOK_PROCESSOR=true</code>).
          </p>
          <button @click="refreshData" class="mt-2 text-sm font-medium text-yellow-800 dark:text-yellow-200 underline">
            Retry
          </button>
        </div>
      </div>
    </div>

    <!-- Account summary cards -->
    <div v-if="store.accountState" class="grid grid-cols-2 md:grid-cols-5 gap-4 mb-6">
      <div class="bg-white dark:bg-gray-800 rounded-lg p-4 shadow-sm border border-gray-200 dark:border-gray-700">
        <p class="text-xs text-gray-500 dark:text-gray-400 uppercase">Equity</p>
        <p class="text-xl font-bold text-gray-900 dark:text-white">${{ safeLocale(store.accountState.equity) }}</p>
      </div>
      <div class="bg-white dark:bg-gray-800 rounded-lg p-4 shadow-sm border border-gray-200 dark:border-gray-700">
        <p class="text-xs text-gray-500 dark:text-gray-400 uppercase">Cash</p>
        <p class="text-xl font-bold text-gray-900 dark:text-white">${{ safeLocale(store.accountState.cash_balance) }}</p>
      </div>
      <div class="bg-white dark:bg-gray-800 rounded-lg p-4 shadow-sm border border-gray-200 dark:border-gray-700">
        <p class="text-xs text-gray-500 dark:text-gray-400 uppercase">Realized P&L</p>
        <p class="text-xl font-bold" :class="Number(store.accountState.realized_pnl) >= 0 ? 'text-green-600' : 'text-red-600'">
          ${{ safeLocale(store.accountState.realized_pnl) }}
        </p>
      </div>
      <div class="bg-white dark:bg-gray-800 rounded-lg p-4 shadow-sm border border-gray-200 dark:border-gray-700">
        <p class="text-xs text-gray-500 dark:text-gray-400 uppercase">Daily P&L</p>
        <p class="text-xl font-bold" :class="Number(store.accountState.daily_pnl) >= 0 ? 'text-green-600' : 'text-red-600'">
          ${{ safeLocale(store.accountState.daily_pnl) }}
        </p>
      </div>
      <div class="bg-white dark:bg-gray-800 rounded-lg p-4 shadow-sm border border-gray-200 dark:border-gray-700">
        <p class="text-xs text-gray-500 dark:text-gray-400 uppercase">Max Drawdown</p>
        <p class="text-xl font-bold text-red-600">${{ safeLocale(store.accountState.max_drawdown) }}</p>
      </div>
    </div>

    <!-- Filters -->
    <div class="flex flex-wrap gap-3 mb-6">
      <input
        v-model="store.filters.symbol"
        @input="debouncedFetch"
        placeholder="Filter by symbol..."
        class="input text-sm w-40"
      />
      <input
        v-model="store.filters.strategy"
        @input="debouncedFetch"
        placeholder="Filter by strategy..."
        class="input text-sm w-40"
      />
      <input
        v-model="store.filters.startDate"
        type="date"
        @change="fetchTrades"
        class="input text-sm"
      />
      <input
        v-model="store.filters.endDate"
        type="date"
        @change="fetchTrades"
        class="input text-sm"
      />
    </div>

    <!-- Trades table -->
    <div class="bg-white dark:bg-gray-800 shadow-sm rounded-lg overflow-hidden border border-gray-200 dark:border-gray-700">
      <div v-if="store.loading && !initialized" class="p-12 text-center">
        <div class="animate-spin rounded-full h-8 w-8 border-b-2 border-primary-600 mx-auto mb-3"></div>
        <p class="text-gray-500 dark:text-gray-400 text-sm">Loading trades...</p>
      </div>
      <div v-else-if="store.trades.length === 0 && !initError" class="p-12 text-center">
        <svg class="mx-auto h-12 w-12 text-gray-400 dark:text-gray-500 mb-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z" />
        </svg>
        <h3 class="text-sm font-medium text-gray-900 dark:text-gray-100">No simulated trades yet</h3>
        <p class="mt-1 text-sm text-gray-500 dark:text-gray-400 max-w-md mx-auto">
          Trades appear here when webhook signals are processed through the simulation engine.
          Send a TradingView webhook to <code class="px-1 py-0.5 bg-gray-100 dark:bg-gray-700 rounded text-xs">/api/webhooks/tradingview</code> to get started.
        </p>
      </div>
      <div v-else-if="store.trades.length > 0" class="overflow-x-auto">
        <table class="min-w-full divide-y divide-gray-200 dark:divide-gray-700">
          <thead class="bg-gray-50 dark:bg-gray-700">
            <tr>
              <th class="px-4 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-300 uppercase">Symbol</th>
              <th class="px-4 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-300 uppercase">Type</th>
              <th class="px-4 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-300 uppercase">Strategy</th>
              <th class="px-4 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-300 uppercase">Entry</th>
              <th class="px-4 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-300 uppercase">Exit</th>
              <th class="px-4 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-300 uppercase">Qty</th>
              <th class="px-4 py-3 text-right text-xs font-medium text-gray-500 dark:text-gray-300 uppercase">P&L</th>
              <th class="px-4 py-3 text-right text-xs font-medium text-gray-500 dark:text-gray-300 uppercase">P&L %</th>
              <th class="px-4 py-3 text-right text-xs font-medium text-gray-500 dark:text-gray-300 uppercase">R</th>
              <th class="px-4 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-300 uppercase">DTE</th>
              <th class="px-4 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-300 uppercase">Date</th>
            </tr>
          </thead>
          <tbody class="divide-y divide-gray-200 dark:divide-gray-700">
            <tr v-for="trade in store.trades" :key="trade.id" class="hover:bg-gray-50 dark:hover:bg-gray-700/50">
              <td class="px-4 py-3 text-sm font-medium text-gray-900 dark:text-white whitespace-nowrap">
                {{ trade.symbol }}
                <span v-if="trade.strike" class="text-gray-400 text-xs ml-1">
                  ${{ trade.strike }} {{ trade.contract_type }}
                </span>
              </td>
              <td class="px-4 py-3 text-sm text-gray-600 dark:text-gray-400">
                <span
                  class="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium"
                  :class="contractTypeClass(trade.contract_type)"
                >
                  {{ trade.contract_type }}
                </span>
              </td>
              <td class="px-4 py-3 text-sm text-gray-600 dark:text-gray-400">{{ trade.strategy || '-' }}</td>
              <td class="px-4 py-3 text-sm text-gray-900 dark:text-gray-200">${{ formatNum(trade.entry_price) }}</td>
              <td class="px-4 py-3 text-sm text-gray-900 dark:text-gray-200">
                {{ trade.exit_price ? '$' + formatNum(trade.exit_price) : '-' }}
              </td>
              <td class="px-4 py-3 text-sm text-gray-600 dark:text-gray-400">{{ trade.quantity }}</td>
              <td class="px-4 py-3 text-sm text-right font-medium" :class="Number(trade.pnl) >= 0 ? 'text-green-600' : 'text-red-600'">
                {{ Number(trade.pnl) >= 0 ? '+' : '' }}${{ formatNum(trade.pnl) }}
              </td>
              <td class="px-4 py-3 text-sm text-right" :class="Number(trade.pnl_percent) >= 0 ? 'text-green-600' : 'text-red-600'">
                {{ formatNum(trade.pnl_percent) }}%
              </td>
              <td class="px-4 py-3 text-sm text-right text-gray-600 dark:text-gray-400">
                {{ trade.r_multiple ? formatNum(trade.r_multiple) + 'R' : '-' }}
              </td>
              <td class="px-4 py-3 text-sm text-gray-600 dark:text-gray-400">{{ trade.dte_at_entry ?? '-' }}</td>
              <td class="px-4 py-3 text-sm text-gray-500 dark:text-gray-400 whitespace-nowrap">
                {{ formatDate(trade.entry_time) }}
              </td>
            </tr>
          </tbody>
        </table>

        <!-- Pagination -->
        <div v-if="store.pagination.total > store.pagination.limit" class="px-4 py-3 border-t border-gray-200 dark:border-gray-700 flex items-center justify-between">
          <p class="text-sm text-gray-500 dark:text-gray-400">
            Showing {{ (store.pagination.page - 1) * store.pagination.limit + 1 }} -
            {{ Math.min(store.pagination.page * store.pagination.limit, store.pagination.total) }}
            of {{ store.pagination.total }}
          </p>
          <div class="flex gap-2">
            <button @click="changePage(-1)" :disabled="store.pagination.page <= 1" class="btn-secondary text-sm disabled:opacity-50">Previous</button>
            <button @click="changePage(1)" :disabled="store.pagination.page * store.pagination.limit >= store.pagination.total" class="btn-secondary text-sm disabled:opacity-50">Next</button>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, onMounted } from 'vue'
import { useSimulationStore } from '@/stores/simulation'

const store = useSimulationStore()
const initialized = ref(false)
const initError = ref(null)
let debounceTimer = null

function fetchTrades() {
  store.pagination.page = 1
  store.fetchTrades().catch(() => {})
}

function debouncedFetch() {
  clearTimeout(debounceTimer)
  debounceTimer = setTimeout(fetchTrades, 300)
}

function changePage(delta) {
  store.pagination.page += delta
  store.fetchTrades().catch(() => {})
}

function formatNum(v) {
  const n = Number(v)
  return isNaN(n) ? '0.00' : n.toFixed(2)
}

function safeLocale(v) {
  const n = Number(v)
  return isNaN(n) ? '0' : n.toLocaleString()
}

function contractTypeClass(type) {
  const map = {
    CALL: 'bg-green-100 text-green-800 dark:bg-green-900/20 dark:text-green-400',
    PUT: 'bg-red-100 text-red-800 dark:bg-red-900/20 dark:text-red-400',
    STOCK: 'bg-blue-100 text-blue-800 dark:bg-blue-900/20 dark:text-blue-400',
    CREDIT_SPREAD: 'bg-purple-100 text-purple-800 dark:bg-purple-900/20 dark:text-purple-400',
  }
  return map[type] || 'bg-gray-100 text-gray-800 dark:bg-gray-800 dark:text-gray-400'
}

function formatDate(dateStr) {
  if (!dateStr) return '-'
  return new Date(dateStr).toLocaleDateString('en-US', {
    month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit'
  })
}

async function refreshData() {
  initError.value = null
  store.error = null
  await Promise.allSettled([
    store.fetchAccountState(),
    store.fetchTrades(),
  ])
  initialized.value = true
  if (store.error) {
    initError.value = store.error
  }
}

onMounted(() => {
  refreshData()
})
</script>
