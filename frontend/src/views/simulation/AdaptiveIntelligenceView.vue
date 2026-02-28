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

    <!-- ═══ Tab: Exit Tuning (placeholder) ═══ -->
    <div v-else-if="activeTab === 'exits'">
      <div class="bg-white dark:bg-gray-800 rounded-lg shadow p-12 text-center text-gray-500 dark:text-gray-400">
        <WrenchScrewdriverIcon class="h-12 w-12 mx-auto mb-3 opacity-50" />
        <p class="font-medium">Exit Tuning — Coming Soon</p>
        <p class="mt-2 text-xs max-w-md mx-auto">MAE/MFE distributions, adaptive stop/target calibration, and IV-adjusted exit parameters. Requires IV snapshot accumulation.</p>
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

    <!-- ═══ Tab: IV Optimizer (placeholder) ═══ -->
    <div v-else-if="activeTab === 'iv'">
      <div class="bg-white dark:bg-gray-800 rounded-lg shadow p-12 text-center text-gray-500 dark:text-gray-400">
        <ChartBarSquareIcon class="h-12 w-12 mx-auto mb-3 opacity-50" />
        <p class="font-medium">IV Optimizer — Coming Soon</p>
        <p class="mt-2 text-xs max-w-md mx-auto">DTE x IV rank performance matrix and empirically optimal delta/DTE selection by volatility environment. Requires IV snapshot accumulation.</p>
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
} from '@heroicons/vue/24/outline'

const store = useSimulationStore()

const activeTab = ref('calibration')
const lookbackDays = ref(90)
const bannerDismissed = ref(false)

const tabs = [
  { id: 'calibration', label: 'Calibration' },
  { id: 'regime',      label: 'Regime Edge' },
  { id: 'temporal',    label: 'Temporal Edge' },
  { id: 'exits',       label: 'Exit Tuning', badge: 'Soon' },
  { id: 'backtest',    label: 'Backtest', badge: 'Soon' },
  { id: 'iv',          label: 'IV Optimizer', badge: 'Soon' },
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
