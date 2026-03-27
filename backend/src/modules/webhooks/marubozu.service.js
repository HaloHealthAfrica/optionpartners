'use strict';

const crypto = require('crypto');
const { v4: uuidv4 } = require('uuid');
const db = require('../../config/database');
const logger = require('../../utils/logger');
const dataServiceProxy = require('../../services/dataServiceProxy');

const SYMBOL_ALLOWLIST = new Set(
  (process.env.MARUBOZU_SYMBOL_ALLOWLIST || 'SPY,QQQ,IWM')
    .split(',')
    .map((s) => s.trim().toUpperCase())
    .filter(Boolean),
);

function getExpectedSecret() {
  return process.env.MARUBOZU_WEBHOOK_SECRET || '';
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
 * Fail-closed on quote+chain (same policy as GolfMedic).
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
    logger.warn(`[Marubozu] quote failed ${symbol}: ${e.message}`, 'marubozu');
    missing.push('quote');
  }

  try {
    chainRes = await dataServiceProxy.getOptionsChain(symbol);
  } catch (e) {
    logger.warn(`[Marubozu] options chain failed ${symbol}: ${e.message}`, 'marubozu');
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
        execution: { spread: spreadFromQuote(quote) },
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
      execution: { spread: spreadFromQuote(quote) },
    },
    _chainRaw: chain,
    _quoteRaw: quote,
  };
}

/**
 * Near-ATM leg in a DTE band (defaults 20–45).
 */
function pickAdvisoryOptionFromChain(chain, underlyingPrice, callOrPut, dteMin, dteMax) {
  if (!chain || !Array.isArray(chain.contracts) || chain.contracts.length === 0) return null;
  if (!underlyingPrice || !Number.isFinite(underlyingPrice)) return null;
  const right = String(callOrPut).toLowerCase();
  const now = Date.now();
  const exps =
    chain.expirations && chain.expirations.length
      ? [...chain.expirations]
      : [...new Set(chain.contracts.map((c) => c.expiration))];
  const scored = exps
    .map((exp) => {
      const expMs = new Date(`${exp}T17:00:00`).getTime();
      const dte = Math.ceil((expMs - now) / 86400000);
      return { exp, dte };
    })
    .filter((e) => e.dte >= dteMin && e.dte <= dteMax);
  if (scored.length === 0) return null;
  const midTarget = Math.round((dteMin + dteMax) / 2);
  scored.sort((a, b) => Math.abs(a.dte - midTarget) - Math.abs(b.dte - midTarget));
  const chosen = scored[0].exp;
  const dteChosen = scored[0].dte;
  const contracts = chain.contracts.filter((c) => c.expiration === chosen && c.type === right);
  if (contracts.length === 0) return null;
  let best = contracts[0];
  let bestDist = Math.abs(Number(contracts[0].strike) - underlyingPrice);
  for (const c of contracts) {
    const d = Math.abs(Number(c.strike) - underlyingPrice);
    if (d < bestDist) {
      bestDist = d;
      best = c;
    }
  }
  return { strike: Number(best.strike), expiration: chosen, dte: dteChosen };
}

function validateSignalBatchBody(body) {
  if (!body || typeof body !== 'object') return 'Payload must be a JSON object';
  if (String(body.event || '').toUpperCase() !== 'SIGNAL_BATCH') return 'event must be SIGNAL_BATCH';
  if (!body.strategy || typeof body.strategy !== 'string') return 'Missing strategy';
  if (body.timestamp == null || body.timestamp === '') return 'Missing timestamp';
  if (!Array.isArray(body.signals) || body.signals.length === 0) return 'signals must be a non-empty array';
  return null;
}

function confidenceToEngineScore(conf) {
  const c = Math.min(1, Math.max(0, Number(conf)));
  if (!Number.isFinite(c)) return 40;
  if (c < 0.7) return 40;
  return Math.round(40 + ((c - 0.7) / 0.3) * 55);
}

function tierForSignal(sig) {
  const conf = Number(sig.confidence);
  const bias = Number(sig.context?.bias);
  const mar = Number(sig.context?.marubozu);
  const absBias = Number.isFinite(bias) ? Math.abs(bias) : 0;
  const isA =
    conf >= 0.8 &&
    absBias >= 0.7 &&
    Number.isFinite(mar) &&
    mar >= 1.5;
  return isA ? 'A' : 'B';
}

function passesIngestFilters(sig, maxRank, minConf, minAbsBias, minMarubozu) {
  const rank = parseInt(sig.rank, 10);
  if (!Number.isFinite(rank) || rank < 1 || rank > maxRank) return false;
  const conf = Number(sig.confidence);
  if (!Number.isFinite(conf) || conf < minConf) return false;
  const bias = Number(sig.context?.bias);
  if (!Number.isFinite(bias) || Math.abs(bias) < minAbsBias) return false;
  if (minMarubozu > 0) {
    const mar = Number(sig.context?.marubozu);
    if (!Number.isFinite(mar) || mar < minMarubozu) return false;
  }
  return true;
}

async function resolveUserId() {
  let userId = process.env.SIM_DEFAULT_USER_ID;
  if (!userId && process.env.NODE_ENV !== 'production') {
    const { rows } = await db.query('SELECT id FROM users ORDER BY created_at ASC LIMIT 1');
    userId = rows[0]?.id;
  }
  return userId || null;
}

/** True when payload is a Marubozu-style batch (same shape ingested via /tradingview or /marubozu). */
function isSignalBatchPayload(body) {
  if (!body || typeof body !== 'object') return false;
  return String(body.event || '').toUpperCase() === 'SIGNAL_BATCH' && Array.isArray(body.signals);
}

class MarubozuService {
  validateWebhookSecret(pathSecret, headerSecret) {
    return validateWebhookSecret(pathSecret, headerSecret);
  }

  /**
   * Ingest SIGNAL_BATCH → fan-out to one webhook_events row per eligible signal.
   * @returns {Promise<{ status: string, batch_ingest_id: string, results: Array }>}
   */
  async ingest(rawPayload, opts = {}) {
    const { clientIP = null, userAgent = 'unknown' } = opts;
    const err = validateSignalBatchBody(rawPayload);
    if (err) {
      const e = new Error(err);
      e.status = 400;
      throw e;
    }

    const maxRank = Math.min(3, Math.max(1, parseInt(process.env.MARUBOZU_MAX_RANK || '1', 10)));
    const minConf = parseFloat(process.env.MARUBOZU_MIN_CONFIDENCE || '0.7');
    const minAbsBias = parseFloat(process.env.MARUBOZU_MIN_BIAS_ABS || '0.6');
    const minMarubozu = parseFloat(process.env.MARUBOZU_MIN_MARUBOZU || '0');
    const dteMin = parseInt(process.env.MARUBOZU_DTE_MIN || '20', 10);
    const dteMax = parseInt(process.env.MARUBOZU_DTE_MAX || '45', 10);

    let userId = opts.userId;
    if (userId == null || userId === '') {
      userId = await resolveUserId();
    }
    const batchIngestId = uuidv4();
    const ingestTimestamp = new Date().toISOString();

    const sorted = [...rawPayload.signals].sort((a, b) => (parseInt(a.rank, 10) || 99) - (parseInt(b.rank, 10) || 99));
    const results = [];

    for (const sig of sorted) {
      const symbolUpper = String(sig.symbol || '').toUpperCase();
      if (!symbolUpper) {
        results.push({ symbol: null, signal_id: sig.signal_id, skipped: true, reason: 'missing_symbol' });
        continue;
      }
      if (!passesIngestFilters(sig, maxRank, minConf, minAbsBias, minMarubozu)) {
        results.push({ symbol: symbolUpper, signal_id: sig.signal_id, skipped: true, reason: 'filter' });
        continue;
      }

      const dedupeKey = `mz:${String(sig.signal_id || '').trim()}`;
      if (!dedupeKey || dedupeKey === 'mz:') {
        results.push({ symbol: symbolUpper, skipped: true, reason: 'missing_signal_id' });
        continue;
      }

      if (!SYMBOL_ALLOWLIST.has(symbolUpper)) {
        const id = uuidv4();
        const provider_context = {
          batch_ingest_id: batchIngestId,
          signal_id: sig.signal_id,
          rank: sig.rank,
          ingest_timestamp: ingestTimestamp,
          normalized: { event: 'SIGNAL_BATCH', strategy: rawPayload.strategy },
        };
        const enrichment_status = 'BLOCKED';
        const enrichment = {
          reason: 'symbol_not_allowlisted',
          symbol: symbolUpper,
          allowlist: [...SYMBOL_ALLOWLIST],
        };
        const flat = buildFlattenedPayload(rawPayload, sig, symbolUpper, null, tierForSignal(sig));
        const ins = await db.query(
          `INSERT INTO webhook_events (
            id, source, indicator_source, raw_payload, signature_valid, dedupe_key, status,
            error_message, user_id, client_ip, user_agent,
            enrichment_status, enrichment, provider_context
          ) VALUES (
            $1, 'marubozu', 'MARUBOZU', $2, true, $3, 'RECEIVED', NULL, $4, $5, $6,
            $7, $8::jsonb, $9::jsonb
          )
          ON CONFLICT (dedupe_key) DO NOTHING
          RETURNING id, enrichment_status`,
          [
            id,
            JSON.stringify(flat),
            dedupeKey,
            userId,
            clientIP,
            userAgent,
            enrichment_status,
            JSON.stringify(enrichment),
            JSON.stringify(provider_context),
          ],
        );
        if (ins.rows.length === 0) {
          results.push(await duplicateResult(dedupeKey));
        } else {
          results.push({
            internal_signal_id: id,
            symbol: symbolUpper,
            signal_id: sig.signal_id,
            enrichment_status,
            is_duplicate: false,
          });
        }
        continue;
      }

      const enriched = await runEnrichment(symbolUpper);
      let { enrichment_status, enrichment } = enriched;
      let strikePick = null;
      const quote = enriched._quoteRaw;
      const chain = enriched._chainRaw;
      const refPx = quote ? Number(quote.price ?? quote.last) : null;
      const entryPx = sig.entry?.price != null ? Number(sig.entry.price) : null;
      const underlyingRef =
        refPx != null && Number.isFinite(refPx)
          ? refPx
          : entryPx != null && Number.isFinite(entryPx)
            ? entryPx
            : null;

      const dirU = String(sig.direction || '').toUpperCase();
      const optRight = dirU === 'PUT' ? 'put' : 'call';

      if (enrichment_status !== 'BLOCKED' && chain && underlyingRef != null) {
        strikePick = pickAdvisoryOptionFromChain(chain, underlyingRef, optRight, dteMin, dteMax);
      }

      if (enrichment_status !== 'BLOCKED' && !strikePick) {
        enrichment_status = 'BLOCKED';
        const prev = typeof enrichment === 'object' && enrichment ? enrichment : {};
        enrichment = {
          ...prev,
          reason: 'strike_pick_failed',
          dte_band: [dteMin, dteMax],
          underlying_ref: underlyingRef,
        };
      }

      delete enriched._chainRaw;
      delete enriched._quoteRaw;

      const tier = tierForSignal(sig);
      const flat = buildFlattenedPayload(rawPayload, sig, symbolUpper, strikePick, tier);

      const id = uuidv4();
      const provider_context = {
        batch_ingest_id: batchIngestId,
        signal_id: sig.signal_id,
        rank: sig.rank,
        tier,
        strike_pick: strikePick,
        ingest_timestamp: ingestTimestamp,
        engine_conviction: confidenceToEngineScore(sig.confidence),
        normalized: {
          strategy: rawPayload.strategy,
          timeframe: rawPayload.timeframe,
          direction: dirU,
        },
      };

      const ins = await db.query(
        `INSERT INTO webhook_events (
          id, source, indicator_source, raw_payload, signature_valid, dedupe_key, status,
          error_message, user_id, client_ip, user_agent,
          enrichment_status, enrichment, provider_context
        ) VALUES (
          $1, 'marubozu', 'MARUBOZU', $2, true, $3, 'RECEIVED', NULL, $4, $5, $6,
          $7, $8::jsonb, $9::jsonb
        )
        ON CONFLICT (dedupe_key) DO NOTHING
        RETURNING id, enrichment_status`,
        [
          id,
          JSON.stringify(flat),
          dedupeKey,
          userId,
          clientIP,
          userAgent,
          enrichment_status,
          JSON.stringify(enrichment),
          JSON.stringify(provider_context),
        ],
      );

      if (ins.rows.length === 0) {
        results.push(await duplicateResult(dedupeKey));
      } else {
        logger.info(
          `[Marubozu] stored ${id} ${symbolUpper} rank=${sig.rank} enrichment=${enrichment_status} tier=${tier}`,
          'marubozu',
        );
        results.push({
          internal_signal_id: id,
          symbol: symbolUpper,
          signal_id: sig.signal_id,
          enrichment_status,
          is_duplicate: false,
          tier,
        });
      }
    }

    return { status: 'accepted', batch_ingest_id: batchIngestId, results };
  }
}

function buildFlattenedPayload(batch, sig, symbolUpper, strikePick, tierLabel) {
  const dirU = String(sig.direction || '').toUpperCase();
  const stratName = tierLabel === 'A' ? 'marubozu_a' : 'marubozu_b';
  return {
    event: 'MARUBOZU_ENTRY',
    strategy: stratName,
    timeframe: batch.timeframe ?? null,
    timestamp: batch.timestamp ?? null,
    batch_strategy: batch.strategy,
    symbol: symbolUpper,
    direction: dirU,
    confidence: sig.confidence,
    entry: sig.entry,
    risk: sig.risk,
    context: sig.context,
    signal_id: sig.signal_id,
    rank: sig.rank,
    tier: tierLabel,
    option_type: dirU === 'PUT' ? 'put' : 'call',
    strike: strikePick ? strikePick.strike : null,
    expiration: strikePick ? strikePick.expiration : null,
    dte_suggestion: strikePick ? strikePick.dte : null,
  };
}

/**
 * Single MARUBOZU_ENTRY via POST /tradingview — same enrichment + strike pick as batch fan-out.
 */
async function enrichSingleEntryForTradingView(rawPayload, webhookEventId) {
  const symbolUpper = String(rawPayload.symbol || '').toUpperCase();
  const dteMin = parseInt(process.env.MARUBOZU_DTE_MIN || '20', 10);
  const dteMax = parseInt(process.env.MARUBOZU_DTE_MAX || '45', 10);
  const ingestTimestamp = new Date().toISOString();
  const tier =
    rawPayload.tier ||
    tierForSignal({
      confidence: rawPayload.confidence,
      context: rawPayload.context,
    });
  const dirU = String(rawPayload.direction || '').toUpperCase();
  const optRight = dirU === 'PUT' ? 'put' : 'call';

  const baseContext = {
    internal_signal_id: webhookEventId,
    signal_id: rawPayload.signal_id,
    rank: rawPayload.rank,
    tier,
    ingest_timestamp: ingestTimestamp,
    ingest_path: 'tradingview',
    normalized: {
      event: 'MARUBOZU_ENTRY',
      strategy: rawPayload.strategy || rawPayload.batch_strategy,
      timeframe: rawPayload.timeframe,
      direction: dirU,
    },
  };

  if (!SYMBOL_ALLOWLIST.has(symbolUpper)) {
    return {
      enrichment_status: 'BLOCKED',
      enrichment: {
        reason: 'symbol_not_allowlisted',
        symbol: symbolUpper,
        allowlist: [...SYMBOL_ALLOWLIST],
      },
      provider_context: {
        ...baseContext,
        strike_pick: null,
      },
      mergedPayload: null,
    };
  }

  const enriched = await runEnrichment(symbolUpper);
  let { enrichment_status, enrichment } = enriched;
  let strikePick = null;
  const quote = enriched._quoteRaw;
  const chain = enriched._chainRaw;
  const refPx = quote ? Number(quote.price ?? quote.last) : null;
  const entryPx = rawPayload.entry?.price != null ? Number(rawPayload.entry.price) : null;
  const underlyingRef =
    refPx != null && Number.isFinite(refPx)
      ? refPx
      : entryPx != null && Number.isFinite(entryPx)
        ? entryPx
        : null;

  if (enrichment_status !== 'BLOCKED' && chain && underlyingRef != null) {
    strikePick = pickAdvisoryOptionFromChain(chain, underlyingRef, optRight, dteMin, dteMax);
  }

  if (enrichment_status !== 'BLOCKED' && !strikePick) {
    enrichment_status = 'BLOCKED';
    const prev = typeof enrichment === 'object' && enrichment ? enrichment : {};
    enrichment = {
      ...prev,
      reason: 'strike_pick_failed',
      dte_band: [dteMin, dteMax],
      underlying_ref: underlyingRef,
    };
  }

  delete enriched._chainRaw;
  delete enriched._quoteRaw;

  const provider_context = {
    ...baseContext,
    strike_pick: strikePick,
    engine_conviction: confidenceToEngineScore(rawPayload.confidence),
  };

  let mergedPayload = null;
  if (strikePick) {
    mergedPayload = {
      ...rawPayload,
      strike: strikePick.strike,
      expiration: strikePick.expiration,
      dte_suggestion: strikePick.dte,
    };
  }

  return { enrichment_status, enrichment, provider_context, mergedPayload };
}

async function duplicateResult(dedupeKey) {
  const existing = await db.query(
    `SELECT id, enrichment_status, provider_context, dedupe_key, enrichment FROM webhook_events WHERE dedupe_key = $1`,
    [dedupeKey],
  );
  const row = existing.rows[0];
  const enr = row.enrichment && typeof row.enrichment === 'object' ? row.enrichment : {};
  logger.info(`[Marubozu] duplicate ignored dedupe=${dedupeKey}`, 'marubozu');
  return {
    is_duplicate: true,
    internal_signal_id: row.id,
    enrichment_status: row.enrichment_status || 'UNKNOWN',
    dedupe_key: row.dedupe_key,
    ...(enr.reason ? { reason: enr.reason } : {}),
  };
}

const marubozuServiceInstance = new MarubozuService();
module.exports = marubozuServiceInstance;
module.exports.isSignalBatchPayload = isSignalBatchPayload;
module.exports.enrichSingleEntryForTradingView = enrichSingleEntryForTradingView;
