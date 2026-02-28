export interface ContractParts {
  underlying: string;
  expirationYYYYMMDD: string;
  right: 'C' | 'P';
  strike: number;
}

type Vendor = 'marketdata' | 'unusual_whales';

const CANONICAL_RE = /^O:([A-Z]+):(\d{8}):(C|P):(\d+)$/;

/**
 * Build canonical ID: O:<UNDERLYING>:<YYYYMMDD>:<C|P>:<STRIKE*1000>
 */
export function formatCanonical(parts: ContractParts): string {
  validateParts(parts);
  const strikeInt = Math.round(parts.strike * 1000);
  return `O:${parts.underlying}:${parts.expirationYYYYMMDD}:${parts.right}:${strikeInt}`;
}

export function parseCanonical(id: string): ContractParts {
  const match = id.match(CANONICAL_RE);
  if (!match) {
    throw new Error(`Invalid canonical option ID: "${id}"`);
  }
  const [, underlying, expirationYYYYMMDD, right, strikeRaw] = match;
  return {
    underlying,
    expirationYYYYMMDD,
    right: right as 'C' | 'P',
    strike: parseInt(strikeRaw, 10) / 1000,
  };
}

/**
 * Convert vendor-specific option ID to canonical format.
 *
 * MarketData.app OCC format: SPY260320C00500000
 *   underlying (variable-length letters), YYMMDD, C/P, 8-digit strike (5 integer + 3 decimal places)
 *
 * UnusualWhales uses the same OCC format.
 */
export function vendorToCanonical(
  vendor: Vendor,
  vendorId: string,
  context?: { underlying?: string; expiration?: string; right?: string; strike?: number },
): string {
  switch (vendor) {
    case 'marketdata':
    case 'unusual_whales':
      return occToCanonical(vendorId);
    default:
      throw new Error(`Unsupported vendor: ${vendor}`);
  }
}

export function canonicalToVendor(id: string, vendor: Vendor): string {
  const parts = parseCanonical(id);
  switch (vendor) {
    case 'marketdata':
    case 'unusual_whales':
      return canonicalToOcc(parts);
    default:
      throw new Error(`Unsupported vendor: ${vendor}`);
  }
}

// ── OCC helpers ──────────────────────────────────────────────────

const OCC_RE = /^([A-Z]+)(\d{6})([CP])(\d{8})$/;

function occToCanonical(occ: string): string {
  const match = occ.match(OCC_RE);
  if (!match) {
    throw new Error(`Invalid OCC option symbol: "${occ}"`);
  }
  const [, underlying, yymmdd, right, strikePadded] = match;
  const expirationYYYYMMDD = `20${yymmdd.slice(0, 2)}${yymmdd.slice(2, 4)}${yymmdd.slice(4, 6)}`;
  const strikeWhole = parseInt(strikePadded, 10);
  const strikeCanonical = strikeWhole;
  return `O:${underlying}:${expirationYYYYMMDD}:${right}:${strikeCanonical}`;
}

function canonicalToOcc(parts: ContractParts): string {
  const { underlying, expirationYYYYMMDD, right, strike } = parts;
  const yy = expirationYYYYMMDD.slice(2, 4);
  const mm = expirationYYYYMMDD.slice(4, 6);
  const dd = expirationYYYYMMDD.slice(6, 8);
  const yymmdd = `${yy}${mm}${dd}`;

  const strikeInt = Math.round(strike * 1000);
  const strikePadded = strikeInt.toString().padStart(8, '0');

  return `${underlying}${yymmdd}${right}${strikePadded}`;
}

// ── Validation ───────────────────────────────────────────────────

function validateParts(parts: ContractParts): void {
  if (!parts.underlying || !/^[A-Z]+$/.test(parts.underlying)) {
    throw new Error(`Invalid underlying: "${parts.underlying}" — must be uppercase letters`);
  }
  if (!/^\d{8}$/.test(parts.expirationYYYYMMDD)) {
    throw new Error(
      `Invalid expiration: "${parts.expirationYYYYMMDD}" — must be YYYYMMDD`,
    );
  }
  if (parts.right !== 'C' && parts.right !== 'P') {
    throw new Error(`Invalid right: "${parts.right}" — must be C or P`);
  }
  if (typeof parts.strike !== 'number' || parts.strike <= 0 || !isFinite(parts.strike)) {
    throw new Error(`Invalid strike: ${parts.strike} — must be a positive finite number`);
  }
}
