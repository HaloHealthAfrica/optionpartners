# Webhook Pipeline Observatory — Design & Implementation

End-to-end visibility into webhook ingestion, processing, and eventual trade execution for troubleshooting and diagnostics.

---

## 1. Pipeline Stages

| Stage | Component | Data Touched |
|-------|-----------|--------------|
| **Ingestion** | webhook.controller → webhook.service.ingest() | raw payload, dedupe, validation |
| **Validation** | webhook.validator | timestamp, payload structure, signature |
| **Source detection** | indicator-detector | indicator_source (SIGNALS, STRAT, MTF_BIAS, etc.) |
| **Symbol state update** | symbol-state.service | MTF_BIAS, TREND, OPTIONS_FLOW, etc. |
| **Decision router** | decision-router.evaluate() | guards, conviction, approval |
| **Options construction** | options-constructor.service | strike, DTE, contract type |
| **Executor** | executor.simulateOrder() | order, fill, position |
| **Finalizer** | trade-finalizer | sim_trade, PnL |

---

## 2. High & Medium Priority Items (Implemented)

### High Priority
- **Processor status** — Running/stopped, processed count, last cycle
- **Kill switch + max positions** — Account gates that block all trades
- **Rate limiting visibility** — Current limits, throttled sources, rejections

### Medium Priority
- **Connectivity gate status** — Data-service HEALTHY/DEGRADED/UNHEALTHY
- **Retry / dead-letter** — Retry count, exhausted retries, dead-letter eligible
- **Symbol state freshness** — macro_updated_at age per symbol

---

## 3. UI Sections

### A. Pipeline Overview Dashboard
- Flow diagram: Ingest → Validate → Route → Decide → Execute → Trade
- Stage health: RECEIVED, PROCESSED, REJECTED counts
- Queue health: pending, stuck, oldest pending

### B. System Gates Panel
- Processor: Running / Stopped
- Kill switch: Active / Inactive
- Max positions: Open / Max
- Connectivity gate: HEALTHY / DEGRADED / UNHEALTHY

### C. Rate Limiting Panel
- Current rate limit status (IP, API key)
- Recent rejections due to rate limit

### D. Retry & Dead Letter Panel
- Retryable rejections (retry_count < 3)
- Exhausted retries (retry_count >= 3)
- Dead letter count (if status supported)

### E. Symbol State Freshness
- Per-symbol macro_updated_at age
- Stale symbols (>2h)

### F. Processing Metrics
- Latency by stage (decision_router, executor, finalizer)
- Success rates, error breakdown

### G. Event Trace (Single Webhook)
- Raw payload, processing stages, orders, positions, trades
- Link from Webhook Inbox

---

## 4. API Endpoints

| Endpoint | Purpose |
|----------|---------|
| GET /api/sim/pipeline-observatory | Aggregated observatory data |
| GET /api/webhooks/processing-metrics | Processing latency, queue health |
| GET /api/webhooks/source-metrics | Rate limiting |
| GET /api/sim/status | Processor, kill switch |
| GET /api/sim/positions | Open positions count |

---

## 5. Data Gaps (Future)

- Per-event enrichment tracking (which data-service calls ran)
- Provider used (data-service load balancer)
- Export trace as JSON
