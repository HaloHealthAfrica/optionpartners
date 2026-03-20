<template>
    <div class="content-wrapper py-8">
        <div class="mb-8">
            <h1 class="heading-page">Error Code Reference</h1>
            <p class="mt-2 text-gray-600 dark:text-gray-400">
                Comprehensive catalog of all system error codes with
                descriptions, severity, and suggested fixes
            </p>
        </div>

        <!-- Loading state -->
        <div v-if="loading" class="flex justify-center items-center h-64">
            <div
                class="animate-spin rounded-full h-12 w-12 border-b-2 border-primary-600"
            ></div>
        </div>

        <!-- Error state -->
        <div
            v-else-if="fetchError"
            class="rounded-md bg-red-50 dark:bg-red-900/20 p-4 mb-6"
        >
            <p class="text-sm text-red-800 dark:text-red-400">
                {{ fetchError }}
            </p>
            <button
                @click="loadCatalog"
                class="mt-2 text-sm text-red-600 dark:text-red-400 hover:underline"
            >
                Try again
            </button>
        </div>

        <template v-else>
            <!-- Severity Summary Cards -->
            <div
                class="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-5 gap-4 mb-8"
            >
                <div
                    class="bg-white dark:bg-gray-800 rounded-lg shadow p-4 flex flex-col border-l-4 border-red-600"
                >
                    <p
                        class="text-xs font-semibold uppercase tracking-wider text-red-600 dark:text-red-400"
                    >
                        Critical
                    </p>
                    <p
                        class="mt-1 text-2xl font-bold text-gray-900 dark:text-white"
                    >
                        {{ severitySummary.critical }}
                    </p>
                </div>
                <div
                    class="bg-white dark:bg-gray-800 rounded-lg shadow p-4 flex flex-col border-l-4 border-orange-500"
                >
                    <p
                        class="text-xs font-semibold uppercase tracking-wider text-orange-600 dark:text-orange-400"
                    >
                        High
                    </p>
                    <p
                        class="mt-1 text-2xl font-bold text-gray-900 dark:text-white"
                    >
                        {{ severitySummary.high }}
                    </p>
                </div>
                <div
                    class="bg-white dark:bg-gray-800 rounded-lg shadow p-4 flex flex-col border-l-4 border-yellow-500"
                >
                    <p
                        class="text-xs font-semibold uppercase tracking-wider text-yellow-600 dark:text-yellow-400"
                    >
                        Medium
                    </p>
                    <p
                        class="mt-1 text-2xl font-bold text-gray-900 dark:text-white"
                    >
                        {{ severitySummary.medium }}
                    </p>
                </div>
                <div
                    class="bg-white dark:bg-gray-800 rounded-lg shadow p-4 flex flex-col border-l-4 border-blue-500"
                >
                    <p
                        class="text-xs font-semibold uppercase tracking-wider text-blue-600 dark:text-blue-400"
                    >
                        Low
                    </p>
                    <p
                        class="mt-1 text-2xl font-bold text-gray-900 dark:text-white"
                    >
                        {{ severitySummary.low }}
                    </p>
                </div>
                <div
                    class="bg-white dark:bg-gray-800 rounded-lg shadow p-4 flex flex-col border-l-4 border-gray-400"
                >
                    <p
                        class="text-xs font-semibold uppercase tracking-wider text-gray-600 dark:text-gray-400"
                    >
                        Total
                    </p>
                    <p
                        class="mt-1 text-2xl font-bold text-gray-900 dark:text-white"
                    >
                        {{ severitySummary.total }}
                    </p>
                </div>
            </div>

            <!-- Filters -->
            <div
                class="bg-white dark:bg-gray-800 rounded-lg shadow p-4 mb-6 flex flex-col sm:flex-row gap-4"
            >
                <!-- Search -->
                <div class="flex-1 relative">
                    <svg
                        class="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-gray-400"
                        fill="none"
                        viewBox="0 0 24 24"
                        stroke="currentColor"
                    >
                        <path
                            stroke-linecap="round"
                            stroke-linejoin="round"
                            stroke-width="2"
                            d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z"
                        />
                    </svg>
                    <input
                        v-model="searchQuery"
                        type="text"
                        placeholder="Search by code, title, message, or description..."
                        class="w-full pl-10 pr-4 py-2 text-sm border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-700 text-gray-900 dark:text-white placeholder-gray-400 focus:ring-2 focus:ring-primary-500 focus:border-transparent"
                    />
                </div>

                <!-- Category Filter -->
                <select
                    v-model="selectedCategory"
                    class="px-3 py-2 text-sm border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-700 text-gray-900 dark:text-white focus:ring-2 focus:ring-primary-500 focus:border-transparent"
                >
                    <option value="">All Categories</option>
                    <option
                        v-for="cat in categories"
                        :key="cat.key"
                        :value="cat.key"
                    >
                        {{ cat.label }} ({{ cat.count }})
                    </option>
                </select>

                <!-- Severity Filter -->
                <select
                    v-model="selectedSeverity"
                    class="px-3 py-2 text-sm border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-700 text-gray-900 dark:text-white focus:ring-2 focus:ring-primary-500 focus:border-transparent"
                >
                    <option value="">All Severities</option>
                    <option value="critical">Critical</option>
                    <option value="high">High</option>
                    <option value="medium">Medium</option>
                    <option value="low">Low</option>
                </select>

                <!-- Clear Filters -->
                <button
                    v-if="searchQuery || selectedCategory || selectedSeverity"
                    @click="clearFilters"
                    class="px-3 py-2 text-sm text-gray-600 dark:text-gray-400 hover:text-gray-900 dark:hover:text-white border border-gray-300 dark:border-gray-600 rounded-lg hover:bg-gray-50 dark:hover:bg-gray-700 transition-colors whitespace-nowrap"
                >
                    Clear filters
                </button>
            </div>

            <!-- Results count -->
            <p class="text-sm text-gray-500 dark:text-gray-400 mb-4">
                Showing {{ filteredErrors.length }} of
                {{ allErrors.length }} error codes
            </p>

            <!-- Error Cards grouped by category -->
            <div
                v-for="group in groupedErrors"
                :key="group.categoryKey"
                class="mb-8"
            >
                <div class="flex items-center gap-3 mb-4">
                    <span
                        class="inline-block w-3 h-3 rounded-full"
                        :style="{
                            backgroundColor: group.categoryColor,
                        }"
                    ></span>
                    <h2
                        class="text-lg font-semibold text-gray-900 dark:text-white"
                    >
                        {{ group.categoryLabel }}
                    </h2>
                    <span
                        class="text-xs font-medium px-2 py-0.5 rounded-full bg-gray-100 dark:bg-gray-700 text-gray-600 dark:text-gray-400"
                    >
                        {{ group.errors.length }}
                    </span>
                </div>

                <div class="space-y-3">
                    <div
                        v-for="err in group.errors"
                        :key="err.code"
                        class="bg-white dark:bg-gray-800 rounded-lg shadow-sm border border-gray-200 dark:border-gray-700 overflow-hidden transition-all"
                    >
                        <!-- Error Header (always visible) -->
                        <button
                            @click="toggleExpanded(err.code)"
                            class="w-full px-5 py-4 flex items-center gap-4 text-left hover:bg-gray-50 dark:hover:bg-gray-750 transition-colors"
                        >
                            <span :class="severityBadgeClass(err.severity)">
                                {{ err.severity }}
                            </span>
                            <code
                                class="text-sm font-mono font-bold text-primary-600 dark:text-primary-400 whitespace-nowrap"
                                >{{ err.code }}</code
                            >
                            <span
                                class="text-sm font-medium text-gray-900 dark:text-white flex-1 min-w-0 truncate"
                            >
                                {{ err.title }}
                            </span>
                            <span
                                v-if="err.httpStatus"
                                class="text-xs font-mono px-2 py-0.5 rounded bg-gray-100 dark:bg-gray-700 text-gray-500 dark:text-gray-400 whitespace-nowrap"
                            >
                                HTTP {{ err.httpStatus }}
                            </span>
                            <svg
                                class="h-4 w-4 text-gray-400 transition-transform flex-shrink-0"
                                :class="{
                                    'rotate-180':
                                        expandedCodes.has(err.code),
                                }"
                                fill="none"
                                viewBox="0 0 24 24"
                                stroke="currentColor"
                            >
                                <path
                                    stroke-linecap="round"
                                    stroke-linejoin="round"
                                    stroke-width="2"
                                    d="M19 9l-7 7-7-7"
                                />
                            </svg>
                        </button>

                        <!-- Expanded Detail -->
                        <div
                            v-if="expandedCodes.has(err.code)"
                            class="border-t border-gray-200 dark:border-gray-700 px-5 py-5 space-y-5 bg-gray-50/50 dark:bg-gray-800/50"
                        >
                            <!-- Error Message -->
                            <div>
                                <h4
                                    class="text-xs font-semibold uppercase tracking-wider text-gray-500 dark:text-gray-400 mb-1.5"
                                >
                                    Error Message
                                </h4>
                                <code
                                    class="text-sm bg-red-50 dark:bg-red-900/20 text-red-700 dark:text-red-400 px-3 py-1.5 rounded-md inline-block font-mono"
                                    >{{ err.message }}</code
                                >
                            </div>

                            <!-- Description -->
                            <div>
                                <h4
                                    class="text-xs font-semibold uppercase tracking-wider text-gray-500 dark:text-gray-400 mb-1.5"
                                >
                                    Description
                                </h4>
                                <p
                                    class="text-sm text-gray-700 dark:text-gray-300"
                                >
                                    {{ err.description }}
                                </p>
                            </div>

                            <div class="grid grid-cols-1 lg:grid-cols-2 gap-5">
                                <!-- Possible Causes -->
                                <div>
                                    <h4
                                        class="text-xs font-semibold uppercase tracking-wider text-gray-500 dark:text-gray-400 mb-2"
                                    >
                                        Possible Causes
                                    </h4>
                                    <ul class="space-y-1.5">
                                        <li
                                            v-for="(
                                                cause, i
                                            ) in err.possibleCauses"
                                            :key="i"
                                            class="flex items-start gap-2 text-sm text-gray-600 dark:text-gray-400"
                                        >
                                            <svg
                                                class="h-4 w-4 text-orange-400 mt-0.5 flex-shrink-0"
                                                fill="none"
                                                viewBox="0 0 24 24"
                                                stroke="currentColor"
                                            >
                                                <path
                                                    stroke-linecap="round"
                                                    stroke-linejoin="round"
                                                    stroke-width="2"
                                                    d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"
                                                />
                                            </svg>
                                            <span>{{ cause }}</span>
                                        </li>
                                    </ul>
                                </div>

                                <!-- Suggested Fixes -->
                                <div>
                                    <h4
                                        class="text-xs font-semibold uppercase tracking-wider text-gray-500 dark:text-gray-400 mb-2"
                                    >
                                        Suggested Fixes
                                    </h4>
                                    <ul class="space-y-1.5">
                                        <li
                                            v-for="(
                                                fix, i
                                            ) in err.suggestedFixes"
                                            :key="i"
                                            class="flex items-start gap-2 text-sm text-gray-600 dark:text-gray-400"
                                        >
                                            <svg
                                                class="h-4 w-4 text-green-500 mt-0.5 flex-shrink-0"
                                                fill="none"
                                                viewBox="0 0 24 24"
                                                stroke="currentColor"
                                            >
                                                <path
                                                    stroke-linecap="round"
                                                    stroke-linejoin="round"
                                                    stroke-width="2"
                                                    d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z"
                                                />
                                            </svg>
                                            <span>{{ fix }}</span>
                                        </li>
                                    </ul>
                                </div>
                            </div>

                            <!-- Metadata -->
                            <div
                                class="flex flex-wrap gap-4 pt-3 border-t border-gray-200 dark:border-gray-700"
                            >
                                <span
                                    class="text-xs text-gray-500 dark:text-gray-400"
                                >
                                    Internal Code:
                                    <code
                                        class="font-mono text-gray-700 dark:text-gray-300"
                                        >{{
                                            err.internalCode
                                        }}</code
                                    >
                                </span>
                                <span
                                    v-if="err.httpStatus"
                                    class="text-xs text-gray-500 dark:text-gray-400"
                                >
                                    HTTP Status:
                                    <code
                                        class="font-mono text-gray-700 dark:text-gray-300"
                                        >{{ err.httpStatus }}</code
                                    >
                                </span>
                                <span
                                    class="text-xs text-gray-500 dark:text-gray-400"
                                >
                                    Category:
                                    <span
                                        class="text-gray-700 dark:text-gray-300"
                                        >{{
                                            err.category.label
                                        }}</span
                                    >
                                </span>
                            </div>
                        </div>
                    </div>
                </div>
            </div>

            <!-- Empty state -->
            <div
                v-if="filteredErrors.length === 0"
                class="text-center py-16"
            >
                <svg
                    class="mx-auto h-12 w-12 text-gray-400"
                    fill="none"
                    viewBox="0 0 24 24"
                    stroke="currentColor"
                >
                    <path
                        stroke-linecap="round"
                        stroke-linejoin="round"
                        stroke-width="1.5"
                        d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z"
                    />
                </svg>
                <h3
                    class="mt-4 text-sm font-medium text-gray-900 dark:text-white"
                >
                    No matching error codes
                </h3>
                <p class="mt-1 text-sm text-gray-500 dark:text-gray-400">
                    Try adjusting your search or filters
                </p>
            </div>
        </template>
    </div>
</template>

<script setup>
import { ref, computed, onMounted, reactive } from "vue";
import { useRoute } from "vue-router";
import api from "@/services/api";

const route = useRoute();

const loading = ref(true);
const fetchError = ref(null);
const allErrors = ref([]);
const categories = ref([]);
const severitySummary = ref({
    critical: 0,
    high: 0,
    medium: 0,
    low: 0,
    total: 0,
});

const searchQuery = ref("");
const selectedCategory = ref("");
const selectedSeverity = ref("");
const expandedCodes = reactive(new Set());

function toggleExpanded(code) {
    if (expandedCodes.has(code)) {
        expandedCodes.delete(code);
    } else {
        expandedCodes.add(code);
    }
}

function clearFilters() {
    searchQuery.value = "";
    selectedCategory.value = "";
    selectedSeverity.value = "";
}

function severityBadgeClass(severity) {
    const base =
        "inline-flex items-center px-2 py-0.5 rounded text-xs font-semibold uppercase tracking-wider whitespace-nowrap";
    switch (severity) {
        case "critical":
            return `${base} bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-400`;
        case "high":
            return `${base} bg-orange-100 text-orange-800 dark:bg-orange-900/30 dark:text-orange-400`;
        case "medium":
            return `${base} bg-yellow-100 text-yellow-800 dark:bg-yellow-900/30 dark:text-yellow-400`;
        case "low":
            return `${base} bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-400`;
        default:
            return `${base} bg-gray-100 text-gray-800 dark:bg-gray-700 dark:text-gray-400`;
    }
}

const filteredErrors = computed(() => {
    let errors = [...allErrors.value];

    if (selectedCategory.value) {
        errors = errors.filter(
            (e) => e.category.key === selectedCategory.value
        );
    }

    if (selectedSeverity.value) {
        errors = errors.filter((e) => e.severity === selectedSeverity.value);
    }

    if (searchQuery.value) {
        const q = searchQuery.value.toLowerCase();
        errors = errors.filter(
            (e) =>
                e.code.toLowerCase().includes(q) ||
                e.title.toLowerCase().includes(q) ||
                e.message.toLowerCase().includes(q) ||
                e.description.toLowerCase().includes(q) ||
                e.internalCode.toLowerCase().includes(q)
        );
    }

    return errors;
});

const groupedErrors = computed(() => {
    const groups = {};
    for (const err of filteredErrors.value) {
        const key = err.category.key;
        if (!groups[key]) {
            groups[key] = {
                categoryKey: key,
                categoryLabel: err.category.label,
                categoryColor: err.category.color,
                errors: [],
            };
        }
        groups[key].errors.push(err);
    }

    const severityOrder = { critical: 0, high: 1, medium: 2, low: 3 };
    for (const group of Object.values(groups)) {
        group.errors.sort(
            (a, b) =>
                (severityOrder[a.severity] ?? 4) -
                (severityOrder[b.severity] ?? 4)
        );
    }

    return Object.values(groups);
});

async function loadCatalog() {
    loading.value = true;
    fetchError.value = null;
    try {
        const { data } = await api.get("/admin/error-catalog");
        allErrors.value = data.errors;
        categories.value = data.categories;
        severitySummary.value = data.severitySummary;
    } catch (err) {
        const msg = err.response?.data?.error || err.response?.data?.message || err.message;
        const status = err.response?.status;
        fetchError.value = status
            ? `${msg || "Request failed"} (HTTP ${status})`
            : msg || "Failed to load error catalog. The API may not be available.";
    } finally {
        loading.value = false;
    }
}

onMounted(async () => {
    await loadCatalog();
    if (route.query.search) {
        searchQuery.value = route.query.search;
        const match = allErrors.value.find(
            (e) => e.code === route.query.search
        );
        if (match) {
            expandedCodes.add(match.code);
        }
    }
});
</script>
