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
          @click="openAIPanel"
          class="btn-secondary text-sm flex items-center gap-1.5"
        >
          <SparklesIcon class="h-4 w-4" />
          AI Analysis
        </button>
        <router-link
          to="/sim/pipeline-observatory"
          class="btn-secondary text-sm flex items-center gap-1.5"
        >
          Pipeline Observatory
        </router-link>
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

    <!-- ==================== TRADED SIGNALS VIEW ==================== -->
    <template v-if="activeStatus === 'TRADED_SIGNALS'">
      <!-- Sub-filter pills -->
      <div class="flex gap-2 mb-4">
        <button
          v-for="f in tradedSubFilters"
          :key="f.value"
          @click="setTradedOutcome(f.value)"
          class="px-3 py-1.5 rounded-full text-xs font-medium transition-all"
          :class="tradedOutcome === f.value
            ? 'bg-gray-900 text-white dark:bg-white dark:text-gray-900'
            : 'bg-gray-100 text-gray-600 hover:bg-gray-200 dark:bg-gray-700 dark:text-gray-300 dark:hover:bg-gray-600'"
        >
          {{ f.label }}
          <span v-if="f.count > 0" class="ml-1 opacity-70">{{ f.count }}</span>
        </button>
      </div>

      <!-- Summary analytics cards -->
      <div v-if="summary" class="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-6 gap-3 mb-5">
        <div class="bg-white dark:bg-gray-800 rounded-lg p-4 border border-gray-200 dark:border-gray-700">
          <div class="text-2xl font-bold text-gray-900 dark:text-white">{{ summary.total }}</div>
          <div class="text-xs text-gray-500 dark:text-gray-400 mt-1">Total Signals</div>
        </div>
        <div class="bg-white dark:bg-gray-800 rounded-lg p-4 border border-green-200 dark:border-green-800">
          <div class="text-2xl font-bold text-green-600 dark:text-green-400">{{ summary.traded?.count || 0 }}</div>
          <div class="text-xs text-gray-500 dark:text-gray-400 mt-1">Traded</div>
          <div v-if="summary.traded?.open_trades > 0" class="text-xs text-amber-500 mt-0.5">{{ summary.traded.open_trades }} open</div>
        </div>
        <div class="bg-white dark:bg-gray-800 rounded-lg p-4 border border-red-200 dark:border-red-800">
          <div class="text-2xl font-bold text-red-600 dark:text-red-400">{{ summary.blocked?.count || 0 }}</div>
          <div class="text-xs text-gray-500 dark:text-gray-400 mt-1">Blocked</div>
        </div>
        <div class="bg-white dark:bg-gray-800 rounded-lg p-4 border border-gray-200 dark:border-gray-700">
          <div class="text-2xl font-bold" :class="summary.traded?.win_rate != null ? (summary.traded.win_rate >= 50 ? 'text-green-600 dark:text-green-400' : 'text-red-600 dark:text-red-400') : 'text-gray-400'">
            {{ summary.traded?.win_rate != null ? summary.traded.win_rate + '%' : '-' }}
          </div>
          <div class="text-xs text-gray-500 dark:text-gray-400 mt-1">Win Rate</div>
          <div v-if="summary.traded?.wins != null" class="text-xs text-gray-400 mt-0.5">{{ summary.traded.wins }}W / {{ summary.traded.losses }}L</div>
        </div>
        <div class="bg-white dark:bg-gray-800 rounded-lg p-4 border border-gray-200 dark:border-gray-700">
          <div class="text-2xl font-bold" :class="(summary.traded?.total_pnl || 0) >= 0 ? 'text-green-600 dark:text-green-400' : 'text-red-600 dark:text-red-400'">
            {{ (summary.traded?.total_pnl || 0) >= 0 ? '+' : '' }}${{ Number(summary.traded?.total_pnl || 0).toFixed(0) }}
          </div>
          <div class="text-xs text-gray-500 dark:text-gray-400 mt-1">Total P&L</div>
          <div v-if="summary.traded?.avg_pnl" class="text-xs text-gray-400 mt-0.5">Avg ${{ Number(summary.traded.avg_pnl).toFixed(2) }}</div>
        </div>
        <div class="bg-white dark:bg-gray-800 rounded-lg p-4 border border-gray-200 dark:border-gray-700">
          <div class="text-2xl font-bold text-gray-900 dark:text-white">{{ formatNum(summary.traded?.avg_conviction) }}</div>
          <div class="text-xs text-gray-500 dark:text-gray-400 mt-1">Avg Conviction</div>
          <div class="text-xs text-gray-400 mt-0.5">Blocked: {{ formatNum(summary.blocked?.avg_conviction) }}</div>
        </div>
      </div>

      <!-- Analytics panels: Strategy Performance + Blocker Breakdown -->
      <div v-if="summary && (summary.by_strategy?.length || summary.blocked?.by_gate?.length)" class="grid grid-cols-1 lg:grid-cols-2 gap-4 mb-5">
        <!-- Strategy performance -->
        <div v-if="summary.by_strategy?.length" class="bg-white dark:bg-gray-800 rounded-lg border border-gray-200 dark:border-gray-700 p-4">
          <h3 class="text-sm font-semibold text-gray-700 dark:text-gray-300 mb-3">Performance by Strategy</h3>
          <div class="space-y-2.5">
            <div v-for="s in summary.by_strategy" :key="s.strategy" class="flex items-center justify-between text-sm">
              <div class="flex items-center gap-2 min-w-0">
                <span class="font-medium text-gray-900 dark:text-gray-200 truncate">{{ s.strategy }}</span>
                <span class="text-xs text-gray-400 whitespace-nowrap">{{ s.traded }}T / {{ s.blocked }}B</span>
              </div>
              <div class="flex items-center gap-3 flex-shrink-0">
                <span v-if="s.win_rate != null" class="text-xs font-medium" :class="s.win_rate >= 50 ? 'text-green-600 dark:text-green-400' : 'text-red-600 dark:text-red-400'">
                  {{ s.win_rate }}%
                </span>
                <span class="text-xs font-mono font-medium whitespace-nowrap" :class="Number(s.pnl) >= 0 ? 'text-green-600 dark:text-green-400' : 'text-red-600 dark:text-red-400'">
                  {{ Number(s.pnl) >= 0 ? '+' : '' }}${{ Number(s.pnl).toFixed(0) }}
                </span>
                <div class="w-16 h-1.5 rounded-full bg-gray-200 dark:bg-gray-600 overflow-hidden">
                  <div class="h-full rounded-full bg-blue-500" :style="{ width: Math.min(100, Number(s.avg_conviction) || 0) + '%' }"></div>
                </div>
              </div>
            </div>
          </div>
        </div>

        <!-- Blocker breakdown -->
        <div v-if="summary.blocked?.by_gate?.length" class="bg-white dark:bg-gray-800 rounded-lg border border-gray-200 dark:border-gray-700 p-4">
          <h3 class="text-sm font-semibold text-gray-700 dark:text-gray-300 mb-3">Blocker Breakdown</h3>
          <div class="space-y-2.5">
            <div v-for="g in summary.blocked.by_gate" :key="g.gate" class="flex items-center justify-between">
              <div class="flex items-center gap-2 min-w-0">
                <span class="inline-flex items-center justify-center w-6 h-6 rounded bg-red-100 dark:bg-red-900/30 text-red-700 dark:text-red-300 text-xs font-bold flex-shrink-0">
                  {{ g.count }}
                </span>
                <span class="text-sm font-medium text-gray-900 dark:text-gray-200 truncate">{{ formatGateName(g.gate) }}</span>
              </div>
              <div class="flex items-center gap-2 flex-shrink-0">
                <span class="text-xs text-gray-400">avg {{ formatNum(g.avg_conviction) }}</span>
                <div class="w-20 h-1.5 rounded-full bg-gray-200 dark:bg-gray-600 overflow-hidden">
                  <div class="h-full rounded-full bg-red-500" :style="{ width: (summary.blocked.count > 0 ? (g.count / summary.blocked.count * 100) : 0) + '%' }"></div>
                </div>
              </div>
            </div>
          </div>
          <!-- Strategy blockers -->
          <div v-if="summary.blocked.by_strategy?.length" class="mt-4 pt-3 border-t border-gray-100 dark:border-gray-700">
            <h4 class="text-xs font-medium text-gray-500 dark:text-gray-400 mb-2 uppercase tracking-wide">Most Blocked Strategies</h4>
            <div class="flex flex-wrap gap-1.5">
              <span
                v-for="bs in summary.blocked.by_strategy"
                :key="bs.strategy"
                class="inline-flex items-center gap-1 px-2 py-1 rounded-md bg-red-50 dark:bg-red-900/20 text-red-700 dark:text-red-300 text-xs font-medium"
              >
                {{ bs.strategy }}
                <span class="text-red-400 dark:text-red-500">{{ bs.blocked_count }}</span>
              </span>
            </div>
          </div>
        </div>
      </div>

      <!-- Symbol performance (compact row) -->
      <div v-if="summary?.by_symbol?.length" class="bg-white dark:bg-gray-800 rounded-lg border border-gray-200 dark:border-gray-700 p-4 mb-5">
        <h3 class="text-sm font-semibold text-gray-700 dark:text-gray-300 mb-3">Performance by Symbol</h3>
        <div class="flex flex-wrap gap-3">
          <div v-for="sym in summary.by_symbol" :key="sym.symbol" class="flex items-center gap-2 bg-gray-50 dark:bg-gray-700/50 rounded-lg px-3 py-2">
            <span class="text-sm font-bold text-gray-900 dark:text-gray-200">{{ sym.symbol }}</span>
            <span class="text-xs text-gray-400">{{ sym.traded }}T/{{ sym.blocked }}B</span>
            <span v-if="sym.win_rate != null" class="text-xs font-medium" :class="sym.win_rate >= 50 ? 'text-green-600 dark:text-green-400' : 'text-red-600 dark:text-red-400'">
              {{ sym.win_rate }}%
            </span>
            <span class="text-xs font-mono font-medium" :class="Number(sym.pnl) >= 0 ? 'text-green-600 dark:text-green-400' : 'text-red-600 dark:text-red-400'">
              {{ Number(sym.pnl) >= 0 ? '+' : '' }}${{ Number(sym.pnl).toFixed(0) }}
            </span>
          </div>
        </div>
      </div>

      <!-- Signals table -->
      <div class="bg-white dark:bg-gray-800 shadow rounded-lg overflow-hidden">
        <div v-if="store.loading && !refreshing" class="p-8 text-center text-gray-500">
          <ArrowPathIcon class="h-8 w-8 animate-spin mx-auto mb-2" />
          Loading traded signals...
        </div>
        <div v-else-if="store.tradedSignals.length === 0" class="p-8 text-center text-gray-500 dark:text-gray-400">
          <InboxIcon class="h-12 w-12 mx-auto mb-3 opacity-40" />
          <p class="font-medium">No trade decisions found</p>
          <p class="text-sm mt-1">Signals that reach the trade decision engine will appear here</p>
        </div>
        <table v-else class="min-w-full divide-y divide-gray-200 dark:divide-gray-700">
          <thead class="bg-gray-50 dark:bg-gray-700">
            <tr>
              <th class="px-4 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-300 uppercase">Time</th>
              <th class="px-4 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-300 uppercase">Symbol</th>
              <th class="px-4 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-300 uppercase">Direction</th>
              <th class="px-4 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-300 uppercase">Strategy</th>
              <th class="px-4 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-300 uppercase">Contract</th>
              <th class="px-4 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-300 uppercase">Verdict</th>
              <th class="px-4 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-300 uppercase">Conviction</th>
              <th class="px-4 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-300 uppercase">Confidence</th>
              <th class="px-4 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-300 uppercase">P&L</th>
              <th class="px-4 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-300 uppercase">Reason</th>
            </tr>
          </thead>
          <tbody class="divide-y divide-gray-200 dark:divide-gray-700">
            <tr
              v-for="sig in store.tradedSignals"
              :key="sig.id"
              @click="selectedTradedSignal = sig"
              class="hover:bg-gray-50 dark:hover:bg-gray-700/50 cursor-pointer transition-colors"
            >
              <td class="px-4 py-3 text-sm text-gray-900 dark:text-gray-200 whitespace-nowrap">
                {{ formatTime(sig.created_at) }}
              </td>
              <td class="px-4 py-3 text-sm font-semibold text-gray-900 dark:text-gray-200">
                {{ sig.symbol }}
              </td>
              <td class="px-4 py-3">
                <span v-if="sig.direction" class="text-xs font-medium" :class="directionClass(sig.direction)">
                  {{ sig.direction }}
                </span>
                <span v-else class="text-xs text-gray-400">-</span>
              </td>
              <td class="px-4 py-3 text-xs text-gray-600 dark:text-gray-300 font-medium">
                {{ sig.strategy || '-' }}
              </td>
              <td class="px-4 py-3 text-xs font-mono text-gray-600 dark:text-gray-400">
                <template v-if="isSpread(sig)">
                  <span v-if="hasSpreadLegs(sig)" class="text-green-600 dark:text-green-400" :title="`Short: $${sig.strike_short} / Long: $${sig.strike_long}`">
                    Sell ${{ formatStrike(sig.strike_short) }} / Buy ${{ formatStrike(sig.strike_long) }}
                    <span class="text-gray-400 ml-0.5">{{ spreadTypeChar(sig) }}</span>
                  </span>
                  <span v-else class="text-amber-600 dark:text-amber-400" title="Spread legs not found — position may not have been created">
                    —
                  </span>
                </template>
                <span v-else-if="sig.contract_type && sig.strike">
                  {{ sig.contract_type }} ${{ formatStrike(sig.strike) }}
                </span>
                <span v-else class="text-gray-400">-</span>
              </td>
              <td class="px-4 py-3">
                <span
                  class="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium"
                  :class="verdictClass(sig)"
                >
                  {{ sig.traded ? 'TRADED' : 'BLOCKED' }}
                  <span v-if="sig.traded && sig.position_verified === false" class="opacity-75" title="Position not found in ledger">⚠</span>
                </span>
              </td>
              <td class="px-4 py-3">
                <div class="flex items-center gap-1.5">
                  <div class="w-12 h-1.5 rounded-full bg-gray-200 dark:bg-gray-600 overflow-hidden">
                    <div
                      class="h-full rounded-full transition-all"
                      :class="convictionBarColor(sig.conviction_score)"
                      :style="{ width: Math.min(100, sig.conviction_score || 0) + '%' }"
                    ></div>
                  </div>
                  <span class="text-xs font-mono text-gray-700 dark:text-gray-300">{{ formatNum(sig.conviction_score) }}</span>
                </div>
              </td>
              <td class="px-4 py-3 text-xs font-mono text-gray-600 dark:text-gray-300">
                {{ sig.signal_confidence != null ? formatNum(sig.signal_confidence) : '-' }}
              </td>
              <td class="px-4 py-3 text-sm font-medium whitespace-nowrap">
                <template v-if="sig.trade_id && sig.pnl != null">
                  <span :class="Number(sig.pnl) >= 0 ? 'text-green-600 dark:text-green-400' : 'text-red-600 dark:text-red-400'">
                    {{ Number(sig.pnl) >= 0 ? '+' : '' }}${{ Number(sig.pnl).toFixed(2) }}
                  </span>
                </template>
                <template v-else-if="sig.traded && !sig.trade_id">
                  <span class="text-amber-500 text-xs">Open</span>
                </template>
                <span v-else class="text-gray-400 text-xs">-</span>
              </td>
              <td class="px-4 py-3 text-xs max-w-xs truncate" :class="sig.traded ? 'text-gray-500 dark:text-gray-400' : 'text-red-600 dark:text-red-400'">
                {{ getTradedSignalSummary(sig) }}
              </td>
            </tr>
          </tbody>
        </table>

        <!-- Traded signals pagination -->
        <div v-if="store.tradedSignalsPagination.total > store.tradedSignalsPagination.limit" class="px-4 py-3 border-t border-gray-200 dark:border-gray-700 flex items-center justify-between">
          <p class="text-sm text-gray-500 dark:text-gray-400">
            Showing {{ (store.tradedSignalsPagination.page - 1) * store.tradedSignalsPagination.limit + 1 }} -
            {{ Math.min(store.tradedSignalsPagination.page * store.tradedSignalsPagination.limit, store.tradedSignalsPagination.total) }}
            of {{ store.tradedSignalsPagination.total }}
          </p>
          <div class="flex gap-2">
            <button
              @click="changeTradedPage(-1)"
              :disabled="store.tradedSignalsPagination.page <= 1"
              class="px-3 py-1 rounded text-sm border border-gray-300 dark:border-gray-600 disabled:opacity-50"
            >Previous</button>
            <button
              @click="changeTradedPage(1)"
              :disabled="store.tradedSignalsPagination.page * store.tradedSignalsPagination.limit >= store.tradedSignalsPagination.total"
              class="px-3 py-1 rounded text-sm border border-gray-300 dark:border-gray-600 disabled:opacity-50"
            >Next</button>
          </div>
        </div>
      </div>
    </template>

    <!-- ==================== STANDARD WEBHOOK TABLE ==================== -->
    <template v-else>
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
              <td class="px-4 py-3">
                <div class="flex items-center gap-2 max-w-xs">
                  <span class="truncate flex-1" :class="event.error_message ? 'text-red-600 dark:text-red-400' : 'text-green-600 dark:text-green-400'">
                    {{ getDetailSummary(event) }}
                  </span>
                  <button
                    v-if="event.status === 'REJECTED' && isRetryable(event)"
                    @click.stop="retryEvent(event)"
                    :disabled="retrying"
                    class="flex-shrink-0 p-1 rounded text-amber-600 dark:text-amber-400 hover:bg-amber-100 dark:hover:bg-amber-900/30 disabled:opacity-50"
                    title="Retry processing"
                  >
                    <ArrowPathIcon class="h-4 w-4" :class="{ 'animate-spin': retrying }" />
                  </button>
                </div>
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
    </template>

    <!-- Event detail modal (standard webhooks) -->
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
            <button
              v-if="isRetryable(selectedEvent)"
              @click="retrySelectedEvent"
              :disabled="retrying"
              class="mt-2 inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-sm font-medium bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-200 hover:bg-amber-200 dark:hover:bg-amber-900/50 disabled:opacity-50"
            >
              <ArrowPathIcon class="h-4 w-4" :class="{ 'animate-spin': retrying }" />
              {{ retrying ? 'Retrying...' : 'Retry' }}
            </button>
          </div>

          <div>
            <span class="text-xs text-gray-500 dark:text-gray-400 block mb-1">Raw Payload</span>
            <pre class="p-3 bg-gray-100 dark:bg-gray-900 rounded-lg text-xs overflow-x-auto text-gray-800 dark:text-gray-300 max-h-80">{{ JSON.stringify(selectedEvent.raw_payload, null, 2) }}</pre>
          </div>
        </div>
      </div>
    </div>

    <!-- Traded Signal detail modal -->
    <div v-if="selectedTradedSignal" class="fixed inset-0 z-50 flex items-center justify-center bg-black/50" @click.self="selectedTradedSignal = null">
      <div class="bg-white dark:bg-gray-800 rounded-lg shadow-xl max-w-4xl w-full mx-4 max-h-[85vh] overflow-y-auto">
        <div class="p-6">
          <div class="flex items-center justify-between mb-4">
            <div>
              <h3 class="text-lg font-semibold text-gray-900 dark:text-white">
                Signal Decision — {{ selectedTradedSignal.symbol }}
              </h3>
              <p class="text-xs text-gray-500 dark:text-gray-400 mt-0.5">{{ formatTime(selectedTradedSignal.created_at) }}</p>
            </div>
            <button @click="selectedTradedSignal = null" class="text-gray-400 hover:text-gray-600 dark:hover:text-gray-300">
              <XMarkIcon class="h-5 w-5" />
            </button>
          </div>

          <!-- Verdict banner -->
          <div
            class="rounded-lg p-4 mb-5 border"
            :class="selectedTradedSignal.traded
              ? 'bg-green-50 border-green-200 dark:bg-green-900/20 dark:border-green-800'
              : 'bg-red-50 border-red-200 dark:bg-red-900/20 dark:border-red-800'"
          >
            <div class="flex items-center justify-between">
              <div class="flex items-center gap-3">
                <span
                  class="inline-flex px-2.5 py-1 rounded-full text-xs font-bold uppercase tracking-wide"
                  :class="selectedTradedSignal.traded
                    ? 'bg-green-200 text-green-800 dark:bg-green-800 dark:text-green-200'
                    : 'bg-red-200 text-red-800 dark:bg-red-800 dark:text-red-200'"
                >{{ selectedTradedSignal.traded ? 'TRADED' : 'BLOCKED' }}</span>
                <span class="text-sm font-medium" :class="directionClass(selectedTradedSignal.direction)">
                  {{ selectedTradedSignal.direction }} {{ selectedTradedSignal.symbol }}
                </span>
              </div>
              <div v-if="selectedTradedSignal.trade_id && selectedTradedSignal.pnl != null" class="text-right">
                <div class="text-xs text-gray-500 dark:text-gray-400">Trade P&L</div>
                <div class="text-lg font-bold" :class="Number(selectedTradedSignal.pnl) >= 0 ? 'text-green-600 dark:text-green-400' : 'text-red-600 dark:text-red-400'">
                  {{ Number(selectedTradedSignal.pnl) >= 0 ? '+' : '' }}${{ Number(selectedTradedSignal.pnl).toFixed(2) }}
                </div>
              </div>
            </div>
            <p v-if="!selectedTradedSignal.traded && selectedTradedSignal.rejection_reason" class="mt-2 text-sm text-red-700 dark:text-red-300">
              {{ selectedTradedSignal.rejection_reason }}
            </p>
          </div>

          <!-- Decision metrics -->
          <div class="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-5">
            <div class="bg-gray-50 dark:bg-gray-700/50 rounded-lg p-3">
              <div class="text-xs text-gray-500 dark:text-gray-400">Conviction</div>
              <div class="flex items-center gap-2 mt-1">
                <div class="w-16 h-2 rounded-full bg-gray-200 dark:bg-gray-600 overflow-hidden">
                  <div class="h-full rounded-full" :class="convictionBarColor(selectedTradedSignal.conviction_score)" :style="{ width: Math.min(100, selectedTradedSignal.conviction_score || 0) + '%' }"></div>
                </div>
                <span class="text-sm font-bold text-gray-900 dark:text-gray-200">{{ formatNum(selectedTradedSignal.conviction_score) }}</span>
              </div>
            </div>
            <div class="bg-gray-50 dark:bg-gray-700/50 rounded-lg p-3">
              <div class="text-xs text-gray-500 dark:text-gray-400">Signal Confidence</div>
              <div class="text-sm font-bold text-gray-900 dark:text-gray-200 mt-1">{{ selectedTradedSignal.signal_confidence != null ? formatNum(selectedTradedSignal.signal_confidence) : '-' }}</div>
            </div>
            <div class="bg-gray-50 dark:bg-gray-700/50 rounded-lg p-3">
              <div class="text-xs text-gray-500 dark:text-gray-400">Strategy</div>
              <div class="text-sm font-medium text-gray-900 dark:text-gray-200 mt-1">{{ selectedTradedSignal.strategy || '-' }}</div>
            </div>
            <div class="bg-gray-50 dark:bg-gray-700/50 rounded-lg p-3">
              <div class="text-xs text-gray-500 dark:text-gray-400">Gate</div>
              <div class="text-sm font-medium mt-1" :class="selectedTradedSignal.rejection_gate ? 'text-red-600 dark:text-red-400' : 'text-green-600 dark:text-green-400'">
                {{ selectedTradedSignal.rejection_gate || 'PASSED' }}
              </div>
            </div>
          </div>

          <!-- Position not verified warning -->
          <div v-if="selectedTradedSignal.traded && selectedTradedSignal.position_verified === false" class="mb-5 p-4 bg-amber-50 dark:bg-amber-900/20 rounded-lg border border-amber-200 dark:border-amber-800">
            <div class="flex items-start gap-2">
              <span class="text-amber-600 dark:text-amber-400 text-lg">⚠</span>
              <div>
                <div class="text-sm font-medium text-amber-800 dark:text-amber-200">Position not found in ledger</div>
                <div class="text-xs text-amber-700 dark:text-amber-300 mt-1">The signal was approved but no sim_position or sim_trade exists. The spread may not have been created (e.g. executor failure after verdict).</div>
              </div>
            </div>
          </div>

          <!-- Trade details (if traded) -->
          <div v-if="selectedTradedSignal.trade_id || (selectedTradedSignal.traded && selectedTradedSignal.position_verified)" class="mb-5">
            <h4 class="text-sm font-semibold text-gray-700 dark:text-gray-300 mb-2">Trade Execution</h4>
            <div v-if="isSpread(selectedTradedSignal) && hasSpreadLegs(selectedTradedSignal)" class="mb-3 p-3 bg-purple-50 dark:bg-purple-900/20 rounded-lg border border-purple-200 dark:border-purple-800">
              <div class="text-xs font-medium text-purple-700 dark:text-purple-300 mb-2">Spread Legs</div>
              <div class="grid grid-cols-2 gap-3 text-sm">
                <div>
                  <div class="text-xs text-gray-500 dark:text-gray-400">Short leg (sold)</div>
                  <div class="font-mono font-medium text-gray-900 dark:text-gray-200">${{ formatStrike(selectedTradedSignal.strike_short) }} {{ spreadTypeChar(selectedTradedSignal) }}</div>
                </div>
                <div>
                  <div class="text-xs text-gray-500 dark:text-gray-400">Long leg (bought)</div>
                  <div class="font-mono font-medium text-gray-900 dark:text-gray-200">${{ formatStrike(selectedTradedSignal.strike_long) }} {{ spreadTypeChar(selectedTradedSignal) }}</div>
                </div>
              </div>
              <div class="mt-2 text-xs text-gray-500 dark:text-gray-400">
                Width: ${{ Math.abs(Number(selectedTradedSignal.strike_short) - Number(selectedTradedSignal.strike_long)).toFixed(0) }}
              </div>
            </div>
            <div class="grid grid-cols-2 sm:grid-cols-4 gap-3">
              <div class="bg-gray-50 dark:bg-gray-700/50 rounded-lg p-3">
                <div class="text-xs text-gray-500 dark:text-gray-400">Contract</div>
                <div class="text-sm font-medium text-gray-900 dark:text-gray-200 mt-1">{{ selectedTradedSignal.contract_type }} {{ selectedTradedSignal.side }}</div>
              </div>
              <div class="bg-gray-50 dark:bg-gray-700/50 rounded-lg p-3">
                <div class="text-xs text-gray-500 dark:text-gray-400">Strike / DTE</div>
                <div class="text-sm font-medium text-gray-900 dark:text-gray-200 mt-1">{{ selectedTradedSignal.strike || (hasSpreadLegs(selectedTradedSignal) ? `${formatStrike(selectedTradedSignal.strike_short)}/${formatStrike(selectedTradedSignal.strike_long)}` : '-') }} / {{ selectedTradedSignal.dte_at_entry ?? '-' }}d</div>
              </div>
              <div class="bg-gray-50 dark:bg-gray-700/50 rounded-lg p-3">
                <div class="text-xs text-gray-500 dark:text-gray-400">Entry / Exit</div>
                <div class="text-sm font-medium text-gray-900 dark:text-gray-200 mt-1">
                  ${{ Number(selectedTradedSignal.entry_price).toFixed(2) }}
                  <span v-if="selectedTradedSignal.exit_price">/ ${{ Number(selectedTradedSignal.exit_price).toFixed(2) }}</span>
                </div>
              </div>
              <div v-if="selectedTradedSignal.exit_reason" class="bg-gray-50 dark:bg-gray-700/50 rounded-lg p-3">
                <div class="text-xs text-gray-500 dark:text-gray-400">Exit Reason</div>
                <div class="text-sm font-medium text-gray-900 dark:text-gray-200 mt-1">{{ selectedTradedSignal.exit_reason }}</div>
              </div>
            </div>
          </div>

          <!-- Decision rationale -->
          <div v-if="selectedTradedSignal.checks_detail" class="mb-5">
            <h4 class="text-sm font-semibold text-gray-700 dark:text-gray-300 mb-2">Decision Rationale</h4>
            <div class="space-y-1.5">
              <div
                v-for="(line, i) in parsedRationale(selectedTradedSignal.checks_detail)"
                :key="i"
                class="flex items-start gap-2 text-sm"
              >
                <span class="mt-0.5 flex-shrink-0 text-xs" :class="line.startsWith('+') ? 'text-green-500' : line.startsWith('-') ? 'text-red-500' : 'text-gray-400'">
                  {{ line.startsWith('+') ? '+' : line.startsWith('-') ? '-' : '~' }}
                </span>
                <span class="text-gray-700 dark:text-gray-300">{{ line.replace(/^[+\-~]\s*/, '') }}</span>
              </div>
            </div>
          </div>

          <!-- Engine params -->
          <div v-if="selectedTradedSignal.checks_detail" class="mb-5">
            <h4 class="text-sm font-semibold text-gray-700 dark:text-gray-300 mb-2">Engine Parameters</h4>
            <div class="grid grid-cols-2 sm:grid-cols-3 gap-3">
              <div v-if="parsedChecks(selectedTradedSignal.checks_detail).delta_target" class="bg-gray-50 dark:bg-gray-700/50 rounded-lg p-3">
                <div class="text-xs text-gray-500 dark:text-gray-400">Delta Target</div>
                <div class="text-sm font-mono text-gray-900 dark:text-gray-200 mt-1">{{ parsedChecks(selectedTradedSignal.checks_detail).delta_target }}</div>
              </div>
              <div v-if="parsedChecks(selectedTradedSignal.checks_detail).dte_target" class="bg-gray-50 dark:bg-gray-700/50 rounded-lg p-3">
                <div class="text-xs text-gray-500 dark:text-gray-400">DTE Target</div>
                <div class="text-sm font-mono text-gray-900 dark:text-gray-200 mt-1">{{ parsedChecks(selectedTradedSignal.checks_detail).dte_target }}d</div>
              </div>
              <div v-if="parsedChecks(selectedTradedSignal.checks_detail).size_multiplier" class="bg-gray-50 dark:bg-gray-700/50 rounded-lg p-3">
                <div class="text-xs text-gray-500 dark:text-gray-400">Size Multiplier</div>
                <div class="text-sm font-mono text-gray-900 dark:text-gray-200 mt-1">{{ parsedChecks(selectedTradedSignal.checks_detail).size_multiplier }}x</div>
              </div>
              <div v-if="parsedChecks(selectedTradedSignal.checks_detail).risk_parameters?.stop_source" class="bg-gray-50 dark:bg-gray-700/50 rounded-lg p-3">
                <div class="text-xs text-gray-500 dark:text-gray-400">Stop Source</div>
                <div class="text-sm font-mono text-gray-900 dark:text-gray-200 mt-1">{{ parsedChecks(selectedTradedSignal.checks_detail).risk_parameters.stop_source }}</div>
              </div>
              <div v-if="parsedChecks(selectedTradedSignal.checks_detail).risk_parameters?.stop_level" class="bg-gray-50 dark:bg-gray-700/50 rounded-lg p-3">
                <div class="text-xs text-gray-500 dark:text-gray-400">Stop Level</div>
                <div class="text-sm font-mono text-gray-900 dark:text-gray-200 mt-1">${{ parsedChecks(selectedTradedSignal.checks_detail).risk_parameters.stop_level }}</div>
              </div>
              <div v-if="parsedChecks(selectedTradedSignal.checks_detail).action" class="bg-gray-50 dark:bg-gray-700/50 rounded-lg p-3">
                <div class="text-xs text-gray-500 dark:text-gray-400">Action</div>
                <div class="text-sm font-mono text-gray-900 dark:text-gray-200 mt-1">{{ parsedChecks(selectedTradedSignal.checks_detail).action }}</div>
              </div>
            </div>
          </div>

          <!-- Raw payload -->
          <div v-if="selectedTradedSignal.raw_payload">
            <h4 class="text-sm font-semibold text-gray-700 dark:text-gray-300 mb-2">Original Webhook Payload</h4>
            <pre class="p-3 bg-gray-100 dark:bg-gray-900 rounded-lg text-xs overflow-x-auto text-gray-800 dark:text-gray-300 max-h-60">{{ JSON.stringify(selectedTradedSignal.raw_payload, null, 2) }}</pre>
          </div>
        </div>
      </div>
    </div>

    <!-- AI Analysis Slide-over Panel -->
    <Transition
      enter-active-class="transition ease-out duration-300"
      enter-from-class="translate-x-full"
      enter-to-class="translate-x-0"
      leave-active-class="transition ease-in duration-200"
      leave-from-class="translate-x-0"
      leave-to-class="translate-x-full"
    >
      <div v-if="aiPanelOpen" class="fixed inset-y-0 right-0 z-50 w-full sm:w-[540px] flex">
        <!-- Backdrop -->
        <div class="fixed inset-0 bg-black/30" @click="closeAIPanel"></div>

        <!-- Panel -->
        <div class="relative ml-auto flex h-full w-full sm:w-[540px] flex-col bg-white dark:bg-gray-800 shadow-2xl">
          <!-- Panel Header -->
          <div class="flex items-center justify-between px-6 py-4 border-b border-gray-200 dark:border-gray-700">
            <div class="flex items-center gap-3">
              <div class="p-2 rounded-lg bg-primary-100 dark:bg-primary-900/30">
                <SparklesIcon class="h-5 w-5 text-primary-600 dark:text-primary-400" />
              </div>
              <div>
                <h3 class="text-sm font-semibold text-gray-900 dark:text-white">Webhook Signal Analysis</h3>
                <p class="text-xs text-gray-500 dark:text-gray-400">
                  <template v-if="aiStore.hasActiveSession && aiStore.currentSession?.source === 'webhooks'">
                    {{ aiStore.followupsRemaining }} of {{ aiStore.currentSession.max_followups }} follow-ups remaining
                  </template>
                  <template v-else>
                    AI-powered analysis of your signal processing pipeline
                  </template>
                </p>
              </div>
            </div>
            <div class="flex items-center gap-2">
              <button
                v-if="aiStore.hasActiveSession && aiStore.currentSession?.source === 'webhooks'"
                @click="startWebhookAnalysis"
                :disabled="aiStore.generating"
                class="text-xs px-2.5 py-1.5 rounded-md border border-gray-300 dark:border-gray-600 text-gray-600 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700"
              >
                New Analysis
              </button>
              <button @click="closeAIPanel" class="text-gray-400 hover:text-gray-600 dark:hover:text-gray-300">
                <XMarkIcon class="h-5 w-5" />
              </button>
            </div>
          </div>

          <!-- Panel Body -->
          <div class="flex-1 overflow-y-auto">
            <!-- No session: start prompt -->
            <div v-if="!aiStore.hasActiveSession && !aiStore.loading && !aiStore.generating" class="flex flex-col items-center justify-center h-full px-6 text-center">
              <SparklesIcon class="h-12 w-12 text-gray-300 dark:text-gray-600 mb-4" />
              <h4 class="text-base font-medium text-gray-900 dark:text-white mb-2">
                Analyze Your Signal Pipeline
              </h4>
              <p class="text-sm text-gray-500 dark:text-gray-400 mb-6 max-w-sm">
                Get AI-powered insights on your webhook signals, conviction engine performance,
                strategy effectiveness, and actionable optimization recommendations.
              </p>

              <div v-if="!aiStore.canStartSession" class="mb-4 p-3 bg-amber-50 dark:bg-amber-900/20 rounded-lg max-w-sm">
                <p class="text-amber-800 dark:text-amber-200 text-sm">
                  <template v-if="aiStore.credits.unlimited === false && aiStore.credits.remaining <= 0">
                    You've used all your AI credits for this period.
                  </template>
                  <template v-else>
                    AI analysis requires credits. Configure your AI provider in Settings.
                  </template>
                </p>
              </div>

              <button
                @click="startWebhookAnalysis"
                :disabled="!aiStore.canStartSession || aiStore.generating"
                class="btn-primary inline-flex items-center gap-2"
              >
                <SparklesIcon class="h-4 w-4" />
                Start Signal Analysis
                <span v-if="!aiStore.credits.unlimited" class="text-xs opacity-75">
                  ({{ aiStore.creditCosts.new_session }} credits)
                </span>
              </button>
            </div>

            <!-- Loading state -->
            <div v-else-if="aiStore.loading && !aiStore.hasActiveSession" class="flex flex-col items-center justify-center h-full px-6">
              <div class="animate-spin h-10 w-10 mb-4 border-4 border-primary-600 border-t-transparent rounded-full"></div>
              <p class="text-gray-600 dark:text-gray-400 font-medium">Analyzing your signal pipeline...</p>
              <p class="text-gray-400 dark:text-gray-500 text-xs mt-2">Reviewing signals, conviction scores, and trade outcomes</p>
            </div>

            <!-- Conversation -->
            <div v-else-if="aiStore.hasActiveSession" class="px-6 py-4 space-y-4" ref="aiMessagesContainer">
              <template v-for="(message, index) in aiStore.messages" :key="index">
                <div v-if="message.role === 'user'" class="flex justify-end">
                  <div class="max-w-[85%] bg-primary-600 text-white rounded-lg px-4 py-2">
                    <p class="text-sm whitespace-pre-wrap">{{ message.content }}</p>
                  </div>
                </div>
                <div v-else-if="message.role === 'assistant'" class="flex justify-start">
                  <div class="max-w-[95%] bg-gray-100 dark:bg-gray-700 rounded-lg px-4 py-3">
                    <AIWebhookReport v-if="index === 0" :content="message.content" />
                    <AIReportRenderer v-else :content="message.content" />
                  </div>
                </div>
              </template>

              <div v-if="aiStore.generating" class="flex justify-start">
                <div class="bg-gray-100 dark:bg-gray-700 rounded-lg px-4 py-3">
                  <div class="flex items-center gap-2 text-gray-500 dark:text-gray-400">
                    <div class="flex gap-1">
                      <div class="w-2 h-2 bg-primary-600 rounded-full animate-bounce" style="animation-delay: 0ms"></div>
                      <div class="w-2 h-2 bg-primary-600 rounded-full animate-bounce" style="animation-delay: 150ms"></div>
                      <div class="w-2 h-2 bg-primary-600 rounded-full animate-bounce" style="animation-delay: 300ms"></div>
                    </div>
                    <span class="text-sm">Thinking...</span>
                  </div>
                </div>
              </div>
            </div>
          </div>

          <!-- Panel Footer: Follow-up input -->
          <div v-if="aiStore.hasActiveSession && aiStore.currentSession?.source === 'webhooks'" class="border-t border-gray-200 dark:border-gray-700 px-6 py-4">
            <div v-if="aiStore.canAskFollowup">
              <form @submit.prevent="sendAIFollowup" class="flex gap-2">
                <input
                  v-model="aiFollowupMessage"
                  type="text"
                  placeholder="Ask a follow-up question..."
                  class="flex-1 rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 px-3 py-2 text-sm text-gray-900 dark:text-gray-100 placeholder-gray-400 focus:ring-2 focus:ring-primary-500 focus:border-transparent"
                  :disabled="aiStore.generating || !aiStore.canSendFollowup"
                />
                <button
                  type="submit"
                  :disabled="!aiFollowupMessage.trim() || aiStore.generating || !aiStore.canSendFollowup"
                  class="btn-primary inline-flex items-center gap-1 text-sm"
                >
                  <PaperAirplaneIcon class="h-4 w-4" />
                  Send
                </button>
              </form>
              <p v-if="!aiStore.canSendFollowup && !aiStore.credits.unlimited" class="text-xs text-amber-600 dark:text-amber-400 mt-2">
                Not enough credits for a follow-up question
              </p>
            </div>
            <div v-else class="text-center">
              <p class="text-sm text-gray-500 dark:text-gray-400 mb-3">All follow-up questions used for this session.</p>
              <button
                @click="startWebhookAnalysis"
                :disabled="!aiStore.canStartSession"
                class="btn-primary text-sm inline-flex items-center gap-2"
              >
                <SparklesIcon class="h-4 w-4" />
                Start New Analysis
              </button>
            </div>
          </div>

          <!-- Error display -->
          <div v-if="aiStore.error" class="px-6 py-3 border-t border-red-200 dark:border-red-800 bg-red-50 dark:bg-red-900/20">
            <p class="text-red-800 dark:text-red-200 text-sm">{{ aiStore.error }}</p>
            <button @click="aiStore.clearError" class="text-red-600 dark:text-red-400 text-xs underline mt-1">Dismiss</button>
          </div>
        </div>
      </div>
    </Transition>
  </div>
</template>

<script setup>
import { ref, computed, onMounted, onUnmounted, watch, nextTick } from 'vue'
import { useSimulationStore } from '@/stores/simulation'
import { useAIStore } from '@/stores/ai'
import { ArrowPathIcon, XMarkIcon, BoltIcon, InboxIcon, SparklesIcon, PaperAirplaneIcon } from '@heroicons/vue/24/outline'
import AIReportRenderer from '@/components/ai/AIReportRenderer.vue'
import AIWebhookReport from '@/components/ai/AIWebhookReport.vue'
import api from '@/services/api'

const store = useSimulationStore()
const aiStore = useAIStore()
const selectedEvent = ref(null)
const selectedTradedSignal = ref(null)
const processing = ref(false)
const refreshing = ref(false)
const retrying = ref(false)
const activeStatus = ref('')
const tradedOutcome = ref('')
const autoRefresh = ref(true)
const stats = ref({ total: 0, RECEIVED: 0, PROCESSED: 0, REJECTED: 0 })
let refreshTimer = null

// AI panel state
const aiPanelOpen = ref(false)
const aiFollowupMessage = ref('')
const aiMessagesContainer = ref(null)

function openAIPanel() {
  aiPanelOpen.value = true
  aiStore.fetchCredits().catch(() => {})
}

function closeAIPanel() {
  aiPanelOpen.value = false
}

async function startWebhookAnalysis() {
  aiStore.reset()
  try {
    const filters = {}
    if (tradedOutcome.value) filters.outcome = tradedOutcome.value
    await aiStore.createWebhookSession(filters)
    await nextTick()
    scrollAIToBottom()
  } catch (err) {
    console.error('[WEBHOOK_AI] Error starting analysis:', err)
  }
}

async function sendAIFollowup() {
  if (!aiFollowupMessage.value.trim()) return
  const message = aiFollowupMessage.value.trim()
  aiFollowupMessage.value = ''
  try {
    await aiStore.sendFollowup(message)
    await nextTick()
    scrollAIToBottom()
  } catch (err) {
    console.error('[WEBHOOK_AI] Error sending follow-up:', err)
    aiFollowupMessage.value = message
  }
}

function scrollAIToBottom() {
  if (aiMessagesContainer.value) {
    aiMessagesContainer.value.scrollTop = aiMessagesContainer.value.scrollHeight
  }
}

watch(() => aiStore.messages.length, async () => {
  await nextTick()
  scrollAIToBottom()
})

const webhookUrl = computed(() => {
  const host = window.location.origin
  return `${host}/api/webhooks/tradingview`
})

const statusTabs = computed(() => [
  { label: 'All', value: '', count: stats.value.total },
  { label: 'Received', value: 'RECEIVED', count: stats.value.RECEIVED },
  { label: 'Processed', value: 'PROCESSED', count: stats.value.PROCESSED },
  { label: 'Rejected', value: 'REJECTED', count: stats.value.REJECTED },
  { label: 'Traded Signals', value: 'TRADED_SIGNALS', count: store.tradedSignalsCounts.total },
])

const tradedSubFilters = computed(() => [
  { label: 'All', value: '', count: store.tradedSignalsCounts.total },
  { label: 'Traded', value: 'traded', count: store.tradedSignalsCounts.traded_count },
  { label: 'Blocked', value: 'blocked', count: store.tradedSignalsCounts.blocked_count },
])

const summary = computed(() => store.tradedSignalsSummary)

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

function isRetryable(event) {
  if (!event || event.status !== 'REJECTED') return false
  const msg = event.error_message || ''
  const retryCount = event.retry_count ?? 0
  return msg.startsWith('Processing error:') && retryCount < 3
}

async function retrySelectedEvent() {
  if (!selectedEvent.value || !isRetryable(selectedEvent.value)) return
  await retryEvent(selectedEvent.value)
  selectedEvent.value = null
}

async function retryEvent(event) {
  if (!event || !isRetryable(event)) return
  retrying.value = true
  try {
    await store.retryWebhook(event.id)
    await Promise.all([store.fetchWebhookEvents(), fetchStats()])
  } catch (err) {
    console.error('[WEBHOOK] Retry failed:', err)
  } finally {
    retrying.value = false
  }
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

function convictionBarColor(score) {
  if (score >= 70) return 'bg-green-500'
  if (score >= 40) return 'bg-amber-500'
  return 'bg-red-500'
}

function formatNum(v) {
  if (v == null) return '-'
  return Number(v).toFixed(1)
}

function verdictClass(sig) {
  if (!sig.traded) return 'bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-300'
  if (sig.position_verified === false) return 'bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-300'
  return 'bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-300'
}

function isSpread(sig) {
  const ct = (sig.contract_type || '').toUpperCase()
  return ct === 'CREDIT_SPREAD' || ct === 'DEBIT_SPREAD'
}

function hasSpreadLegs(sig) {
  return sig.strike_short != null && sig.strike_long != null
}

function formatStrike(v) {
  if (v == null) return '-'
  const n = Number(v)
  return isNaN(n) ? String(v) : (n % 1 === 0 ? n.toFixed(0) : n.toFixed(2))
}

function spreadTypeChar(sig) {
  const ct = (sig.contract_type || '').toUpperCase()
  const dir = (sig.direction || '').toLowerCase()
  if (ct === 'CREDIT_SPREAD') return dir === 'short' ? 'C' : 'P'  // bear call vs bull put
  if (ct === 'DEBIT_SPREAD') return dir === 'short' ? 'P' : 'C'   // bear put vs bull call
  return ''
}

function getTradedSignalSummary(sig) {
  if (!sig.traded) {
    return sig.rejection_reason || sig.rejection_detail || 'Blocked by engine'
  }
  const detail = parsedChecks(sig.checks_detail)
  const parts = []
  if (detail.action) parts.push(detail.action)
  if (detail.rationale?.length) parts.push(detail.rationale[0])
  return parts.join(' — ') || 'Approved'
}

function parsedChecks(checksDetail) {
  if (!checksDetail) return {}
  if (typeof checksDetail === 'string') {
    try { return JSON.parse(checksDetail) } catch { return {} }
  }
  return checksDetail
}

function parsedRationale(checksDetail) {
  const detail = parsedChecks(checksDetail)
  return detail.rationale || []
}

function formatGateName(gate) {
  if (!gate) return 'Unknown'
  return gate
    .replace(/_/g, ' ')
    .replace(/\b\w/g, c => c.toUpperCase())
    .replace(/\bPnl\b/i, 'P&L')
    .replace(/\bDte\b/i, 'DTE')
}

function setTradedOutcome(outcome) {
  tradedOutcome.value = outcome
  store.tradedSignalsPagination.page = 1
  store.fetchTradedSignals({ outcome: outcome || undefined })
}

function changeTradedPage(delta) {
  store.tradedSignalsPagination.page += delta
  store.fetchTradedSignals({ outcome: tradedOutcome.value || undefined })
}

function filterByStatus(status) {
  activeStatus.value = status
  if (status === 'TRADED_SIGNALS') {
    store.tradedSignalsPagination.page = 1
    tradedOutcome.value = ''
    store.fetchTradedSignals()
    store.fetchTradedSignalsSummary()
    return
  }
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
    const fetches = [fetchStats()]
    if (activeStatus.value === 'TRADED_SIGNALS') {
      fetches.push(
        store.fetchTradedSignals({ outcome: tradedOutcome.value || undefined }),
        store.fetchTradedSignalsSummary()
      )
    } else {
      fetches.push(store.fetchWebhookEvents())
    }
    await Promise.all(fetches)
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
  await Promise.all([
    store.fetchWebhookEvents(),
    fetchStats(),
    store.fetchTradedSignals(),
    store.fetchTradedSignalsSummary(),
  ])
  if (autoRefresh.value) startAutoRefresh()
})

onUnmounted(() => {
  stopAutoRefresh()
})
</script>
