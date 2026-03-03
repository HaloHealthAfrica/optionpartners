const db = require('../config/database');

/**
 * Get user's timezone from database
 * @param {string} userId - User ID
 * @returns {Promise<string>} User's timezone (defaults to 'UTC')
 */
async function getUserTimezone(userId) {
  try {
    if (!userId) {
      return 'UTC';
    }
    
    const query = 'SELECT timezone FROM users WHERE id = $1';
    const result = await db.query(query, [userId]);
    
    if (result.rows.length === 0) {
      console.warn(`User ${userId} not found, using UTC timezone`);
      return 'UTC';
    }
    
    return result.rows[0].timezone || 'UTC';
  } catch (error) {
    console.error('Error getting user timezone:', error);
    return 'UTC';
  }
}

/**
 * Convert a timestamp to a specific timezone and extract the date
 * @param {string|Date} timestamp - The timestamp to convert
 * @param {string} timezone - Target timezone (e.g., 'America/New_York', 'UTC')
 * @returns {string} Date in YYYY-MM-DD format in the target timezone
 */
function getDateInTimezone(timestamp, timezone = 'UTC', includeTime) {
  try {
    if (!timestamp) {
      return null;
    }
    
    const date = new Date(timestamp);
    if (isNaN(date.getTime())) {
      console.error('Invalid timestamp:', timestamp);
      return null;
    }
    
    if (includeTime === undefined) {
      includeTime = (typeof timestamp === 'string' && timestamp.includes('T'));
    }
    
    const options = includeTime
      ? { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }
      : { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' };
    
    // Use Intl.DateTimeFormat to get the date (and time if includeTime is true) in the target timezone
    const formatter = new Intl.DateTimeFormat('en-CA', options);
    
    const localDate = formatter.format(date);
    return localDate;
  } catch (error) {
    console.error('Error converting timestamp to timezone:', error, { timestamp, timezone });
    // Fallback to UTC
    return new Date(timestamp).toISOString().split('T')[0];
  }
}

/**
 * Get day of week (0-6, Sunday=0) for a date in a specific timezone
 * @param {string|Date} timestamp - The timestamp
 * @param {string} timezone - Target timezone
 * @returns {number} Day of week (0-6, Sunday=0)
 */
function getDayOfWeekInTimezone(timestamp, timezone = 'UTC') {
  try {
    if (!timestamp) {
      return null;
    }

    const date = new Date(timestamp);
    if (isNaN(date.getTime())) {
      console.error('Invalid timestamp for day of week:', timestamp);
      return null;
    }

    // Create a new date object in the target timezone
    const localDate = new Date(date.toLocaleString('en-US', { timeZone: timezone }));
    return localDate.getDay(); // 0 = Sunday, 1 = Monday, etc.
  } catch (error) {
    console.error('Error getting day of week in timezone:', error, { timestamp, timezone });
    // Fallback to UTC
    return new Date(timestamp).getUTCDay();
  }
}

/**
 * Convert a timestamp to user's local timezone and extract date or datetime
 * @param {string} userId - User ID
 * @param {string|Date} timestamp - The timestamp to convert
 * @param {boolean} [includeTime] - If true, include time details
 * @returns {Promise<string>} Date (or datetime) in user's timezone
 */
async function getUserLocalDate(userId, timestamp, includeTime) {
  const userTimezone = await getUserTimezone(userId);
  return getDateInTimezone(timestamp, userTimezone, includeTime);
}

/**
 * Get day of week for a timestamp in user's timezone
 * @param {string} userId - User ID
 * @param {string|Date} timestamp - The timestamp
 * @returns {Promise<number>} Day of week (0-6, Sunday=0) in user's timezone
 */
async function getUserDayOfWeek(userId, timestamp) {
  const userTimezone = await getUserTimezone(userId);
  return getDayOfWeekInTimezone(timestamp, userTimezone);
}

// ── Eastern Time market-hours utilities ─────────────────────────────────
// Single source of truth for ET conversion. Replaces manual DST math
// scattered across safety-guards, trade-decision-engine, etc.

const ET_TZ = 'America/New_York';

/**
 * Current Eastern Time minutes since midnight (handles DST via Intl API).
 * @returns {number} 0-1439
 */
function getETMinutes() {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: ET_TZ, hour: 'numeric', minute: 'numeric', hour12: false,
  }).formatToParts(new Date());

  const h = parseInt(parts.find(p => p.type === 'hour').value, 10);
  const m = parseInt(parts.find(p => p.type === 'minute').value, 10);
  return h * 60 + m;
}

/**
 * Current Eastern Time hour and minute.
 * @returns {{ hours: number, minutes: number, totalMinutes: number }}
 */
function getETTime() {
  const totalMinutes = getETMinutes();
  return {
    hours: Math.floor(totalMinutes / 60),
    minutes: totalMinutes % 60,
    totalMinutes,
  };
}

/**
 * Whether the current ET time falls within a given range (inclusive).
 * @param {string} startHHMM "HH:MM"
 * @param {string} endHHMM   "HH:MM"
 * @returns {{ allowed: boolean, currentET: string, reason?: string }}
 */
function isWithinTradingHours(startHHMM = '09:30', endHHMM = '16:00') {
  const { hours, minutes, totalMinutes } = getETTime();
  const [sH, sM] = startHHMM.split(':').map(Number);
  const [eH, eM] = endHHMM.split(':').map(Number);
  const startMin = sH * 60 + sM;
  const endMin = eH * 60 + eM;

  const currentET = `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`;

  if (totalMinutes < startMin || totalMinutes > endMin) {
    return {
      allowed: false,
      currentET,
      reason: `Outside trading hours (ET): current ${currentET}, allowed ${startHHMM}-${endHHMM}`,
    };
  }
  return { allowed: true, currentET };
}

/**
 * Derive market session phase from current ET clock time.
 * @returns {string} OPENING_DRIVE | MORNING | MIDDAY | AFTERNOON | CLOSE | CLOSED
 */
function deriveSessionPhase() {
  const m = getETMinutes();
  if (m >= 570 && m < 600) return 'OPENING_DRIVE';  // 09:30-10:00
  if (m >= 600 && m < 720) return 'MORNING';         // 10:00-12:00
  if (m >= 720 && m < 840) return 'MIDDAY';           // 12:00-14:00
  if (m >= 840 && m < 930) return 'AFTERNOON';        // 14:00-15:30
  if (m >= 930 && m < 960) return 'CLOSE';            // 15:30-16:00
  return 'CLOSED';
}

/**
 * Current date in Eastern Time as YYYY-MM-DD.
 */
function getETDate() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: ET_TZ }).format(new Date());
}

module.exports = {
  getUserTimezone,
  getDateInTimezone,
  getDayOfWeekInTimezone,
  getUserLocalDate,
  getUserDayOfWeek,
  getETMinutes,
  getETTime,
  isWithinTradingHours,
  deriveSessionPhase,
  getETDate,
};