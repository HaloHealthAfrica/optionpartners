import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import api from '@/services/api'

export const useMarketDataStore = defineStore('marketData', () => {
  const regime = ref(null)
  const vix = ref(null)
  const macro = ref(null)
  const marketHours = ref(null)
  const gexData = ref({})
  const flowData = ref({})
  const ivData = ref({})
  const serviceHealth = ref(null)

  const loading = ref({
    regime: false,
    vix: false,
    macro: false,
    marketHours: false,
    gex: false,
    flow: false,
    iv: false,
    health: false
  })

  const errors = ref({
    regime: null,
    vix: null,
    macro: null,
    marketHours: null,
    gex: null,
    flow: null,
    iv: null,
    health: null
  })

  const isMarketOpen = computed(() => marketHours.value?.data?.isOpen ?? false)

  const regimeBadge = computed(() => {
    if (!regime.value?.data) return null
    const r = regime.value.data
    const labels = {
      'low-vol': { text: 'Low Vol', color: 'green' },
      'normal': { text: 'Normal', color: 'blue' },
      'elevated': { text: 'Elevated', color: 'yellow' },
      'crisis': { text: 'Crisis', color: 'red' }
    }
    return labels[r.regime] || { text: r.regime, color: 'gray' }
  })

  async function fetchRegime() {
    loading.value.regime = true
    errors.value.regime = null
    try {
      const response = await api.get('/market-data/regime')
      regime.value = response.data
    } catch (err) {
      errors.value.regime = err.response?.data?.error || err.message
    } finally {
      loading.value.regime = false
    }
  }

  async function fetchVIX() {
    loading.value.vix = true
    errors.value.vix = null
    try {
      const response = await api.get('/market-data/vix')
      vix.value = response.data
    } catch (err) {
      errors.value.vix = err.response?.data?.error || err.message
    } finally {
      loading.value.vix = false
    }
  }

  async function fetchMacro() {
    loading.value.macro = true
    errors.value.macro = null
    try {
      const response = await api.get('/market-data/macro')
      macro.value = response.data
    } catch (err) {
      errors.value.macro = err.response?.data?.error || err.message
    } finally {
      loading.value.macro = false
    }
  }

  async function fetchMarketHours() {
    loading.value.marketHours = true
    errors.value.marketHours = null
    try {
      const response = await api.get('/market-data/market-hours')
      marketHours.value = response.data
    } catch (err) {
      errors.value.marketHours = err.response?.data?.error || err.message
    } finally {
      loading.value.marketHours = false
    }
  }

  async function fetchGEX(symbol) {
    loading.value.gex = true
    errors.value.gex = null
    try {
      const response = await api.get(`/market-data/gex/${symbol}`)
      gexData.value[symbol.toUpperCase()] = response.data
    } catch (err) {
      errors.value.gex = err.response?.data?.error || err.message
    } finally {
      loading.value.gex = false
    }
  }

  async function fetchFlow(symbol) {
    loading.value.flow = true
    errors.value.flow = null
    try {
      const response = await api.get(`/market-data/flow/${symbol}`)
      flowData.value[symbol.toUpperCase()] = response.data
    } catch (err) {
      errors.value.flow = err.response?.data?.error || err.message
    } finally {
      loading.value.flow = false
    }
  }

  async function fetchIV(symbol) {
    loading.value.iv = true
    errors.value.iv = null
    try {
      const response = await api.get(`/market-data/iv/${symbol}`)
      ivData.value[symbol.toUpperCase()] = response.data
    } catch (err) {
      errors.value.iv = err.response?.data?.error || err.message
    } finally {
      loading.value.iv = false
    }
  }

  async function fetchServiceHealth() {
    loading.value.health = true
    errors.value.health = null
    try {
      const response = await api.get('/market-data/health')
      serviceHealth.value = response.data
    } catch (err) {
      errors.value.health = err.response?.data?.error || err.message
    } finally {
      loading.value.health = false
    }
  }

  async function fetchOverview() {
    await Promise.allSettled([
      fetchRegime(),
      fetchVIX(),
      fetchMacro(),
      fetchMarketHours()
    ])
  }

  async function fetchSymbolData(symbol) {
    await Promise.allSettled([
      fetchGEX(symbol),
      fetchFlow(symbol),
      fetchIV(symbol)
    ])
  }

  return {
    regime,
    vix,
    macro,
    marketHours,
    gexData,
    flowData,
    ivData,
    serviceHealth,
    loading,
    errors,
    isMarketOpen,
    regimeBadge,
    fetchRegime,
    fetchVIX,
    fetchMacro,
    fetchMarketHours,
    fetchGEX,
    fetchFlow,
    fetchIV,
    fetchServiceHealth,
    fetchOverview,
    fetchSymbolData
  }
})
