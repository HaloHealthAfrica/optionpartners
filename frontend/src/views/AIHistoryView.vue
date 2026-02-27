<template>
  <div class="content-wrapper py-8">
    <!-- Header -->
    <div class="mb-8">
      <div class="flex flex-col sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 class="heading-page">AI Sessions</h1>
          <p class="mt-1 text-sm text-gray-600 dark:text-gray-400">
            Browse your past AI trading analysis sessions and credit usage
          </p>
        </div>
        <div class="mt-4 sm:mt-0 flex items-center space-x-3">
          <CreditBadge />
          <button @click="startNewAnalysis" :disabled="!aiStore.canStartSession" class="btn-primary text-sm inline-flex items-center gap-2">
            <SparklesIcon class="h-4 w-4" />
            New Analysis
          </button>
        </div>
      </div>
    </div>

    <!-- Tabs -->
    <div class="border-b border-gray-200 dark:border-gray-700 mb-6">
      <nav class="-mb-px flex space-x-8">
        <button
          @click="activeTab = 'sessions'"
          :class="[
            activeTab === 'sessions'
              ? 'border-primary-500 text-primary-600 dark:text-primary-400'
              : 'border-transparent text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-300 hover:border-gray-300',
            'whitespace-nowrap py-4 px-1 border-b-2 font-medium text-sm'
          ]"
        >
          Session History
        </button>
        <button
          @click="activeTab = 'credits'"
          :class="[
            activeTab === 'credits'
              ? 'border-primary-500 text-primary-600 dark:text-primary-400'
              : 'border-transparent text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-300 hover:border-gray-300',
            'whitespace-nowrap py-4 px-1 border-b-2 font-medium text-sm'
          ]"
        >
          Credit Usage
        </button>
      </nav>
    </div>

    <!-- Sessions Tab -->
    <div v-show="activeTab === 'sessions'">
      <!-- Loading -->
      <div v-if="loadingSessions" class="flex justify-center py-12">
        <div class="animate-spin rounded-full h-8 w-8 border-b-2 border-primary-600"></div>
      </div>

      <!-- Sessions List -->
      <div v-else-if="sessions.length > 0" class="space-y-4">
        <div
          v-for="session in sessions"
          :key="session.id"
          class="bg-white dark:bg-gray-800 rounded-lg shadow-sm border border-gray-200 dark:border-gray-700 hover:shadow-md transition-shadow cursor-pointer"
          @click="viewSession(session)"
        >
          <div class="p-5">
            <div class="flex items-start justify-between">
              <div class="flex-1 min-w-0">
                <div class="flex items-center gap-3 mb-2">
                  <SparklesIcon class="h-5 w-5 text-primary-500 flex-shrink-0" />
                  <h3 class="text-sm font-semibold text-gray-900 dark:text-gray-100 truncate">
                    {{ sessionTitle(session) }}
                  </h3>
                  <span
                    class="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium flex-shrink-0"
                    :class="statusBadge(session.status)"
                  >
                    {{ session.status }}
                  </span>
                </div>
                <p v-if="session.trade_summary" class="text-sm text-gray-600 dark:text-gray-400 line-clamp-2">
                  {{ session.trade_summary }}
                </p>
                <div class="mt-3 flex items-center gap-4 text-xs text-gray-500 dark:text-gray-400">
                  <span>{{ formatDate(session.created_at) }}</span>
                  <span>{{ session.followup_count || 0 }}/{{ session.max_followups || 5 }} follow-ups</span>
                  <span v-if="session.credits_used">{{ session.credits_used }} credits used</span>
                </div>
              </div>
              <svg class="h-5 w-5 text-gray-400 dark:text-gray-500 ml-4 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 5l7 7-7 7" />
              </svg>
            </div>
          </div>
        </div>
      </div>

      <!-- Empty State -->
      <div v-else class="text-center py-12">
        <SparklesIcon class="mx-auto h-12 w-12 text-gray-400 dark:text-gray-500" />
        <h3 class="mt-2 text-sm font-medium text-gray-900 dark:text-gray-100">No AI sessions yet</h3>
        <p class="mt-1 text-sm text-gray-500 dark:text-gray-400">
          Start your first AI analysis to get personalized trading insights.
        </p>
        <div class="mt-6">
          <button
            @click="startNewAnalysis"
            :disabled="!aiStore.canStartSession"
            class="btn-primary inline-flex items-center gap-2"
          >
            <SparklesIcon class="h-4 w-4" />
            Start AI Analysis
          </button>
        </div>
      </div>
    </div>

    <!-- Credit Usage Tab -->
    <div v-show="activeTab === 'credits'">
      <!-- Credit Overview Cards -->
      <div class="grid grid-cols-1 sm:grid-cols-3 gap-6 mb-8">
        <div class="bg-white dark:bg-gray-800 rounded-lg shadow-sm border border-gray-200 dark:border-gray-700 p-5">
          <div class="text-sm text-gray-500 dark:text-gray-400">Credits Remaining</div>
          <div class="mt-1 text-2xl font-bold text-gray-900 dark:text-gray-100">
            {{ aiStore.credits.unlimited ? 'Unlimited' : (aiStore.credits.remaining ?? '—') }}
          </div>
          <div v-if="aiStore.credits.period_end" class="mt-1 text-xs text-gray-500 dark:text-gray-400">
            Resets {{ formatDate(aiStore.credits.period_end) }}
          </div>
        </div>
        <div class="bg-white dark:bg-gray-800 rounded-lg shadow-sm border border-gray-200 dark:border-gray-700 p-5">
          <div class="text-sm text-gray-500 dark:text-gray-400">Credits Used</div>
          <div class="mt-1 text-2xl font-bold text-gray-900 dark:text-gray-100">
            {{ aiStore.credits.used }}
          </div>
          <div class="mt-1 text-xs text-gray-500 dark:text-gray-400">this period</div>
        </div>
        <div class="bg-white dark:bg-gray-800 rounded-lg shadow-sm border border-gray-200 dark:border-gray-700 p-5">
          <div class="text-sm text-gray-500 dark:text-gray-400">Credit Costs</div>
          <div class="mt-2 space-y-1 text-sm">
            <div class="flex justify-between">
              <span class="text-gray-600 dark:text-gray-400">New session</span>
              <span class="font-medium text-gray-900 dark:text-gray-100">{{ aiStore.creditCosts.new_session }} credits</span>
            </div>
            <div class="flex justify-between">
              <span class="text-gray-600 dark:text-gray-400">Follow-up</span>
              <span class="font-medium text-gray-900 dark:text-gray-100">{{ aiStore.creditCosts.followup }} credits</span>
            </div>
          </div>
        </div>
      </div>

      <!-- Credit Usage Bar -->
      <div v-if="!aiStore.credits.unlimited && aiStore.credits.allocated" class="bg-white dark:bg-gray-800 rounded-lg shadow-sm border border-gray-200 dark:border-gray-700 p-5 mb-8">
        <div class="flex justify-between text-sm mb-2">
          <span class="text-gray-600 dark:text-gray-400">Usage</span>
          <span class="text-gray-900 dark:text-gray-100 font-medium">
            {{ aiStore.credits.used }} / {{ aiStore.credits.allocated }}
          </span>
        </div>
        <div class="w-full bg-gray-200 dark:bg-gray-700 rounded-full h-3">
          <div
            class="h-3 rounded-full transition-all"
            :class="usageBarColor"
            :style="{ width: usagePercent + '%' }"
          ></div>
        </div>
      </div>

      <!-- Credit History -->
      <div class="bg-white dark:bg-gray-800 rounded-lg shadow-sm border border-gray-200 dark:border-gray-700">
        <div class="px-5 py-4 border-b border-gray-200 dark:border-gray-700">
          <h3 class="text-sm font-medium text-gray-900 dark:text-gray-100">Usage History</h3>
        </div>
        <div v-if="loadingHistory" class="flex justify-center py-8">
          <div class="animate-spin rounded-full h-6 w-6 border-b-2 border-primary-600"></div>
        </div>
        <div v-else-if="creditHistory.length > 0" class="divide-y divide-gray-200 dark:divide-gray-700">
          <div
            v-for="entry in creditHistory"
            :key="entry.id || entry.period"
            class="px-5 py-3 flex items-center justify-between"
          >
            <div>
              <div class="text-sm font-medium text-gray-900 dark:text-gray-100">{{ entry.period || entry.description }}</div>
              <div class="text-xs text-gray-500 dark:text-gray-400">{{ entry.sessions_count || 0 }} sessions</div>
            </div>
            <div class="text-right">
              <div class="text-sm font-semibold text-gray-900 dark:text-gray-100">{{ entry.credits_used || 0 }} credits</div>
              <div v-if="entry.credits_allocated" class="text-xs text-gray-500 dark:text-gray-400">
                of {{ entry.credits_allocated }}
              </div>
            </div>
          </div>
        </div>
        <div v-else class="px-5 py-8 text-center text-sm text-gray-500 dark:text-gray-400">
          No credit usage history available
        </div>
      </div>
    </div>

    <!-- Session Detail Modal -->
    <div
      v-if="selectedSession"
      class="fixed inset-0 bg-gray-600/50 overflow-y-auto h-full w-full z-50"
      @click.self="selectedSession = null"
    >
      <div class="relative top-10 mx-auto max-w-3xl shadow-lg rounded-lg bg-white dark:bg-gray-800 border border-gray-300 dark:border-gray-700 mb-10">
        <!-- Modal Header -->
        <div class="flex items-center justify-between px-6 py-4 border-b border-gray-200 dark:border-gray-700">
          <div class="flex items-center gap-3">
            <SparklesIcon class="h-5 w-5 text-primary-500" />
            <div>
              <h3 class="text-lg font-medium text-gray-900 dark:text-gray-100">{{ sessionTitle(selectedSession) }}</h3>
              <p class="text-xs text-gray-500 dark:text-gray-400">{{ formatDate(selectedSession.created_at) }}</p>
            </div>
          </div>
          <div class="flex items-center gap-3">
            <button
              v-if="selectedSession.status === 'active'"
              @click="resumeSession(selectedSession)"
              class="btn-primary text-sm inline-flex items-center gap-1"
            >
              Resume
            </button>
            <button @click="selectedSession = null" class="text-gray-400 hover:text-gray-600 dark:hover:text-gray-300">
              <svg class="h-6 w-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </div>
        </div>

        <!-- Modal Body - Messages -->
        <div class="px-6 py-4 max-h-[70vh] overflow-y-auto space-y-4">
          <div v-if="loadingSessionDetail" class="flex justify-center py-8">
            <div class="animate-spin rounded-full h-6 w-6 border-b-2 border-primary-600"></div>
          </div>
          <template v-else-if="sessionMessages.length > 0">
            <div v-for="(message, index) in sessionMessages" :key="index">
              <!-- User Message -->
              <div v-if="message.role === 'user'" class="flex justify-end mb-4">
                <div class="max-w-[85%] bg-primary-600 text-white rounded-lg px-4 py-2">
                  <p class="text-sm whitespace-pre-wrap">{{ message.content }}</p>
                </div>
              </div>
              <!-- Assistant Message -->
              <div v-else class="flex justify-start mb-4">
                <div class="max-w-[95%] bg-gray-100 dark:bg-gray-700 rounded-lg px-4 py-3">
                  <div class="prose dark:prose-invert prose-sm max-w-none text-sm whitespace-pre-wrap">{{ message.content }}</div>
                </div>
              </div>
            </div>
          </template>
          <div v-else class="text-center py-8 text-gray-500 dark:text-gray-400">
            <p class="text-sm">No messages in this session</p>
          </div>
        </div>

        <!-- Modal Footer -->
        <div class="px-6 py-3 border-t border-gray-200 dark:border-gray-700 flex justify-between text-xs text-gray-500 dark:text-gray-400">
          <span>{{ (selectedSession.followup_count || 0) }}/{{ selectedSession.max_followups || 5 }} follow-ups used</span>
          <span>Status: {{ selectedSession.status }}</span>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, computed, onMounted } from 'vue'
import { useRouter } from 'vue-router'
import { useAIStore } from '@/stores/ai'
import { SparklesIcon } from '@heroicons/vue/24/outline'
import CreditBadge from '@/components/ai/CreditBadge.vue'
import api from '@/services/api'

const router = useRouter()
const aiStore = useAIStore()

const activeTab = ref('sessions')
const sessions = ref([])
const creditHistory = ref([])
const loadingSessions = ref(true)
const loadingHistory = ref(false)
const loadingSessionDetail = ref(false)
const selectedSession = ref(null)
const sessionMessages = ref([])

const usagePercent = computed(() => {
  if (!aiStore.credits.allocated) return 0
  return Math.min((aiStore.credits.used / aiStore.credits.allocated) * 100, 100)
})

const usageBarColor = computed(() => {
  if (usagePercent.value >= 90) return 'bg-red-500'
  if (usagePercent.value >= 70) return 'bg-yellow-500'
  return 'bg-primary-500'
})

function statusBadge(status) {
  const map = {
    active: 'bg-green-100 text-green-800 dark:bg-green-900/20 dark:text-green-400',
    closed: 'bg-gray-100 text-gray-800 dark:bg-gray-800 dark:text-gray-400',
    expired: 'bg-yellow-100 text-yellow-800 dark:bg-yellow-900/20 dark:text-yellow-400'
  }
  return map[status] || map.closed
}

function sessionTitle(session) {
  if (session.title) return session.title
  const date = new Date(session.created_at)
  return `Analysis - ${date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}`
}

function formatDate(dateStr) {
  if (!dateStr) return ''
  return new Date(dateStr).toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit'
  })
}

async function loadSessions() {
  loadingSessions.value = true
  try {
    await aiStore.fetchRecentSessions(20)
    sessions.value = aiStore.recentSessions
  } catch (err) {
    console.error('[AI_HISTORY] Error loading sessions:', err)
  } finally {
    loadingSessions.value = false
  }
}

async function loadCreditHistory() {
  loadingHistory.value = true
  try {
    const response = await api.get('/ai/credits/history', { params: { limit: 12 } })
    creditHistory.value = response.data.history || response.data || []
  } catch (err) {
    console.error('[AI_HISTORY] Error loading credit history:', err)
  } finally {
    loadingHistory.value = false
  }
}

async function viewSession(session) {
  selectedSession.value = session
  loadingSessionDetail.value = true
  sessionMessages.value = []
  try {
    const loaded = await aiStore.loadSession(session.id)
    sessionMessages.value = loaded?.messages || aiStore.messages || []
    if (loaded) {
      selectedSession.value = { ...session, ...loaded }
    }
  } catch (err) {
    console.error('[AI_HISTORY] Error loading session detail:', err)
  } finally {
    loadingSessionDetail.value = false
  }
}

async function resumeSession(session) {
  try {
    await aiStore.loadSession(session.id)
    selectedSession.value = null
    router.push({ name: 'metrics', query: { aiPanel: 'open' } })
  } catch (err) {
    console.error('[AI_HISTORY] Error resuming session:', err)
  }
}

function startNewAnalysis() {
  router.push({ name: 'metrics', query: { aiPanel: 'open' } })
}

onMounted(async () => {
  await Promise.allSettled([
    aiStore.fetchCredits(),
    loadSessions(),
    loadCreditHistory()
  ])
})
</script>
