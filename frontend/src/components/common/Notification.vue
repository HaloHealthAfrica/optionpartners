<template>
  <Transition
    enter-active-class="transform ease-out duration-300 transition"
    enter-from-class="translate-y-2 opacity-0 sm:translate-y-0 sm:translate-x-2"
    enter-to-class="translate-y-0 opacity-100 sm:translate-x-0"
    leave-active-class="transition ease-in duration-200"
    leave-from-class="opacity-100"
    leave-to-class="opacity-0"
  >
    <div
      v-if="notification"
      class="fixed bottom-4 right-4 max-w-sm w-full bg-white dark:bg-gray-800 shadow-lg rounded-lg pointer-events-auto ring-1 ring-black ring-opacity-5 overflow-hidden z-50"
    >
      <div class="p-4">
        <div class="flex items-start">
          <div class="flex-shrink-0">
            <CheckCircleIcon v-if="notification.type === 'success'" class="h-6 w-6 text-green-400" />
            <XCircleIcon v-else-if="notification.type === 'error'" class="h-6 w-6 text-red-400" />
            <ExclamationTriangleIcon v-else class="h-6 w-6 text-yellow-400" />
          </div>
          <div class="ml-3 w-0 flex-1">
            <p class="text-sm font-medium text-gray-900 dark:text-white">
              {{ notification.title }}
            </p>
            <p v-if="notification.message" class="mt-1 text-sm text-gray-500 dark:text-gray-400">
              {{ notification.message }}
            </p>
            <div v-if="notification.errorCode" class="mt-2 flex items-center gap-2">
              <code class="text-xs font-mono px-1.5 py-0.5 rounded bg-red-50 dark:bg-red-900/20 text-red-600 dark:text-red-400 border border-red-200 dark:border-red-800">{{ notification.errorCode }}</code>
              <router-link
                v-if="isAdmin"
                :to="{ path: '/admin/errors', query: { search: notification.errorCode } }"
                class="text-xs text-primary-600 dark:text-primary-400 hover:underline"
                @click="close"
              >
                View details
              </router-link>
            </div>
          </div>
          <div class="ml-4 flex-shrink-0 flex">
            <button
              @click="close"
              class="rounded-md inline-flex text-gray-400 hover:text-gray-500 focus:outline-none"
            >
              <XMarkIcon class="h-5 w-5" />
            </button>
          </div>
        </div>
      </div>
    </div>
  </Transition>
</template>

<script setup>
import { ref, watch, computed } from 'vue'
import { useNotification } from '@/composables/useNotification'
import { useAuthStore } from '@/stores/auth'
import { CheckCircleIcon, XCircleIcon, ExclamationTriangleIcon, XMarkIcon } from '@heroicons/vue/24/outline'

const { notification, clearNotification } = useNotification()
const authStore = useAuthStore()
const timer = ref(null)

const isAdmin = computed(() => authStore.user?.role === 'admin')

watch(notification, (newVal) => {
  if (newVal) {
    clearTimeout(timer.value)
    timer.value = setTimeout(() => {
      clearNotification()
    }, newVal.errorCode ? 8000 : 5000)
  }
})

function close() {
  clearTimeout(timer.value)
  clearNotification()
}
</script>
