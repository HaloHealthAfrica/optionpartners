<template>
  <div class="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
    <div class="flex items-center justify-between mb-6">
      <div>
        <h1 class="text-2xl font-bold text-gray-900 dark:text-white">Webhook Inbox</h1>
        <p class="mt-1 text-sm text-gray-500 dark:text-gray-400">Raw TradingView webhook events and their processing status</p>
      </div>
      <div class="flex items-center gap-3">
        <button
          @click="processAll"
          :disabled="processing"
          class="btn-primary text-sm flex items-center gap-2"
        >
          <ArrowPathIcon class="h-4 w-4" :class="{ 'animate-spin': processing }" />
          Process Pending
        </button>
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
          ? 'bg-primary-100 text-primary-700 dark:bg-primary-900/30 dark:text-primary-300'
          : 'text-gray-600 hover:bg-gray-100 dark:text-gray-400 dark:hover:bg-gray-700'"
      >
        {{ tab.label }}
        <span v-if="tab.count !== undefined" class="ml-1 text-xs opacity-75">({{ tab.count }})</span>
      </button>
    </div>

    <!-- Events table -->
    <div class="bg-white dark:bg-gray-800 shadow rounded-lg overflow-hidden">
      <div v-if="store.loading" class="p-8 text-center text-gray-500">
        <ArrowPathIcon class="h-8 w-8 animate-spin mx-auto mb-2" />
        Loading webhook events...
      </div>
      <div v-else-if="store.webhookEvents.length === 0" class="p-8 text-center text-gray-500 dark:text-gray-400">
        No webhook events found. Configure your TradingView alerts to send webhooks to this endpoint.
      </div>
      <table v-else class="min-w-full divide-y divide-gray-200 dark:divide-gray-700">
        <thead class="bg-gray-50 dark:bg-gray-700">
          <tr>
            <th class="px-4 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-300 uppercase">Time</th>
            <th class="px-4 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-300 uppercase">Source</th>
            <th class="px-4 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-300 uppercase">Status</th>
            <th class="px-4 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-300 uppercase">Symbol</th>
            <th class="px-4 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-300 uppercase">Action</th>
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
            <td class="px-4 py-3 text-sm text-gray-600 dark:text-gray-400">{{ event.source }}</td>
            <td class="px-4 py-3">
              <span
                class="inline-flex px-2 py-0.5 rounded-full text-xs font-medium"
                :class="statusClass(event.status)"
              >
                {{ event.status }}
              </span>
            </td>
            <td class="px-4 py-3 text-sm font-medium text-gray-900 dark:text-gray-200">
              {{ event.raw_payload?.ticker || event.raw_payload?.symbol || '-' }}
            </td>
            <td class="px-4 py-3 text-sm text-gray-600 dark:text-gray-400">
              {{ event.raw_payload?.action || event.raw_payload?.order_action || '-' }}
            </td>
            <td class="px-4 py-3 text-sm text-red-600 dark:text-red-400 max-w-xs truncate">
              {{ event.error_message || (event.status === 'PROCESSED' ? 'Processed successfully' : '') }}
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

    <!-- Event detail modal -->
    <div v-if="selectedEvent" class="fixed inset-0 z-50 flex items-center justify-center bg-black/50" @click.self="selectedEvent = null">
      <div class="bg-white dark:bg-gray-800 rounded-lg shadow-xl max-w-2xl w-full mx-4 max-h-[80vh] overflow-y-auto">
        <div class="p-6">
          <div class="flex items-center justify-between mb-4">
            <h3 class="text-lg font-semibold text-gray-900 dark:text-white">Webhook Event Detail</h3>
            <button @click="selectedEvent = null" class="text-gray-400 hover:text-gray-600 dark:hover:text-gray-300">
              <XMarkIcon class="h-5 w-5" />
            </button>
          </div>
          <div class="space-y-3 text-sm">
            <div class="flex justify-between">
              <span class="text-gray-500 dark:text-gray-400">ID</span>
              <span class="font-mono text-gray-900 dark:text-gray-200 text-xs">{{ selectedEvent.id }}</span>
            </div>
            <div class="flex justify-between">
              <span class="text-gray-500 dark:text-gray-400">Received</span>
              <span class="text-gray-900 dark:text-gray-200">{{ formatTime(selectedEvent.received_at) }}</span>
            </div>
            <div class="flex justify-between">
              <span class="text-gray-500 dark:text-gray-400">Status</span>
              <span :class="statusClass(selectedEvent.status)" class="px-2 py-0.5 rounded-full text-xs font-medium">{{ selectedEvent.status }}</span>
            </div>
            <div class="flex justify-between">
              <span class="text-gray-500 dark:text-gray-400">Signature Valid</span>
              <span :class="selectedEvent.signature_valid ? 'text-green-600' : 'text-red-600'">{{ selectedEvent.signature_valid ? 'Yes' : 'No' }}</span>
            </div>
            <div v-if="selectedEvent.error_message">
              <span class="text-gray-500 dark:text-gray-400 block mb-1">Error</span>
              <div class="p-2 bg-red-50 dark:bg-red-900/20 rounded text-red-700 dark:text-red-300 text-xs">{{ selectedEvent.error_message }}</div>
            </div>
            <div>
              <span class="text-gray-500 dark:text-gray-400 block mb-1">Raw Payload</span>
              <pre class="p-3 bg-gray-100 dark:bg-gray-900 rounded text-xs overflow-x-auto text-gray-800 dark:text-gray-300">{{ JSON.stringify(selectedEvent.raw_payload, null, 2) }}</pre>
            </div>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, onMounted } from 'vue'
import { useSimulationStore } from '@/stores/simulation'
import { ArrowPathIcon, XMarkIcon } from '@heroicons/vue/24/outline'

const store = useSimulationStore()
const selectedEvent = ref(null)
const processing = ref(false)
const activeStatus = ref('')

const statusTabs = ref([
  { label: 'All', value: '' },
  { label: 'Received', value: 'RECEIVED' },
  { label: 'Processed', value: 'PROCESSED' },
  { label: 'Rejected', value: 'REJECTED' },
])

function statusClass(status) {
  switch (status) {
    case 'RECEIVED': return 'bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-300'
    case 'PROCESSED': return 'bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-300'
    case 'REJECTED': return 'bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-300'
    default: return 'bg-gray-100 text-gray-800 dark:bg-gray-700 dark:text-gray-300'
  }
}

function formatTime(ts) {
  return new Date(ts).toLocaleString()
}

function filterByStatus(status) {
  activeStatus.value = status
  store.filters.webhookStatus = status
  store.webhookPagination.page = 1
  store.fetchWebhookEvents()
}

function changePage(delta) {
  store.webhookPagination.page += delta
  store.fetchWebhookEvents()
}

async function processAll() {
  processing.value = true
  try {
    await store.processPending()
    await store.fetchWebhookEvents()
  } finally {
    processing.value = false
  }
}

onMounted(() => {
  store.fetchWebhookEvents()
})
</script>
