'use strict';

const crypto = require('crypto');
const { v4: uuidv4 } = require('uuid');
const db = require('../../config/database');
const logger = require('../../utils/logger');
const dataServiceProxy = require('../../services/dataServiceProxy');

const ALLOWED_EVENTS = new Set(['ELITE_SETUP', 'SIGNAL_BULL', 'SIGNAL_BEAR', 'TFC_ALIGN', 'EXIT_SIGNAL']);

/** Router never requires COMPLETE/PARTIAL for these — avoid slow data-service calls (TradingView ~3s timeout). */
const GOLF_MEDIC_NO_MARKET_ENRICHMENT = new Set(['TFC_ALIGN', 'EXIT_SIGNAL']);
const SYMBOL_ALLOWLIST = new Set(
  (process.env.GOLF_MEDIC_SYMBOL_ALLOWLIST || 'SPY,QQQ,IWM')
    .split(',')
    .map((s) => s.trim().toUpperCase())
    .filter(Boolean),
);

function getExpectedSecret() {
  return process.env.GOLF_MEDIC_WEBHOOK_SECRET || '';
}

function secretsMatch(provided, expected) {
  if (typeof provided !== 'string' || typeof expected !== 'string' || !expected.length) return false;
  try {
    const a = Buffer.from(provided, 'utf8');
    const b = Buffer.from(expected, 'utf8');
    if (a.length !== b.length) return false;
    return crypto.timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

function validateWebhookSecret(pathSecret, headerSecret) {
  const expected = String(getExpectedSecret() || '').trim();
  if (!expected) return { ok: true };
  const header = typeof headerSecret === 'string' ? headerSecret.trim() : '';
  const path = typeof pathSecret === 'string' ? pathSecret.trim() : '';
  if (secretsMatch(path, expected) || secretsMatch(header, expected)) return { ok: true };
  return { ok: false, reason: 'mismatch' };
}

function timeframeToMs(tf) {
  const s = String(tf == null ? '5' : tf).trim().toUpperCase();
  if (s === 'D' || s === '1D' || s === 'DAY') return 86400000;
  if (s === 'W' || s === '1W') return 7 * 86400000;
  const n = parseInt(s, 10);
  if (!Number.isFinite(n) || n <= 0) return 5 * 60 * 1000;
  return n * 60 * 1000;
}

function normalizeTimestampMs(ts) {
  const n = Number(ts);
  if (!Number.isFinite(n)) return null;
  return n < 1e12 ? Math.round(n * 1000) : Math.round(n);
}

function computeBarBucket(timestamp, tf) {
  const ms = normalizeTimestampMs(timestamp);
  if (ms == null) return 0;
  const tfMs = timeframeToMs(tf);
  if (tfMs <= 0) return 0;
  return Math.floor(ms / tfMs);
}

function linkageKey(payload) {
  const combo = payload.strat?.combo ?? '';
  const pivot = payload.nearest_pivot ?? '';
  return [String(payload.symbol || '').toUpperCase(), String(payload.timeframe ?? ''), payload.direction, combo, pivot]
    .join('|');
}

function canonicalSignalSubset(payload) {
  return {
    event: payload.event ?? null,
    grade: payload.grade ?? null,
    direction: payload.direction ?? null,
    symbol: payload.symbol ?? null,
    timeframe: payload.timeframe ?? null,
    timestamp: payload.timestamp ?? null,
    bar_time: payload.bar_time ?? null,
    strat: payload.strat
      ? {
          combo: payload.strat.combo ?? null,
          bar: payload.strat.bar ?? null,
          prev: payload.strat.prev ?? null,
          prev2: payload.strat.prev2 ?? null,
        }
      : null,
    nearest_pivot: payload.nearest_pivot ?? null,
    at_pivot: payload.at_pivot ?? null,
  };
}

function computeSignalHash(payload) {
  const stable = JSON.stringify(canonicalSignalSubset(payload));
  return crypto.createHash('sha256').update(stable, 'utf8').digest('hex');
}

function computeDedupeKey(payload, barBucket) {
  const symbol = String(payload.symbol || '').toUpperCase();
  const tf = String(payload.timeframe ?? '');
  const ev = String(payload.event || '').toUpperCase();
  const grade = String(payload.grade ?? '');
  const dir = String(payload.direction ?? '');
  const raw = [symbol, tf, ev, grade, dir, String(barBucket)].join('|');
  const h = crypto.createHash('sha256').update(raw, 'utf8').digest('hex').substring(0, 40);
  return `gm:${h}`;
}

function validateGolfMedicBody(body) {
  if (!body || typeof body !== 'object') return 'Payload must be a JSON object';
  const symbol = body.symbol;
  if (!symbol || typeof symbol !== 'string') return 'Missing symbol';
  const ev = String(body.event || '').toUpperCase();
  if (!ALLOWED_EVENTS.has(ev)) return `Invalid or unsupported event: ${body.event}`;
  if (body.grade == null || body.grade === '') return 'Missing grade';
  if (body.direction == null || body.direction === '') return 'Missing direction';
  if (body.timestamp == null || body.timestamp === '') return 'Missing timestamp';
  return null;
}

function unwrapProvider(res) {
  if (!res || typeof res !== 'object') return null;
  if (Object.prototype.hasOwnProperty.call(res, 'data')) return res.data;
  return res;
}

function quoteValid(q) {
  if (!q || typeof q !== 'object') return false;
  const p = q.price ?? q.last;
  return typeof p === 'number' && Number.isFinite(p);
}

function chainValid(c) {
  if (!c || typeof c !== 'object') return false;
  return Array.isArray(c.contracts) && c.contracts.length > 0;
}

function summarizeChainForStorage(chain, maxContracts = 80) {
  if (!chain || !Array.isArray(chain.contracts)) return null;
  return {
    symbol: chain.symbol,
    expirations: chain.expirations,
    contractCount: chain.contracts.length,
    timestamp: chain.timestamp,
    contracts: chain.contracts.slice(0, maxContracts),
    truncated: chain.contracts.length > maxContracts,
  };
}

function spreadFromQuote(q) {
  if (!q) return null;
  const bid = q.bid;
  const ask = q.ask;
  const price = q.price ?? q.last;
  if (typeof bid !== 'number' || typeof ask !== 'number' || !Number.isFinite(bid) || !Number.isFinite(ask)) {
    return null;
  }
  const abs = ask - bid;
  const mid = (bid + ask) / 2;
  const pct = mid > 0 ? abs / mid : null;
  return { bid, ask, abs, spread_pct: pct };
}

/**
 * Fail-closed: missing quote OR options chain → BLOCKED.
 * PARTIAL: quote + chain OK but some ancillary fetches failed.
 * COMPLETE: quote + chain + all ancillary succeeded.
 */
async function runEnrichment(symbol) {
  const missing = [];
  let quoteRes = null;
  let chainRes = null;
  let ivRes = null;
  let gexRes = null;
  let flowRes = null;
  let vixRes = null;
  let regimeRes = null;
  let volRegimeRes = null;

  try {
    quoteRes = await dataServiceProxy.getQuote(symbol);
  } catch (e) {
    logger.warn(`[GolfMedic] quote failed ${symbol}: ${e.message}`, 'golfmedic');
    missing.push('quote');
  }

  try {
    chainRes = await dataServiceProxy.getOptionsChain(symbol);
  } catch (e) {
    logger.warn(`[GolfMedic] options chain failed ${symbol}: ${e.message}`, 'golfmedic');
    missing.push('options_chain');
  }

  try {
    ivRes = await dataServiceProxy.getIV(symbol);
  } catch {
    missing.push('iv');
  }

  try {
    gexRes = await dataServiceProxy.getGEX(symbol);
  } catch {
    missing.push('gex');
  }

  try {
    flowRes = await dataServiceProxy.getFlow(symbol);
  } catch {
    missing.push('flow');
  }

  try {
    vixRes = await dataServiceProxy.getVIX();
  } catch {
    missing.push('vix');
  }

  try {
    regimeRes = await dataServiceProxy.getRegime();
  } catch {
    missing.push('regime');
  }

  try {
    volRegimeRes = await dataServiceProxy.getVolatilityRegime(symbol);
  } catch {
    missing.push('volatility_regime');
  }

  const quote = unwrapProvider(quoteRes);
  const chain = unwrapProvider(chainRes);

  const qOk = quoteValid(quote);
  const cOk = chainValid(chain);

    if (!qOk || !cOk) {
    return {
      enrichment_status: 'BLOCKED',
      enrichment: {
        reason: 'missing_quote_or_chain',
        missing,
        quote: qOk ? quote : null,
        options: cOk ? summarizeChainForStorage(chain) : null,
        iv: unwrapProvider(ivRes),
        gex: unwrapProvider(gexRes),
        flow: unwrapProvider(flowRes),
        vix: unwrapProvider(vixRes),
        regime: unwrapProvider(regimeRes),
        volatility_regime: unwrapProvider(volRegimeRes),
        execution: {
          spread: spreadFromQuote(quote),
        },
      },
    };
  }

  const ancillaryMiss = missing.filter((m) => m !== 'quote' && m !== 'options_chain');
  const status = ancillaryMiss.length === 0 ? 'COMPLETE' : 'PARTIAL';

  return {
    enrichment_status: status,
    enrichment: {
      reason: status === 'PARTIAL' ? 'partial_ancillary' : undefined,
      missing: ancillaryMiss.length ? ancillaryMiss : undefined,
      quote,
      options: summarizeChainForStorage(chain),
      iv: unwrapProvider(ivRes),
      gex: unwrapProvider(gexRes),
      flow: unwrapProvider(flowRes),
      vix: unwrapProvider(vixRes),
      regime: unwrapProvider(regimeRes),
      volatility_regime: unwrapProvider(volRegimeRes),
      execution: {
        spread: spreadFromQuote(quote),
      },
    },
  };
}

/**
 * Allowlist + event-aware enrichment: TFC_ALIGN / EXIT_SIGNAL skip data-service (fast webhook ACK).
 */
async function resolveGolfMedicEnrichment(rawPayload, symbolUpper) {
  if (!SYMBOL_ALLOWLIST.has(symbolUpper)) {
    return {
      enrichment_status: 'BLOCKED',
      enrichment: {
        reason: 'symbol_not_allowlisted',
        symbol: symbolUpper,
        allowlist: [...SYMBOL_ALLOWLIST],
      },
    };
  }
  const ev = String(rawPayload.event || '').toUpperCase();
  if (GOLF_MEDIC_NO_MARKET_ENRICHMENT.has(ev)) {
    return {
      enrichment_status: 'SKIPPED',
      enrichment: {
        reason: 'no_market_snapshot_required',
        event: ev,
      },
    };
  }
  const enriched = await runEnrichment(symbolUpper);
  return {
    enrichment_status: enriched.enrichment_status,
    enrichment: enriched.enrichment,
  };
}

/**
 * Build enrichment + provider_context for POST /tradingview GolfMedic rows
 * (same quote/chain policy as POST /golfmedic).
 */
async function enrichPayloadForTradingView(rawPayload, webhookEventId) {
  const symbolUpper = String(rawPayload.symbol || '').toUpperCase();
  const barBucket = computeBarBucket(rawPayload.timestamp, rawPayload.timeframe);
  const signalHash = computeSignalHash(rawPayload);
  const ingestTimestamp = new Date().toISOString();
  const provider_context = {
    internal_signal_id: webhookEventId,
    signal_hash: signalHash,
    bar_bucket: barBucket,
    linkage_key: linkageKey({ ...rawPayload, symbol: symbolUpper }),
    ingest_timestamp: ingestTimestamp,
    ingest_path: 'tradingview',
    normalized: {
      event: String(rawPayload.event || '').toUpperCase(),
      grade: rawPayload.grade,
      direction: rawPayload.direction,
    },
  };

  const { enrichment_status, enrichment } = await resolveGolfMedicEnrichment(rawPayload, symbolUpper);

  return { enrichment_status, enrichment, provider_context };
}

async function resolveUserId() {
  let userId = process.env.SIM_DEFAULT_USER_ID;
  if (!userId && process.env.NODE_ENV !== 'production') {
    const { rows } = await db.query('SELECT id FROM users ORDER BY created_at ASC LIMIT 1');
    userId = rows[0]?.id;
  }
  return userId || null;
}

class GolfMedicService {
  validateWebhookSecret(pathSecret, headerSecret) {
    return validateWebhookSecret(pathSecret, headerSecret);
  }

  /**
   * @param {Object} rawPayload
   * @param {Object} opts
   * @param {string|null} opts.clientIP
   * @param {string} opts.userAgent
   * @returns {Promise<Object>}
   */
  async ingest(rawPayload, opts = {}) {
    const { clientIP = null, userAgent = 'unknown' } = opts;
    const err = validateGolfMedicBody(rawPayload);
    if (err) {
      const e = new Error(err);
      e.status = 400;
      throw e;
    }

    const symbolUpper = String(rawPayload.symbol).toUpperCase();
    const barBucket = computeBarBucket(rawPayload.timestamp, rawPayload.timeframe);
    const signalHash = computeSignalHash(rawPayload);
    const dedupeKey = computeDedupeKey(rawPayload, barBucket);
    const link = linkageKey({ ...rawPayload, symbol: symbolUpper });
    const ingestTimestamp = new Date().toISOString();
    const id = uuidv4();
    const userId = await resolveUserId();

    const provider_context = {
      internal_signal_id: id,
      signal_hash: signalHash,
      bar_bucket: barBucket,
      linkage_key: link,
      ingest_timestamp: ingestTimestamp,
      normalized: {
        event: String(rawPayload.event).toUpperCase(),
        grade: rawPayload.grade,
        direction: rawPayload.direction,
      },
    };

    const { enrichment_status, enrichment } = await resolveGolfMedicEnrichment(rawPayload, symbolUpper);

    const result = await db.query(
      `INSERT INTO webhook_events (
        id, source, indicator_source, raw_payload, signature_valid, dedupe_key, status,
        error_message, user_id, client_ip, user_agent,
        enrichment_status, enrichment, provider_context
      ) VALUES (
        $1, 'golfmedic', 'GOLF_MEDIC', $2, true, $3, 'RECEIVED', NULL, $4, $5, $6,
        $7, $8::jsonb, $9::jsonb
      )
      ON CONFLICT (dedupe_key) DO NOTHING
      RETURNING id, enrichment_status, provider_context`,
      [
        id,
        JSON.stringify(rawPayload),
        dedupeKey,
        userId,
        clientIP,
        userAgent,
        enrichment_status,
        JSON.stringify(enrichment),
        JSON.stringify(provider_context),
      ],
    );

    if (result.rows.length === 0) {
      const existing = await db.query(
        `SELECT id, enrichment_status, provider_context, dedupe_key, enrichment FROM webhook_events WHERE dedupe_key = $1`,
        [dedupeKey],
      );
      const row = existing.rows[0];
      const enr = row.enrichment && typeof row.enrichment === 'object' ? row.enrichment : {};
      logger.info(`[GolfMedic] duplicate ignored dedupe=${dedupeKey}`, 'golfmedic');
      return {
        status: 'accepted',
        is_duplicate: true,
        internal_signal_id: row.id,
        enrichment_status: row.enrichment_status || 'UNKNOWN',
        signal_hash: row.provider_context?.signal_hash,
        bar_bucket: row.provider_context?.bar_bucket,
        linkage_key: row.provider_context?.linkage_key,
        dedupe_key: row.dedupe_key,
        ...(enr.reason ? { reason: enr.reason } : {}),
      };
    }

    logger.info(
      `[GolfMedic] stored ${id} ${symbolUpper} ${provider_context.normalized.event} enrichment=${enrichment_status}`,
      'golfmedic',
    );

    return {
      status: 'accepted',
      is_duplicate: false,
      internal_signal_id: id,
      enrichment_status,
      signal_hash: signalHash,
      bar_bucket: barBucket,
      linkage_key: link,
      dedupe_key: dedupeKey,
      ...(enrichment.reason ? { reason: enrichment.reason } : {}),
    };
  }
}

const golfMedicServiceInstance = new GolfMedicService();
module.exports = golfMedicServiceInstance;
module.exports.enrichPayloadForTradingView = enrichPayloadForTradingView;
