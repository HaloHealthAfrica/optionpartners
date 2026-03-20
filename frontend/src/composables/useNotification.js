import { ref } from 'vue'

const notification = ref(null)
const modalAlert = ref(null)

export function useNotification() {
  function showNotification(type, title, message = '', errorCode = null) {
    notification.value = { type, title, message, errorCode }
  }

  function showSuccess(title, message) {
    showNotification('success', title, message)
  }

  function showError(title, message, errorCode = null) {
    showNotification('error', title, message, errorCode)
  }

  function showWarning(title, message, errorCode = null) {
    showNotification('warning', title, message, errorCode)
  }

  /**
   * Extract error details from an API error and display a toast.
   * Automatically pulls errorCode from the response when available.
   */
  function showApiError(title, err, fallbackMessage = 'An unexpected error occurred') {
    const message = err?.response?.data?.error || err?.response?.data?.message || err?.message || fallbackMessage
    const errorCode = err?.response?.data?.errorCode || null
    showError(title, message, errorCode)
  }

  function showCriticalError(title, message, options = {}) {
    modalAlert.value = { 
      type: 'error', 
      title, 
      message,
      errorCode: options.errorCode || null,
      confirmText: options.confirmText || 'OK',
      onConfirm: options.onConfirm || clearModalAlert
    }
  }

  /**
   * Show a critical error modal from an API error, auto-extracting errorCode.
   */
  function showApiCriticalError(title, err, fallbackMessage = 'An unexpected error occurred', options = {}) {
    const message = err?.response?.data?.error || err?.response?.data?.message || err?.message || fallbackMessage
    const errorCode = err?.response?.data?.errorCode || null
    showCriticalError(title, message, { ...options, errorCode })
  }

  function showImportantWarning(title, message, options = {}) {
    modalAlert.value = {
      type: 'warning',
      title,
      message,
      errorCode: options.errorCode || null,
      confirmText: options.confirmText || 'OK',
      cancelText: options.cancelText,
      linkUrl: options.linkUrl,
      linkText: options.linkText,
      onConfirm: options.onConfirm || clearModalAlert,
      onCancel: options.onCancel || clearModalAlert
    }
  }

  function showConfirmation(title, message, onConfirm, onCancel = null) {
    modalAlert.value = {
      type: 'confirm',
      title,
      message,
      confirmText: 'Confirm',
      cancelText: 'Cancel',
      onConfirm: () => {
        clearModalAlert()
        onConfirm()
      },
      onCancel: () => {
        clearModalAlert()
        if (onCancel) onCancel()
      }
    }
  }

  function showDangerConfirmation(title, message, onConfirm, options = {}) {
    modalAlert.value = {
      type: 'error',
      title,
      message,
      confirmText: options.confirmText || 'Delete',
      cancelText: options.cancelText || 'Cancel',
      onConfirm: () => {
        clearModalAlert()
        onConfirm()
      },
      onCancel: () => {
        clearModalAlert()
        if (options.onCancel) options.onCancel()
      }
    }
  }

  function showSuccessModal(title, message, options = {}) {
    modalAlert.value = {
      type: 'success',
      title,
      message,
      confirmText: options.confirmText || 'OK',
      onConfirm: options.onConfirm || clearModalAlert
    }
  }

  function clearNotification() {
    notification.value = null
  }

  function clearModalAlert() {
    modalAlert.value = null
  }

  return {
    notification,
    modalAlert,
    showNotification,
    showSuccess,
    showError,
    showWarning,
    showApiError,
    showCriticalError,
    showApiCriticalError,
    showImportantWarning,
    showConfirmation,
    showDangerConfirmation,
    showSuccessModal,
    clearNotification,
    clearModalAlert
  }
}
