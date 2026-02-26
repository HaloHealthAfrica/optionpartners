<template>
  <div class="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
    <div class="flex items-center justify-between mb-6">
      <div>
        <h1 class="text-2xl font-bold text-gray-900 dark:text-white">Sim Equity Curve</h1>
        <p class="mt-1 text-sm text-gray-500 dark:text-gray-400">Track your simulated portfolio equity over time</p>
      </div>
      <div class="flex items-center gap-4">
        <div v-if="store.accountState" class="text-right">
          <p class="text-sm text-gray-500 dark:text-gray-400">Current Equity</p>
          <p class="text-2xl font-bold text-gray-900 dark:text-white">${{ parseFloat(store.accountState.equity).toLocaleString() }}</p>
        </div>
      </div>
    </div>

    <!-- Kill switch + account controls -->
    <div class="grid grid-cols-1 md:grid-cols-4 gap-4 mb-6">
      <div class="bg-white dark:bg-gray-800 rounded-lg p-4 shadow">
        <p class="text-xs text-gray-500 dark:text-gray-400 uppercase">Buying Power</p>
        <p class="text-lg font-bold text-gray-900 dark:text-white">
          ${{ store.accountState ? parseFloat(store.accountState.buying_power).toLocaleString() : '0' }}
        </p>
      </div>
      <div class="bg-white dark:bg-gray-800 rounded-lg p-4 shadow">
        <p class="text-xs text-gray-500 dark:text-gray-400 uppercase">Margin Used</p>
        <p class="text-lg font-bold text-gray-900 dark:text-white">
          ${{ store.accountState ? parseFloat(store.accountState.margin_used).toLocaleString() : '0' }}
        </p>
      </div>
      <div class="bg-white dark:bg-gray-800 rounded-lg p-4 shadow">
        <p class="text-xs text-gray-500 dark:text-gray-400 uppercase">Peak Equity</p>
        <p class="text-lg font-bold text-green-600 dark:text-green-400">
          ${{ store.accountState ? parseFloat(store.accountState.peak_equity).toLocaleString() : '0' }}
        </p>
      </div>
      <div class="bg-white dark:bg-gray-800 rounded-lg p-4 shadow flex items-center justify-between">
        <div>
          <p class="text-xs text-gray-500 dark:text-gray-400 uppercase">Kill Switch</p>
          <p class="text-sm font-bold" :class="store.killSwitchActive ? 'text-red-600' : 'text-green-600'">
            {{ store.killSwitchActive ? 'ACTIVE' : 'Inactive' }}
          </p>
        </div>
        <button
          @click="toggleKillSwitch"
          class="px-3 py-1.5 rounded text-xs font-medium"
          :class="store.killSwitchActive
            ? 'bg-green-100 text-green-700 hover:bg-green-200 dark:bg-green-900/30 dark:text-green-300'
            : 'bg-red-100 text-red-700 hover:bg-red-200 dark:bg-red-900/30 dark:text-red-300'"
        >
          {{ store.killSwitchActive ? 'Deactivate' : 'Activate' }}
        </button>
      </div>
    </div>

    <!-- Equity curve chart -->
    <div class="bg-white dark:bg-gray-800 rounded-lg shadow p-6 mb-6">
      <div v-if="store.equityCurve.length === 0" class="text-center py-12 text-gray-500 dark:text-gray-400">
        <ChartBarIcon class="h-12 w-12 mx-auto mb-3 opacity-50" />
        <p>No equity data yet. Process some trades to see the equity curve.</p>
      </div>
      <div v-else>
        <canvas ref="chartCanvas" class="w-full" style="height: 400px;"></canvas>
      </div>
    </div>

    <!-- Open positions -->
    <div class="bg-white dark:bg-gray-800 rounded-lg shadow overflow-hidden">
      <div class="px-6 py-4 border-b border-gray-200 dark:border-gray-700 flex items-center justify-between">
        <h2 class="text-lg font-semibold text-gray-900 dark:text-white">Open Positions</h2>
        <span class="text-sm text-gray-500 dark:text-gray-400">{{ store.positions.length }} open</span>
      </div>
      <div v-if="store.positions.length === 0" class="p-6 text-center text-gray-500 dark:text-gray-400">
        No open positions
      </div>
      <table v-else class="min-w-full divide-y divide-gray-200 dark:divide-gray-700">
        <thead class="bg-gray-50 dark:bg-gray-700">
          <tr>
            <th class="px-4 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-300 uppercase">Symbol</th>
            <th class="px-4 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-300 uppercase">Type</th>
            <th class="px-4 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-300 uppercase">Strategy</th>
            <th class="px-4 py-3 text-right text-xs font-medium text-gray-500 dark:text-gray-300 uppercase">Qty</th>
            <th class="px-4 py-3 text-right text-xs font-medium text-gray-500 dark:text-gray-300 uppercase">Avg Price</th>
            <th class="px-4 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-300 uppercase">Expiration</th>
            <th class="px-4 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-300 uppercase">Opened</th>
          </tr>
        </thead>
        <tbody class="divide-y divide-gray-200 dark:divide-gray-700">
          <tr v-for="pos in store.positions" :key="pos.id">
            <td class="px-4 py-3 text-sm font-medium text-gray-900 dark:text-white">{{ pos.symbol }}</td>
            <td class="px-4 py-3 text-sm text-gray-600 dark:text-gray-400">{{ pos.contract_type }}</td>
            <td class="px-4 py-3 text-sm text-gray-600 dark:text-gray-400">{{ pos.strategy || '-' }}</td>
            <td class="px-4 py-3 text-sm text-right text-gray-900 dark:text-gray-200">{{ pos.quantity }}</td>
            <td class="px-4 py-3 text-sm text-right text-gray-900 dark:text-gray-200">${{ parseFloat(pos.avg_price).toFixed(2) }}</td>
            <td class="px-4 py-3 text-sm text-gray-600 dark:text-gray-400">{{ pos.expiration ? new Date(pos.expiration).toLocaleDateString() : '-' }}</td>
            <td class="px-4 py-3 text-sm text-gray-600 dark:text-gray-400">{{ new Date(pos.opened_at).toLocaleString() }}</td>
          </tr>
        </tbody>
      </table>
    </div>

    <!-- Reset account button -->
    <div class="mt-6 flex justify-end">
      <button
        @click="confirmReset"
        class="px-4 py-2 bg-red-600 text-white rounded-lg text-sm font-medium hover:bg-red-700 transition-colors"
      >
        Reset Sim Account
      </button>
    </div>
  </div>
</template>

<script setup>
import { ref, onMounted, watch, nextTick } from 'vue'
import { useSimulationStore } from '@/stores/simulation'
import { ChartBarIcon } from '@heroicons/vue/24/outline'

const store = useSimulationStore()
const chartCanvas = ref(null)
let chartInstance = null

async function toggleKillSwitch() {
  await store.toggleKillSwitch(!store.killSwitchActive)
}

async function confirmReset() {
  if (confirm('Are you sure you want to reset the simulation account? All positions will be closed and the balance reset to the initial amount.')) {
    await store.resetAccount()
    await Promise.all([
      store.fetchPositions({ status: 'OPEN' }),
      store.fetchEquityCurve(),
    ])
  }
}

async function renderChart() {
  if (!chartCanvas.value || store.equityCurve.length === 0) return

  const { Chart, registerables } = await import('chart.js')
  Chart.register(...registerables)

  if (chartInstance) chartInstance.destroy()

  const labels = store.equityCurve.map(p => new Date(p.snapshot_at).toLocaleDateString())
  const equityData = store.equityCurve.map(p => parseFloat(p.equity))

  const isDark = document.documentElement.classList.contains('dark')
  const gridColor = isDark ? 'rgba(255,255,255,0.1)' : 'rgba(0,0,0,0.1)'
  const textColor = isDark ? '#9ca3af' : '#6b7280'

  chartInstance = new Chart(chartCanvas.value, {
    type: 'line',
    data: {
      labels,
      datasets: [{
        label: 'Equity',
        data: equityData,
        borderColor: '#3b82f6',
        backgroundColor: 'rgba(59, 130, 246, 0.1)',
        fill: true,
        tension: 0.3,
        pointRadius: 2,
        pointHoverRadius: 5,
      }],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            label: (ctx) => `Equity: $${ctx.parsed.y.toLocaleString()}`,
          },
        },
      },
      scales: {
        x: {
          grid: { color: gridColor },
          ticks: { color: textColor, maxTicksLimit: 15 },
        },
        y: {
          grid: { color: gridColor },
          ticks: {
            color: textColor,
            callback: (val) => '$' + val.toLocaleString(),
          },
        },
      },
    },
  })
}

watch(() => store.equityCurve, async () => {
  await nextTick()
  renderChart()
}, { deep: true })

onMounted(async () => {
  await Promise.all([
    store.fetchAccountState(),
    store.fetchPositions({ status: 'OPEN' }),
    store.fetchEquityCurve(),
  ])
  await nextTick()
  renderChart()
})
</script>
