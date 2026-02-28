<template>
  <div class="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
    <div class="flex items-center justify-between mb-6">
      <div>
        <h1 class="text-2xl font-bold text-gray-900 dark:text-white">Adaptive Intelligence</h1>
        <p class="mt-1 text-sm text-gray-500 dark:text-gray-400">
          Feedback loop analytics — conviction calibration, regime edge, and temporal patterns
        </p>
      </div>
      <div class="flex items-center gap-3">
        <select
          v-model="lookbackDays"
          @change="refreshActiveTab"
          class="text-sm rounded-lg border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 text-gray-700 dark:text-gray-300 px-3 py-2"
        >
          <option :value="30">Last 30 days</option>
          <option :value="60">Last 60 days</option>
          <option :value="90">Last 90 days</option>
          <option :value="180">Last 180 days</option>
          <option :value="365">Last year</option>
        </select>
        <button
          @click="refreshActiveTab"
          class="inline-flex items-center px-3 py-2 text-sm font-medium rounded-lg bg-white dark:bg-gray-800 text-gray-700 dark:text-gray-300 border border-gray-300 dark:border-gray-600 hover:bg-gray-50 dark:hover:bg-gray-700"
        >
          <ArrowPathIcon class="h-4 w-4 mr-1.5" :class="{ 'animate-spin': store.adaptiveLoading }" />
          Refresh
        </button>
      </div>
    </div>

    <!-- Summary cards -->
    <div v-if="store.adaptiveSummary" class="grid grid-cols-2 md:grid-cols-4 gap-4 mb-6">
      <div class="bg-white dark:bg-gray-800 rounded-lg shadow p-4">
        <p class="text-xs font-medium text-gray-500 dark:text-gray-400 uppercase">Calibration Health</p>
        <p class="text-lg font-bold mt-1" :class="store.adaptiveSummary.calibration?.health === 'ALIGNED' ? 'text-green-600' : 'text-amber-600'">
          {{ store.adaptiveSummary.calibration?.health || '-' }}
        </p>
        <p class="text-xs text-gray-500 mt-0.5">{{ store.adaptiveSummary.calibration?.driftCount || 0 }} weight drifts</p>
      </div>
      <div class="bg-white dark:bg-gray-800 rounded-lg shadow p-4">
        <p class="text-xs font-medium text-gray-500 dark:text-gray-400 uppercase">Total Trades</p>
        <p class="text-2xl font-bold text-gray-900 dark:text-white mt-1">{{ store.adaptiveSummary.calibration?.totalTrades || 0 }}</p>
      </div>
      <div class="bg-white dark:bg-gray-800 rounded-lg shadow p-4">
        <p class="text-xs font-medium text-gray-500 dark:text-gray-400 uppercase">Edge Hours</p>
        <p class="text-2xl font-bold text-indigo-600 mt-1">{{ store.adaptiveSummary.temporal?.edgeHours?.length || 0 }}</p>
        <p class="text-xs text-gray-500 mt-0.5">statistically significant</p>
      </div>
      <div class="bg-white dark:bg-gray-800 rounded-lg shadow p-4">
        <p class="text-xs font-medium text-gray-500 dark:text-gray-400 uppercase">Base Win Rate</p>
        <p class="text-2xl font-bold text-gray-900 dark:text-white mt-1">{{ formatPct(store.adaptiveSummary.temporal?.baseWinRate) }}</p>
      </div>
    </div>

    <!-- Recalibration prompt banner -->
    <div
      v-if="store.calibrationStatus?.recalibrationDue && !store.calibrationStatus?.autoCalibrationEnabled && !bannerDismissed"
      class="mb-6 rounded-lg border border-indigo-200 dark:border-indigo-800 bg-indigo-50 dark:bg-indigo-900/20 p-4 flex items-center justify-between"
    >
      <div class="flex items-center gap-3">
        <div class="flex-shrink-0 w-10 h-10 rounded-full bg-indigo-100 dark:bg-indigo-800 flex items-center justify-center">
          <AdjustmentsHorizontalIcon class="h-5 w-5 text-indigo-600 dark:text-indigo-400" />
        </div>
        <div>
          <p class="text-sm font-semibold text-indigo-900 dark:text-indigo-200">Recalibration Available</p>
          <p class="text-xs text-indigo-700 dark:text-indigo-400">
            {{ store.calibrationStatus.tradesSinceLastCalibration }} trades since last calibration
            (threshold: {{ store.calibrationStatus.calibrationThreshold }}).
            Review updated weight recommendations on the Calibration tab.
          </p>
        </div>
      </div>
      <div class="flex gap-2 flex-shrink-0">
        <button
          @click="handleApplyCalibration"
          :disabled="store.adaptiveLoading"
          class="inline-flex items-center px-3 py-1.5 text-xs font-semibold rounded-lg bg-indigo-600 text-white hover:bg-indigo-700 disabled:opacity-50"
        >
          Apply Weights
        </button>
        <button
          @click="dismissBanner"
          class="inline-flex items-center px-3 py-1.5 text-xs font-medium rounded-lg text-indigo-700 dark:text-indigo-400 hover:bg-indigo-100 dark:hover:bg-indigo-900/30"
        >
          Dismiss
        </button>
      </div>
    </div>

    <!-- Tabs -->
    <div class="border-b border-gray-200 dark:border-gray-700 mb-6">
      <nav class="flex space-x-6 overflow-x-auto">
        <button
          v-for="tab in tabs"
          :key="tab.id"
          @click="switchTab(tab.id)"
          class="pb-3 text-sm font-medium border-b-2 transition-colors whitespace-nowrap"
          :class="activeTab === tab.id
            ? 'border-indigo-500 text-indigo-600 dark:text-indigo-400'
            : 'border-transparent text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-300'"
        >
          {{ tab.label }}
          <span v-if="tab.badge" class="ml-1.5 inline-flex items-center px-1.5 py-0.5 rounded text-xs font-medium bg-gray-100 dark:bg-gray-700 text-gray-500 dark:text-gray-400">
            {{ tab.badge }}
          </span>
        </button>
      </nav>
    </div>

    <!-- Loading state -->
    <div v-if="store.adaptiveLoading" class="flex items-center justify-center py-20">
      <div class="animate-spin rounded-full h-8 w-8 border-b-2 border-indigo-500"></div>
      <span class="ml-3 text-gray-500 dark:text-gray-400">Analyzing historical data...</span>
    </div>

    <!-- ═══ Tab: Calibration ═══ -->
    <div v-else-if="activeTab === 'calibration'">
      <div v-if="!store.calibrationData || store.calibrationData.totalTrades === 0" class="bg-white dark:bg-gray-800 rounded-lg shadow p-12 text-center text-gray-500 dark:text-gray-400">
        <AdjustmentsHorizontalIcon class="h-12 w-12 mx-auto mb-3 opacity-50" />
        <p>No completed trades to calibrate against. The engine needs trade outcomes to compute empirical weights.</p>
      </div>

      <div v-else>
        <div class="bg-white dark:bg-gray-800 rounded-lg shadow mb-4 px-4 py-3 flex items-center justify-between">
          <div>
            <span class="text-sm font-medium text-gray-700 dark:text-gray-300">Calibration based on</span>
            <span class="ml-2 text-sm font-bold text-gray-900 dark:text-white">{{ store.calibrationData.totalTrades }} trades</span>
            <span class="ml-2 text-sm text-gray-500">(last {{ store.calibrationData.lookbackDays }} days)</span>
          </div>
          <span
            class="inline-flex items-center px-2.5 py-1 rounded-full text-xs font-semibold"
            :class="store.calibrationData.calibrationHealth === 'ALIGNED'
              ? 'bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-400'
              : 'bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-400'"
          >
            {{ store.calibrationData.calibrationHealth === 'ALIGNED' ? 'Weights Aligned' : `${store.calibrationData.driftCount} Drift(s) Detected` }}
          </span>
        </div>

        <div class="bg-white dark:bg-gray-800 rounded-lg shadow overflow-hidden">
          <table class="min-w-full divide-y divide-gray-200 dark:divide-gray-700">
            <thead class="bg-gray-50 dark:bg-gray-900/50">
              <tr>
                <th class="px-4 py-3 text-left text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase">Component</th>
                <th class="px-4 py-3 text-center text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase">Static Wt</th>
                <th class="px-4 py-3 text-center text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase">Recommended</th>
                <th class="px-4 py-3 text-center text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase">Drift</th>
                <th class="px-4 py-3 text-center text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase">WR Lift</th>
                <th class="px-4 py-3 text-center text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase">Avg R Lift</th>
                <th class="px-4 py-3 text-center text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase">Present n</th>
                <th class="px-4 py-3 text-center text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase">Present WR</th>
                <th class="px-4 py-3 text-center text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase">Absent WR</th>
              </tr>
            </thead>
            <tbody class="divide-y divide-gray-200 dark:divide-gray-700">
              <tr
                v-for="comp in store.calibrationData.components"
                :key="comp.key"
                :class="{ 'bg-amber-50/50 dark:bg-amber-900/10': Math.abs(comp.weightDrift) >= 3 && comp.significant }"
              >
                <td class="px-4 py-3 text-sm font-medium text-gray-900 dark:text-white">
                  {{ formatComponentKey(comp.key) }}
                  <span v-if="!comp.significant" class="ml-1 text-xs text-gray-400">(low n)</span>
                </td>
                <td class="px-4 py-3 text-sm text-center font-mono" :class="comp.staticWeight > 0 ? 'text-green-600' : 'text-red-500'">
                  {{ comp.staticWeight > 0 ? '+' : '' }}{{ comp.staticWeight }}
                </td>
                <td class="px-4 py-3 text-sm text-center font-mono font-bold" :class="comp.recommendedWeight > 0 ? 'text-green-600' : comp.recommendedWeight < 0 ? 'text-red-500' : 'text-gray-500'">
                  {{ comp.recommendedWeight > 0 ? '+' : '' }}{{ comp.recommendedWeight }}
                </td>
                <td class="px-4 py-3 text-sm text-center">
                  <span
                    v-if="comp.significant && comp.weightDrift !== 0"
                    class="inline-flex items-center px-1.5 py-0.5 rounded text-xs font-semibold"
                    :class="Math.abs(comp.weightDrift) >= 3
                      ? 'bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-400'
                      : 'bg-gray-100 text-gray-600 dark:bg-gray-700 dark:text-gray-400'"
                  >
                    {{ comp.weightDrift > 0 ? '+' : '' }}{{ comp.weightDrift }}
                  </span>
                  <span v-else class="text-gray-400">—</span>
                </td>
                <td class="px-4 py-3 text-sm text-center" :class="comp.winRateLift > 0 ? 'text-green-600' : comp.winRateLift < 0 ? 'text-red-500' : 'text-gray-500'">
                  {{ comp.winRateLift > 0 ? '+' : '' }}{{ comp.winRateLift }}%
                </td>
                <td class="px-4 py-3 text-sm text-center font-mono" :class="comp.avgRLift > 0 ? 'text-green-600' : comp.avgRLift < 0 ? 'text-red-500' : 'text-gray-500'">
                  {{ comp.avgRLift > 0 ? '+' : '' }}{{ comp.avgRLift }}R
                </td>
                <td class="px-4 py-3 text-sm text-center text-gray-600 dark:text-gray-400">{{ comp.present.sampleSize }}</td>
                <td class="px-4 py-3 text-sm text-center text-gray-600 dark:text-gray-400">{{ formatPct(comp.present.winRate) }}</td>
                <td class="px-4 py-3 text-sm text-center text-gray-600 dark:text-gray-400">{{ formatPct(comp.absent.winRate) }}</td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>
    </div>

    <!-- ═══ Tab: Regime Edge ═══ -->
    <div v-else-if="activeTab === 'regime'">
      <div v-if="!store.regimeEdgeData || store.regimeEdgeData.totalTrades === 0" class="bg-white dark:bg-gray-800 rounded-lg shadow p-12 text-center text-gray-500 dark:text-gray-400">
        <ChartBarSquareIcon class="h-12 w-12 mx-auto mb-3 opacity-50" />
        <p>No regime-tagged trades yet. Trades need volatility snapshots to compute regime-conditional performance.</p>
      </div>

      <div v-else>
        <!-- Strategy implications -->
        <div v-if="store.regimeEdgeData.currentImplications?.length" class="mb-6 grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          <div
            v-for="imp in store.regimeEdgeData.currentImplications"
            :key="imp.strategy"
            class="bg-white dark:bg-gray-800 rounded-lg shadow p-4"
          >
            <h3 class="text-sm font-bold text-gray-900 dark:text-white mb-2">{{ imp.strategy }}</h3>
            <div class="space-y-1.5">
              <div v-if="imp.strong.length" class="flex items-center gap-2">
                <span class="inline-flex items-center px-1.5 py-0.5 rounded text-xs font-semibold bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-400">STRONG</span>
                <span class="text-xs text-gray-600 dark:text-gray-400">{{ imp.strong.join(', ') }}</span>
              </div>
              <div v-if="imp.active.length" class="flex items-center gap-2">
                <span class="inline-flex items-center px-1.5 py-0.5 rounded text-xs font-semibold bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-400">ACTIVE</span>
                <span class="text-xs text-gray-600 dark:text-gray-400">{{ imp.active.join(', ') }}</span>
              </div>
              <div v-if="imp.suppressed.length" class="flex items-center gap-2">
                <span class="inline-flex items-center px-1.5 py-0.5 rounded text-xs font-semibold bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-400">SUPPRESSED</span>
                <span class="text-xs text-gray-600 dark:text-gray-400">{{ imp.suppressed.join(', ') }}</span>
              </div>
            </div>
          </div>
        </div>

        <!-- Matrix table -->
        <div class="bg-white dark:bg-gray-800 rounded-lg shadow overflow-hidden">
          <table class="min-w-full divide-y divide-gray-200 dark:divide-gray-700">
            <thead class="bg-gray-50 dark:bg-gray-900/50">
              <tr>
                <th class="px-4 py-3 text-left text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase">Strategy</th>
                <th class="px-4 py-3 text-left text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase">Regime</th>
                <th class="px-4 py-3 text-center text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase">Trades</th>
                <th class="px-4 py-3 text-center text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase">Win Rate</th>
                <th class="px-4 py-3 text-center text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase">Avg R</th>
                <th class="px-4 py-3 text-center text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase">PF</th>
                <th class="px-4 py-3 text-right text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase">Total P&L</th>
                <th class="px-4 py-3 text-center text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase">Status</th>
              </tr>
            </thead>
            <tbody class="divide-y divide-gray-200 dark:divide-gray-700">
              <tr
                v-for="(cell, idx) in store.regimeEdgeData.matrix"
                :key="idx"
                :class="{
                  'bg-red-50/50 dark:bg-red-900/10': cell.status === 'SUPPRESSED',
                  'bg-green-50/50 dark:bg-green-900/10': cell.status === 'STRONG',
                }"
              >
                <td class="px-4 py-3 text-sm font-medium text-gray-900 dark:text-white">{{ cell.strategy }}</td>
                <td class="px-4 py-3 text-sm">
                  <span class="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium" :class="regimeBadgeClass(cell.regime)">
                    {{ cell.regime }}
                  </span>
                </td>
                <td class="px-4 py-3 text-sm text-center text-gray-600 dark:text-gray-400">{{ cell.totalTrades }}</td>
                <td class="px-4 py-3 text-sm text-center font-semibold" :class="cell.winRate >= 0.5 ? 'text-green-600' : 'text-red-500'">
                  {{ formatPct(cell.winRate) }}
                </td>
                <td class="px-4 py-3 text-sm text-center font-mono" :class="cell.avgR >= 0 ? 'text-green-600' : 'text-red-500'">
                  {{ cell.avgR > 0 ? '+' : '' }}{{ cell.avgR }}R
                </td>
                <td class="px-4 py-3 text-sm text-center text-gray-600 dark:text-gray-400">{{ cell.profitFactor }}</td>
                <td class="px-4 py-3 text-sm text-right font-mono" :class="cell.totalPnl >= 0 ? 'text-green-600' : 'text-red-500'">
                  ${{ cell.totalPnl.toLocaleString() }}
                </td>
                <td class="px-4 py-3 text-center">
                  <span
                    class="inline-flex items-center px-2 py-0.5 rounded text-xs font-semibold"
                    :class="statusBadgeClass(cell.status)"
                  >
                    {{ cell.status }}
                  </span>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>
    </div>

    <!-- ═══ Tab: Temporal Edge ═══ -->
    <div v-else-if="activeTab === 'temporal'">
      <div v-if="!store.temporalEdgeData || store.temporalEdgeData.totalTrades === 0" class="bg-white dark:bg-gray-800 rounded-lg shadow p-12 text-center text-gray-500 dark:text-gray-400">
        <ClockIcon class="h-12 w-12 mx-auto mb-3 opacity-50" />
        <p>No trades with entry timestamps to analyze temporal patterns.</p>
      </div>

      <div v-else>
        <!-- Edge hours callout -->
        <div v-if="store.temporalEdgeData.edgeHours?.length" class="mb-6 bg-white dark:bg-gray-800 rounded-lg shadow p-4">
          <h3 class="text-sm font-semibold text-gray-900 dark:text-white mb-3">Statistically Significant Edge Hours</h3>
          <div class="flex flex-wrap gap-2">
            <span
              v-for="edge in store.temporalEdgeData.edgeHours"
              :key="edge.label"
              class="inline-flex items-center px-3 py-1.5 rounded-lg text-sm font-medium"
              :class="edge.direction === 'STRONG'
                ? 'bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-400'
                : 'bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-400'"
            >
              {{ edge.label }}
              <span class="ml-1.5 font-bold">{{ edge.winRateDelta > 0 ? '+' : '' }}{{ edge.winRateDelta }}%</span>
              <span class="ml-1 text-xs opacity-75">(n={{ edge.sampleSize }})</span>
            </span>
          </div>
        </div>

        <!-- Heatmap grid -->
        <div class="bg-white dark:bg-gray-800 rounded-lg shadow p-4 mb-6">
          <h3 class="text-sm font-semibold text-gray-900 dark:text-white mb-4">Win Rate Heatmap — Hour x Day</h3>
          <div class="overflow-x-auto">
            <table class="w-full">
              <thead>
                <tr>
                  <th class="px-3 py-2 text-left text-xs font-semibold text-gray-500 dark:text-gray-400">Hour</th>
                  <th v-for="day in ['Mon', 'Tue', 'Wed', 'Thu', 'Fri']" :key="day" class="px-3 py-2 text-center text-xs font-semibold text-gray-500 dark:text-gray-400">{{ day }}</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="hour in heatmapHours" :key="hour">
                  <td class="px-3 py-2 text-xs font-medium text-gray-700 dark:text-gray-300">{{ hour }}</td>
                  <td
                    v-for="day in ['Mon', 'Tue', 'Wed', 'Thu', 'Fri']"
                    :key="`${hour}-${day}`"
                    class="px-3 py-2 text-center"
                  >
                    <div
                      v-if="getHeatmapCell(hour, day)"
                      class="rounded-lg px-2 py-1.5 text-xs font-semibold"
                      :class="heatmapCellClass(getHeatmapCell(hour, day))"
                      :title="`${getHeatmapCell(hour, day).sampleSize} trades, ${formatPct(getHeatmapCell(hour, day).winRate)} WR, $${getHeatmapCell(hour, day).totalPnl} PnL`"
                    >
                      {{ formatPct(getHeatmapCell(hour, day).winRate) }}
                      <div class="text-[10px] opacity-75 font-normal">n={{ getHeatmapCell(hour, day).sampleSize }}</div>
                    </div>
                    <div v-else class="text-xs text-gray-300 dark:text-gray-600">—</div>
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>

        <!-- Hour summary bar -->
        <div class="grid grid-cols-1 md:grid-cols-2 gap-6">
          <div class="bg-white dark:bg-gray-800 rounded-lg shadow p-4">
            <h3 class="text-sm font-semibold text-gray-900 dark:text-white mb-3">Performance by Hour</h3>
            <div class="space-y-2">
              <div v-for="h in store.temporalEdgeData.hourSummary" :key="h.label" class="flex items-center gap-3">
                <span class="text-xs font-medium text-gray-600 dark:text-gray-400 w-16">{{ h.label }}</span>
                <div class="flex-1 bg-gray-100 dark:bg-gray-700 rounded-full h-4 relative overflow-hidden">
                  <div
                    class="h-full rounded-full transition-all"
                    :class="h.winRate >= 0.5 ? 'bg-green-500' : 'bg-red-400'"
                    :style="{ width: `${Math.min(h.winRate * 100, 100)}%` }"
                  ></div>
                </div>
                <span class="text-xs font-semibold w-12 text-right" :class="h.winRate >= 0.5 ? 'text-green-600' : 'text-red-500'">
                  {{ formatPct(h.winRate) }}
                </span>
                <span class="text-xs text-gray-400 w-10 text-right">n={{ h.sampleSize }}</span>
              </div>
            </div>
          </div>

          <div class="bg-white dark:bg-gray-800 rounded-lg shadow p-4">
            <h3 class="text-sm font-semibold text-gray-900 dark:text-white mb-3">Performance by Day</h3>
            <div class="space-y-2">
              <div v-for="d in store.temporalEdgeData.daySummary" :key="d.day" class="flex items-center gap-3">
                <span class="text-xs font-medium text-gray-600 dark:text-gray-400 w-16">{{ d.day }}</span>
                <div class="flex-1 bg-gray-100 dark:bg-gray-700 rounded-full h-4 relative overflow-hidden">
                  <div
                    class="h-full rounded-full transition-all"
                    :class="d.winRate >= 0.5 ? 'bg-green-500' : 'bg-red-400'"
                    :style="{ width: `${Math.min(d.winRate * 100, 100)}%` }"
                  ></div>
                </div>
                <span class="text-xs font-semibold w-12 text-right" :class="d.winRate >= 0.5 ? 'text-green-600' : 'text-red-500'">
                  {{ formatPct(d.winRate) }}
                </span>
                <span class="text-xs text-gray-400 w-10 text-right">n={{ d.sampleSize }}</span>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>

    <!-- ═══ Calibration Management Panel (inside calibration tab) ═══ -->
    <div v-if="activeTab === 'calibration' && !store.adaptiveLoading" class="mt-6 space-y-4">
      <!-- Active weights status -->
      <div class="bg-white dark:bg-gray-800 rounded-lg shadow p-4">
        <div class="flex items-center justify-between mb-3">
          <h3 class="text-sm font-semibold text-gray-900 dark:text-white">Weight Management</h3>
          <div class="flex items-center gap-3">
            <label class="flex items-center gap-2 text-xs text-gray-600 dark:text-gray-400 cursor-pointer">
              <input
                type="checkbox"
                :checked="store.calibrationStatus?.autoCalibrationEnabled"
                @change="handleToggleAuto($event.target.checked)"
                class="rounded border-gray-300 text-indigo-600 focus:ring-indigo-500 h-4 w-4"
              />
              Auto-calibrate
            </label>
            <span class="text-xs text-gray-400">|</span>
            <span class="text-xs text-gray-500 dark:text-gray-400">
              Threshold:
              <select
                :value="store.calibrationStatus?.calibrationThreshold || 25"
                @change="handleSetThreshold(parseInt($event.target.value))"
                class="ml-1 text-xs rounded border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 text-gray-700 dark:text-gray-300 py-0.5 px-1"
              >
                <option :value="10">10</option>
                <option :value="15">15</option>
                <option :value="25">25</option>
                <option :value="50">50</option>
                <option :value="100">100</option>
              </select>
              trades
            </span>
          </div>
        </div>

        <div class="flex items-center justify-between p-3 rounded-lg bg-gray-50 dark:bg-gray-900/30">
          <div class="flex items-center gap-4">
            <div>
              <span class="text-xs text-gray-500 dark:text-gray-400">Status</span>
              <p class="text-sm font-semibold" :class="store.activeWeights?.hasActiveWeights ? 'text-indigo-600' : 'text-gray-500'">
                {{ store.activeWeights?.hasActiveWeights ? `${store.activeWeights.weights.length} calibrated weights active` : 'Using static weights' }}
              </p>
            </div>
            <div>
              <span class="text-xs text-gray-500 dark:text-gray-400">Trades Since Cal</span>
              <p class="text-sm font-semibold text-gray-900 dark:text-white">
                {{ store.calibrationStatus?.tradesSinceLastCalibration || 0 }} / {{ store.calibrationStatus?.calibrationThreshold || 25 }}
              </p>
            </div>
            <div v-if="store.calibrationStatus?.lastCalibratedAt">
              <span class="text-xs text-gray-500 dark:text-gray-400">Last Calibrated</span>
              <p class="text-sm font-semibold text-gray-900 dark:text-white">{{ formatDate(store.calibrationStatus.lastCalibratedAt) }}</p>
            </div>
          </div>
          <div class="flex gap-2">
            <button
              @click="handleApplyCalibration"
              :disabled="store.adaptiveLoading || !store.calibrationData?.totalTrades"
              class="inline-flex items-center px-3 py-1.5 text-xs font-semibold rounded-lg bg-indigo-600 text-white hover:bg-indigo-700 disabled:opacity-50"
            >
              Apply Recommended Weights
            </button>
            <button
              v-if="store.activeWeights?.hasActiveWeights"
              @click="handleRevert"
              :disabled="store.adaptiveLoading"
              class="inline-flex items-center px-3 py-1.5 text-xs font-medium rounded-lg text-red-700 dark:text-red-400 border border-red-300 dark:border-red-700 hover:bg-red-50 dark:hover:bg-red-900/20 disabled:opacity-50"
            >
              Revert to Static
            </button>
          </div>
        </div>
      </div>

      <!-- Active weights detail -->
      <div v-if="store.activeWeights?.hasActiveWeights" class="bg-white dark:bg-gray-800 rounded-lg shadow overflow-hidden">
        <div class="px-4 py-3 border-b border-gray-200 dark:border-gray-700">
          <h3 class="text-sm font-semibold text-gray-900 dark:text-white">Active Calibrated Weights</h3>
        </div>
        <table class="min-w-full divide-y divide-gray-200 dark:divide-gray-700">
          <thead class="bg-gray-50 dark:bg-gray-900/50">
            <tr>
              <th class="px-4 py-2 text-left text-xs font-semibold text-gray-500 uppercase">Component</th>
              <th class="px-4 py-2 text-center text-xs font-semibold text-gray-500 uppercase">Static</th>
              <th class="px-4 py-2 text-center text-xs font-semibold text-gray-500 uppercase">Calibrated</th>
              <th class="px-4 py-2 text-center text-xs font-semibold text-gray-500 uppercase">Drift</th>
              <th class="px-4 py-2 text-center text-xs font-semibold text-gray-500 uppercase">Sample</th>
              <th class="px-4 py-2 text-right text-xs font-semibold text-gray-500 uppercase">Applied</th>
            </tr>
          </thead>
          <tbody class="divide-y divide-gray-200 dark:divide-gray-700">
            <tr v-for="w in store.activeWeights.weights" :key="w.component_key">
              <td class="px-4 py-2 text-sm text-gray-900 dark:text-white">{{ formatComponentKey(w.component_key) }}</td>
              <td class="px-4 py-2 text-sm text-center text-gray-500">{{ w.static_weight }}</td>
              <td class="px-4 py-2 text-sm text-center font-semibold text-indigo-600">{{ w.calibrated_weight }}</td>
              <td class="px-4 py-2 text-sm text-center" :class="w.weight_drift > 0 ? 'text-green-600' : w.weight_drift < 0 ? 'text-red-600' : 'text-gray-500'">
                {{ w.weight_drift > 0 ? '+' : '' }}{{ w.weight_drift }}
              </td>
              <td class="px-4 py-2 text-sm text-center text-gray-500">{{ w.sample_size }}</td>
              <td class="px-4 py-2 text-xs text-right text-gray-400">{{ formatDate(w.calibrated_at) }}</td>
            </tr>
          </tbody>
        </table>
      </div>

      <!-- Audit log -->
      <div class="bg-white dark:bg-gray-800 rounded-lg shadow overflow-hidden">
        <div class="px-4 py-3 border-b border-gray-200 dark:border-gray-700 flex items-center justify-between">
          <h3 class="text-sm font-semibold text-gray-900 dark:text-white">Calibration Audit Log</h3>
          <button @click="store.fetchCalibrationLog()" class="text-xs text-indigo-600 hover:text-indigo-500">Refresh</button>
        </div>
        <div v-if="store.calibrationLog.length === 0" class="p-6 text-center text-xs text-gray-400">No calibration events yet.</div>
        <div v-else class="max-h-64 overflow-y-auto">
          <div
            v-for="entry in store.calibrationLog"
            :key="entry.id"
            class="px-4 py-2.5 border-b border-gray-100 dark:border-gray-700/50 last:border-0"
          >
            <div class="flex items-center justify-between">
              <div class="flex items-center gap-2">
                <span
                  class="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-semibold uppercase"
                  :class="{
                    'bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-400': entry.action === 'APPLIED' || entry.action === 'AUTO_APPLIED',
                    'bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-400': entry.action === 'REVERTED',
                    'bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-400': entry.action === 'TOGGLED',
                  }"
                >
                  {{ entry.action }}
                </span>
                <span class="text-xs text-gray-600 dark:text-gray-300">{{ entry.summary }}</span>
              </div>
              <span class="text-[10px] text-gray-400">{{ formatDate(entry.created_at) }}</span>
            </div>
          </div>
        </div>
      </div>
    </div>

    <!-- ═══ Tab: Signal Quality ═══ -->
    <div v-else-if="activeTab === 'signalQuality'">
      <div v-if="!store.signalQualityData || store.signalQualityData.totalTrades === 0" class="bg-white dark:bg-gray-800 rounded-lg shadow p-12 text-center text-gray-500 dark:text-gray-400">
        <ChartBarSquareIcon class="h-12 w-12 mx-auto mb-3 opacity-50" />
        <p>No completed trades to analyze signal quality against.</p>
      </div>

      <div v-else class="space-y-6">
        <!-- Source performance -->
        <div class="bg-white dark:bg-gray-800 rounded-lg shadow overflow-hidden">
          <div class="px-4 py-3 border-b border-gray-200 dark:border-gray-700">
            <h3 class="text-sm font-semibold text-gray-900 dark:text-white">Source Performance</h3>
            <p class="text-xs text-gray-500 mt-0.5">Win rate, profit factor and avg PnL by indicator source</p>
          </div>
          <table class="min-w-full divide-y divide-gray-200 dark:divide-gray-700">
            <thead class="bg-gray-50 dark:bg-gray-900/50">
              <tr>
                <th class="px-4 py-2 text-left text-xs font-semibold text-gray-500 uppercase">Source</th>
                <th class="px-4 py-2 text-center text-xs font-semibold text-gray-500 uppercase">Trades</th>
                <th class="px-4 py-2 text-center text-xs font-semibold text-gray-500 uppercase">Win Rate</th>
                <th class="px-4 py-2 text-center text-xs font-semibold text-gray-500 uppercase">Profit Factor</th>
                <th class="px-4 py-2 text-center text-xs font-semibold text-gray-500 uppercase">Avg PnL</th>
                <th class="px-4 py-2 text-center text-xs font-semibold text-gray-500 uppercase">Total PnL</th>
                <th class="px-4 py-2 text-center text-xs font-semibold text-gray-500 uppercase">Avg R</th>
                <th class="px-4 py-2 text-center text-xs font-semibold text-gray-500 uppercase">Avg Conv.</th>
              </tr>
            </thead>
            <tbody class="divide-y divide-gray-200 dark:divide-gray-700">
              <tr v-for="s in store.signalQualityData.sourcePerformance" :key="s.source" :class="{ 'opacity-50': !s.significant }">
                <td class="px-4 py-2 text-sm font-medium text-gray-900 dark:text-white">{{ s.source }}</td>
                <td class="px-4 py-2 text-sm text-center text-gray-500">{{ s.sampleSize }}</td>
                <td class="px-4 py-2 text-sm text-center font-semibold" :class="s.winRate >= 0.5 ? 'text-green-600' : 'text-red-500'">{{ formatPct(s.winRate) }}</td>
                <td class="px-4 py-2 text-sm text-center" :class="s.profitFactor >= 1.5 ? 'text-green-600' : s.profitFactor >= 1 ? 'text-gray-700 dark:text-gray-300' : 'text-red-500'">{{ s.profitFactor }}</td>
                <td class="px-4 py-2 text-sm text-center" :class="s.avgPnl >= 0 ? 'text-green-600' : 'text-red-500'">${{ s.avgPnl }}</td>
                <td class="px-4 py-2 text-sm text-center font-semibold" :class="s.totalPnl >= 0 ? 'text-green-600' : 'text-red-500'">${{ s.totalPnl }}</td>
                <td class="px-4 py-2 text-sm text-center text-gray-500">{{ s.avgR || '-' }}</td>
                <td class="px-4 py-2 text-sm text-center text-gray-500">{{ s.avgConviction || '-' }}</td>
              </tr>
            </tbody>
          </table>
        </div>

        <!-- Conviction accuracy -->
        <div class="bg-white dark:bg-gray-800 rounded-lg shadow overflow-hidden">
          <div class="px-4 py-3 border-b border-gray-200 dark:border-gray-700">
            <h3 class="text-sm font-semibold text-gray-900 dark:text-white">Conviction Accuracy</h3>
            <p class="text-xs mt-0.5" :class="store.signalQualityData.convictionAccuracy?.isMonotonic ? 'text-green-600' : 'text-amber-600'">
              {{ store.signalQualityData.convictionAccuracy?.recommendation }}
            </p>
          </div>
          <div class="p-4 space-y-2">
            <div v-for="b in store.signalQualityData.convictionAccuracy?.buckets" :key="b.bucket" class="flex items-center gap-3">
              <span class="text-xs font-mono font-medium text-gray-600 dark:text-gray-400 w-14">{{ b.bucket }}</span>
              <div class="flex-1 bg-gray-100 dark:bg-gray-700 rounded-full h-5 relative overflow-hidden">
                <div class="h-full rounded-full transition-all" :class="b.winRate >= 0.5 ? 'bg-green-500' : 'bg-red-400'" :style="{ width: `${Math.min(b.winRate * 100, 100)}%` }"></div>
              </div>
              <span class="text-xs font-semibold w-12 text-right" :class="b.winRate >= 0.5 ? 'text-green-600' : 'text-red-500'">{{ formatPct(b.winRate) }}</span>
              <span class="text-xs text-gray-400 w-16 text-right">n={{ b.sampleSize }}, ${{ b.avgPnl }}</span>
            </div>
          </div>
        </div>

        <!-- Delta + DTE performance side-by-side -->
        <div class="grid grid-cols-1 md:grid-cols-2 gap-6">
          <div class="bg-white dark:bg-gray-800 rounded-lg shadow overflow-hidden">
            <div class="px-4 py-3 border-b border-gray-200 dark:border-gray-700">
              <h3 class="text-sm font-semibold text-gray-900 dark:text-white">Delta Performance</h3>
              <p class="text-xs text-indigo-600 mt-0.5">{{ store.signalQualityData.deltaPerformance?.recommendation }}</p>
            </div>
            <div class="p-4 space-y-2">
              <div v-for="d in store.signalQualityData.deltaPerformance?.buckets" :key="d.bucket" class="flex items-center gap-2">
                <span class="text-[11px] text-gray-600 dark:text-gray-400 w-28 truncate" :title="d.bucket">{{ d.bucket }}</span>
                <div class="flex-1 bg-gray-100 dark:bg-gray-700 rounded-full h-4 overflow-hidden">
                  <div class="h-full rounded-full" :class="d.winRate >= 0.5 ? 'bg-green-500' : 'bg-red-400'" :style="{ width: `${Math.min(d.winRate * 100, 100)}%` }"></div>
                </div>
                <span class="text-xs font-semibold w-10 text-right" :class="d.winRate >= 0.5 ? 'text-green-600' : 'text-red-500'">{{ formatPct(d.winRate) }}</span>
                <span class="text-[10px] text-gray-400 w-8 text-right">n={{ d.sampleSize }}</span>
              </div>
            </div>
          </div>

          <div class="bg-white dark:bg-gray-800 rounded-lg shadow overflow-hidden">
            <div class="px-4 py-3 border-b border-gray-200 dark:border-gray-700">
              <h3 class="text-sm font-semibold text-gray-900 dark:text-white">DTE Performance</h3>
              <p class="text-xs text-indigo-600 mt-0.5">{{ store.signalQualityData.dtePerformance?.recommendation }}</p>
            </div>
            <div class="p-4 space-y-2">
              <div v-for="d in store.signalQualityData.dtePerformance?.buckets" :key="d.bucket" class="flex items-center gap-2">
                <span class="text-[11px] text-gray-600 dark:text-gray-400 w-20 truncate">{{ d.bucket }}</span>
                <div class="flex-1 bg-gray-100 dark:bg-gray-700 rounded-full h-4 overflow-hidden">
                  <div class="h-full rounded-full" :class="d.winRate >= 0.5 ? 'bg-green-500' : 'bg-red-400'" :style="{ width: `${Math.min(d.winRate * 100, 100)}%` }"></div>
                </div>
                <span class="text-xs font-semibold w-10 text-right" :class="d.winRate >= 0.5 ? 'text-green-600' : 'text-red-500'">{{ formatPct(d.winRate) }}</span>
                <span class="text-[10px] text-gray-400 w-8 text-right">n={{ d.sampleSize }}</span>
              </div>
            </div>
          </div>
        </div>

        <!-- Position sizing + Expected move filter -->
        <div class="grid grid-cols-1 md:grid-cols-2 gap-6">
          <div class="bg-white dark:bg-gray-800 rounded-lg shadow overflow-hidden">
            <div class="px-4 py-3 border-b border-gray-200 dark:border-gray-700">
              <h3 class="text-sm font-semibold text-gray-900 dark:text-white">Position Sizing</h3>
              <p class="text-xs mt-0.5" :class="store.signalQualityData.sizingPerformance?.sizingEffective ? 'text-green-600' : 'text-amber-600'">
                {{ store.signalQualityData.sizingPerformance?.recommendation }}
              </p>
            </div>
            <div class="p-4">
              <div v-for="t in store.signalQualityData.sizingPerformance?.tiers" :key="t.tier" class="flex items-center justify-between py-1.5 border-b border-gray-100 dark:border-gray-700/50 last:border-0">
                <span class="text-xs text-gray-700 dark:text-gray-300">{{ t.tier }}</span>
                <div class="flex items-center gap-3">
                  <span class="text-xs" :class="t.winRate >= 0.5 ? 'text-green-600' : 'text-red-500'">{{ formatPct(t.winRate) }} WR</span>
                  <span class="text-xs" :class="t.avgPnl >= 0 ? 'text-green-600' : 'text-red-500'">${{ t.avgPnl }}</span>
                  <span class="text-[10px] text-gray-400">n={{ t.sampleSize }}</span>
                </div>
              </div>
            </div>
          </div>

          <div class="bg-white dark:bg-gray-800 rounded-lg shadow overflow-hidden">
            <div class="px-4 py-3 border-b border-gray-200 dark:border-gray-700">
              <h3 class="text-sm font-semibold text-gray-900 dark:text-white">Expected Move Filter</h3>
              <p class="text-xs text-gray-500 mt-0.5">{{ store.signalQualityData.expectedMoveFilter?.recommendation }}</p>
            </div>
            <div class="p-4 grid grid-cols-3 gap-4 text-center">
              <div>
                <p class="text-xs text-gray-500">Passed</p>
                <p class="text-lg font-bold text-gray-900 dark:text-white">{{ store.signalQualityData.expectedMoveFilter?.passed || 0 }}</p>
                <p class="text-xs text-gray-400">{{ formatPct(store.signalQualityData.expectedMoveFilter?.passedWinRate) }} WR</p>
              </div>
              <div>
                <p class="text-xs text-gray-500">Rejected</p>
                <p class="text-lg font-bold text-red-500">{{ store.signalQualityData.expectedMoveFilter?.rejected || 0 }}</p>
                <p class="text-xs text-gray-400">{{ store.signalQualityData.expectedMoveFilter?.rejectedSymbols || 0 }} symbols</p>
              </div>
              <div>
                <p class="text-xs text-gray-500">Filter Rate</p>
                <p class="text-lg font-bold text-amber-600">{{ formatPct(store.signalQualityData.expectedMoveFilter?.filterRate) }}</p>
              </div>
            </div>
          </div>
        </div>

        <!-- IV Environment + Flow Alignment -->
        <div class="grid grid-cols-1 md:grid-cols-2 gap-6">
          <div class="bg-white dark:bg-gray-800 rounded-lg shadow overflow-hidden">
            <div class="px-4 py-3 border-b border-gray-200 dark:border-gray-700">
              <h3 class="text-sm font-semibold text-gray-900 dark:text-white">IV Environment</h3>
              <p class="text-xs text-indigo-600 mt-0.5">{{ store.signalQualityData.ivEnvironment?.recommendation }}</p>
            </div>
            <div v-if="store.signalQualityData.ivEnvironment?.buckets?.length" class="p-4 space-y-2">
              <div v-for="b in store.signalQualityData.ivEnvironment.buckets" :key="b.bucket" class="flex items-center gap-2">
                <span class="text-[11px] text-gray-600 dark:text-gray-400 w-28 truncate" :title="b.bucket">{{ b.bucket }}</span>
                <div class="flex-1 bg-gray-100 dark:bg-gray-700 rounded-full h-4 overflow-hidden">
                  <div class="h-full rounded-full" :class="b.winRate >= 0.5 ? 'bg-green-500' : 'bg-red-400'" :style="{ width: `${Math.min(b.winRate * 100, 100)}%` }"></div>
                </div>
                <span class="text-xs font-semibold w-10 text-right" :class="b.winRate >= 0.5 ? 'text-green-600' : 'text-red-500'">{{ formatPct(b.winRate) }}</span>
                <span class="text-[10px] text-gray-400 w-14 text-right">R:{{ b.avgR || '-' }} n={{ b.sampleSize }}</span>
              </div>
            </div>
            <div v-else class="p-4 text-center text-xs text-gray-400">
              No IV snapshot data available for analysis
            </div>
          </div>

          <div class="bg-white dark:bg-gray-800 rounded-lg shadow overflow-hidden">
            <div class="px-4 py-3 border-b border-gray-200 dark:border-gray-700">
              <h3 class="text-sm font-semibold text-gray-900 dark:text-white">Flow Alignment</h3>
              <p class="text-xs mt-0.5" :class="store.signalQualityData.flowAlignment?.flowIsEdge ? 'text-green-600' : 'text-amber-600'">
                {{ store.signalQualityData.flowAlignment?.recommendation }}
              </p>
            </div>
            <div v-if="store.signalQualityData.flowAlignment?.buckets?.length" class="p-4">
              <div v-for="b in store.signalQualityData.flowAlignment.buckets" :key="b.alignment" class="flex items-center justify-between py-1.5 border-b border-gray-100 dark:border-gray-700/50 last:border-0">
                <span class="text-xs font-medium text-gray-700 dark:text-gray-300">{{ b.alignment }}</span>
                <div class="flex items-center gap-3">
                  <span class="text-xs" :class="b.winRate >= 0.5 ? 'text-green-600' : 'text-red-500'">{{ formatPct(b.winRate) }} WR</span>
                  <span class="text-xs" :class="b.avgPnl >= 0 ? 'text-green-600' : 'text-red-500'">${{ b.avgPnl }}</span>
                  <span class="text-[10px] text-gray-400">PCR:{{ b.avgPcr }} n={{ b.sampleSize }}</span>
                </div>
              </div>
            </div>
            <div v-else class="p-4 text-center text-xs text-gray-400">
              No flow snapshot data available for analysis
            </div>
          </div>
        </div>
      </div>
    </div>

    <!-- ═══ Tab: Guard Effectiveness ═══ -->
    <div v-else-if="activeTab === 'guards'">
      <div v-if="!store.guardEffectivenessData" class="bg-white dark:bg-gray-800 rounded-lg shadow p-12 text-center text-gray-500 dark:text-gray-400">
        <ShieldCheckIcon class="h-12 w-12 mx-auto mb-3 opacity-50" />
        <p>No guard data available yet.</p>
      </div>

      <div v-else class="space-y-6">
        <!-- Acceptance rate + rejection summary -->
        <div class="grid grid-cols-2 md:grid-cols-4 gap-4">
          <div class="bg-white dark:bg-gray-800 rounded-lg shadow p-4">
            <p class="text-xs font-medium text-gray-500 uppercase">Acceptance Rate</p>
            <p class="text-2xl font-bold text-gray-900 dark:text-white mt-1">{{ store.guardEffectivenessData.acceptanceRate }}%</p>
          </div>
          <div class="bg-white dark:bg-gray-800 rounded-lg shadow p-4">
            <p class="text-xs font-medium text-gray-500 uppercase">Total Rejections</p>
            <p class="text-2xl font-bold text-red-500 mt-1">{{ store.guardEffectivenessData.totalRejections }}</p>
          </div>
          <div class="bg-white dark:bg-gray-800 rounded-lg shadow p-4">
            <p class="text-xs font-medium text-gray-500 uppercase">Total Trades</p>
            <p class="text-2xl font-bold text-green-600 mt-1">{{ store.guardEffectivenessData.totalTrades }}</p>
          </div>
          <div class="bg-white dark:bg-gray-800 rounded-lg shadow p-4">
            <p class="text-xs font-medium text-gray-500 uppercase">Avg Latency</p>
            <p class="text-2xl font-bold text-gray-900 dark:text-white mt-1">{{ store.guardEffectivenessData.latency?.avgLatencyMs || 0 }}ms</p>
            <p class="text-xs text-gray-400">p95: {{ store.guardEffectivenessData.latency?.p95LatencyMs || 0 }}ms</p>
          </div>
        </div>

        <!-- Gate rejection breakdown -->
        <div class="bg-white dark:bg-gray-800 rounded-lg shadow overflow-hidden">
          <div class="px-4 py-3 border-b border-gray-200 dark:border-gray-700">
            <h3 class="text-sm font-semibold text-gray-900 dark:text-white">Rejection by Gate</h3>
          </div>
          <table class="min-w-full divide-y divide-gray-200 dark:divide-gray-700">
            <thead class="bg-gray-50 dark:bg-gray-900/50">
              <tr>
                <th class="px-4 py-2 text-left text-xs font-semibold text-gray-500 uppercase">Gate</th>
                <th class="px-4 py-2 text-center text-xs font-semibold text-gray-500 uppercase">Rejections</th>
                <th class="px-4 py-2 text-center text-xs font-semibold text-gray-500 uppercase">Share</th>
                <th class="px-4 py-2 text-center text-xs font-semibold text-gray-500 uppercase">Symbols</th>
                <th class="px-4 py-2 text-right text-xs font-semibold text-gray-500 uppercase">Last Seen</th>
              </tr>
            </thead>
            <tbody class="divide-y divide-gray-200 dark:divide-gray-700">
              <tr v-for="g in store.guardEffectivenessData.gateBreakdown" :key="g.gate">
                <td class="px-4 py-2 text-sm font-medium text-gray-900 dark:text-white">{{ g.gate }}</td>
                <td class="px-4 py-2 text-sm text-center font-semibold text-red-500">{{ g.count }}</td>
                <td class="px-4 py-2 text-sm text-center text-gray-500">{{ g.percentage }}%</td>
                <td class="px-4 py-2 text-sm text-center text-gray-500">{{ g.symbolsAffected }}</td>
                <td class="px-4 py-2 text-xs text-right text-gray-400">{{ formatDate(g.lastSeen) }}</td>
              </tr>
            </tbody>
          </table>
        </div>

        <!-- Exit quality (MAE/MFE) -->
        <div v-if="store.guardEffectivenessData.exitQuality?.totalTrades > 0" class="bg-white dark:bg-gray-800 rounded-lg shadow overflow-hidden">
          <div class="px-4 py-3 border-b border-gray-200 dark:border-gray-700">
            <h3 class="text-sm font-semibold text-gray-900 dark:text-white">Exit Quality (MAE / MFE)</h3>
            <p class="text-xs text-gray-500 mt-0.5">How much heat winners take (MAE) and how much profit losers give back (MFE)</p>
          </div>
          <div class="p-4 grid grid-cols-2 gap-6">
            <div>
              <h4 class="text-xs font-semibold text-gray-700 dark:text-gray-300 mb-2">Max Adverse Excursion (all trades)</h4>
              <div class="space-y-1 text-xs">
                <div class="flex justify-between"><span class="text-gray-500">Average</span><span class="font-mono">{{ fmtExcursion(store.guardEffectivenessData.exitQuality.mae.avg) }}</span></div>
                <div class="flex justify-between"><span class="text-gray-500">Median</span><span class="font-mono">{{ fmtExcursion(store.guardEffectivenessData.exitQuality.mae.median) }}</span></div>
                <div class="flex justify-between"><span class="text-gray-500">75th pctl</span><span class="font-mono">{{ fmtExcursion(store.guardEffectivenessData.exitQuality.mae.p75) }}</span></div>
                <div class="flex justify-between"><span class="text-gray-500">90th pctl</span><span class="font-mono text-red-500">{{ fmtExcursion(store.guardEffectivenessData.exitQuality.mae.p90) }}</span></div>
              </div>
              <div class="mt-3 pt-2 border-t border-gray-100 dark:border-gray-700 text-xs">
                <div class="flex justify-between"><span class="text-green-600">Winner avg MAE</span><span class="font-mono">{{ fmtExcursion(store.guardEffectivenessData.exitQuality.winnerMae.avg) }}</span></div>
                <div class="flex justify-between"><span class="text-green-600">Winner 90th pctl</span><span class="font-mono">{{ fmtExcursion(store.guardEffectivenessData.exitQuality.winnerMae.p90) }}</span></div>
              </div>
            </div>
            <div>
              <h4 class="text-xs font-semibold text-gray-700 dark:text-gray-300 mb-2">Max Favorable Excursion (all trades)</h4>
              <div class="space-y-1 text-xs">
                <div class="flex justify-between"><span class="text-gray-500">Average</span><span class="font-mono">{{ fmtExcursion(store.guardEffectivenessData.exitQuality.mfe.avg) }}</span></div>
                <div class="flex justify-between"><span class="text-gray-500">Median</span><span class="font-mono">{{ fmtExcursion(store.guardEffectivenessData.exitQuality.mfe.median) }}</span></div>
                <div class="flex justify-between"><span class="text-gray-500">75th pctl</span><span class="font-mono">{{ fmtExcursion(store.guardEffectivenessData.exitQuality.mfe.p75) }}</span></div>
                <div class="flex justify-between"><span class="text-gray-500">90th pctl</span><span class="font-mono text-green-600">{{ fmtExcursion(store.guardEffectivenessData.exitQuality.mfe.p90) }}</span></div>
              </div>
              <div class="mt-3 pt-2 border-t border-gray-100 dark:border-gray-700 text-xs">
                <div class="flex justify-between"><span class="text-red-500">Loser avg MFE</span><span class="font-mono">{{ fmtExcursion(store.guardEffectivenessData.exitQuality.loserMfe.avg) }}</span></div>
                <div class="flex justify-between"><span class="text-red-500">Loser 75th pctl</span><span class="font-mono">{{ fmtExcursion(store.guardEffectivenessData.exitQuality.loserMfe.p75) }}</span></div>
              </div>
            </div>
          </div>
          <div v-if="store.guardEffectivenessData.exitQuality.recommendations?.length" class="px-4 pb-3 space-y-2">
            <div v-for="(rec, i) in store.guardEffectivenessData.exitQuality.recommendations" :key="i"
              class="p-2 rounded-lg bg-indigo-50 dark:bg-indigo-900/20 text-xs"
            >
              <p class="font-semibold text-indigo-800 dark:text-indigo-300">{{ rec.type === 'stop_adjustment' ? 'Stop Calibration' : 'Target Calibration' }}</p>
              <p class="text-indigo-700 dark:text-indigo-400 mt-0.5">{{ rec.suggested }}</p>
              <p class="text-indigo-500 dark:text-indigo-500 mt-0.5 italic">{{ rec.rationale }}</p>
            </div>
          </div>
        </div>

        <!-- Exit reason breakdown -->
        <div v-if="store.guardEffectivenessData.exitReasons?.length" class="bg-white dark:bg-gray-800 rounded-lg shadow overflow-hidden">
          <div class="px-4 py-3 border-b border-gray-200 dark:border-gray-700">
            <h3 class="text-sm font-semibold text-gray-900 dark:text-white">Exit Type Performance</h3>
          </div>
          <table class="min-w-full divide-y divide-gray-200 dark:divide-gray-700">
            <thead class="bg-gray-50 dark:bg-gray-900/50">
              <tr>
                <th class="px-4 py-2 text-left text-xs font-semibold text-gray-500 uppercase">Exit Type</th>
                <th class="px-4 py-2 text-center text-xs font-semibold text-gray-500 uppercase">Count</th>
                <th class="px-4 py-2 text-center text-xs font-semibold text-gray-500 uppercase">Win Rate</th>
                <th class="px-4 py-2 text-center text-xs font-semibold text-gray-500 uppercase">Avg PnL</th>
                <th class="px-4 py-2 text-center text-xs font-semibold text-gray-500 uppercase">Total PnL</th>
                <th class="px-4 py-2 text-center text-xs font-semibold text-gray-500 uppercase">Avg R</th>
              </tr>
            </thead>
            <tbody class="divide-y divide-gray-200 dark:divide-gray-700">
              <tr v-for="e in store.guardEffectivenessData.exitReasons" :key="e.exitType">
                <td class="px-4 py-2 text-sm font-medium text-gray-900 dark:text-white">{{ e.exitType }}</td>
                <td class="px-4 py-2 text-sm text-center text-gray-500">{{ e.sampleSize }}</td>
                <td class="px-4 py-2 text-sm text-center font-semibold" :class="e.winRate >= 0.5 ? 'text-green-600' : 'text-red-500'">{{ formatPct(e.winRate) }}</td>
                <td class="px-4 py-2 text-sm text-center" :class="e.avgPnl >= 0 ? 'text-green-600' : 'text-red-500'">${{ e.avgPnl }}</td>
                <td class="px-4 py-2 text-sm text-center font-semibold" :class="e.totalPnl >= 0 ? 'text-green-600' : 'text-red-500'">${{ e.totalPnl }}</td>
                <td class="px-4 py-2 text-sm text-center text-gray-500">{{ e.avgR || '-' }}</td>
              </tr>
            </tbody>
          </table>
        </div>

        <!-- Guard threshold analysis -->
        <div class="bg-white dark:bg-gray-800 rounded-lg shadow overflow-hidden">
          <div class="px-4 py-3 border-b border-gray-200 dark:border-gray-700">
            <h3 class="text-sm font-semibold text-gray-900 dark:text-white">Guard Threshold Analysis</h3>
            <p class="text-xs text-gray-500 mt-0.5">Empirical assessment of each configurable guard parameter</p>
          </div>
          <div class="divide-y divide-gray-200 dark:divide-gray-700">
            <div v-for="t in store.guardEffectivenessData.guardThresholds" :key="t.guard" class="px-4 py-3">
              <div class="flex items-start justify-between">
                <div>
                  <p class="text-sm font-semibold text-gray-900 dark:text-white">{{ t.description }}</p>
                  <p class="text-xs text-gray-500 mt-0.5">Current: <span class="font-mono">{{ t.currentValue }}</span></p>
                  <p v-if="t.analysis" class="text-xs text-gray-500 mt-0.5">{{ t.analysis }}</p>
                </div>
                <span class="text-xs px-2 py-1 rounded-full" :class="t.recommendation.includes('effective') || t.recommendation.includes('appropriate') || t.recommendation.includes('acceptable')
                  ? 'bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-400'
                  : t.recommendation.includes('Insufficient')
                    ? 'bg-gray-100 text-gray-500 dark:bg-gray-700 dark:text-gray-400'
                    : 'bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-400'
                ">
                  {{ t.recommendation.includes('effective') || t.recommendation.includes('appropriate') || t.recommendation.includes('acceptable') ? 'OK' : t.recommendation.includes('Insufficient') ? 'Needs Data' : 'Review' }}
                </span>
              </div>
              <p class="text-xs mt-1.5 text-indigo-600 dark:text-indigo-400">{{ t.recommendation }}</p>
              <!-- Session/staleness buckets if present -->
              <div v-if="t.buckets?.length" class="mt-2 space-y-1">
                <div v-for="b in t.buckets" :key="b.bucket || b.session || b.staleness" class="flex items-center gap-2 text-xs">
                  <span class="text-gray-500 w-24 truncate">{{ b.bucket || b.session || b.staleness }}</span>
                  <div class="flex-1 bg-gray-100 dark:bg-gray-700 rounded-full h-3 overflow-hidden">
                    <div class="h-full rounded-full" :class="(b.winRate || 0) >= 0.5 ? 'bg-green-500' : 'bg-red-400'" :style="{ width: `${Math.min((b.winRate || 0) * 100, 100)}%` }"></div>
                  </div>
                  <span class="font-semibold w-10 text-right" :class="(b.winRate || 0) >= 0.5 ? 'text-green-600' : 'text-red-500'">{{ b.winRate ? formatPct(b.winRate) : '-' }}</span>
                  <span class="text-gray-400 w-8 text-right">n={{ b.sampleSize || b.snapshots || 0 }}</span>
                </div>
              </div>
            </div>
          </div>
        </div>

        <!-- Latency impact -->
        <div v-if="store.guardEffectivenessData.latency?.latencyImpact?.length" class="bg-white dark:bg-gray-800 rounded-lg shadow overflow-hidden">
          <div class="px-4 py-3 border-b border-gray-200 dark:border-gray-700">
            <h3 class="text-sm font-semibold text-gray-900 dark:text-white">Processing Latency Impact</h3>
            <p class="text-xs text-gray-500 mt-0.5">Does processing speed affect trade outcomes?</p>
          </div>
          <div class="p-4 space-y-2">
            <div v-for="l in store.guardEffectivenessData.latency.latencyImpact" :key="l.bucket" class="flex items-center gap-3">
              <span class="text-xs text-gray-600 dark:text-gray-400 w-20">{{ l.bucket }}</span>
              <div class="flex-1 bg-gray-100 dark:bg-gray-700 rounded-full h-4 overflow-hidden">
                <div class="h-full rounded-full" :class="l.winRate >= 0.5 ? 'bg-green-500' : 'bg-red-400'" :style="{ width: `${Math.min(l.winRate * 100, 100)}%` }"></div>
              </div>
              <span class="text-xs font-semibold w-10 text-right" :class="l.winRate >= 0.5 ? 'text-green-600' : 'text-red-500'">{{ formatPct(l.winRate) }}</span>
              <span class="text-xs text-gray-400 w-16 text-right">n={{ l.sampleSize }}, ${{ l.avgPnl }}</span>
            </div>
          </div>
        </div>

        <!-- GEX Environment -->
        <div class="bg-white dark:bg-gray-800 rounded-lg shadow overflow-hidden">
          <div class="px-4 py-3 border-b border-gray-200 dark:border-gray-700">
            <h3 class="text-sm font-semibold text-gray-900 dark:text-white">GEX Environment</h3>
            <p class="text-xs text-indigo-600 mt-0.5">{{ store.guardEffectivenessData.gexEnvironment?.recommendation }}</p>
          </div>
          <div v-if="store.guardEffectivenessData.gexEnvironment?.buckets?.length" class="p-4">
            <div v-for="b in store.guardEffectivenessData.gexEnvironment.buckets" :key="b.bucket" class="flex items-center justify-between py-1.5 border-b border-gray-100 dark:border-gray-700/50 last:border-0">
              <div class="flex items-center gap-2">
                <span class="text-xs font-medium text-gray-700 dark:text-gray-300">{{ b.bucket }}</span>
                <span class="text-[10px] text-gray-400">(avg {{ b.avgGexMillions }}M)</span>
              </div>
              <div class="flex items-center gap-3">
                <span class="text-xs" :class="b.winRate >= 0.5 ? 'text-green-600' : 'text-red-500'">{{ formatPct(b.winRate) }} WR</span>
                <span class="text-xs" :class="b.avgPnl >= 0 ? 'text-green-600' : 'text-red-500'">${{ b.avgPnl }}</span>
                <span class="text-[10px] text-gray-400">R:{{ b.avgR || '-' }} n={{ b.sampleSize }}</span>
              </div>
            </div>
          </div>
          <div v-else class="p-4 text-center text-xs text-gray-400">
            No GEX snapshot data available for environment analysis
          </div>
        </div>
      </div>
    </div>

    <!-- ═══ Tab: Backtest (placeholder) ═══ -->
    <div v-else-if="activeTab === 'backtest'">
      <div class="bg-white dark:bg-gray-800 rounded-lg shadow p-12 text-center text-gray-500 dark:text-gray-400">
        <BeakerIcon class="h-12 w-12 mx-auto mb-3 opacity-50" />
        <p class="font-medium">Backtest Lab — Coming Soon</p>
        <p class="mt-2 text-xs max-w-md mx-auto">Replay historical webhooks through modified engine rules to validate changes before deployment.</p>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, computed, onMounted } from 'vue'
import { useSimulationStore } from '@/stores/simulation'
import {
  ArrowPathIcon,
  AdjustmentsHorizontalIcon,
  ChartBarSquareIcon,
  ClockIcon,
  WrenchScrewdriverIcon,
  BeakerIcon,
  ShieldCheckIcon,
} from '@heroicons/vue/24/outline'

const store = useSimulationStore()

const activeTab = ref('calibration')
const lookbackDays = ref(90)
const bannerDismissed = ref(false)

const tabs = [
  { id: 'calibration',  label: 'Calibration' },
  { id: 'signalQuality', label: 'Signal Quality' },
  { id: 'guards',       label: 'Guard Effectiveness' },
  { id: 'regime',       label: 'Regime Edge' },
  { id: 'temporal',     label: 'Temporal Edge' },
  { id: 'backtest',     label: 'Backtest', badge: 'Soon' },
]

const heatmapHours = computed(() => {
  if (!store.temporalEdgeData?.heatmap) return []
  return [...new Set(store.temporalEdgeData.heatmap.map(c => c.hour))]
})

function getHeatmapCell(hour, day) {
  return store.temporalEdgeData?.heatmap?.find(c => c.hour === hour && c.day === day) || null
}

function heatmapCellClass(cell) {
  if (!cell || !cell.significant) return 'bg-gray-100 dark:bg-gray-700 text-gray-500 dark:text-gray-400'
  if (cell.winRate >= 0.65) return 'bg-green-200 dark:bg-green-900/50 text-green-900 dark:text-green-300'
  if (cell.winRate >= 0.55) return 'bg-green-100 dark:bg-green-900/30 text-green-800 dark:text-green-400'
  if (cell.winRate >= 0.45) return 'bg-gray-100 dark:bg-gray-700 text-gray-700 dark:text-gray-300'
  if (cell.winRate >= 0.35) return 'bg-red-100 dark:bg-red-900/30 text-red-800 dark:text-red-400'
  return 'bg-red-200 dark:bg-red-900/50 text-red-900 dark:text-red-300'
}

function regimeBadgeClass(regime) {
  const map = {
    TRENDING: 'bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-400',
    HIGH_VOL_EXPANSION: 'bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-400',
    LOW_VOL_CHOP: 'bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-400',
    NEUTRAL: 'bg-gray-100 text-gray-800 dark:bg-gray-700 dark:text-gray-300',
    UNKNOWN: 'bg-gray-100 text-gray-500 dark:bg-gray-700 dark:text-gray-400',
  }
  return map[regime] || map.UNKNOWN
}

function statusBadgeClass(status) {
  const map = {
    STRONG: 'bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-400',
    ACTIVE: 'bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-400',
    SUPPRESSED: 'bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-400',
    INSUFFICIENT_DATA: 'bg-gray-100 text-gray-500 dark:bg-gray-700 dark:text-gray-400',
  }
  return map[status] || map.INSUFFICIENT_DATA
}

function formatPct(val) {
  if (val == null) return '-'
  return `${(val * 100).toFixed(1)}%`
}

function fmtExcursion(val) {
  if (val == null || val === 0) return '-'
  return `${(val * 100).toFixed(2)}%`
}

function formatComponentKey(key) {
  const names = {
    strat_align: 'STRAT Alignment',
    strat_conflict: 'STRAT Conflict',
    strat_continuity: 'STRAT Continuity',
    strat_no_cont: 'STRAT No Continuity',
    continuation: 'Continuation Pattern',
    revstrat: 'RevStrat Pattern',
    trend_high: 'Trend Align (High)',
    trend_mid: 'Trend Align (Mid)',
    flow_unusual: 'Unusual Flow',
    flow_aligns: 'Flow Aligns',
    flow_conflict: 'Flow Conflict',
    saty_aligns: 'SATY Phase Aligns',
    saty_conflict: 'SATY Phase Conflict',
    macro_strong: 'Strong Macro',
    iv_high: 'High IV Penalty',
    iv_low: 'Low IV Boost',
    gex_negative: 'Negative GEX Boost',
    gex_positive: 'Positive GEX Penalty',
    hist_flow_aligns: 'Historical Flow Aligns',
    hist_flow_conflict: 'Historical Flow Conflict',
  }
  return names[key] || key
}

async function switchTab(tabId) {
  activeTab.value = tabId
  await loadTabData(tabId)
}

async function loadTabData(tabId) {
  const days = lookbackDays.value
  try {
    if (tabId === 'calibration' && !store.calibrationData) {
      await store.fetchCalibration(days)
    } else if (tabId === 'signalQuality' && !store.signalQualityData) {
      await store.fetchSignalQuality(days)
    } else if (tabId === 'guards' && !store.guardEffectivenessData) {
      await store.fetchGuardEffectiveness(days)
    } else if (tabId === 'regime' && !store.regimeEdgeData) {
      await store.fetchRegimeEdge(days)
    } else if (tabId === 'temporal' && !store.temporalEdgeData) {
      await store.fetchTemporalEdge(days)
    }
  } catch {
    // Error is captured in store
  }
}

async function refreshActiveTab() {
  const days = lookbackDays.value
  store.calibrationData = null
  store.regimeEdgeData = null
  store.temporalEdgeData = null
  store.adaptiveSummary = null
  store.signalQualityData = null
  store.guardEffectivenessData = null

  await Promise.all([
    store.fetchAdaptiveSummary(days),
    store.fetchCalibrationStatus(),
    store.fetchActiveWeights(),
    loadTabData(activeTab.value),
  ])
}

async function handleApplyCalibration() {
  try {
    await store.applyCalibration(lookbackDays.value)
    bannerDismissed.value = true
    store.calibrationData = null
    await store.fetchCalibration(lookbackDays.value)
    await store.fetchCalibrationLog()
  } catch {
    // error captured in store
  }
}

async function handleRevert() {
  try {
    await store.revertCalibration()
    store.calibrationData = null
    await store.fetchCalibration(lookbackDays.value)
    await store.fetchCalibrationLog()
  } catch {
    // error captured in store
  }
}

async function handleToggleAuto(enabled) {
  await store.toggleAutoCalibration(enabled)
}

async function handleSetThreshold(val) {
  try {
    const { default: api } = await import('@/services/api')
    await api.put('/sim/adaptive/calibration/threshold', { threshold: val })
    await store.fetchCalibrationStatus()
  } catch {
    // error in store
  }
}

function dismissBanner() {
  bannerDismissed.value = true
}

function formatDate(iso) {
  if (!iso) return '-'
  const d = new Date(iso)
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
}

onMounted(async () => {
  await Promise.all([
    store.fetchAdaptiveSummary(lookbackDays.value),
    store.fetchCalibration(lookbackDays.value),
    store.fetchCalibrationStatus(),
    store.fetchActiveWeights(),
    store.fetchCalibrationLog(),
  ])
})
</script>
