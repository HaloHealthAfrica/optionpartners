# Task 11 – Webhook Error Handling & Recovery

**Goal:** Strengthen the ingestion/processing pipeline so that transient failures do not silently drop signals and lead to stuck events. Provide operators with tools to requeue failed webhooks and implement exponential backoff to avoid tight retry loops.

## Changes made

1. **Exponential backoff for automatic retries**
   * `webhookService.getPending()` now calculates a delay based on `retry_count`:
     - 30 s × 2^retry_count (capped at 64‑factor) before an event becomes eligible again.
     - This prevents busy‑looping on an impossible-to-process payload during outages.
   * Added explanatory comments in the SQL query.

2. **Logging enhancements**
   * `webhookService.markForRetry()` logs when an event is requeued or when it cannot be retried.
   * Controller catch blocks now differentiate transient/database errors with a 503 response.

3. **Manual retry endpoint**
   * `POST /api/webhooks/:id/retry` (authenticated) allows admins/users to push a rejected event back into the queue.
   * Controller method `retryWebhook` returns 404/400/500 as appropriate and logs failures.

4. **Controller robustness**
   * `receiveTradingViewWebhook()` distinguishes transient errors (connect/timeouts/database) and signals them with HTTP 503 so callers can retry later.
   * Added tests around this behavior.

5. **Extensive unit tests**
   * New service tests verify backoff query composition, retry eligibility logic, and dead‑letter escalation handling.
   * Controller tests cover manual retry endpoint and error classification.
   * Existing webhook tests remain unaffected.

## Testing & results

```
npm test -- src/__tests__/webhooks/webhook.service.test.js \
          src/__tests__/webhooks/webhook.controller.test.js
```

All 18 new/updated tests pass (service + controller, plus existing indicator/normalizer specs).

## Operational impact

- Failed webhook events due to processing errors will automatically retry with increasing delay and stop after three attempts.
- Events that exhaust retries are moved to `DEAD_LETTER` with Sentry warning alerts.
- Operators can inspect and manually requeue events via the new API or UI.
- Transient database/connectivity issues in ingestion return 503, enabling upstream backoff.

This task completes the webhook error recovery improvements. Ready to proceed to the next task.
