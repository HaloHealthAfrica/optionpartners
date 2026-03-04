/**
 * Market session detection for API call budget management.
 * All times are US Eastern (ET). UTC offsets approximate EST;
 * for full DST accuracy, deploy with TZ=America/New_York or
 * use Intl-based conversion.
 */

export enum MarketSession {
  RTH = 'RTH',
  PRE_MARKET = 'PRE_MARKET',
  POST_MARKET = 'POST_MARKET',
  OVERNIGHT = 'OVERNIGHT',
  WEEKEND = 'WEEKEND',
}

interface SessionWindow {
  /** Minutes from midnight ET */
  startMin: number;
  endMin: number;
}

const SESSIONS: Record<string, SessionWindow> = {
  PRE_MARKET: { startMin: 240, endMin: 570 },   // 4:00 AM – 9:30 AM ET
  RTH:        { startMin: 570, endMin: 960 },    // 9:30 AM – 4:00 PM ET
  POST_MARKET:{ startMin: 960, endMin: 1200 },   // 4:00 PM – 8:00 PM ET
  // OVERNIGHT = everything else on a weekday (8:00 PM – 4:00 AM)
};

function getEasternTime(now: Date = new Date()): { day: number; minutesSinceMidnight: number } {
  const eastern = new Date(now.toLocaleString('en-US', { timeZone: 'America/New_York' }));
  const day = eastern.getDay(); // 0=Sun, 6=Sat
  const minutesSinceMidnight = eastern.getHours() * 60 + eastern.getMinutes();
  return { day, minutesSinceMidnight };
}

export function getCurrentSession(now?: Date): MarketSession {
  const { day, minutesSinceMidnight: mins } = getEasternTime(now);

  if (day === 0 || day === 6) return MarketSession.WEEKEND;

  if (mins >= SESSIONS.PRE_MARKET.startMin && mins < SESSIONS.PRE_MARKET.endMin) {
    return MarketSession.PRE_MARKET;
  }
  if (mins >= SESSIONS.RTH.startMin && mins < SESSIONS.RTH.endMin) {
    return MarketSession.RTH;
  }
  if (mins >= SESSIONS.POST_MARKET.startMin && mins < SESSIONS.POST_MARKET.endMin) {
    return MarketSession.POST_MARKET;
  }

  return MarketSession.OVERNIGHT;
}

export function isActiveSession(session: MarketSession): boolean {
  return session !== MarketSession.OVERNIGHT && session !== MarketSession.WEEKEND;
}
