<template>
  <div class="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
    <div class="flex items-center justify-between mb-6">
      <div>
        <h1 class="text-2xl font-bold text-gray-900 dark:text-white">Sim Trades</h1>
        <p class="mt-1 text-sm text-gray-500 dark:text-gray-400">Simulated trades from webhook signals</p>
      </div>
      <div class="flex items-center gap-3 text-sm">
        <span class="text-gray-500 dark:text-gray-400">Total P&L:</span>
        <span
          class="text-lg font-bold"
          :class="store.totalPnL >= 0 ? 'text-green-600 dark:text-green-400' : 'text-red-600 dark:text-red-400'"
        >
          {{ store.totalPnL >= 0 ? '+' : '' }}${{ store.totalPnL?.toFixed(2) ?? '0.00' }}
        </span>
      </div>
    </div>

    <!-- Account summary cards -->
    <div v-if="store.accountState" class="grid grid-cols-2 md:grid-cols-5 gap-4 mb-6">
      <div class="bg-white dark:bg-gray-800 rounded-lg p-4 shadow">
        <p class="text-xs text-gray-500 dark:text-gray-400 uppercase">Equity</p>
        <p class="text-xl font-bold text-gray-900 dark:text-white">${{ parseFloat(store.accountState.equity).toLocaleString() }}</p>
      </div>
      <div class="bg-white dark:bg-gray-800 rounded-lg p-4 shadow">
        <p class="text-xs text-gray-500 dark:text-gray-400 uppercase">Cash</p>
        <p class="text-xl font-bold text-gray-900 dark:text-white">${{ parseFloat(store.accountState.cash_balance).toLocaleString() }}</p>
      </div>
      <div class="bg-white dark:bg-gray-800 rounded-lg p-4 shadow">
        <p class="text-xs text-gray-500 dark:text-gray-400 uppercase">Realized P&L</p>
        <p class="text-xl font-bold" :class="parseFloat(store.accountState.realized_pnl) >= 0 ? 'text-green-600' : 'text-red-600'">
          ${{ parseFloat(store.accountState.realized_pnl).toLocaleString() }}
        </p>
      </div>
      <div class="bg-white dark:bg-gray-800 rounded-lg p-4 shadow">
        <p class="text-xs text-gray-500 dark:text-gray-400 uppercase">Daily P&L</p>
        <p class="text-xl font-bold" :class="parseFloat(store.accountState.daily_pnl) >= 0 ? 'text-green-600' : 'text-red-600'">
          ${{ parseFloat(store.accountState.daily_pnl).toLocaleString() }}
        </p>
      </div>
      <div class="bg-white dark:bg-gray-800 rounded-lg p-4 shadow">
        <p class="text-xs text-gray-500 dark:text-gray-400 uppercase">Max Drawdown</p>
        <p class="text-xl font-bold text-red-600">${{ parseFloat(store.accountState.max_drawdown).toLocaleString() }}</p>
      </div>
    </div>

    <!-- Filters -->
    <div class="flex flex-wrap gap-3 mb-6">
      <input
        v-model="store.filters.symbol"
        @input="debouncedFetch"
        placeholder="Filter by symbol..."
        class="px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-800 text-sm text-gray-900 dark:text-white"
      />
      <input
        v-model="store.filters.strategy"
        @input="debouncedFetch"
        placeholder="Filter by strategy..."
        class="px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-800 text-sm text-gray-900 dark:text-white"
      />
      <input
        v-model="store.filters.startDate"
        type="date"
        @change="fetchTrades"
        class="px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-800 text-sm text-gray-900 dark:text-white"
      />
      <input
        v-model="store.filters.endDate"
        type="date"
        @change="fetchTrades"
        class="px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-800 text-sm text-gray-900 dark:text-white"
      />
    </div>

    <!-- Trades table -->
    <div class="bg-white dark:bg-gray-800 shadow rounded-lg overflow-hidden">
      <div v-if="store.loading" class="p-8 text-center text-gray-500">Loading trades...</div>
      <div v-else-if="store.trades.length === 0" class="p-8 text-center text-gray-500 dark:text-gray-400">
        No simulated trades yet. Trades appear here when webhook signals are processed through the simulation engine.
      </div>
      <table v-else class="min-w-full divide-y divide-gray-200 dark:divide-gray-700">
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
          </tr>
        </thead>
        <tbody class="divide-y divide-gray-200 dark:divide-gray-700">
          <tr v-for="trade in store.trades" :key="trade.id" class="hover:bg-gray-50 dark:hover:bg-gray-700/50">
            <td class="px-4 py-3 text-sm font-medium text-gray-900 dark:text-white">
              {{ trade.symbol }}
              <span v-if="trade.strike" class="text-gray-400 text-xs ml-1">
                ${{ trade.strike }} {{ trade.contract_type }}
              </span>
            </td>
            <td class="px-4 py-3 text-sm text-gray-600 dark:text-gray-400">{{ trade.contract_type }}</td>
            <td class="px-4 py-3 text-sm text-gray-600 dark:text-gray-400">{{ trade.strategy || '-' }}</td>
            <td class="px-4 py-3 text-sm text-gray-900 dark:text-gray-200">${{ parseFloat(trade.entry_price).toFixed(2) }}</td>
            <td class="px-4 py-3 text-sm text-gray-900 dark:text-gray-200">
              {{ trade.exit_price ? '$' + parseFloat(trade.exit_price).toFixed(2) : '-' }}
            </td>
            <td class="px-4 py-3 text-sm text-gray-600 dark:text-gray-400">{{ trade.quantity }}</td>
            <td class="px-4 py-3 text-sm text-right font-medium" :class="parseFloat(trade.pnl) >= 0 ? 'text-green-600' : 'text-red-600'">
              {{ parseFloat(trade.pnl) >= 0 ? '+' : '' }}${{ parseFloat(trade.pnl).toFixed(2) }}
            </td>
            <td class="px-4 py-3 text-sm text-right" :class="parseFloat(trade.pnl_percent) >= 0 ? 'text-green-600' : 'text-red-600'">
              {{ parseFloat(trade.pnl_percent).toFixed(2) }}%
            </td>
            <td class="px-4 py-3 text-sm text-right text-gray-600 dark:text-gray-400">
              {{ trade.r_multiple ? parseFloat(trade.r_multiple).toFixed(2) + 'R' : '-' }}
            </td>
            <td class="px-4 py-3 text-sm text-gray-600 dark:text-gray-400">{{ trade.dte_at_entry ?? '-' }}</td>
          </tr>
        </tbody>
      </table>

      <!-- Pagination -->
      <div v-if="store.pagination.total > store.pagination.limit" class="px-4 py-3 border-t border-gray-200 dark:border-gray-700 flex items-center justify-between">
        <p class="text-sm text-gray-500">
          Showing {{ (store.pagination.page - 1) * store.pagination.limit + 1 }} -
          {{ Math.min(store.pagination.page * store.pagination.limit, store.pagination.total) }}
          of {{ store.pagination.total }}
        </p>
        <div class="flex gap-2">
          <button @click="changePage(-1)" :disabled="store.pagination.page <= 1" class="px-3 py-1 rounded text-sm border border-gray-300 dark:border-gray-600 disabled:opacity-50">Previous</button>
          <button @click="changePage(1)" :disabled="store.pagination.page * store.pagination.limit >= store.pagination.total" class="px-3 py-1 rounded text-sm border border-gray-300 dark:border-gray-600 disabled:opacity-50">Next</button>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { onMounted } from 'vue'
import { useSimulationStore } from '@/stores/simulation'

const store = useSimulationStore()
let debounceTimer = null

function fetchTrades() {
  store.pagination.page = 1
  store.fetchTrades()
}

function debouncedFetch() {
  clearTimeout(debounceTimer)
  debounceTimer = setTimeout(fetchTrades, 300)
}

function changePage(delta) {
  store.pagination.page += delta
  store.fetchTrades()
}

onMounted(async () => {
  await Promise.all([
    store.fetchAccountState(),
    store.fetchTrades(),
  ])
})
</script>
