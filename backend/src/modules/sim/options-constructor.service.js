'use strict';

const db = require('../../config/database');
const dataServiceProxy = require('../../services/dataServiceProxy');
const logger = require('../../utils/logger');
const Sentry = require('@sentry/node');

/**
 * Deterministic Options Constructor.
 *
 * Activated when a webhook signal lacks strike/expiration and the constructor
 * feature flag is enabled. Builds a fully specified options structure
 * (CALL, PUT, or CREDIT_SPREAD) from strategy recipes and live chain data.
 *
 * This service NEVER:
 *  - Places trades (executor owns that)
 *  - Mutates capital (ledger owns that)
 *  - Sizes positions (risk engine owns that)
 *  - Bypasses safety/adaptive guards (they run before this)
 *
 * Pipeline position: after strategy gate, before risk engine.
 */
class OptionsConstructor {
  /**
   * Construct a fully specified options trade from a bare signal.
   *
   * @param {Object} signal - The mapped signal with contractType === null
   * @param {string} userId - User ID for per-user recipe overrides
   * @param {Object} [engineOverrides] - Delta/DTE targets from TradeDecisionEngine.
   *   When provided, these override the DB recipe values. Expected shape:
   *   { contract_type, target_delta, min_delta, max_delta, target_dte, min_dte, max_dte,
   *     min_open_interest, min_volume, max_bid_ask_spread_pct, spread_width }
   * @param {Object} [regimeContext] - Regime context for dynamic scoring weights.
   *   { regime, hvPercentile, atrRatio }
   * @returns {Promise<{ success: boolean, signal?: Object, reason?: string }>}
   */
  async construct(signal, userId, engineOverrides = null, regimeContext = null) {
    try {
      const direction = this._resolveDirection(signal);
      if (!direction) {
        return { success: false, reason: 'Cannot determine direction from signal' };
      }

      let recipe;
      if (engineOverrides) {
        recipe = this._buildRecipeFromOverrides(engineOverrides, direction);
      } else {
        recipe = await this._getRecipe(signal.strategy, direction, userId);
      }

      if (!recipe) {
        return {
          success: false,
          reason: `No recipe found for strategy=${signal.strategy} direction=${direction}`,
        };
      }

      const chainResult = await this._fetchChain(signal.symbol);
      if (!chainResult.success) {
        // Fallback: synthetic construction from signal data when chain unavailable
        logger.warn(`[OPTIONS_CONSTRUCTOR] Chain unavailable for ${signal.symbol} — using synthetic construction`, 'options-constructor');
        return this._constructSynthetic(signal, recipe, direction);
      }
      const chain = chainResult.chain;

      const expiration = this._selectExpiration(chain.expirations, recipe);
      if (!expiration) {
        return this._constructSynthetic(signal, recipe, direction);
      }

      const expirationContracts = chain.contracts.filter(
        (c) => c.expiration === expiration
      );

      if (recipe.contract_type === 'CREDIT_SPREAD') {
        return this._constructSpread(signal, recipe, expirationContracts, expiration, direction, regimeContext);
      }

      return this._constructSingleLeg(signal, recipe, expirationContracts, expiration, regimeContext);
    } catch (err) {
      logger.error(`Options constructor error: ${err.message}`, 'options-constructor');
      Sentry.captureException(err, { tags: { module: 'options-constructor' } });
      return { success: false, reason: `Constructor error: ${err.message}` };
    }
  }

  /**
   * Check if a signal needs construction (missing options specifics).
   */
  needsConstruction(signal) {
    return signal.contractType === null;
  }

  /**
   * Check if the constructor feature is enabled for a user.
   */
  async isEnabled(userId) {
    try {
      const result = await db.query(
        `SELECT enable_options_constructor FROM sim_intelligence_config WHERE user_id = $1`,
        [userId]
      );
      if (result.rows.length === 0) return true; // default enabled
      return result.rows[0].enable_options_constructor !== false;
    } catch {
      return true; // default enabled if config unavailable
    }
  }

  /**
   * Build a synthetic recipe from engine overrides so the existing
   * strike/expiration selection logic works without modification.
   */
  _buildRecipeFromOverrides(overrides, direction) {
    return {
      strategy: 'ENGINE',
      direction,
      contract_type: overrides.contract_type || 'CALL',
      target_delta: overrides.target_delta || 0.50,
      min_delta: overrides.min_delta || 0.40,
      max_delta: overrides.max_delta || 0.60,
      target_dte: overrides.target_dte || 21,
      min_dte: overrides.min_dte || 14,
      max_dte: overrides.max_dte || 30,
      min_open_interest: overrides.min_open_interest || 100,
      min_volume: overrides.min_volume || 10,
      max_bid_ask_spread_pct: overrides.max_bid_ask_spread_pct || 0.08,
      spread_width: overrides.spread_width || 5,
      is_active: true,
    };
  }

  // --- Recipe resolution ---

  async _getRecipe(strategy, direction, userId) {
    // Per-user override first, then global default
    const result = await db.query(
      `SELECT * FROM strategy_trade_recipe
       WHERE strategy = $1 AND direction = $2 AND is_active = TRUE
         AND (user_id = $3 OR user_id IS NULL)
       ORDER BY user_id NULLS LAST
       LIMIT 1`,
      [strategy, direction, userId]
    );
    return result.rows[0] || null;
  }

  // --- Chain fetching (data-service first, local snapshot fallback) ---

  async _fetchChain(symbol) {
    // Try live data service first
    try {
      const result = await dataServiceProxy.getOptionsChain(symbol);
      if (result?.data?.contracts?.length > 0) {
        return { success: true, chain: result.data };
      }
    } catch (_) { /* fall through to local snapshot */ }

    // Fallback: most recent CHAIN_SNAPSHOT from webhook ingestion
    try {
      const snap = await db.query(
        `SELECT raw_payload FROM market_data_events
         WHERE symbol = $1 AND event_type = 'CHAIN_SNAPSHOT'
         ORDER BY received_at DESC LIMIT 1`,
        [symbol]
      );
      if (snap.rows.length > 0) {
        const payload = typeof snap.rows[0].raw_payload === 'string'
          ? JSON.parse(snap.rows[0].raw_payload)
          : snap.rows[0].raw_payload;
        const contracts = payload.contracts || payload.chain || [];
        if (contracts.length > 0) {
          logger.info(`[OPTIONS_CONSTRUCTOR] Using cached chain snapshot for ${symbol} (${contracts.length} contracts)`, 'options-constructor');
          return { success: true, chain: { contracts, expirations: payload.expirations || [] } };
        }
      }
    } catch (err) {
      logger.warn(`Local chain snapshot lookup failed: ${err.message}`, 'options-constructor');
    }

    return { success: false, reason: `Options chain unavailable for ${symbol}` };
  }

  // --- Expiration selection ---

  _selectExpiration(expirations, recipe) {
    if (!expirations || expirations.length === 0) return null;

    const now = new Date();
    const scored = expirations
      .map((exp) => {
        const dte = Math.ceil((new Date(exp) - now) / (1000 * 60 * 60 * 24));
        return { expiration: exp, dte };
      })
      .filter((e) => e.dte >= recipe.min_dte && e.dte <= recipe.max_dte);

    if (scored.length === 0) return null;

    // Closest to target_dte
    scored.sort((a, b) =>
      Math.abs(a.dte - recipe.target_dte) - Math.abs(b.dte - recipe.target_dte)
    );

    return scored[0].expiration;
  }

  // --- Synthetic construction when chain data unavailable ---

  _constructSynthetic(signal, recipe, direction) {
    const underlyingPrice = signal.limitPrice || signal.meta?.originalPayload?.price ||
      signal.meta?.originalPayload?.entry?.price || signal.meta?.originalPayload?.current_price;
    if (!underlyingPrice) {
      return { success: false, reason: 'Cannot construct synthetic: no underlying price available' };
    }

    const contractType = direction === 'long' ? 'CALL' : 'PUT';
    const targetDte = recipe.target_dte || 7;
    const expDate = new Date();
    expDate.setDate(expDate.getDate() + targetDte);
    // Round to next Friday
    const dayOfWeek = expDate.getDay();
    const daysToFri = (5 - dayOfWeek + 7) % 7 || 7;
    expDate.setDate(expDate.getDate() + daysToFri);
    const expiration = expDate.toISOString().slice(0, 10);

    // ATM strike rounded to nearest dollar
    const strike = Math.round(underlyingPrice);

    // Estimate option price: ~2-3% of underlying for ATM weekly
    const estimatedPremium = Math.round(underlyingPrice * 0.025 * 100) / 100;

    const enrichedSignal = {
      ...signal,
      contractType,
      strike,
      expiration,
      strikeShort: null,
      strikeLong: null,
      bidPrice: estimatedPremium * 0.97,
      askPrice: estimatedPremium * 1.03,
      midPrice: estimatedPremium,
      delta: direction === 'long' ? 0.50 : -0.50,
      quantity: signal.quantity || 1,
      meta: {
        ...signal.meta,
        constructedBy: 'options-constructor-synthetic',
        synthetic: true,
        recipe: {
          strategy: recipe.strategy,
          direction: recipe.direction,
          target_dte: targetDte,
          target_delta: recipe.target_delta || 0.50,
        },
        selectedDte: targetDte,
        selectedDelta: direction === 'long' ? 0.50 : -0.50,
      },
    };

    logger.info(
      `[OPTIONS_CONSTRUCTOR] Synthetic ${contractType} $${strike} exp=${expiration} premium=$${estimatedPremium} for ${signal.symbol}`,
      'options-constructor'
    );

    return { success: true, signal: enrichedSignal };
  }

  // --- Single leg construction (CALL or PUT) ---

  _constructSingleLeg(signal, recipe, contracts, expiration, regimeContext = null) {
    const optionType = recipe.contract_type === 'CALL' ? 'call' : 'put';
    const candidates = contracts.filter((c) => c.type === optionType);

    if (candidates.length === 0) {
      return { success: false, reason: `No ${optionType} contracts at expiration ${expiration}` };
    }

    const strike = this._selectStrikeByDelta(candidates, recipe, regimeContext);
    if (!strike) {
      return {
        success: false,
        reason: `No strike near target_delta=${recipe.target_delta} (range ${recipe.min_delta}-${recipe.max_delta})`,
      };
    }

    const liquidityCheck = this._checkLiquidity(strike, recipe);
    if (!liquidityCheck.pass) {
      return { success: false, reason: liquidityCheck.reason };
    }

    const enrichedSignal = {
      ...signal,
      contractType: recipe.contract_type,
      strike: strike.strike,
      expiration,
      strikeShort: null,
      strikeLong: null,
      bidPrice: strike.bid,
      askPrice: strike.ask,
      midPrice: strike.mid,
      delta: strike.delta,
      quantity: signal.quantity || 1,
      meta: {
        ...signal.meta,
        constructedBy: 'options-constructor',
        recipe: {
          strategy: recipe.strategy,
          direction: recipe.direction,
          target_dte: recipe.target_dte,
          target_delta: recipe.target_delta,
        },
        selectedDte: Math.ceil((new Date(expiration) - new Date()) / (1000 * 60 * 60 * 24)),
        selectedDelta: strike.delta,
        openInterest: strike.openInterest,
        volume: strike.volume,
        impliedVolatility: strike.impliedVolatility,
        greeks: {
          delta: strike.delta,
          gamma: strike.gamma,
          theta: strike.theta,
          vega: strike.vega,
        },
        riskScore: strike._riskScore || null,
      },
    };

    return { success: true, signal: enrichedSignal };
  }

  // --- Spread construction ---

  _constructSpread(signal, recipe, contracts, expiration, direction, regimeContext = null) {
    // For credit spreads:
    //   Bullish (long direction) → Bull Put Spread: sell higher put, buy lower put
    //   Bearish (short direction) → Bear Call Spread: sell lower call, buy higher call
    const isBullish = direction === 'long';
    const optionType = isBullish ? 'put' : 'call';
    const candidates = contracts.filter((c) => c.type === optionType);

    if (candidates.length === 0) {
      return { success: false, reason: `No ${optionType} contracts at expiration ${expiration}` };
    }

    // Select short leg by delta
    const shortLeg = this._selectStrikeByDelta(candidates, recipe, regimeContext);
    if (!shortLeg) {
      return {
        success: false,
        reason: `No short leg strike near target_delta=${recipe.target_delta}`,
      };
    }

    // Find long leg offset by spread width
    const spreadWidth = parseFloat(recipe.spread_width) || 5;
    const longStrikeTarget = isBullish
      ? shortLeg.strike - spreadWidth  // buy lower put
      : shortLeg.strike + spreadWidth; // buy higher call

    const longLeg = this._findClosestStrike(candidates, longStrikeTarget);
    if (!longLeg) {
      return {
        success: false,
        reason: `No long leg available at width=${spreadWidth} from short strike=${shortLeg.strike}`,
      };
    }

    const actualWidth = Math.abs(shortLeg.strike - longLeg.strike);
    if (actualWidth < 1) {
      return { success: false, reason: 'Spread width too narrow (< $1)' };
    }

    // Validate liquidity on both legs
    for (const leg of [shortLeg, longLeg]) {
      const check = this._checkLiquidity(leg, recipe);
      if (!check.pass) {
        return { success: false, reason: `${leg.strike} strike: ${check.reason}` };
      }
    }

    const creditReceived = shortLeg.mid - longLeg.mid;
    const maxLossPerContract = (actualWidth - Math.max(0, creditReceived)) * 100;

    const enrichedSignal = {
      ...signal,
      contractType: 'CREDIT_SPREAD',
      strike: shortLeg.strike,
      strikeShort: shortLeg.strike,
      strikeLong: longLeg.strike,
      expiration,
      bidPrice: creditReceived > 0 ? creditReceived : shortLeg.bid - longLeg.ask,
      askPrice: shortLeg.ask - longLeg.bid,
      midPrice: creditReceived,
      delta: shortLeg.delta,
      quantity: signal.quantity || 1,
      meta: {
        ...signal.meta,
        constructedBy: 'options-constructor',
        recipe: {
          strategy: recipe.strategy,
          direction: recipe.direction,
          target_dte: recipe.target_dte,
          target_delta: recipe.target_delta,
          spread_width: recipe.spread_width,
        },
        spreadType: isBullish ? 'BULL_PUT_SPREAD' : 'BEAR_CALL_SPREAD',
        shortLeg: {
          strike: shortLeg.strike, delta: shortLeg.delta, mid: shortLeg.mid,
          gamma: shortLeg.gamma, theta: shortLeg.theta, vega: shortLeg.vega,
          riskScore: shortLeg._riskScore || null,
        },
        longLeg: {
          strike: longLeg.strike, delta: longLeg.delta, mid: longLeg.mid,
          gamma: longLeg.gamma, theta: longLeg.theta, vega: longLeg.vega,
        },
        netGreeks: {
          delta: (shortLeg.delta || 0) - (longLeg.delta || 0),
          gamma: (shortLeg.gamma || 0) - (longLeg.gamma || 0),
          theta: (shortLeg.theta || 0) - (longLeg.theta || 0),
          vega: (shortLeg.vega || 0) - (longLeg.vega || 0),
        },
        actualWidth: actualWidth,
        creditReceived,
        maxLossPerContract,
        selectedDte: Math.ceil((new Date(expiration) - new Date()) / (1000 * 60 * 60 * 24)),
      },
    };

    return { success: true, signal: enrichedSignal };
  }

  // --- Multi-factor strike selection (Greeks + risk + liquidity) ---

  /**
   * Rank and select the best strike using a weighted composite score
   * across delta accuracy, theta efficiency, gamma exposure, IV value,
   * and liquidity quality. Returns the top-ranked contract with its
   * full scorecard attached.
   *
   * Weight profiles:
   *   deltaWeight  (0.30) — proximity to target delta
   *   thetaWeight  (0.15) — theta/premium ratio (time-decay efficiency)
   *   gammaWeight  (0.10) — gamma bang-for-buck
   *   ivWeight     (0.15) — prefer lower IV relative to peers (cheaper)
   *   liquidWeight (0.30) — OI, volume, tight spread
   */
  _selectStrikeByDelta(contracts, recipe, regimeContext = null) {
    const targetDelta = parseFloat(recipe.target_delta);
    const minDelta = parseFloat(recipe.min_delta);
    const maxDelta = parseFloat(recipe.max_delta);
    const dynamicWeights = this._getDynamicWeights(regimeContext);

    const eligible = contracts.filter((c) => {
      const absDelta = Math.abs(c.delta);
      return absDelta >= minDelta && absDelta <= maxDelta;
    });

    if (eligible.length === 0) return null;
    if (eligible.length === 1) {
      eligible[0]._riskScore = this._scoreContract(eligible[0], targetDelta, eligible, dynamicWeights);
      return eligible[0];
    }

    const scored = eligible.map((c) => ({
      ...c,
      _riskScore: this._scoreContract(c, targetDelta, eligible, dynamicWeights),
    }));

    scored.sort((a, b) => b._riskScore.composite - a._riskScore.composite);

    logger.info(
      `[STRIKE_RANK] Top 3: ${scored.slice(0, 3).map((c) =>
        `$${c.strike} Δ=${Math.abs(c.delta).toFixed(2)} score=${c._riskScore.composite.toFixed(1)}`
      ).join(' | ')}`,
      'options-constructor'
    );

    return scored[0];
  }

  /**
   * Compute a 0-100 composite risk/quality score for a contract.
   * Accepts optional dynamic weights derived from regime context.
   */
  _scoreContract(contract, targetDelta, peers, dynamicWeights = null) {
    const W = dynamicWeights || { delta: 0.30, theta: 0.15, gamma: 0.10, iv: 0.15, liquidity: 0.30 };

    // Delta accuracy: 100 when exactly on target, 0 at boundary
    const deltaError = Math.abs(Math.abs(contract.delta) - targetDelta);
    const maxDeltaError = Math.max(0.20, targetDelta);
    const deltaScore = Math.max(0, 100 * (1 - deltaError / maxDeltaError));

    // Theta efficiency: |theta| / premium — higher = more decay per $ risked
    let thetaScore = 50;
    if (contract.theta != null && contract.mid > 0) {
      const thetaRatio = Math.abs(contract.theta) / contract.mid;
      const peerRatios = peers
        .filter((p) => p.theta != null && p.mid > 0)
        .map((p) => Math.abs(p.theta) / p.mid);
      if (peerRatios.length > 1) {
        thetaScore = this._percentileRank(thetaRatio, peerRatios);
      }
    }

    // Gamma score: higher gamma = more convexity (good for debit, bad for credit)
    let gammaScore = 50;
    if (contract.gamma != null) {
      const peerGammas = peers.filter((p) => p.gamma != null).map((p) => p.gamma);
      if (peerGammas.length > 1) {
        gammaScore = this._percentileRank(contract.gamma, peerGammas);
      }
    }

    // IV value: prefer lower IV among peers (cheaper relative premium)
    let ivScore = 50;
    if (contract.impliedVolatility != null) {
      const peerIVs = peers
        .filter((p) => p.impliedVolatility != null)
        .map((p) => p.impliedVolatility);
      if (peerIVs.length > 1) {
        ivScore = 100 - this._percentileRank(contract.impliedVolatility, peerIVs);
      }
    }

    // Liquidity: composite of OI, volume, and spread tightness
    const oiScore = Math.min(100, (contract.openInterest || 0) / 50);
    const volScore = Math.min(100, (contract.volume || 0) / 10);
    let spreadScore = 100;
    if (contract.mid > 0 && contract.ask > 0 && contract.bid >= 0) {
      const spreadPct = (contract.ask - contract.bid) / contract.mid;
      spreadScore = Math.max(0, 100 * (1 - spreadPct / 0.15));
    }
    const liquidityScore = oiScore * 0.35 + volScore * 0.30 + spreadScore * 0.35;

    const composite =
      W.delta * deltaScore +
      W.theta * thetaScore +
      W.gamma * gammaScore +
      W.iv * ivScore +
      W.liquidity * liquidityScore;

    return {
      composite: Math.round(composite * 10) / 10,
      delta: Math.round(deltaScore),
      theta: Math.round(thetaScore),
      gamma: Math.round(gammaScore),
      iv: Math.round(ivScore),
      liquidity: Math.round(liquidityScore),
    };
  }

  /**
   * Percentile rank of a value within a peer array (0-100).
   */
  _percentileRank(value, peers) {
    const sorted = [...peers].sort((a, b) => a - b);
    const idx = sorted.findIndex((v) => v >= value);
    if (idx === -1) return 100;
    return Math.round((idx / sorted.length) * 100);
  }

  _findClosestStrike(contracts, targetStrike) {
    if (contracts.length === 0) return null;

    const sorted = [...contracts].sort(
      (a, b) => Math.abs(a.strike - targetStrike) - Math.abs(b.strike - targetStrike)
    );

    return sorted[0];
  }

  // --- Liquidity validation ---

  _checkLiquidity(contract, recipe) {
    if (contract.openInterest < recipe.min_open_interest) {
      return {
        pass: false,
        reason: `Open interest ${contract.openInterest} < min ${recipe.min_open_interest}`,
      };
    }

    if (contract.volume < recipe.min_volume) {
      return {
        pass: false,
        reason: `Volume ${contract.volume} < min ${recipe.min_volume}`,
      };
    }

    if (contract.mid > 0) {
      const spreadPct = (contract.ask - contract.bid) / contract.mid;
      const maxSpread = parseFloat(recipe.max_bid_ask_spread_pct);
      if (spreadPct > maxSpread) {
        return {
          pass: false,
          reason: `Bid-ask spread ${(spreadPct * 100).toFixed(1)}% > max ${(maxSpread * 100).toFixed(1)}%`,
        };
      }
    }

    return { pass: true };
  }

  // --- Regime-adaptive scoring weights ---

  /**
   * Compute dynamic scoring weights based on regime context.
   * Weights are normalized to sum to 1.0 for deterministic scoring.
   *
   * HIGH_VOL_EXPANSION: delta +20%, theta penalty -10%
   * LOW_VOL_CHOP:       liquidity (spread+OI) +25%, gamma -30%
   * TRENDING:           delta +10%
   */
  _getDynamicWeights(regimeContext) {
    const base = { delta: 0.30, theta: 0.15, gamma: 0.10, iv: 0.15, liquidity: 0.30 };
    if (!regimeContext?.regime) return base;

    const W = { ...base };

    switch (regimeContext.regime) {
      case 'HIGH_VOL_EXPANSION':
        W.delta *= 1.20;
        W.theta *= 0.90;
        break;
      case 'LOW_VOL_CHOP':
        W.liquidity *= 1.25;
        W.gamma *= 0.70;
        break;
      case 'TRENDING':
        W.delta *= 1.10;
        break;
    }

    const total = W.delta + W.theta + W.gamma + W.iv + W.liquidity;
    W.delta /= total;
    W.theta /= total;
    W.gamma /= total;
    W.iv /= total;
    W.liquidity /= total;

    return W;
  }

  // --- Direction resolution ---

  _resolveDirection(signal) {
    if (signal.direction) return signal.direction;
    if (signal.action === 'BUY') return 'long';
    if (signal.action === 'SELL') return 'short';
    return null;
  }
}

module.exports = new OptionsConstructor();
module.exports.OptionsConstructor = OptionsConstructor;
