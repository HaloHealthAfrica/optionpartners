<template>
  <div class="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
    <div class="mb-6">
      <h1 class="text-2xl font-bold text-gray-900 dark:text-white">Strategy Breakdown</h1>
      <p class="mt-1 text-sm text-gray-500 dark:text-gray-400">Performance analytics by strategy and DTE bucket</p>
    </div>

    <!-- Strategy performance cards -->
    <div v-if="store.strategyBreakdown.length === 0 && !loading" class="bg-white dark:bg-gray-800 rounded-lg shadow p-12 text-center text-gray-500 dark:text-gray-400">
      <ChartBarSquareIcon class="h-12 w-12 mx-auto mb-3 opacity-50" />
      <p>No strategy data yet. Complete some simulated trades to see analytics.</p>
    </div>

    <div v-else class="space-y-6">
      <!-- Strategy summary cards -->
      <div class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
        <div
          v-for="strat in store.strategyBreakdown"
          :key="strat.strategy"
          class="bg-white dark:bg-gray-800 rounded-lg shadow p-5"
        >
          <div class="flex items-center justify-between mb-3">
            <h3 class="text-lg font-bold text-gray-900 dark:text-white">{{ strat.strategy || 'Unknown' }}</h3>
            <span
              class="text-lg font-bold"
              :class="parseFloat(strat.total_pnl) >= 0 ? 'text-green-600' : 'text-red-600'"
            >
              {{ parseFloat(strat.total_pnl) >= 0 ? '+' : '' }}${{ parseFloat(strat.total_pnl).toLocaleString() }}
            </span>
          </div>

          <div class="grid grid-cols-2 gap-3 text-sm">
            <div>
              <p class="text-gray-500 dark:text-gray-400">Trades</p>
              <p class="font-semibold text-gray-900 dark:text-white">{{ strat.total_trades }}</p>
            </div>
            <div>
              <p class="text-gray-500 dark:text-gray-400">Win Rate</p>
              <p class="font-semibold" :class="parseFloat(strat.win_rate) >= 50 ? 'text-green-600' : 'text-red-600'">
                {{ parseFloat(strat.win_rate).toFixed(1) }}%
              </p>
            </div>
            <div>
              <p class="text-gray-500 dark:text-gray-400">Avg P&L</p>
              <p class="font-semibold" :class="parseFloat(strat.avg_pnl) >= 0 ? 'text-green-600' : 'text-red-600'">
                ${{ parseFloat(strat.avg_pnl).toFixed(2) }}
              </p>
            </div>
            <div>
              <p class="text-gray-500 dark:text-gray-400">Avg R</p>
              <p class="font-semibold text-gray-900 dark:text-white">
                {{ strat.avg_r_multiple ? parseFloat(strat.avg_r_multiple).toFixed(2) + 'R' : '-' }}
              </p>
            </div>
            <div>
              <p class="text-gray-500 dark:text-gray-400">Best Trade</p>
              <p class="font-semibold text-green-600">${{ parseFloat(strat.best_trade).toFixed(2) }}</p>
            </div>
            <div>
              <p class="text-gray-500 dark:text-gray-400">Worst Trade</p>
              <p class="font-semibold text-red-600">${{ parseFloat(strat.worst_trade).toFixed(2) }}</p>
            </div>
          </div>

          <!-- Win/loss bar -->
          <div class="mt-3">
            <div class="flex h-2 rounded-full overflow-hidden bg-gray-200 dark:bg-gray-700">
              <div
                class="bg-green-500 transition-all"
                :style="{ width: parseFloat(strat.win_rate) + '%' }"
              ></div>
              <div
                class="bg-red-500 transition-all"
                :style="{ width: (100 - parseFloat(strat.win_rate)) + '%' }"
              ></div>
            </div>
            <div class="flex justify-between text-xs text-gray-500 mt-1">
              <span>{{ strat.winning_trades }}W</span>
              <span>{{ strat.losing_trades }}L</span>
            </div>
          </div>
        </div>
      </div>

      <!-- DTE Breakdown table -->
      <div class="bg-white dark:bg-gray-800 rounded-lg shadow overflow-hidden">
        <div class="px-6 py-4 border-b border-gray-200 dark:border-gray-700">
          <h2 class="text-lg font-semibold text-gray-900 dark:text-white">Performance by DTE Bucket</h2>
        </div>
        <div v-if="store.dteBreakdown.length === 0" class="p-6 text-center text-gray-500 dark:text-gray-400">
          No DTE data available
        </div>
        <table v-else class="min-w-full divide-y divide-gray-200 dark:divide-gray-700">
          <thead class="bg-gray-50 dark:bg-gray-700">
            <tr>
              <th class="px-6 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-300 uppercase">DTE Bucket</th>
              <th class="px-6 py-3 text-right text-xs font-medium text-gray-500 dark:text-gray-300 uppercase">Trades</th>
              <th class="px-6 py-3 text-right text-xs font-medium text-gray-500 dark:text-gray-300 uppercase">Winners</th>
              <th class="px-6 py-3 text-right text-xs font-medium text-gray-500 dark:text-gray-300 uppercase">Win Rate</th>
              <th class="px-6 py-3 text-right text-xs font-medium text-gray-500 dark:text-gray-300 uppercase">Total P&L</th>
              <th class="px-6 py-3 text-right text-xs font-medium text-gray-500 dark:text-gray-300 uppercase">Avg P&L</th>
            </tr>
          </thead>
          <tbody class="divide-y divide-gray-200 dark:divide-gray-700">
            <tr v-for="bucket in store.dteBreakdown" :key="bucket.dte_bucket">
              <td class="px-6 py-4 text-sm font-medium text-gray-900 dark:text-white">{{ bucket.dte_bucket }}</td>
              <td class="px-6 py-4 text-sm text-right text-gray-600 dark:text-gray-400">{{ bucket.total_trades }}</td>
              <td class="px-6 py-4 text-sm text-right text-gray-600 dark:text-gray-400">{{ bucket.winners }}</td>
              <td class="px-6 py-4 text-sm text-right font-medium" :class="parseFloat(bucket.win_rate) >= 50 ? 'text-green-600' : 'text-red-600'">
                {{ parseFloat(bucket.win_rate).toFixed(1) }}%
              </td>
              <td class="px-6 py-4 text-sm text-right font-medium" :class="parseFloat(bucket.total_pnl) >= 0 ? 'text-green-600' : 'text-red-600'">
                ${{ parseFloat(bucket.total_pnl).toLocaleString() }}
              </td>
              <td class="px-6 py-4 text-sm text-right" :class="parseFloat(bucket.avg_pnl) >= 0 ? 'text-green-600' : 'text-red-600'">
                ${{ parseFloat(bucket.avg_pnl).toFixed(2) }}
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      <!-- Sim Runs history -->
      <div class="bg-white dark:bg-gray-800 rounded-lg shadow overflow-hidden">
        <div class="px-6 py-4 border-b border-gray-200 dark:border-gray-700">
          <h2 class="text-lg font-semibold text-gray-900 dark:text-white">Replay Runs</h2>
        </div>
        <div v-if="store.simRuns.length === 0" class="p-6 text-center text-gray-500 dark:text-gray-400">
          No replay runs yet. Use the Historical Replay API to backtest strategies.
        </div>
        <table v-else class="min-w-full divide-y divide-gray-200 dark:divide-gray-700">
          <thead class="bg-gray-50 dark:bg-gray-700">
            <tr>
              <th class="px-4 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-300 uppercase">Symbol</th>
              <th class="px-4 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-300 uppercase">Strategy</th>
              <th class="px-4 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-300 uppercase">Period</th>
              <th class="px-4 py-3 text-right text-xs font-medium text-gray-500 dark:text-gray-300 uppercase">Trades</th>
              <th class="px-4 py-3 text-right text-xs font-medium text-gray-500 dark:text-gray-300 uppercase">Win Rate</th>
              <th class="px-4 py-3 text-right text-xs font-medium text-gray-500 dark:text-gray-300 uppercase">P&L</th>
              <th class="px-4 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-300 uppercase">Status</th>
            </tr>
          </thead>
          <tbody class="divide-y divide-gray-200 dark:divide-gray-700">
            <tr v-for="run in store.simRuns" :key="run.id">
              <td class="px-4 py-3 text-sm font-medium text-gray-900 dark:text-white">{{ run.symbol }}</td>
              <td class="px-4 py-3 text-sm text-gray-600 dark:text-gray-400">{{ run.strategy }}</td>
              <td class="px-4 py-3 text-sm text-gray-600 dark:text-gray-400">
                {{ new Date(run.start_date).toLocaleDateString() }} - {{ new Date(run.end_date).toLocaleDateString() }}
              </td>
              <td class="px-4 py-3 text-sm text-right text-gray-900 dark:text-gray-200">{{ run.total_trades }}</td>
              <td class="px-4 py-3 text-sm text-right" :class="parseFloat(run.win_rate) >= 0.5 ? 'text-green-600' : 'text-red-600'">
                {{ (parseFloat(run.win_rate) * 100).toFixed(1) }}%
              </td>
              <td class="px-4 py-3 text-sm text-right font-medium" :class="parseFloat(run.total_pnl) >= 0 ? 'text-green-600' : 'text-red-600'">
                ${{ parseFloat(run.total_pnl).toLocaleString() }}
              </td>
              <td class="px-4 py-3">
                <span
                  class="inline-flex px-2 py-0.5 rounded-full text-xs font-medium"
                  :class="{
                    'bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-300': run.status === 'COMPLETED',
                    'bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-300': run.status === 'RUNNING',
                    'bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-300': run.status === 'FAILED',
                  }"
                >{{ run.status }}</span>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, onMounted } from 'vue'
import { useSimulationStore } from '@/stores/simulation'
import { ChartBarSquareIcon } from '@heroicons/vue/24/outline'

const store = useSimulationStore()
const loading = ref(true)

onMounted(async () => {
  await Promise.all([
    store.fetchStrategyBreakdown(),
    store.fetchDteBreakdown(),
    store.fetchSimRuns(),
  ])
  loading.value = false
})
</script>
