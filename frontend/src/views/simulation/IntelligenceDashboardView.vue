<template>
  <div class="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
    <div class="flex items-center justify-between mb-6">
      <div>
        <h1 class="text-2xl font-bold text-gray-900 dark:text-white">Intelligence Dashboard</h1>
        <p class="mt-1 text-sm text-gray-500 dark:text-gray-400">
          Strategy scoring, automated exits, adaptive guards, and signal priority
        </p>
      </div>
      <div class="flex gap-2">
        <button
          @click="refreshAll"
          class="inline-flex items-center px-3 py-2 text-sm font-medium rounded-lg bg-white dark:bg-gray-800 text-gray-700 dark:text-gray-300 border border-gray-300 dark:border-gray-600 hover:bg-gray-50 dark:hover:bg-gray-700"
        >
          <ArrowPathIcon class="h-4 w-4 mr-1.5" :class="{ 'animate-spin': loading }" />
          Refresh
        </button>
        <button
          @click="recalculate"
          class="inline-flex items-center px-3 py-2 text-sm font-medium rounded-lg bg-indigo-600 text-white hover:bg-indigo-700"
        >
          <CalculatorIcon class="h-4 w-4 mr-1.5" />
          Recalculate
        </button>
      </div>
    </div>

    <!-- Status overview cards -->
    <div class="grid grid-cols-2 md:grid-cols-4 gap-4 mb-6">
      <div class="bg-white dark:bg-gray-800 rounded-lg shadow p-4">
        <p class="text-xs font-medium text-gray-500 dark:text-gray-400 uppercase">Active Strategies</p>
        <p class="text-2xl font-bold text-green-600 mt-1">{{ intelligenceStatus?.activeStrategies ?? '-' }}</p>
      </div>
      <div class="bg-white dark:bg-gray-800 rounded-lg shadow p-4">
        <p class="text-xs font-medium text-gray-500 dark:text-gray-400 uppercase">Underperforming</p>
        <p class="text-2xl font-bold text-red-600 mt-1">{{ intelligenceStatus?.underperformingStrategies ?? '-' }}</p>
      </div>
      <div class="bg-white dark:bg-gray-800 rounded-lg shadow p-4">
        <p class="text-xs font-medium text-gray-500 dark:text-gray-400 uppercase">Active Cooldowns</p>
        <p class="text-2xl font-bold text-amber-600 mt-1">{{ intelligenceStatus?.activeCooldowns?.length ?? '-' }}</p>
      </div>
      <div class="bg-white dark:bg-gray-800 rounded-lg shadow p-4">
        <p class="text-xs font-medium text-gray-500 dark:text-gray-400 uppercase">Exit Monitor</p>
        <p class="text-2xl font-bold mt-1" :class="intelligenceStatus?.exitMonitor?.running ? 'text-green-600' : 'text-gray-400'">
          {{ intelligenceStatus?.exitMonitor?.running ? 'Running' : 'Stopped' }}
        </p>
        <p v-if="intelligenceStatus?.exitMonitor" class="text-xs text-gray-500 mt-0.5">
          {{ intelligenceStatus.exitMonitor.exitsTriggered }} exits triggered
        </p>
      </div>
    </div>

    <!-- Tabs -->
    <div class="border-b border-gray-200 dark:border-gray-700 mb-6">
      <nav class="flex space-x-6">
        <button
          v-for="tab in tabs"
          :key="tab.id"
          @click="activeTab = tab.id"
          class="pb-3 text-sm font-medium border-b-2 transition-colors"
          :class="activeTab === tab.id
            ? 'border-indigo-500 text-indigo-600 dark:text-indigo-400'
            : 'border-transparent text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-300'"
        >
          {{ tab.label }}
        </button>
      </nav>
    </div>

    <!-- Tab: Strategy Scorecard -->
    <div v-if="activeTab === 'scorecard'">
      <div v-if="store.scorecard.length === 0 && !loading" class="bg-white dark:bg-gray-800 rounded-lg shadow p-12 text-center text-gray-500 dark:text-gray-400">
        <ChartBarSquareIcon class="h-12 w-12 mx-auto mb-3 opacity-50" />
        <p>No scorecard data yet. Complete trades to populate strategy metrics.</p>
      </div>

      <div v-else class="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
        <div
          v-for="card in store.scorecard"
          :key="card.strategy"
          class="bg-white dark:bg-gray-800 rounded-lg shadow p-5 border-l-4"
          :class="statusBorderColor(card.status)"
        >
          <div class="flex items-center justify-between mb-3">
            <div class="flex items-center gap-2">
              <span class="h-3 w-3 rounded-full" :class="statusDotColor(card.status)"></span>
              <h3 class="text-lg font-bold text-gray-900 dark:text-white">{{ card.strategy || 'Unknown' }}</h3>
            </div>
            <span
              class="inline-flex px-2 py-0.5 rounded-full text-xs font-medium"
              :class="statusBadgeColor(card.status)"
            >{{ card.status }}</span>
          </div>

          <div class="grid grid-cols-3 gap-3 text-sm">
            <div>
              <p class="text-gray-500 dark:text-gray-400">Win Rate</p>
              <p class="font-bold text-lg" :class="parseFloat(card.win_rate) >= 0.5 ? 'text-green-600' : 'text-red-600'">
                {{ (parseFloat(card.win_rate) * 100).toFixed(1) }}%
              </p>
            </div>
            <div>
              <p class="text-gray-500 dark:text-gray-400">Profit Factor</p>
              <p class="font-bold text-lg" :class="parseFloat(card.profit_factor) >= 1 ? 'text-green-600' : 'text-red-600'">
                {{ parseFloat(card.profit_factor).toFixed(2) }}
              </p>
            </div>
            <div>
              <p class="text-gray-500 dark:text-gray-400">Sharpe</p>
              <p class="font-bold text-lg text-gray-900 dark:text-white">
                {{ parseFloat(card.sharpe_ratio).toFixed(2) }}
              </p>
            </div>
            <div>
              <p class="text-gray-500 dark:text-gray-400">Avg R</p>
              <p class="font-semibold" :class="card.avg_r_multiple && parseFloat(card.avg_r_multiple) > 0 ? 'text-green-600' : 'text-gray-900 dark:text-white'">
                {{ card.avg_r_multiple ? parseFloat(card.avg_r_multiple).toFixed(2) + 'R' : '-' }}
              </p>
            </div>
            <div>
              <p class="text-gray-500 dark:text-gray-400">Streak</p>
              <p class="font-semibold" :class="card.streak_type === 'win' ? 'text-green-600' : card.streak_type === 'loss' ? 'text-red-600' : 'text-gray-500'">
                {{ card.current_streak }}{{ card.streak_type === 'win' ? 'W' : card.streak_type === 'loss' ? 'L' : '' }}
              </p>
            </div>
            <div>
              <p class="text-gray-500 dark:text-gray-400">Trades</p>
              <p class="font-semibold text-gray-900 dark:text-white">{{ card.total_trades }} <span class="text-xs text-gray-400">(last {{ card.window_size }})</span></p>
            </div>
          </div>

          <!-- Win/loss bar -->
          <div class="mt-3">
            <div class="flex h-2 rounded-full overflow-hidden bg-gray-200 dark:bg-gray-700">
              <div class="bg-green-500 transition-all" :style="{ width: (parseFloat(card.win_rate) * 100) + '%' }"></div>
              <div class="bg-red-500 transition-all" :style="{ width: ((1 - parseFloat(card.win_rate)) * 100) + '%' }"></div>
            </div>
            <div class="flex justify-between text-xs text-gray-500 mt-1">
              <span>${{ parseFloat(card.gross_wins).toFixed(0) }} won</span>
              <span>${{ parseFloat(card.gross_losses).toFixed(0) }} lost</span>
            </div>
          </div>
        </div>
      </div>
    </div>

    <!-- Tab: Live Positions -->
    <div v-if="activeTab === 'positions'">
      <div v-if="store.livePositions.length === 0 && !loading" class="bg-white dark:bg-gray-800 rounded-lg shadow p-12 text-center text-gray-500 dark:text-gray-400">
        <EyeIcon class="h-12 w-12 mx-auto mb-3 opacity-50" />
        <p>No open positions to monitor.</p>
      </div>

      <div v-else class="bg-white dark:bg-gray-800 rounded-lg shadow overflow-hidden">
        <table class="min-w-full divide-y divide-gray-200 dark:divide-gray-700">
          <thead class="bg-gray-50 dark:bg-gray-700">
            <tr>
              <th class="px-4 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-300 uppercase">Symbol</th>
              <th class="px-4 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-300 uppercase">Strategy</th>
              <th class="px-4 py-3 text-right text-xs font-medium text-gray-500 dark:text-gray-300 uppercase">Entry</th>
              <th class="px-4 py-3 text-right text-xs font-medium text-gray-500 dark:text-gray-300 uppercase">Current</th>
              <th class="px-4 py-3 text-right text-xs font-medium text-gray-500 dark:text-gray-300 uppercase">P&L %</th>
              <th class="px-4 py-3 text-right text-xs font-medium text-gray-500 dark:text-gray-300 uppercase">Stop Loss</th>
              <th class="px-4 py-3 text-right text-xs font-medium text-gray-500 dark:text-gray-300 uppercase">Take Profit</th>
              <th class="px-4 py-3 text-right text-xs font-medium text-gray-500 dark:text-gray-300 uppercase">DTE</th>
              <th class="px-4 py-3 text-right text-xs font-medium text-gray-500 dark:text-gray-300 uppercase">Hours Open</th>
            </tr>
          </thead>
          <tbody class="divide-y divide-gray-200 dark:divide-gray-700">
            <tr v-for="pos in store.livePositions" :key="pos.id">
              <td class="px-4 py-3 text-sm font-medium text-gray-900 dark:text-white">
                {{ pos.symbol }}
                <span class="text-xs text-gray-500 ml-1">{{ pos.contract_type }}</span>
              </td>
              <td class="px-4 py-3 text-sm text-gray-600 dark:text-gray-400">{{ pos.strategy || '-' }}</td>
              <td class="px-4 py-3 text-sm text-right text-gray-900 dark:text-white">${{ parseFloat(pos.avg_price).toFixed(2) }}</td>
              <td class="px-4 py-3 text-sm text-right font-medium text-gray-900 dark:text-white">
                {{ pos.current_price ? '$' + parseFloat(pos.current_price).toFixed(2) : '-' }}
              </td>
              <td class="px-4 py-3 text-sm text-right font-bold" :class="parseFloat(pos.pnl_pct) >= 0 ? 'text-green-600' : 'text-red-600'">
                {{ parseFloat(pos.pnl_pct) >= 0 ? '+' : '' }}{{ parseFloat(pos.pnl_pct).toFixed(2) }}%
              </td>
              <td class="px-4 py-3 text-sm text-right text-red-600">{{ pos.stop_loss ? '$' + parseFloat(pos.stop_loss).toFixed(2) : '-' }}</td>
              <td class="px-4 py-3 text-sm text-right text-green-600">{{ pos.take_profit ? '$' + parseFloat(pos.take_profit).toFixed(2) : '-' }}</td>
              <td class="px-4 py-3 text-sm text-right" :class="pos.current_dte !== null && pos.current_dte <= 1 ? 'text-red-600 font-bold' : 'text-gray-600 dark:text-gray-400'">
                {{ pos.current_dte !== null ? pos.current_dte + 'd' : '-' }}
              </td>
              <td class="px-4 py-3 text-sm text-right text-gray-600 dark:text-gray-400">
                {{ parseFloat(pos.hours_open).toFixed(1) }}h
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>

    <!-- Tab: Rejections Log -->
    <div v-if="activeTab === 'rejections'">
      <!-- Rejection summary by gate -->
      <div v-if="intelligenceStatus?.rejectionsToday?.length" class="flex gap-3 mb-4 flex-wrap">
        <div
          v-for="r in intelligenceStatus.rejectionsToday"
          :key="r.gate"
          class="bg-white dark:bg-gray-800 rounded-lg shadow px-4 py-2 flex items-center gap-2"
        >
          <ShieldExclamationIcon class="h-4 w-4 text-amber-500" />
          <span class="text-sm font-medium text-gray-900 dark:text-white">{{ r.gate }}</span>
          <span class="bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-300 text-xs font-bold px-1.5 py-0.5 rounded">{{ r.count }}</span>
        </div>
      </div>

      <div v-if="store.rejections.length === 0 && !loading" class="bg-white dark:bg-gray-800 rounded-lg shadow p-12 text-center text-gray-500 dark:text-gray-400">
        <ShieldCheckIcon class="h-12 w-12 mx-auto mb-3 opacity-50" />
        <p>No signal rejections recorded. All signals have been accepted.</p>
      </div>

      <div v-else class="bg-white dark:bg-gray-800 rounded-lg shadow overflow-hidden">
        <table class="min-w-full divide-y divide-gray-200 dark:divide-gray-700">
          <thead class="bg-gray-50 dark:bg-gray-700">
            <tr>
              <th class="px-4 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-300 uppercase">Time</th>
              <th class="px-4 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-300 uppercase">Gate</th>
              <th class="px-4 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-300 uppercase">Symbol</th>
              <th class="px-4 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-300 uppercase">Strategy</th>
              <th class="px-4 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-300 uppercase">Action</th>
              <th class="px-4 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-300 uppercase">Reason</th>
            </tr>
          </thead>
          <tbody class="divide-y divide-gray-200 dark:divide-gray-700">
            <tr v-for="rej in store.rejections" :key="rej.id">
              <td class="px-4 py-3 text-sm text-gray-500 dark:text-gray-400 whitespace-nowrap">
                {{ new Date(rej.created_at).toLocaleString() }}
              </td>
              <td class="px-4 py-3">
                <span class="inline-flex px-2 py-0.5 rounded text-xs font-medium" :class="gateBadgeColor(rej.gate)">
                  {{ rej.gate }}
                </span>
              </td>
              <td class="px-4 py-3 text-sm font-medium text-gray-900 dark:text-white">{{ rej.symbol || '-' }}</td>
              <td class="px-4 py-3 text-sm text-gray-600 dark:text-gray-400">{{ rej.strategy || '-' }}</td>
              <td class="px-4 py-3 text-sm text-gray-600 dark:text-gray-400">{{ rej.action || '-' }}</td>
              <td class="px-4 py-3 text-sm text-gray-600 dark:text-gray-400 max-w-xs truncate" :title="rej.reason">
                {{ rej.reason }}
              </td>
            </tr>
          </tbody>
        </table>

        <!-- Pagination -->
        <div v-if="store.rejectionPagination.total > store.rejectionPagination.limit" class="px-4 py-3 border-t border-gray-200 dark:border-gray-700 flex justify-between items-center">
          <p class="text-sm text-gray-500">
            Showing {{ ((store.rejectionPagination.page - 1) * store.rejectionPagination.limit) + 1 }} -
            {{ Math.min(store.rejectionPagination.page * store.rejectionPagination.limit, store.rejectionPagination.total) }}
            of {{ store.rejectionPagination.total }}
          </p>
          <div class="flex gap-2">
            <button
              @click="store.rejectionPagination.page--; store.fetchRejections()"
              :disabled="store.rejectionPagination.page <= 1"
              class="px-3 py-1 text-sm rounded bg-gray-100 dark:bg-gray-700 disabled:opacity-50"
            >Prev</button>
            <button
              @click="store.rejectionPagination.page++; store.fetchRejections()"
              :disabled="store.rejectionPagination.page * store.rejectionPagination.limit >= store.rejectionPagination.total"
              class="px-3 py-1 text-sm rounded bg-gray-100 dark:bg-gray-700 disabled:opacity-50"
            >Next</button>
          </div>
        </div>
      </div>
    </div>

    <!-- Tab: Cooldowns -->
    <div v-if="activeTab === 'cooldowns'">
      <div v-if="store.cooldowns.length === 0 && !loading" class="bg-white dark:bg-gray-800 rounded-lg shadow p-12 text-center text-gray-500 dark:text-gray-400">
        <ClockIcon class="h-12 w-12 mx-auto mb-3 opacity-50" />
        <p>No active strategy cooldowns. All strategies are trading normally.</p>
      </div>

      <div v-else class="space-y-3">
        <div
          v-for="cd in store.cooldowns"
          :key="cd.id"
          class="bg-white dark:bg-gray-800 rounded-lg shadow p-5 border-l-4 border-amber-500"
        >
          <div class="flex items-center justify-between">
            <div>
              <h3 class="text-lg font-bold text-gray-900 dark:text-white">{{ cd.strategy }}</h3>
              <p class="text-sm text-gray-500 dark:text-gray-400 mt-1">{{ cd.reason }}</p>
              <p class="text-sm text-amber-600 font-medium mt-1">
                Resumes: {{ new Date(cd.cooldown_until).toLocaleString() }}
                ({{ remainingTime(cd.cooldown_until) }})
              </p>
            </div>
            <button
              @click="handleClearCooldown(cd.strategy)"
              class="px-3 py-1.5 text-sm font-medium rounded-lg bg-amber-100 text-amber-800 hover:bg-amber-200 dark:bg-amber-900/30 dark:text-amber-300 dark:hover:bg-amber-900/50"
            >
              Clear Cooldown
            </button>
          </div>
        </div>
      </div>
    </div>

    <!-- Tab: Config -->
    <div v-if="activeTab === 'config'">
      <div class="bg-white dark:bg-gray-800 rounded-lg shadow p-6 max-w-2xl">
        <h2 class="text-lg font-semibold text-gray-900 dark:text-white mb-4">Intelligence Configuration</h2>

        <div v-if="configForm" class="space-y-6">
          <!-- Strategy Gate -->
          <div>
            <h3 class="text-sm font-semibold text-gray-700 dark:text-gray-300 uppercase mb-3">Strategy Gate</h3>
            <div class="grid grid-cols-2 gap-4">
              <div>
                <label class="block text-sm text-gray-600 dark:text-gray-400 mb-1">Min Win Rate</label>
                <div class="flex items-center gap-2">
                  <input type="number" v-model.number="configForm.min_win_rate" step="0.05" min="0" max="1"
                    class="w-full rounded-md border-gray-300 dark:border-gray-600 dark:bg-gray-700 dark:text-white text-sm" />
                  <span class="text-sm text-gray-500">{{ (configForm.min_win_rate * 100).toFixed(0) }}%</span>
                </div>
              </div>
              <div>
                <label class="block text-sm text-gray-600 dark:text-gray-400 mb-1">Min Profit Factor</label>
                <input type="number" v-model.number="configForm.min_profit_factor" step="0.1" min="0"
                  class="w-full rounded-md border-gray-300 dark:border-gray-600 dark:bg-gray-700 dark:text-white text-sm" />
              </div>
              <div>
                <label class="block text-sm text-gray-600 dark:text-gray-400 mb-1">Scorecard Window (trades)</label>
                <input type="number" v-model.number="configForm.scorecard_window" min="5" max="100"
                  class="w-full rounded-md border-gray-300 dark:border-gray-600 dark:bg-gray-700 dark:text-white text-sm" />
              </div>
            </div>
          </div>

          <!-- Exit Monitor -->
          <div>
            <h3 class="text-sm font-semibold text-gray-700 dark:text-gray-300 uppercase mb-3">Exit Monitor</h3>
            <div class="grid grid-cols-2 gap-4">
              <div class="col-span-2">
                <label class="flex items-center gap-2">
                  <input type="checkbox" v-model="configForm.enable_exit_monitor" class="rounded text-indigo-600" />
                  <span class="text-sm text-gray-700 dark:text-gray-300">Enable automated exit monitoring</span>
                </label>
              </div>
              <div>
                <label class="block text-sm text-gray-600 dark:text-gray-400 mb-1">Trailing Stop %</label>
                <div class="flex items-center gap-2">
                  <input type="number" v-model.number="configForm.default_trailing_stop_pct" step="0.01" min="0" max="1"
                    class="w-full rounded-md border-gray-300 dark:border-gray-600 dark:bg-gray-700 dark:text-white text-sm" />
                  <span class="text-sm text-gray-500">{{ (configForm.default_trailing_stop_pct * 100).toFixed(0) }}%</span>
                </div>
              </div>
              <div>
                <label class="block text-sm text-gray-600 dark:text-gray-400 mb-1">Max Hold (hours)</label>
                <input type="number" v-model.number="configForm.default_max_hold_hours" min="1"
                  class="w-full rounded-md border-gray-300 dark:border-gray-600 dark:bg-gray-700 dark:text-white text-sm" />
              </div>
              <div class="col-span-2">
                <label class="flex items-center gap-2">
                  <input type="checkbox" v-model="configForm.force_close_at_dte_zero" class="rounded text-indigo-600" />
                  <span class="text-sm text-gray-700 dark:text-gray-300">Force close at DTE = 0</span>
                </label>
              </div>
            </div>
          </div>

          <!-- Adaptive Guards -->
          <div>
            <h3 class="text-sm font-semibold text-gray-700 dark:text-gray-300 uppercase mb-3">Adaptive Guards</h3>
            <div class="grid grid-cols-2 gap-4">
              <div class="col-span-2">
                <label class="flex items-center gap-2">
                  <input type="checkbox" v-model="configForm.enable_strategy_cooldown" class="rounded text-indigo-600" />
                  <span class="text-sm text-gray-700 dark:text-gray-300">Enable strategy cooldowns after consecutive losses</span>
                </label>
              </div>
              <div>
                <label class="block text-sm text-gray-600 dark:text-gray-400 mb-1">Consecutive Losses for Cooldown</label>
                <input type="number" v-model.number="configForm.cooldown_consecutive_losses" min="2" max="10"
                  class="w-full rounded-md border-gray-300 dark:border-gray-600 dark:bg-gray-700 dark:text-white text-sm" />
              </div>
              <div>
                <label class="block text-sm text-gray-600 dark:text-gray-400 mb-1">Cooldown Duration (min)</label>
                <input type="number" v-model.number="configForm.cooldown_duration_minutes" min="5"
                  class="w-full rounded-md border-gray-300 dark:border-gray-600 dark:bg-gray-700 dark:text-white text-sm" />
              </div>
              <div>
                <label class="block text-sm text-gray-600 dark:text-gray-400 mb-1">Max Correlated Positions</label>
                <input type="number" v-model.number="configForm.max_correlated_positions" min="1" max="10"
                  class="w-full rounded-md border-gray-300 dark:border-gray-600 dark:bg-gray-700 dark:text-white text-sm" />
              </div>
              <div class="col-span-2">
                <label class="flex items-center gap-2">
                  <input type="checkbox" v-model="configForm.enable_drawdown_throttle" class="rounded text-indigo-600" />
                  <span class="text-sm text-gray-700 dark:text-gray-300">Enable drawdown throttle (reduce risk as daily loss increases)</span>
                </label>
              </div>
              <div>
                <label class="block text-sm text-gray-600 dark:text-gray-400 mb-1">Drawdown Throttle Threshold</label>
                <div class="flex items-center gap-2">
                  <input type="number" v-model.number="configForm.drawdown_throttle_pct" step="0.05" min="0.1" max="1"
                    class="w-full rounded-md border-gray-300 dark:border-gray-600 dark:bg-gray-700 dark:text-white text-sm" />
                  <span class="text-sm text-gray-500">{{ (configForm.drawdown_throttle_pct * 100).toFixed(0) }}% of max daily loss</span>
                </div>
              </div>
            </div>
          </div>

          <!-- Signal Priority -->
          <div>
            <h3 class="text-sm font-semibold text-gray-700 dark:text-gray-300 uppercase mb-3">Signal Priority</h3>
            <label class="flex items-center gap-2">
              <input type="checkbox" v-model="configForm.enable_signal_priority" class="rounded text-indigo-600" />
              <span class="text-sm text-gray-700 dark:text-gray-300">Enable signal priority queue (rank competing signals by score)</span>
            </label>
          </div>

          <div class="pt-4 border-t border-gray-200 dark:border-gray-700">
            <button
              @click="saveConfig"
              :disabled="saving"
              class="px-4 py-2 text-sm font-medium rounded-lg bg-indigo-600 text-white hover:bg-indigo-700 disabled:opacity-50"
            >
              {{ saving ? 'Saving...' : 'Save Configuration' }}
            </button>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, reactive, onMounted, watch } from 'vue'
import { useSimulationStore } from '@/stores/simulation'
import {
  ArrowPathIcon, CalculatorIcon, ChartBarSquareIcon,
  EyeIcon, ShieldCheckIcon, ShieldExclamationIcon, ClockIcon,
} from '@heroicons/vue/24/outline'

const store = useSimulationStore()
const loading = ref(true)
const saving = ref(false)
const activeTab = ref('scorecard')
const intelligenceStatus = ref(null)
const configForm = ref(null)

const tabs = [
  { id: 'scorecard', label: 'Strategy Scorecard' },
  { id: 'positions', label: 'Live Positions' },
  { id: 'rejections', label: 'Rejection Log' },
  { id: 'cooldowns', label: 'Cooldowns' },
  { id: 'config', label: 'Configuration' },
]

function statusBorderColor(status) {
  if (status === 'ACTIVE') return 'border-green-500'
  if (status === 'UNDERPERFORMING') return 'border-red-500'
  return 'border-gray-300 dark:border-gray-600'
}

function statusDotColor(status) {
  if (status === 'ACTIVE') return 'bg-green-500'
  if (status === 'UNDERPERFORMING') return 'bg-red-500'
  return 'bg-gray-400'
}

function statusBadgeColor(status) {
  if (status === 'ACTIVE') return 'bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-300'
  if (status === 'UNDERPERFORMING') return 'bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-300'
  if (status === 'PAUSED') return 'bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-300'
  return 'bg-gray-100 text-gray-800 dark:bg-gray-700 dark:text-gray-300'
}

function gateBadgeColor(gate) {
  const map = {
    SAFETY_GUARD: 'bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-300',
    STRATEGY_GATE: 'bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-300',
    ADAPTIVE_GUARD: 'bg-purple-100 text-purple-800 dark:bg-purple-900/30 dark:text-purple-300',
  }
  return map[gate] || 'bg-gray-100 text-gray-800 dark:bg-gray-700 dark:text-gray-300'
}

function remainingTime(until) {
  const ms = new Date(until) - Date.now()
  if (ms <= 0) return 'expired'
  const min = Math.ceil(ms / 60000)
  if (min < 60) return `${min}m`
  const hrs = Math.floor(min / 60)
  return `${hrs}h ${min % 60}m`
}

async function refreshAll() {
  loading.value = true
  try {
    const [statusData] = await Promise.all([
      store.fetchIntelligenceStatus(),
      store.fetchScorecard(),
      store.fetchLivePositions(),
      store.fetchRejections(),
      store.fetchCooldowns(),
    ])
    intelligenceStatus.value = statusData
  } finally {
    loading.value = false
  }
}

async function recalculate() {
  loading.value = true
  try {
    await store.recalculateScorecard()
    await refreshAll()
  } finally {
    loading.value = false
  }
}

async function handleClearCooldown(strategy) {
  await store.clearCooldown(strategy)
}

async function loadConfig() {
  const data = await store.fetchIntelligenceConfig()
  configForm.value = { ...data }
}

async function saveConfig() {
  saving.value = true
  try {
    await store.updateIntelligenceConfig(configForm.value)
  } finally {
    saving.value = false
  }
}

watch(activeTab, (tab) => {
  if (tab === 'config' && !configForm.value) {
    loadConfig()
  }
})

onMounted(async () => {
  await refreshAll()
})
</script>
