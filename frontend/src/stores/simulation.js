import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import api from '@/services/api'

export const useSimulationStore = defineStore('simulation', () => {
  const accountState = ref(null)
  const positions = ref([])
  const orders = ref([])
  const trades = ref([])
  const equityCurve = ref([])
  const strategyBreakdown = ref([])
  const dteBreakdown = ref([])
  const webhookEvents = ref([])
  const simRuns = ref([])
  const status = ref(null)
  const loading = ref(false)
  const error = ref(null)

  // Intelligence layer state
  const scorecard = ref([])
  const cooldowns = ref([])
  const rejections = ref([])
  const livePositions = ref([])
  const intelligenceConfig = ref(null)
  const intelligenceStatus = ref(null)
  const equityByStrategy = ref({})
  const rejectionPagination = ref({ page: 1, limit: 50, total: 0 })

  const pagination = ref({ page: 1, limit: 25, total: 0 })
  const webhookPagination = ref({ page: 1, limit: 25, total: 0 })

  const filters = ref({
    strategy: '',
    symbol: '',
    startDate: '',
    endDate: '',
    webhookStatus: '',
  })

  const totalPnL = computed(() => {
    return accountState.value?.realized_pnl ?? 0
  })

  const equity = computed(() => {
    return accountState.value?.equity ?? 0
  })

  const killSwitchActive = computed(() => {
    return accountState.value?.kill_switch_active ?? false
  })

  async function fetchAccountState() {
    try {
      const { data } = await api.get('/sim/account')
      accountState.value = data
      return data
    } catch (err) {
      error.value = err.response?.data?.error || err.message
      throw err
    }
  }

  async function resetAccount() {
    loading.value = true
    try {
      const { data } = await api.post('/sim/account/reset')
      accountState.value = data.account
      return data
    } catch (err) {
      error.value = err.response?.data?.error || err.message
      throw err
    } finally {
      loading.value = false
    }
  }

  async function fetchPositions(params = {}) {
    loading.value = true
    try {
      const { data } = await api.get('/sim/positions', { params: { ...params, ...pagination.value } })
      positions.value = data.positions
      pagination.value.total = data.total
      return data
    } catch (err) {
      error.value = err.response?.data?.error || err.message
      throw err
    } finally {
      loading.value = false
    }
  }

  async function fetchOrders(params = {}) {
    loading.value = true
    try {
      const { data } = await api.get('/sim/orders', { params })
      orders.value = data.orders
      return data
    } catch (err) {
      error.value = err.response?.data?.error || err.message
      throw err
    } finally {
      loading.value = false
    }
  }

  async function fetchTrades(params = {}) {
    loading.value = true
    try {
      const queryParams = {
        page: pagination.value.page,
        limit: pagination.value.limit,
        ...filters.value,
        ...params,
      }
      const { data } = await api.get('/sim/trades', { params: queryParams })
      trades.value = data.trades
      pagination.value.total = data.total
      return data
    } catch (err) {
      error.value = err.response?.data?.error || err.message
      throw err
    } finally {
      loading.value = false
    }
  }

  async function fetchEquityCurve(params = {}) {
    try {
      const { data } = await api.get('/sim/equity-curve', { params })
      equityCurve.value = data
      return data
    } catch (err) {
      error.value = err.response?.data?.error || err.message
      throw err
    }
  }

  async function fetchStrategyBreakdown() {
    try {
      const { data } = await api.get('/sim/analytics/strategy')
      strategyBreakdown.value = data
      return data
    } catch (err) {
      error.value = err.response?.data?.error || err.message
      throw err
    }
  }

  async function fetchDteBreakdown() {
    try {
      const { data } = await api.get('/sim/analytics/dte')
      dteBreakdown.value = data
      return data
    } catch (err) {
      error.value = err.response?.data?.error || err.message
      throw err
    }
  }

  async function fetchWebhookEvents(params = {}) {
    loading.value = true
    try {
      const queryParams = {
        page: webhookPagination.value.page,
        limit: webhookPagination.value.limit,
        status: filters.value.webhookStatus || undefined,
        ...params,
      }
      const { data } = await api.get('/webhooks', { params: queryParams })
      webhookEvents.value = data.events
      webhookPagination.value.total = data.total
      return data
    } catch (err) {
      error.value = err.response?.data?.error || err.message
      throw err
    } finally {
      loading.value = false
    }
  }

  async function fetchSimRuns() {
    try {
      const { data } = await api.get('/sim/runs')
      simRuns.value = data.runs
      return data
    } catch (err) {
      error.value = err.response?.data?.error || err.message
      throw err
    }
  }

  async function fetchStatus() {
    try {
      const { data } = await api.get('/sim/status')
      status.value = data
      return data
    } catch (err) {
      error.value = err.response?.data?.error || err.message
      throw err
    }
  }

  async function toggleKillSwitch(active) {
    try {
      const { data } = await api.post('/sim/kill-switch', { active })
      accountState.value = data.account
      return data
    } catch (err) {
      error.value = err.response?.data?.error || err.message
      throw err
    }
  }

  async function processPending() {
    try {
      const { data } = await api.post('/sim/process')
      return data
    } catch (err) {
      error.value = err.response?.data?.error || err.message
      throw err
    }
  }

  async function startReplay(params) {
    loading.value = true
    try {
      const { data } = await api.post('/sim/replay', params)
      return data
    } catch (err) {
      error.value = err.response?.data?.error || err.message
      throw err
    } finally {
      loading.value = false
    }
  }

  // Intelligence layer methods
  async function fetchScorecard() {
    try {
      const { data } = await api.get('/sim/intelligence/scorecard')
      scorecard.value = data
      return data
    } catch (err) {
      error.value = err.response?.data?.error || err.message
      throw err
    }
  }

  async function recalculateScorecard() {
    loading.value = true
    try {
      const { data } = await api.post('/sim/intelligence/scorecard/recalculate')
      scorecard.value = data.scorecards || []
      return data
    } catch (err) {
      error.value = err.response?.data?.error || err.message
      throw err
    } finally {
      loading.value = false
    }
  }

  async function fetchCooldowns() {
    try {
      const { data } = await api.get('/sim/intelligence/cooldowns')
      cooldowns.value = data
      return data
    } catch (err) {
      error.value = err.response?.data?.error || err.message
      throw err
    }
  }

  async function clearCooldown(strategy) {
    try {
      await api.delete(`/sim/intelligence/cooldowns/${encodeURIComponent(strategy)}`)
      cooldowns.value = cooldowns.value.filter(c => c.strategy !== strategy)
    } catch (err) {
      error.value = err.response?.data?.error || err.message
      throw err
    }
  }

  async function fetchRejections(params = {}) {
    try {
      const queryParams = {
        page: rejectionPagination.value.page,
        limit: rejectionPagination.value.limit,
        ...params,
      }
      const { data } = await api.get('/sim/intelligence/rejections', { params: queryParams })
      rejections.value = data.rejections
      rejectionPagination.value.total = data.total
      return data
    } catch (err) {
      error.value = err.response?.data?.error || err.message
      throw err
    }
  }

  async function fetchLivePositions() {
    try {
      const { data } = await api.get('/sim/intelligence/positions')
      livePositions.value = data
      return data
    } catch (err) {
      error.value = err.response?.data?.error || err.message
      throw err
    }
  }

  async function fetchIntelligenceConfig() {
    try {
      const { data } = await api.get('/sim/intelligence/config')
      intelligenceConfig.value = data
      return data
    } catch (err) {
      error.value = err.response?.data?.error || err.message
      throw err
    }
  }

  async function updateIntelligenceConfig(updates) {
    try {
      const { data } = await api.put('/sim/intelligence/config', updates)
      intelligenceConfig.value = data
      return data
    } catch (err) {
      error.value = err.response?.data?.error || err.message
      throw err
    }
  }

  async function fetchIntelligenceStatus() {
    try {
      const { data } = await api.get('/sim/intelligence/status')
      intelligenceStatus.value = data
      return data
    } catch (err) {
      error.value = err.response?.data?.error || err.message
      throw err
    }
  }

  async function fetchEquityByStrategy() {
    try {
      const { data } = await api.get('/sim/intelligence/equity-by-strategy')
      equityByStrategy.value = data
      return data
    } catch (err) {
      error.value = err.response?.data?.error || err.message
      throw err
    }
  }

  return {
    accountState, positions, orders, trades, equityCurve,
    strategyBreakdown, dteBreakdown, webhookEvents, simRuns,
    status, loading, error, pagination, webhookPagination, filters,
    totalPnL, equity, killSwitchActive,
    fetchAccountState, resetAccount, fetchPositions, fetchOrders,
    fetchTrades, fetchEquityCurve, fetchStrategyBreakdown,
    fetchDteBreakdown, fetchWebhookEvents, fetchSimRuns,
    fetchStatus, toggleKillSwitch, processPending, startReplay,
    // Intelligence layer
    scorecard, cooldowns, rejections, livePositions,
    intelligenceConfig, intelligenceStatus, equityByStrategy,
    rejectionPagination,
    fetchScorecard, recalculateScorecard, fetchCooldowns, clearCooldown,
    fetchRejections, fetchLivePositions, fetchIntelligenceConfig,
    updateIntelligenceConfig, fetchIntelligenceStatus, fetchEquityByStrategy,
  }
})
