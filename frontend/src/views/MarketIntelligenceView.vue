<template>
  <div class="content-wrapper py-8">
    <!-- Header -->
    <div class="mb-8">
      <div class="flex flex-col sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 class="heading-page">Market Intelligence</h1>
          <p class="mt-1 text-sm text-gray-600 dark:text-gray-400">
            Real-time market regime, volatility, and options flow from the data service
          </p>
        </div>
        <div class="mt-4 sm:mt-0 flex items-center space-x-3">
          <!-- Market Status -->
          <div class="flex items-center space-x-2 text-sm">
            <div
              class="w-2.5 h-2.5 rounded-full"
              :class="marketStatusDot"
            ></div>
            <span class="text-gray-700 dark:text-gray-300">{{ marketStatusLabel }}</span>
          </div>
          <!-- Regime Badge -->
          <span
            v-if="store.regimeBadge"
            class="inline-flex items-center px-2.5 py-1 rounded-full text-xs font-semibold"
            :class="regimeBadgeClass"
          >
            {{ store.regimeBadge.text }}
          </span>
          <button @click="refreshAll" class="btn-secondary text-sm" :disabled="anyLoading">
            <svg v-if="anyLoading" class="animate-spin -ml-1 mr-2 h-4 w-4" fill="none" viewBox="0 0 24 24">
              <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4" />
              <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
            </svg>
            {{ anyLoading ? 'Loading...' : 'Refresh' }}
          </button>
        </div>
      </div>
    </div>

    <!-- Service Unavailable Banner -->
    <div
      v-if="serviceUnavailable"
      class="mb-6 bg-yellow-50 dark:bg-yellow-900/20 border border-yellow-200 dark:border-yellow-800 rounded-lg p-4"
    >
      <div class="flex">
        <svg class="h-5 w-5 text-yellow-400 mr-3 mt-0.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-2.5L13.732 4c-.77-.833-1.964-.833-2.732 0L4.082 16.5c-.77.833.192 2.5 1.732 2.5z" />
        </svg>
        <div>
          <h3 class="text-sm font-medium text-yellow-800 dark:text-yellow-200">Data Service Unavailable</h3>
          <p class="mt-1 text-sm text-yellow-700 dark:text-yellow-300">
            The market data service is not responding. Make sure the data-service is running and
            <code class="px-1 py-0.5 bg-yellow-100 dark:bg-yellow-900/40 rounded text-xs">DATA_SERVICE_URL</code>
            is configured in your backend environment.
          </p>
        </div>
      </div>
    </div>

    <!-- Overview Row -->
    <div class="grid grid-cols-1 md:grid-cols-3 gap-6 mb-8">
      <!-- Market Regime Card -->
      <div class="bg-white dark:bg-gray-800 rounded-lg shadow-sm border border-gray-200 dark:border-gray-700 p-6">
        <h3 class="text-sm font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider mb-4">Market Regime</h3>
        <div v-if="store.loading.regime" class="flex justify-center py-6">
          <div class="animate-spin rounded-full h-6 w-6 border-b-2 border-primary-600"></div>
        </div>
        <div v-else-if="store.regime?.data" class="space-y-4">
          <div class="flex items-center justify-between">
            <span class="text-gray-700 dark:text-gray-300">Regime</span>
            <span class="font-semibold capitalize" :class="regimeTextColor">
              {{ store.regime.data.regime }}
            </span>
          </div>
          <div class="flex items-center justify-between">
            <span class="text-gray-700 dark:text-gray-300">Trading Bias</span>
            <span
              class="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium"
              :class="biasClass"
            >
              {{ store.regime.data.tradingBias }}
            </span>
          </div>
          <div class="flex items-center justify-between">
            <span class="text-gray-700 dark:text-gray-300">VIX Trend</span>
            <span class="text-sm font-medium capitalize" :class="vixTrendColor">
              {{ store.regime.data.vixTrend }}
            </span>
          </div>
          <div class="flex items-center justify-between">
            <span class="text-gray-700 dark:text-gray-300">Term Structure</span>
            <span class="text-sm text-gray-900 dark:text-gray-100 capitalize">
              {{ store.regime.data.termStructure }}
            </span>
          </div>
        </div>
        <p v-else-if="store.errors.regime" class="text-sm text-red-500">{{ store.errors.regime }}</p>
        <p v-else class="text-sm text-gray-500 dark:text-gray-400">No data available</p>
      </div>

      <!-- VIX Card -->
      <div class="bg-white dark:bg-gray-800 rounded-lg shadow-sm border border-gray-200 dark:border-gray-700 p-6">
        <h3 class="text-sm font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider mb-4">VIX & Volatility</h3>
        <div v-if="store.loading.vix" class="flex justify-center py-6">
          <div class="animate-spin rounded-full h-6 w-6 border-b-2 border-primary-600"></div>
        </div>
        <div v-else-if="store.vix?.data" class="space-y-4">
          <div class="text-center mb-3">
            <div class="text-3xl font-bold" :class="vixValueColor">
              {{ store.vix.data.spot?.toFixed(2) }}
            </div>
            <div class="text-xs text-gray-500 dark:text-gray-400 mt-1">VIX Spot</div>
          </div>
          <div class="flex items-center justify-between">
            <span class="text-gray-700 dark:text-gray-300">Term Structure</span>
            <span class="text-sm font-medium capitalize text-gray-900 dark:text-gray-100">
              {{ store.vix.data.termStructure }}
            </span>
          </div>
          <div v-if="store.vix.data.futures?.length" class="border-t border-gray-100 dark:border-gray-700 pt-3">
            <div class="text-xs font-medium text-gray-500 dark:text-gray-400 mb-2">Futures Curve</div>
            <div class="space-y-1">
              <div
                v-for="future in store.vix.data.futures.slice(0, 4)"
                :key="future.month"
                class="flex justify-between text-sm"
              >
                <span class="text-gray-600 dark:text-gray-400">{{ future.month }}</span>
                <span class="font-medium text-gray-900 dark:text-gray-100">
                  {{ future.price?.toFixed(2) }}
                  <span
                    class="text-xs ml-1"
                    :class="future.change >= 0 ? 'text-green-600' : 'text-red-600'"
                  >
                    {{ future.change >= 0 ? '+' : '' }}{{ future.change?.toFixed(2) }}
                  </span>
                </span>
              </div>
            </div>
          </div>
        </div>
        <p v-else-if="store.errors.vix" class="text-sm text-red-500">{{ store.errors.vix }}</p>
        <p v-else class="text-sm text-gray-500 dark:text-gray-400">No data available</p>
      </div>

      <!-- Macro Indicators Card -->
      <div class="bg-white dark:bg-gray-800 rounded-lg shadow-sm border border-gray-200 dark:border-gray-700 p-6">
        <h3 class="text-sm font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider mb-4">Macro Indicators</h3>
        <div v-if="store.loading.macro" class="flex justify-center py-6">
          <div class="animate-spin rounded-full h-6 w-6 border-b-2 border-primary-600"></div>
        </div>
        <div v-else-if="store.macro?.data" class="space-y-4">
          <div class="flex items-center justify-between">
            <span class="text-gray-700 dark:text-gray-300">Fed Funds Rate</span>
            <span class="font-semibold text-gray-900 dark:text-gray-100">
              {{ store.macro.data.fedFundsRate != null ? store.macro.data.fedFundsRate + '%' : 'N/A' }}
            </span>
          </div>
          <div class="flex items-center justify-between">
            <span class="text-gray-700 dark:text-gray-300">2Y Yield</span>
            <span class="font-medium text-gray-900 dark:text-gray-100">
              {{ store.macro.data.yield2y != null ? store.macro.data.yield2y + '%' : 'N/A' }}
            </span>
          </div>
          <div class="flex items-center justify-between">
            <span class="text-gray-700 dark:text-gray-300">10Y Yield</span>
            <span class="font-medium text-gray-900 dark:text-gray-100">
              {{ store.macro.data.yield10y != null ? store.macro.data.yield10y + '%' : 'N/A' }}
            </span>
          </div>
          <div class="flex items-center justify-between">
            <span class="text-gray-700 dark:text-gray-300">Yield Spread (10Y-2Y)</span>
            <span
              class="font-medium"
              :class="store.macro.data.yieldCurveInverted ? 'text-red-600' : 'text-green-600'"
            >
              {{ store.macro.data.yieldSpread != null ? store.macro.data.yieldSpread.toFixed(2) + '%' : 'N/A' }}
              <span v-if="store.macro.data.yieldCurveInverted" class="text-xs ml-1">(Inverted)</span>
            </span>
          </div>
          <div v-if="store.macro.data.nextFomc" class="border-t border-gray-100 dark:border-gray-700 pt-3">
            <div class="flex items-center justify-between">
              <span class="text-gray-700 dark:text-gray-300">Next FOMC</span>
              <div class="text-right">
                <span class="text-sm font-medium text-gray-900 dark:text-gray-100">{{ store.macro.data.nextFomc }}</span>
                <span v-if="store.macro.data.daysUntilFomc != null" class="text-xs text-gray-500 dark:text-gray-400 block">
                  {{ store.macro.data.daysUntilFomc }} days away
                </span>
              </div>
            </div>
          </div>
        </div>
        <p v-else-if="store.errors.macro" class="text-sm text-red-500">{{ store.errors.macro }}</p>
        <p v-else class="text-sm text-gray-500 dark:text-gray-400">No data available</p>
      </div>
    </div>

    <!-- Symbol Lookup Section -->
    <div class="bg-white dark:bg-gray-800 rounded-lg shadow-sm border border-gray-200 dark:border-gray-700 p-6 mb-8">
      <div class="flex flex-col sm:flex-row sm:items-center sm:justify-between mb-6">
        <h2 class="heading-section">Symbol Analysis</h2>
        <div class="mt-3 sm:mt-0 flex items-center space-x-3">
          <SymbolAutocomplete
            v-model="selectedSymbol"
            placeholder="Enter symbol (e.g. SPY)"
            class="w-48"
          />
          <button
            @click="loadSymbolData"
            :disabled="!selectedSymbol || symbolLoading"
            class="btn-primary text-sm"
          >
            {{ symbolLoading ? 'Loading...' : 'Analyze' }}
          </button>
        </div>
      </div>

      <!-- Quick Symbols -->
      <div class="flex flex-wrap gap-2 mb-6">
        <button
          v-for="sym in quickSymbols"
          :key="sym"
          @click="quickLookup(sym)"
          class="px-3 py-1.5 text-xs font-medium rounded-full border transition-colors"
          :class="activeSymbol === sym
            ? 'bg-primary-100 dark:bg-primary-900/30 border-primary-300 dark:border-primary-700 text-primary-700 dark:text-primary-300'
            : 'border-gray-300 dark:border-gray-600 text-gray-600 dark:text-gray-400 hover:bg-gray-50 dark:hover:bg-gray-700'"
        >
          {{ sym }}
        </button>
      </div>

      <!-- Symbol Data Panels -->
      <div v-if="activeSymbol" class="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <!-- GEX Panel -->
        <div class="bg-gray-50 dark:bg-gray-900/50 rounded-lg p-5 border border-gray-100 dark:border-gray-700">
          <h3 class="text-sm font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider mb-4">
            Gamma Exposure (GEX)
          </h3>
          <div v-if="store.loading.gex" class="flex justify-center py-8">
            <div class="animate-spin rounded-full h-6 w-6 border-b-2 border-primary-600"></div>
          </div>
          <div v-else-if="currentGex" class="space-y-3">
            <div class="grid grid-cols-2 gap-3">
              <div>
                <div class="text-xs text-gray-500 dark:text-gray-400">Net GEX</div>
                <div class="text-lg font-bold" :class="currentGex.netGex >= 0 ? 'text-green-600' : 'text-red-600'">
                  {{ formatLargeNumber(currentGex.netGex) }}
                </div>
              </div>
              <div>
                <div class="text-xs text-gray-500 dark:text-gray-400">Total GEX</div>
                <div class="text-lg font-bold text-gray-900 dark:text-gray-100">
                  {{ formatLargeNumber(currentGex.totalGex) }}
                </div>
              </div>
            </div>
            <div class="flex items-center justify-between text-sm">
              <span class="text-green-600">Call: {{ formatLargeNumber(currentGex.callGex) }}</span>
              <span class="text-red-600">Put: {{ formatLargeNumber(currentGex.putGex) }}</span>
            </div>
            <div v-if="currentGex.flipPrice" class="flex items-center justify-between text-sm border-t border-gray-200 dark:border-gray-600 pt-3">
              <span class="text-gray-600 dark:text-gray-400">GEX Flip Price</span>
              <span class="font-semibold text-gray-900 dark:text-gray-100">${{ currentGex.flipPrice?.toFixed(2) }}</span>
            </div>
            <div v-if="currentGex.majorLevels?.length" class="border-t border-gray-200 dark:border-gray-600 pt-3">
              <div class="text-xs font-medium text-gray-500 dark:text-gray-400 mb-2">Key Levels</div>
              <div class="space-y-1">
                <div
                  v-for="level in currentGex.majorLevels.slice(0, 5)"
                  :key="level.strike"
                  class="flex justify-between text-xs"
                >
                  <span class="font-medium" :class="levelTypeColor(level.type)">
                    {{ level.type.toUpperCase() }}
                  </span>
                  <span class="text-gray-900 dark:text-gray-100">${{ level.strike }}</span>
                  <span class="text-gray-500 dark:text-gray-400">{{ formatLargeNumber(level.gex) }}</span>
                </div>
              </div>
            </div>
          </div>
          <p v-else-if="store.errors.gex" class="text-sm text-red-500">{{ store.errors.gex }}</p>
          <p v-else class="text-sm text-gray-500 dark:text-gray-400">Select a symbol to view GEX data</p>
        </div>

        <!-- Options Flow Panel -->
        <div class="bg-gray-50 dark:bg-gray-900/50 rounded-lg p-5 border border-gray-100 dark:border-gray-700">
          <h3 class="text-sm font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider mb-4">
            Options Flow
          </h3>
          <div v-if="store.loading.flow" class="flex justify-center py-8">
            <div class="animate-spin rounded-full h-6 w-6 border-b-2 border-primary-600"></div>
          </div>
          <div v-else-if="currentFlow" class="space-y-3">
            <div class="text-center mb-3">
              <span
                class="inline-flex items-center px-3 py-1 rounded-full text-sm font-semibold"
                :class="sentimentClass(currentFlow.sentiment)"
              >
                {{ currentFlow.sentiment?.toUpperCase() }}
              </span>
            </div>
            <div class="grid grid-cols-2 gap-3">
              <div>
                <div class="text-xs text-gray-500 dark:text-gray-400">Net Premium</div>
                <div class="text-lg font-bold" :class="currentFlow.netPremium >= 0 ? 'text-green-600' : 'text-red-600'">
                  ${{ formatLargeNumber(currentFlow.netPremium) }}
                </div>
              </div>
              <div>
                <div class="text-xs text-gray-500 dark:text-gray-400">Total Premium</div>
                <div class="text-lg font-bold text-gray-900 dark:text-gray-100">
                  ${{ formatLargeNumber(currentFlow.totalPremium) }}
                </div>
              </div>
            </div>
            <!-- Call/Put Premium Bar -->
            <div>
              <div class="flex justify-between text-xs mb-1">
                <span class="text-green-600">Calls: ${{ formatLargeNumber(currentFlow.callPremium) }}</span>
                <span class="text-red-600">Puts: ${{ formatLargeNumber(currentFlow.putPremium) }}</span>
              </div>
              <div class="w-full bg-red-200 dark:bg-red-900/30 rounded-full h-2.5">
                <div
                  class="bg-green-500 h-2.5 rounded-full transition-all"
                  :style="{ width: callPremiumPercent + '%' }"
                ></div>
              </div>
            </div>
            <div class="flex items-center justify-between text-sm border-t border-gray-200 dark:border-gray-600 pt-3">
              <span class="text-gray-600 dark:text-gray-400">P/C Ratio</span>
              <span class="font-semibold text-gray-900 dark:text-gray-100">{{ currentFlow.putCallRatio?.toFixed(2) }}</span>
            </div>
            <div v-if="currentFlow.largestTrades?.length" class="border-t border-gray-200 dark:border-gray-600 pt-3">
              <div class="text-xs font-medium text-gray-500 dark:text-gray-400 mb-2">Largest Trades</div>
              <div class="space-y-1.5">
                <div
                  v-for="(trade, i) in currentFlow.largestTrades.slice(0, 3)"
                  :key="i"
                  class="flex justify-between text-xs"
                >
                  <span :class="trade.type === 'call' ? 'text-green-600' : 'text-red-600'" class="font-medium">
                    {{ trade.type?.toUpperCase() }} ${{ trade.strike }}
                  </span>
                  <span class="text-gray-500 dark:text-gray-400">{{ trade.expiration }}</span>
                  <span class="font-medium text-gray-900 dark:text-gray-100">${{ formatLargeNumber(trade.premium) }}</span>
                </div>
              </div>
            </div>
          </div>
          <p v-else-if="store.errors.flow" class="text-sm text-red-500">{{ store.errors.flow }}</p>
          <p v-else class="text-sm text-gray-500 dark:text-gray-400">Select a symbol to view options flow</p>
        </div>

        <!-- Implied Volatility Panel -->
        <div class="bg-gray-50 dark:bg-gray-900/50 rounded-lg p-5 border border-gray-100 dark:border-gray-700">
          <h3 class="text-sm font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider mb-4">
            Implied Volatility
          </h3>
          <div v-if="store.loading.iv" class="flex justify-center py-8">
            <div class="animate-spin rounded-full h-6 w-6 border-b-2 border-primary-600"></div>
          </div>
          <div v-else-if="currentIV" class="space-y-3">
            <div class="text-center mb-3">
              <div class="text-3xl font-bold text-gray-900 dark:text-gray-100">
                {{ (currentIV.currentIV * 100).toFixed(1) }}%
              </div>
              <div class="text-xs text-gray-500 dark:text-gray-400 mt-1">Current IV</div>
            </div>
            <div class="grid grid-cols-2 gap-3">
              <div class="text-center">
                <div class="text-xs text-gray-500 dark:text-gray-400">IV Rank</div>
                <div class="text-lg font-bold" :class="ivRankColor(currentIV.ivRank)">
                  {{ currentIV.ivRank?.toFixed(0) }}
                </div>
              </div>
              <div class="text-center">
                <div class="text-xs text-gray-500 dark:text-gray-400">IV Percentile</div>
                <div class="text-lg font-bold" :class="ivRankColor(currentIV.ivPercentile)">
                  {{ currentIV.ivPercentile?.toFixed(0) }}%
                </div>
              </div>
            </div>
            <!-- IV Rank Bar -->
            <div>
              <div class="text-xs text-gray-500 dark:text-gray-400 mb-1">IV Rank</div>
              <div class="w-full bg-gray-200 dark:bg-gray-700 rounded-full h-2">
                <div
                  class="h-2 rounded-full transition-all"
                  :class="ivRankBarColor(currentIV.ivRank)"
                  :style="{ width: Math.min(currentIV.ivRank || 0, 100) + '%' }"
                ></div>
              </div>
            </div>
            <div class="border-t border-gray-200 dark:border-gray-600 pt-3 space-y-2">
              <div class="text-xs font-medium text-gray-500 dark:text-gray-400 mb-1">Historical IV</div>
              <div class="flex items-center justify-between text-sm">
                <span class="text-gray-600 dark:text-gray-400">HV 30d</span>
                <span class="font-medium text-gray-900 dark:text-gray-100">{{ (currentIV.historicalIV30 * 100).toFixed(1) }}%</span>
              </div>
              <div class="flex items-center justify-between text-sm">
                <span class="text-gray-600 dark:text-gray-400">HV 60d</span>
                <span class="font-medium text-gray-900 dark:text-gray-100">{{ (currentIV.historicalIV60 * 100).toFixed(1) }}%</span>
              </div>
              <div class="flex items-center justify-between text-sm">
                <span class="text-gray-600 dark:text-gray-400">HV 90d</span>
                <span class="font-medium text-gray-900 dark:text-gray-100">{{ (currentIV.historicalIV90 * 100).toFixed(1) }}%</span>
              </div>
            </div>
          </div>
          <p v-else-if="store.errors.iv" class="text-sm text-red-500">{{ store.errors.iv }}</p>
          <p v-else class="text-sm text-gray-500 dark:text-gray-400">Select a symbol to view IV data</p>
        </div>
      </div>

      <!-- No Symbol Selected State -->
      <div v-else class="text-center py-12">
        <svg class="mx-auto h-12 w-12 text-gray-400 dark:text-gray-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z" />
        </svg>
        <h3 class="mt-2 text-sm font-medium text-gray-900 dark:text-gray-100">No symbol selected</h3>
        <p class="mt-1 text-sm text-gray-500 dark:text-gray-400">
          Enter a ticker symbol above or click a quick symbol to view GEX, options flow, and implied volatility.
        </p>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, computed, onMounted } from 'vue'
import { useMarketDataStore } from '@/stores/marketData'
import SymbolAutocomplete from '@/components/common/SymbolAutocomplete.vue'

const store = useMarketDataStore()

const selectedSymbol = ref('')
const activeSymbol = ref(null)
const quickSymbols = ['SPY', 'QQQ', 'IWM', 'AAPL', 'TSLA', 'NVDA', 'AMZN', 'META']

const anyLoading = computed(() =>
  Object.values(store.loading).some(Boolean)
)

const serviceUnavailable = computed(() => {
  const allFailed = store.errors.regime && store.errors.vix && store.errors.macro
  return allFailed && !store.regime && !store.vix && !store.macro
})

const marketStatusDot = computed(() => {
  if (store.marketHours?.data?.isOpen) return 'bg-green-500'
  if (store.marketHours?.data?.isPreMarket) return 'bg-yellow-500'
  if (store.marketHours?.data?.isAfterHours) return 'bg-blue-500'
  return 'bg-red-500'
})

const marketStatusLabel = computed(() => {
  const h = store.marketHours?.data
  if (!h) return 'Loading...'
  if (h.isOpen) return 'Market Open'
  if (h.isPreMarket) return 'Pre-Market'
  if (h.isAfterHours) return 'After Hours'
  if (h.holiday) return `Closed (${h.holiday})`
  return 'Market Closed'
})

const regimeBadgeClass = computed(() => {
  const map = {
    green: 'bg-green-100 text-green-800 dark:bg-green-900/20 dark:text-green-400',
    blue: 'bg-blue-100 text-blue-800 dark:bg-blue-900/20 dark:text-blue-400',
    yellow: 'bg-yellow-100 text-yellow-800 dark:bg-yellow-900/20 dark:text-yellow-400',
    red: 'bg-red-100 text-red-800 dark:bg-red-900/20 dark:text-red-400',
    gray: 'bg-gray-100 text-gray-800 dark:bg-gray-900/20 dark:text-gray-400'
  }
  return map[store.regimeBadge?.color] || map.gray
})

const regimeTextColor = computed(() => {
  const map = {
    'low-vol': 'text-green-600 dark:text-green-400',
    'normal': 'text-blue-600 dark:text-blue-400',
    'elevated': 'text-yellow-600 dark:text-yellow-400',
    'crisis': 'text-red-600 dark:text-red-400'
  }
  return map[store.regime?.data?.regime] || 'text-gray-900 dark:text-gray-100'
})

const biasClass = computed(() => {
  const map = {
    'risk-on': 'bg-green-100 text-green-800 dark:bg-green-900/20 dark:text-green-400',
    'neutral': 'bg-gray-100 text-gray-800 dark:bg-gray-900/20 dark:text-gray-400',
    'risk-off': 'bg-red-100 text-red-800 dark:bg-red-900/20 dark:text-red-400'
  }
  return map[store.regime?.data?.tradingBias] || map.neutral
})

const vixTrendColor = computed(() => {
  const map = {
    'rising': 'text-red-600 dark:text-red-400',
    'falling': 'text-green-600 dark:text-green-400',
    'stable': 'text-gray-600 dark:text-gray-400'
  }
  return map[store.regime?.data?.vixTrend] || 'text-gray-600'
})

const vixValueColor = computed(() => {
  const spot = store.vix?.data?.spot
  if (!spot) return 'text-gray-900 dark:text-gray-100'
  if (spot >= 30) return 'text-red-600 dark:text-red-400'
  if (spot >= 20) return 'text-yellow-600 dark:text-yellow-400'
  return 'text-green-600 dark:text-green-400'
})

const currentGex = computed(() => {
  if (!activeSymbol.value) return null
  return store.gexData[activeSymbol.value]?.data
})

const currentFlow = computed(() => {
  if (!activeSymbol.value) return null
  return store.flowData[activeSymbol.value]?.data
})

const currentIV = computed(() => {
  if (!activeSymbol.value) return null
  return store.ivData[activeSymbol.value]?.data
})

const callPremiumPercent = computed(() => {
  if (!currentFlow.value) return 50
  const total = (currentFlow.value.callPremium || 0) + (currentFlow.value.putPremium || 0)
  if (total === 0) return 50
  return ((currentFlow.value.callPremium / total) * 100).toFixed(0)
})

const symbolLoading = computed(() =>
  store.loading.gex || store.loading.flow || store.loading.iv
)

function formatLargeNumber(num) {
  if (num == null) return 'N/A'
  const abs = Math.abs(num)
  if (abs >= 1e9) return (num / 1e9).toFixed(1) + 'B'
  if (abs >= 1e6) return (num / 1e6).toFixed(1) + 'M'
  if (abs >= 1e3) return (num / 1e3).toFixed(1) + 'K'
  return num.toFixed(0)
}

function levelTypeColor(type) {
  const map = {
    support: 'text-green-600 dark:text-green-400',
    resistance: 'text-red-600 dark:text-red-400',
    pin: 'text-yellow-600 dark:text-yellow-400',
    flip: 'text-purple-600 dark:text-purple-400'
  }
  return map[type] || 'text-gray-600'
}

function sentimentClass(sentiment) {
  const map = {
    bullish: 'bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-400',
    bearish: 'bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-400',
    neutral: 'bg-gray-100 text-gray-800 dark:bg-gray-900/30 dark:text-gray-400'
  }
  return map[sentiment] || map.neutral
}

function ivRankColor(rank) {
  if (rank == null) return 'text-gray-900 dark:text-gray-100'
  if (rank >= 70) return 'text-red-600 dark:text-red-400'
  if (rank >= 40) return 'text-yellow-600 dark:text-yellow-400'
  return 'text-green-600 dark:text-green-400'
}

function ivRankBarColor(rank) {
  if (rank == null) return 'bg-gray-400'
  if (rank >= 70) return 'bg-red-500'
  if (rank >= 40) return 'bg-yellow-500'
  return 'bg-green-500'
}

function loadSymbolData() {
  if (!selectedSymbol.value) return
  activeSymbol.value = selectedSymbol.value.toUpperCase()
  store.fetchSymbolData(activeSymbol.value)
}

function quickLookup(symbol) {
  selectedSymbol.value = symbol
  activeSymbol.value = symbol
  store.fetchSymbolData(symbol)
}

function refreshAll() {
  store.fetchOverview()
  if (activeSymbol.value) {
    store.fetchSymbolData(activeSymbol.value)
  }
}

onMounted(() => {
  store.fetchOverview()
})
</script>
