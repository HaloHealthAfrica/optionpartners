'use strict';

const db = require('../../config/database');
const { normalizeDirection, STRAT_PLAN_EVENTS } = require('../webhooks/indicator-detector');
const logger = require('../../utils/logger');
const Sentry = require('@sentry/node');

const PLAN_EVENT_SET = STRAT_PLAN_EVENTS;

/**
 * Per-symbol rolling state.
 * Every webhook type updates this state.
 * No trade executes directly from a webhook — trades execute from state evaluation.
 */

const EMPTY_STATE = Object.freeze({
  symbol: null,
  macro_bias: 'NEUTRAL',
  macro_strength: 0,
  regime: null,
  volatility_state: null,
  room_to_resistance: null,
  room_to_support: null,
  previous_macro_bias: null,
  macro_updated_at: null,

  local_bias: 'NEUTRAL',
  local_strength: 0,
  alignment_score: 0,
  conflict_score: 0,
  local_updated_at: null,

  last_price: null,
  price_high: null,
  price_low: null,
  price_open: null,
  price_volume: null,
  atr: null,
  price_updated_at: null,

  liquidity_ok: false,
  chain_ok: false,
  iv_percentile: null,
  bid_ask_spread_pct: null,
  chain_open_interest: null,
  chain_volume: null,
  chain_updated_at: null,

  latest_entry_signal: null,
  latest_strat_signal: null,
  latest_orb_signal: null,
  latest_flow_signal: null,
  latest_saty_signal: null,
  latest_macro_raw: null,

  entry_signal_at: null,
  strat_signal_at: null,
  orb_signal_at: null,
  flow_signal_at: null,
  saty_signal_at: null,
});

class SymbolStateService {
  constructor() {
    this._cache = new Map();
  }

  /**
   * Get the current state for a symbol. Returns a copy.
   * Creates a fresh default state if none exists.
   */
  async getState(userId, symbol) {
    const key = `${userId}:${symbol}`;
    if (this._cache.has(key)) {
      return { ...this._cache.get(key) };
    }

    const result = await db.query(
      'SELECT * FROM symbol_state WHERE user_id = $1 AND symbol = $2',
      [userId, symbol]
    );

    if (result.rows.length > 0) {
      const row = result.rows[0];
      const state = this._rowToState(row);
      this._cache.set(key, state);
      return { ...state };
    }

    const fresh = { ...EMPTY_STATE, symbol };
    this._cache.set(key, fresh);
    return { ...fresh };
  }

  /**
   * Route a webhook to the correct state updater based on indicator source.
   * This is the single entry point — every webhook type flows through here.
   */
  async update(source, rawPayload, userId, symbol) {
    if (!symbol) return;

    const state = await this.getState(userId, symbol);

    switch (source) {
      case 'MTF_BIAS':
        this._applyMtfBias(state, rawPayload);
        break;
      case 'SIGNALS':
        this._applySignals(state, rawPayload);
        break;
      case 'STRAT':
        this._applyStrat(state, rawPayload);
        break;
      case 'TREND':
        this._applyTrend(state, rawPayload);
        break;
      case 'ORB':
        this._applyOrb(state, rawPayload);
        break;
      case 'SATY_PHASE':
        this._applySatyPhase(state, rawPayload);
        break;
      case 'OPTIONS_FLOW':
        this._applyFlow(state, rawPayload);
        break;
      case 'PRICE_TICK':
        this._applyPriceTick(state, rawPayload);
        break;
      case 'CHAIN_SNAPSHOT':
        this._applyChainSnapshot(state, rawPayload);
        break;
      case 'MARKET_CONTEXT':
        this._applyMarketContext(state, rawPayload);
        break;
      case 'PIVOT_MB':
        this._applyPivotMb(state, rawPayload);
        break;
      case 'SQUEEZE_PRO':
        this._applySqueezePro(state, rawPayload);
        break;
      default:
        break;
    }

    const key = `${userId}:${symbol}`;
    this._cache.set(key, state);
    await this._persist(userId, symbol, state);

    logger.info(
      `[STATE] ${symbol} updated from ${source}: macro=${state.macro_bias}(${state.macro_strength}) ` +
      `regime=${state.regime} local=${state.local_bias} price=${state.last_price}`,
      'symbol-state'
    );

    return state;
  }

  // ── MTF_BIAS: highest authority ────────────────────────────────────

  _applyMtfBias(state, payload) {
    const consensus = payload.mtf?.consensus || {};
    const regime = payload.mtf?.regime || {};
    const macroState = payload.macro?.state || {};
    const space = payload.space || {};
    const bar = payload.bar || {};
    const riskCtx = payload.risk_context || {};

    state.previous_macro_bias = state.macro_bias;

    const biasRaw = (consensus.bias_consensus || macroState.macro_class || '').toUpperCase();
    if (biasRaw.includes('BULL') || biasRaw === 'MARKUP') state.macro_bias = 'BULLISH';
    else if (biasRaw.includes('BEAR') || biasRaw === 'MARKDOWN') state.macro_bias = 'BEARISH';
    else state.macro_bias = 'NEUTRAL';

    state.macro_strength = parseFloat(consensus.bias_score ?? macroState.macro_strength ?? 0) || 0;

    const regimeType = (regime.type || '').toUpperCase();
    if (regimeType.includes('TREND')) state.regime = 'TREND';
    else if (regimeType.includes('CHOP') || (regime.chop_score != null && regime.chop_score > 60)) state.regime = 'CHOP';
    else if (regimeType.includes('EXPAN')) state.regime = 'EXPANSION';
    else if (regimeType.includes('CONTRAC')) state.regime = 'CONTRACTION';
    else state.regime = regimeType || null;

    state.volatility_state = regime.atr_state_15m || null;

    state.room_to_resistance = this._normalizeRoom(space.room_to_resistance ?? space.resistance_room);
    state.room_to_support = this._normalizeRoom(space.room_to_support ?? space.support_room);

    if (bar.close) state.last_price = parseFloat(bar.close);
    if (bar.atr || riskCtx.atr) state.atr = parseFloat(bar.atr || riskCtx.atr);

    state.latest_macro_raw = {
      consensus,
      regime,
      macroState,
      space,
      levels: payload.levels || {},
      intent: payload.intent || {},
      riskContext: riskCtx,
      liquidity: payload.liquidity || {},
    };

    state.macro_updated_at = new Date().toISOString();
  }

  // ── SIGNALS: primary entry candidate ───────────────────────────────

  _applySignals(state, payload) {
    const entryObj = payload.entry || {};
    const riskObj = payload.risk || {};
    const trendData = payload.trend_data || {};
    const timeCtx = payload.time_context || {};
    const mktCtx = payload.market_context || {};

    const direction = normalizeDirection(
      payload.direction ?? payload.signal?.type ?? payload.signal?.side ?? payload.trend
    );

    // Derive confidence (0-100) from available fields: explicit confidence, ai_score (0-10), or score (0-10)
    const rawConfidence = parseFloat(payload.confidence) ||
      (parseFloat(payload.signal?.ai_score) * 10) ||
      (parseFloat(payload.score) * 10) || 0;

    state.latest_entry_signal = {
      direction,
      confidence: Math.min(100, Math.round(rawConfidence)),
      score: payload.score_breakdown?.total ?? payload.score ?? 0,
      entry_price: parseFloat(entryObj.price ?? entryObj.entry_price ?? payload.current_price) || null,
      stop_loss: parseFloat(entryObj.stop_loss ?? riskObj.stop_loss) || null,
      target_1: parseFloat(entryObj.target_1 ?? riskObj.target_1) || null,
      target_2: parseFloat(entryObj.target_2 ?? riskObj.target_2) || null,
      rr_ratio: parseFloat(riskObj.rr_ratio_t1 ?? riskObj.rr_ratio ?? riskObj.reward_risk) || null,
      max_loss: parseFloat(riskObj.max_loss_dollars ?? riskObj.max_loss ?? riskObj.risk_amount) || null,
      market_session: mktCtx.session || payload.market_session || payload.session || null,
      volume_vs_avg: parseFloat(mktCtx.volume_vs_avg ?? payload.volume_vs_avg) || null,
      atr: parseFloat(mktCtx.atr ?? trendData.atr ?? payload.atr) || null,
      pattern: payload.pattern || payload.setup || null,
      strategy: payload.pattern || payload.setup || 'SIGNALS',
      trend_alignment: trendData.alignment || null,
      timeframe: payload.timeframe || null,
    };

    if (state.latest_entry_signal.atr) {
      state.atr = state.latest_entry_signal.atr;
    }
    if (state.latest_entry_signal.entry_price) {
      state.last_price = state.latest_entry_signal.entry_price;
    }

    state.entry_signal_at = new Date().toISOString();
  }

  // ── STRAT: confirmation layer + actionable trade trigger ──────────

  _applyStrat(state, payload) {
    const v2 = this._isStratPlanV2(payload);

    if (v2) {
      this._applyStratV2(state, payload);
    } else {
      this._applyStratV1(state, payload);
    }
  }

  _isStratPlanV2(payload) {
    const metaSystem = payload.meta?.system || '';
    if (metaSystem.includes('Strat Plan Engine')) return true;
    const event = (payload.event || '').toUpperCase();
    return PLAN_EVENT_SET.has(event) && payload.setup && typeof payload.setup === 'object';
  }

  _applyStratV1(state, payload) {
    const direction = normalizeDirection(payload.signal?.side ?? payload.trend);

    const entry = parseFloat(payload.entry) || null;
    const stop = parseFloat(payload.stop) || null;
    const target = parseFloat(payload.target) || null;

    const rawScore = typeof payload.score === 'number'
      ? payload.score
      : (typeof payload.signal?.ai_score === 'number' ? payload.signal.ai_score : null);
    const confidence = rawScore != null
      ? (rawScore <= 10 ? Math.min(100, Math.round(rawScore * 10)) : Math.min(100, Math.round(rawScore)))
      : (entry && target && stop ? 75 : null);

    state.latest_strat_signal = {
      direction,
      score: rawScore,
      setup: payload.setup || payload.setupType || payload.setup_type || null,
      entry,
      stop,
      target,
      reversal_level: parseFloat(payload.reversal_level ?? payload.reversalLevel) || null,
    };

    state.strat_signal_at = new Date().toISOString();

    if (entry && entry > 0 && target && target > 0 && stop && stop > 0) {
      const rrRatio = Math.abs(target - entry) / Math.abs(entry - stop) || null;

      state.latest_entry_signal = {
        direction,
        confidence: confidence || 75,
        score: rawScore,
        entry_price: entry,
        stop_loss: stop,
        target_1: target,
        target_2: null,
        rr_ratio: rrRatio ? parseFloat(rrRatio.toFixed(2)) : null,
        max_loss: null,
        market_session: null,
        volume_vs_avg: null,
        atr: state.atr || null,
        pattern: payload.setup || payload.setupType || payload.setup_type || null,
        strategy: payload.setup || 'STRAT',
        trend_alignment: payload.trend || null,
        timeframe: payload.timeframe || null,
      };

      if (entry) state.last_price = entry;
      state.entry_signal_at = new Date().toISOString();
    }
  }

  _applyStratV2(state, payload) {
    const direction = normalizeDirection(payload.setup?.direction ?? payload.setup?.bias);
    const event = (payload.event || '').toUpperCase();

    const entry = parseFloat(payload.plan?.entry) || null;
    const stop = parseFloat(payload.plan?.stop) || null;
    const target1 = parseFloat(payload.plan?.target1) || null;
    const target2 = parseFloat(payload.plan?.target2) || null;
    const atr = parseFloat(payload.plan?.atr) || null;

    const patternKind = (payload.setup?.pattern_kind || '').toUpperCase();
    const continuity = payload.setup?.continuity ?? null;

    // Derive confidence from pattern quality
    let confidence;
    if (patternKind === 'CONTINUATION') confidence = continuity ? 85 : 70;
    else if (patternKind === 'REVERSAL') confidence = continuity ? 75 : 55;
    else if (patternKind === 'REVSTRAT') confidence = continuity ? 65 : 50;
    else                                 confidence = continuity ? 75 : 65;

    state.latest_strat_signal = {
      direction,
      score: null,
      setup: payload.setup?.pattern || null,
      entry,
      stop,
      target: target1,
      target2,
      atr,
      reversal_level: null,
      pattern_kind: payload.setup?.pattern_kind || null,
      continuity,
      htf: payload.setup?.htf || null,
      ltf: payload.setup?.ltf || null,
      ctf: payload.setup?.ctf || null,
      htf_candle: payload.setup?.htf_candle || null,
      htf_candle_prev: payload.setup?.htf_candle_prev || null,
      ctf_candle: payload.setup?.ctf_candle || null,
      event_type: event,
      plan_id: payload.plan_id || null,
      open_condition: payload.plan?.open_condition || null,
      market: payload.market || null,
    };

    if (atr) state.atr = atr;
    state.strat_signal_at = new Date().toISOString();

    // Only populate latest_entry_signal on TRIGGERED / REVERSAL_IN_FORCE
    // Other lifecycle events (PLAN_CREATED, IN_FORCE) are context-only
    const isTrigger = event === 'TRIGGERED' || event === 'REVERSAL_IN_FORCE';

    if (isTrigger && entry && entry > 0 && target1 && target1 > 0 && stop && stop > 0) {
      const rrRatio = Math.abs(target1 - entry) / Math.abs(entry - stop) || null;

      state.latest_entry_signal = {
        direction,
        confidence,
        score: null,
        entry_price: entry,
        stop_loss: stop,
        target_1: target1,
        target_2: target2,
        rr_ratio: rrRatio ? parseFloat(rrRatio.toFixed(2)) : null,
        max_loss: null,
        market_session: null,
        volume_vs_avg: null,
        atr: atr || state.atr || null,
        pattern: payload.setup?.pattern || null,
        strategy: payload.setup?.pattern || 'STRAT_PLAN',
        trend_alignment: null,
        timeframe: payload.setup?.htf || null,
      };

      if (entry) state.last_price = entry;
      state.entry_signal_at = new Date().toISOString();
    }

    // Update market data if present
    if (payload.market) {
      if (payload.market.ltf_close) state.last_price = parseFloat(payload.market.ltf_close);
      if (payload.market.ltf_high) state.price_high = parseFloat(payload.market.ltf_high);
      if (payload.market.ltf_low) state.price_low = parseFloat(payload.market.ltf_low);
      if (payload.market.session_open) state.price_open = parseFloat(payload.market.session_open);
    }
  }

  // ── TREND: multi-timeframe alignment ───────────────────────────────

  _applyTrend(state, payload) {
    const direction = normalizeDirection(payload.bias);
    const tfData = payload.timeframes || {};

    let bullish = 0, bearish = 0, total = 0;
    for (const key of Object.keys(tfData)) {
      const tf = tfData[key];
      if (!tf) continue;
      total++;
      if (tf.dir === 'bullish') bullish++;
      else if (tf.dir === 'bearish') bearish++;
    }

    const alignment = total > 0
      ? Math.round((Math.max(bullish, bearish) / total) * 100)
      : 0;

    const macroDir = state.macro_bias === 'BULLISH' ? 'long'
      : state.macro_bias === 'BEARISH' ? 'short' : null;
    const conflict = macroDir && direction && macroDir !== direction
      ? Math.round((Math.min(bullish, bearish) / Math.max(total, 1)) * 100)
      : 0;

    state.local_bias = direction === 'long' ? 'BULLISH'
      : direction === 'short' ? 'BEARISH' : 'NEUTRAL';
    state.local_strength = alignment;
    state.alignment_score = payload.alignment_score ?? alignment;
    state.conflict_score = payload.conflict_score ?? conflict;
    state.local_updated_at = new Date().toISOString();
  }

  // ── ORB: opening range breakout ────────────────────────────────────

  _applyOrb(state, payload) {
    const direction = normalizeDirection(payload.side ?? payload.action);

    state.latest_orb_signal = {
      direction,
      indicator: payload.indicator || 'ORB',
      entry: parseFloat(payload.entry) || null,
      stop: parseFloat(payload.stop) || null,
      timestamp: payload.timestamp || new Date().toISOString(),
    };

    state.orb_signal_at = new Date().toISOString();
  }

  // ── SATY_PHASE: phase oscillator confirmation ─────────────────────

  _applySatyPhase(state, payload) {
    const direction = normalizeDirection(
      payload.regime_context?.local_bias ??
      payload.execution_guidance?.bias ??
      payload.event?.phase_name
    );

    state.latest_saty_signal = {
      direction,
      engine: payload.meta?.engine || null,
      phaseName: payload.event?.phase_name || null,
      localBias: payload.regime_context?.local_bias || null,
      executionBias: payload.execution_guidance?.bias || null,
      timestamp: payload.timestamp || new Date().toISOString(),
    };

    state.saty_signal_at = new Date().toISOString();
  }

  // ── OPTIONS_FLOW ───────────────────────────────────────────────────

  _applyFlow(state, payload) {
    const sentiment = (payload.sentiment || '').toLowerCase();
    const isBullish = sentiment === 'bullish' || sentiment === 'bull'
      || (payload.type || '').toLowerCase() === 'call';

    state.latest_flow_signal = {
      direction: isBullish ? 'long' : (sentiment === 'bearish' || sentiment === 'bear' ? 'short' : null),
      flow_type: payload.type || null,
      strike: parseFloat(payload.strike) || null,
      expiry: payload.expiry || payload.expiration || null,
      premium: parseFloat(payload.premium) || null,
      size: parseInt(payload.size, 10) || null,
      sentiment: payload.sentiment || null,
      unusual: payload.unusual === true,
      size_percentile: parseFloat(payload.size_percentile) || null,
    };

    state.flow_signal_at = new Date().toISOString();
  }

  // ── PRICE_TICK ─────────────────────────────────────────────────────

  _applyPriceTick(state, payload) {
    state.last_price = parseFloat(payload.price) || state.last_price;
    state.price_high = parseFloat(payload.high) || state.price_high;
    state.price_low = parseFloat(payload.low) || state.price_low;
    state.price_open = parseFloat(payload.open) || state.price_open;
    state.price_volume = parseInt(payload.volume, 10) || state.price_volume;
    if (payload.atr) state.atr = parseFloat(payload.atr);
    state.price_updated_at = new Date().toISOString();
  }

  // ── CHAIN_SNAPSHOT ─────────────────────────────────────────────────

  _applyChainSnapshot(state, payload) {
    const contracts = payload.contracts || payload.chain || [];
    const hasContracts = Array.isArray(contracts) && contracts.length > 0;

    state.chain_ok = hasContracts;
    state.iv_percentile = parseFloat(payload.iv_percentile ?? payload.ivPercentile) || state.iv_percentile;

    if (hasContracts) {
      let totalOI = 0, totalVol = 0, spreadSum = 0, spreadCount = 0;
      for (const c of contracts) {
        totalOI += parseInt(c.openInterest || c.oi || 0, 10);
        totalVol += parseInt(c.volume || c.vol || 0, 10);
        if (c.bid != null && c.ask != null && c.mid > 0) {
          spreadSum += (c.ask - c.bid) / c.mid;
          spreadCount++;
        }
      }
      state.chain_open_interest = totalOI;
      state.chain_volume = totalVol;
      state.bid_ask_spread_pct = spreadCount > 0
        ? Math.round((spreadSum / spreadCount) * 10000) / 10000
        : null;
      state.liquidity_ok = totalOI >= 100 && totalVol >= 10;
    }

    state.chain_updated_at = new Date().toISOString();
  }

  // ── PIVOT_MB: pivot motherbar entry signal ──────────────────────────

  _applyPivotMb(state, payload) {
    const direction = normalizeDirection(payload.side);
    const entry = parseFloat(payload.entry_price) || null;
    const stop = parseFloat(payload.stop_price) || null;
    const targets = payload.targets || [];

    if (entry) state.last_price = entry;

    state.latest_entry_signal = {
      direction,
      confidence: payload.confluence_score || 0,
      score: payload.confluence_score || 0,
      entry_price: entry,
      stop_loss: stop,
      target_1: targets[0] || null,
      target_2: targets[1] || null,
      rr_ratio: (entry && stop && targets[0])
        ? parseFloat((Math.abs(targets[0] - entry) / Math.abs(entry - stop)).toFixed(2))
        : null,
      max_loss: null,
      market_session: null,
      volume_vs_avg: null,
      atr: null,
      pattern: payload.trigger || null,
      strategy: 'pivot_motherbar',
      trend_alignment: null,
      timeframe: payload.timeframe || '15',
    };

    state.entry_signal_at = new Date().toISOString();
  }

  // ── SQUEEZE_PRO: squeeze release entry/exit signal ──────────────────

  _applySqueezePro(state, payload) {
    const direction = normalizeDirection(payload.direction);
    const signalType = (payload.signal_type || '').toUpperCase();
    const isExit = signalType === 'EXIT';

    const squeeze = payload.squeeze || {};
    const levels = payload.levels || {};
    const trend = payload.trend || {};
    const volumeFilter = payload.volume_filter || {};

    const entry = parseFloat(levels.entry || payload.close) || null;
    const slowEma = parseFloat(trend.slow_ema) || null;
    const swingStop = parseFloat(levels.swing_stop) || null;

    let stopLoss = null;
    if (slowEma && swingStop && entry) {
      stopLoss = Math.abs(entry - slowEma) < Math.abs(entry - swingStop) ? slowEma : swingStop;
    } else {
      stopLoss = slowEma || swingStop || null;
    }

    if (entry) state.last_price = entry;

    // Update local bias from price vs macro EMA
    const macroEma = parseFloat(trend.macro_ema) || null;
    if (macroEma && entry) {
      if (entry > macroEma) state.local_bias = 'BULLISH';
      else if (entry < macroEma) state.local_bias = 'BEARISH';
      else state.local_bias = 'NEUTRAL';
      state.local_updated_at = new Date().toISOString();
    }

    if (!isExit) {
      const compressionScore = parseFloat(squeeze.compression_score) || 0;
      const targets = [];
      const t1 = parseFloat(levels.target_1);
      const t2 = parseFloat(levels.target_2);
      if (!isNaN(t1)) targets.push(t1);
      if (!isNaN(t2)) targets.push(t2);

      let confidence;
      if (compressionScore >= 80) {
        confidence = Math.min(95, 60 + Math.round(compressionScore * 0.4));
      } else if (compressionScore >= 60) {
        confidence = Math.min(80, 50 + Math.round(compressionScore * 0.35));
      } else {
        confidence = Math.min(65, 40 + Math.round(compressionScore * 0.3));
      }

      const volumeRatio = parseFloat(volumeFilter.volume_ratio) || 0;
      if (volumeRatio >= 1.5) {
        confidence = Math.min(100, confidence + 5);
      }

      state.latest_entry_signal = {
        direction,
        confidence,
        score: compressionScore,
        entry_price: entry,
        stop_loss: stopLoss,
        target_1: targets[0] || null,
        target_2: targets[1] || null,
        rr_ratio: (entry && stopLoss && targets[0])
          ? parseFloat((Math.abs(targets[0] - entry) / Math.abs(entry - stopLoss)).toFixed(2))
          : null,
        max_loss: null,
        market_session: null,
        volume_vs_avg: volumeRatio || null,
        atr: null,
        pattern: 'SQUEEZE_PRO',
        strategy: 'squeeze_pro',
        trend_alignment: trend.alignment || null,
        timeframe: payload.interval || null,
      };

      state.entry_signal_at = new Date().toISOString();
    }
  }

  // ── MARKET_CONTEXT: rich context data (regime, levels, market bias) ──

  _applyMarketContext(state, payload) {
    state.last_price = parseFloat(payload.price) || state.last_price;

    // Regime
    const regime = payload.regime || {};
    const regimeType = (regime.current || '').toUpperCase();
    if (regimeType) {
      if (regimeType.includes('TREND')) state.regime = 'TREND';
      else if (regimeType.includes('CHOP')) state.regime = 'CHOP';
      else if (regimeType.includes('EXPAN')) state.regime = 'EXPANSION';
      else if (regimeType.includes('CONTRAC')) state.regime = 'CONTRACTION';
      else state.regime = regimeType;
    }

    // Direction / bias
    const direction = (payload.direction || '').toUpperCase();
    if (direction.includes('BULL') || direction === 'LONG') state.local_bias = 'BULLISH';
    else if (direction.includes('BEAR') || direction === 'SHORT') state.local_bias = 'BEARISH';
    else if (direction) state.local_bias = 'NEUTRAL';

    // Volatility
    if (payload.volatility?.state) {
      state.volatility_state = payload.volatility.state;
    }

    // Levels → room to support/resistance
    const levels = payload.levels || {};
    if (levels.dist_to_nearest_res_pct != null) {
      state.room_to_resistance = levels.dist_to_nearest_res_pct > 1 ? 'HIGH' : levels.dist_to_nearest_res_pct > 0.3 ? 'MODERATE' : 'LOW';
    }
    if (levels.dist_to_nearest_sup_pct != null) {
      state.room_to_support = levels.dist_to_nearest_sup_pct > 1 ? 'HIGH' : levels.dist_to_nearest_sup_pct > 0.3 ? 'MODERATE' : 'LOW';
    }

    state.context_updated_at = new Date().toISOString();
  }

  // ── Helpers ────────────────────────────────────────────────────────

  _normalizeRoom(value) {
    if (!value) return null;
    const v = String(value).toUpperCase();
    if (v === 'HIGH' || v === 'LARGE' || v === 'PLENTY') return 'HIGH';
    if (v === 'LOW' || v === 'SMALL' || v === 'TIGHT' || v === 'NONE') return 'LOW';
    return 'MODERATE';
  }

  _rowToState(row) {
    return {
      symbol: row.symbol,
      macro_bias: row.macro_bias || 'NEUTRAL',
      macro_strength: parseFloat(row.macro_strength) || 0,
      regime: row.regime,
      volatility_state: row.volatility_state,
      room_to_resistance: row.room_to_resistance,
      room_to_support: row.room_to_support,
      previous_macro_bias: row.previous_macro_bias,
      macro_updated_at: row.macro_updated_at,
      local_bias: row.local_bias || 'NEUTRAL',
      local_strength: parseFloat(row.local_strength) || 0,
      alignment_score: parseFloat(row.alignment_score) || 0,
      conflict_score: parseFloat(row.conflict_score) || 0,
      local_updated_at: row.local_updated_at,
      last_price: row.last_price ? parseFloat(row.last_price) : null,
      price_high: row.price_high ? parseFloat(row.price_high) : null,
      price_low: row.price_low ? parseFloat(row.price_low) : null,
      price_open: row.price_open ? parseFloat(row.price_open) : null,
      price_volume: row.price_volume ? parseInt(row.price_volume, 10) : null,
      atr: row.atr ? parseFloat(row.atr) : null,
      price_updated_at: row.price_updated_at,
      liquidity_ok: row.liquidity_ok || false,
      chain_ok: row.chain_ok || false,
      iv_percentile: row.iv_percentile ? parseFloat(row.iv_percentile) : null,
      bid_ask_spread_pct: row.bid_ask_spread_pct ? parseFloat(row.bid_ask_spread_pct) : null,
      chain_open_interest: row.chain_open_interest,
      chain_volume: row.chain_volume,
      chain_updated_at: row.chain_updated_at,
      latest_entry_signal: row.latest_entry_signal,
      latest_strat_signal: row.latest_strat_signal,
      latest_orb_signal: row.latest_orb_signal,
      latest_flow_signal: row.latest_flow_signal,
      latest_saty_signal: row.latest_saty_signal,
      latest_macro_raw: row.latest_macro_raw,
      entry_signal_at: row.entry_signal_at,
      strat_signal_at: row.strat_signal_at,
      orb_signal_at: row.orb_signal_at,
      flow_signal_at: row.flow_signal_at,
      saty_signal_at: row.saty_signal_at,
    };
  }

  async _persist(userId, symbol, state) {
    try {
      await db.query(
        `INSERT INTO symbol_state (
           user_id, symbol,
           macro_bias, macro_strength, regime, volatility_state,
           room_to_resistance, room_to_support, previous_macro_bias, macro_updated_at,
           local_bias, local_strength, alignment_score, conflict_score, local_updated_at,
           last_price, price_high, price_low, price_open, price_volume, atr, price_updated_at,
           liquidity_ok, chain_ok, iv_percentile, bid_ask_spread_pct,
           chain_open_interest, chain_volume, chain_updated_at,
           latest_entry_signal, latest_strat_signal, latest_orb_signal,
           latest_flow_signal, latest_saty_signal, latest_macro_raw,
           entry_signal_at, strat_signal_at, orb_signal_at, flow_signal_at, saty_signal_at,
           updated_at
         ) VALUES (
           $1, $2,
           $3, $4, $5, $6, $7, $8, $9, $10,
           $11, $12, $13, $14, $15,
           $16, $17, $18, $19, $20, $21, $22,
           $23, $24, $25, $26, $27, $28, $29,
           $30, $31, $32, $33, $34, $35,
           $36, $37, $38, $39, $40,
           NOW()
         )
         ON CONFLICT (user_id, symbol) DO UPDATE SET
           macro_bias = EXCLUDED.macro_bias,
           macro_strength = EXCLUDED.macro_strength,
           regime = EXCLUDED.regime,
           volatility_state = EXCLUDED.volatility_state,
           room_to_resistance = EXCLUDED.room_to_resistance,
           room_to_support = EXCLUDED.room_to_support,
           previous_macro_bias = EXCLUDED.previous_macro_bias,
           macro_updated_at = EXCLUDED.macro_updated_at,
           local_bias = EXCLUDED.local_bias,
           local_strength = EXCLUDED.local_strength,
           alignment_score = EXCLUDED.alignment_score,
           conflict_score = EXCLUDED.conflict_score,
           local_updated_at = EXCLUDED.local_updated_at,
           last_price = EXCLUDED.last_price,
           price_high = EXCLUDED.price_high,
           price_low = EXCLUDED.price_low,
           price_open = EXCLUDED.price_open,
           price_volume = EXCLUDED.price_volume,
           atr = EXCLUDED.atr,
           price_updated_at = EXCLUDED.price_updated_at,
           liquidity_ok = EXCLUDED.liquidity_ok,
           chain_ok = EXCLUDED.chain_ok,
           iv_percentile = EXCLUDED.iv_percentile,
           bid_ask_spread_pct = EXCLUDED.bid_ask_spread_pct,
           chain_open_interest = EXCLUDED.chain_open_interest,
           chain_volume = EXCLUDED.chain_volume,
           chain_updated_at = EXCLUDED.chain_updated_at,
           latest_entry_signal = EXCLUDED.latest_entry_signal,
           latest_strat_signal = EXCLUDED.latest_strat_signal,
           latest_orb_signal = EXCLUDED.latest_orb_signal,
           latest_flow_signal = EXCLUDED.latest_flow_signal,
           latest_saty_signal = EXCLUDED.latest_saty_signal,
           latest_macro_raw = EXCLUDED.latest_macro_raw,
           entry_signal_at = EXCLUDED.entry_signal_at,
           strat_signal_at = EXCLUDED.strat_signal_at,
           orb_signal_at = EXCLUDED.orb_signal_at,
           flow_signal_at = EXCLUDED.flow_signal_at,
           saty_signal_at = EXCLUDED.saty_signal_at,
           updated_at = NOW()`,
        [
          userId, symbol,
          state.macro_bias, state.macro_strength, state.regime, state.volatility_state,
          state.room_to_resistance, state.room_to_support, state.previous_macro_bias, state.macro_updated_at,
          state.local_bias, state.local_strength, state.alignment_score, state.conflict_score, state.local_updated_at,
          state.last_price, state.price_high, state.price_low, state.price_open, state.price_volume, state.atr, state.price_updated_at,
          state.liquidity_ok, state.chain_ok, state.iv_percentile, state.bid_ask_spread_pct,
          state.chain_open_interest, state.chain_volume, state.chain_updated_at,
          state.latest_entry_signal ? JSON.stringify(state.latest_entry_signal) : null,
          state.latest_strat_signal ? JSON.stringify(state.latest_strat_signal) : null,
          state.latest_orb_signal ? JSON.stringify(state.latest_orb_signal) : null,
          state.latest_flow_signal ? JSON.stringify(state.latest_flow_signal) : null,
          state.latest_saty_signal ? JSON.stringify(state.latest_saty_signal) : null,
          state.latest_macro_raw ? JSON.stringify(state.latest_macro_raw) : null,
          state.entry_signal_at, state.strat_signal_at, state.orb_signal_at, state.flow_signal_at, state.saty_signal_at,
        ]
      );
    } catch (err) {
      logger.error(`Failed to persist symbol state for ${symbol}: ${err.message}`, 'symbol-state');
      Sentry.captureException(err, { tags: { module: 'symbol-state' } });
    }
  }

  /**
   * Check if macro bias just flipped from a previous value.
   */
  hasMacroBiasFlip(state) {
    return state.previous_macro_bias
      && state.previous_macro_bias !== 'NEUTRAL'
      && state.macro_bias !== 'NEUTRAL'
      && state.previous_macro_bias !== state.macro_bias;
  }

  clearCache(userId, symbol) {
    this._cache.delete(`${userId}:${symbol}`);
  }
}

module.exports = new SymbolStateService();
module.exports.SymbolStateService = SymbolStateService;
module.exports.EMPTY_STATE = EMPTY_STATE;
