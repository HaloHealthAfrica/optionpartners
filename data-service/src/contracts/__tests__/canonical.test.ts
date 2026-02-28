import { describe, it, expect } from 'vitest';
import {
  formatCanonical,
  parseCanonical,
  vendorToCanonical,
  canonicalToVendor,
  ContractParts,
} from '../canonical';

// ── formatCanonical ──────────────────────────────────────────────

describe('formatCanonical', () => {
  it('formats SPY $500 call', () => {
    const parts: ContractParts = {
      underlying: 'SPY',
      expirationYYYYMMDD: '20260320',
      right: 'C',
      strike: 500,
    };
    expect(formatCanonical(parts)).toBe('O:SPY:20260320:C:500000');
  });

  it('formats TSLA $1234.56 put', () => {
    const parts: ContractParts = {
      underlying: 'TSLA',
      expirationYYYYMMDD: '20260619',
      right: 'P',
      strike: 1234.56,
    };
    expect(formatCanonical(parts)).toBe('O:TSLA:20260619:P:1234560');
  });

  it('formats low-strike penny option', () => {
    const parts: ContractParts = {
      underlying: 'F',
      expirationYYYYMMDD: '20260116',
      right: 'C',
      strike: 0.5,
    };
    expect(formatCanonical(parts)).toBe('O:F:20260116:C:500');
  });

  it('formats whole-dollar strike without decimals', () => {
    const parts: ContractParts = {
      underlying: 'AAPL',
      expirationYYYYMMDD: '20261218',
      right: 'P',
      strike: 200,
    };
    expect(formatCanonical(parts)).toBe('O:AAPL:20261218:P:200000');
  });

  it('rejects invalid underlying', () => {
    expect(() =>
      formatCanonical({ underlying: 'spy', expirationYYYYMMDD: '20260320', right: 'C', strike: 500 }),
    ).toThrow('Invalid underlying');
  });

  it('rejects empty underlying', () => {
    expect(() =>
      formatCanonical({ underlying: '', expirationYYYYMMDD: '20260320', right: 'C', strike: 500 }),
    ).toThrow('Invalid underlying');
  });

  it('rejects invalid expiration format', () => {
    expect(() =>
      formatCanonical({ underlying: 'SPY', expirationYYYYMMDD: '2026032', right: 'C', strike: 500 }),
    ).toThrow('Invalid expiration');
  });

  it('rejects negative strike', () => {
    expect(() =>
      formatCanonical({ underlying: 'SPY', expirationYYYYMMDD: '20260320', right: 'C', strike: -10 }),
    ).toThrow('Invalid strike');
  });

  it('rejects zero strike', () => {
    expect(() =>
      formatCanonical({ underlying: 'SPY', expirationYYYYMMDD: '20260320', right: 'C', strike: 0 }),
    ).toThrow('Invalid strike');
  });
});

// ── parseCanonical ───────────────────────────────────────────────

describe('parseCanonical', () => {
  it('parses SPY $500 call', () => {
    expect(parseCanonical('O:SPY:20260320:C:500000')).toEqual({
      underlying: 'SPY',
      expirationYYYYMMDD: '20260320',
      right: 'C',
      strike: 500,
    });
  });

  it('parses TSLA $1234.56 put', () => {
    expect(parseCanonical('O:TSLA:20260619:P:1234560')).toEqual({
      underlying: 'TSLA',
      expirationYYYYMMDD: '20260619',
      right: 'P',
      strike: 1234.56,
    });
  });

  it('parses low-strike option', () => {
    expect(parseCanonical('O:F:20260116:C:500')).toEqual({
      underlying: 'F',
      expirationYYYYMMDD: '20260116',
      right: 'C',
      strike: 0.5,
    });
  });

  it('round-trips through format → parse', () => {
    const original: ContractParts = {
      underlying: 'AMZN',
      expirationYYYYMMDD: '20270115',
      right: 'P',
      strike: 185.5,
    };
    expect(parseCanonical(formatCanonical(original))).toEqual(original);
  });

  it('rejects malformed IDs', () => {
    expect(() => parseCanonical('SPY:20260320:C:500000')).toThrow('Invalid canonical');
    expect(() => parseCanonical('')).toThrow('Invalid canonical');
    expect(() => parseCanonical('O:SPY:20260320:X:500000')).toThrow('Invalid canonical');
  });
});

// ── vendorToCanonical ────────────────────────────────────────────

describe('vendorToCanonical', () => {
  describe('marketdata (OCC format)', () => {
    it('converts SPY $500 call', () => {
      expect(vendorToCanonical('marketdata', 'SPY260320C00500000')).toBe(
        'O:SPY:20260320:C:500000',
      );
    });

    it('converts TSLA $1234.56 put', () => {
      expect(vendorToCanonical('marketdata', 'TSLA260619P01234560')).toBe(
        'O:TSLA:20260619:P:1234560',
      );
    });

    it('converts low-strike F $0.50 call', () => {
      expect(vendorToCanonical('marketdata', 'F260116C00000500')).toBe(
        'O:F:20260116:C:500',
      );
    });

    it('converts AAPL $200 put', () => {
      expect(vendorToCanonical('marketdata', 'AAPL261218P00200000')).toBe(
        'O:AAPL:20261218:P:200000',
      );
    });

    it('rejects invalid OCC symbols', () => {
      expect(() => vendorToCanonical('marketdata', 'INVALID')).toThrow('Invalid OCC');
      expect(() => vendorToCanonical('marketdata', '')).toThrow('Invalid OCC');
    });
  });

  describe('unusual_whales (OCC format)', () => {
    it('converts SPY $500 call', () => {
      expect(vendorToCanonical('unusual_whales', 'SPY260320C00500000')).toBe(
        'O:SPY:20260320:C:500000',
      );
    });

    it('converts TSLA $1234.56 put', () => {
      expect(vendorToCanonical('unusual_whales', 'TSLA260619P01234560')).toBe(
        'O:TSLA:20260619:P:1234560',
      );
    });
  });
});

// ── canonicalToVendor ────────────────────────────────────────────

describe('canonicalToVendor', () => {
  describe('marketdata', () => {
    it('converts SPY $500 call to OCC', () => {
      expect(canonicalToVendor('O:SPY:20260320:C:500000', 'marketdata')).toBe(
        'SPY260320C00500000',
      );
    });

    it('converts TSLA $1234.56 put to OCC', () => {
      expect(canonicalToVendor('O:TSLA:20260619:P:1234560', 'marketdata')).toBe(
        'TSLA260619P01234560',
      );
    });

    it('converts low-strike F $0.50 call to OCC', () => {
      expect(canonicalToVendor('O:F:20260116:C:500', 'marketdata')).toBe(
        'F260116C00000500',
      );
    });

    it('converts AAPL $200 put to OCC', () => {
      expect(canonicalToVendor('O:AAPL:20261218:P:200000', 'marketdata')).toBe(
        'AAPL261218P00200000',
      );
    });
  });

  describe('unusual_whales', () => {
    it('converts SPY $500 call to OCC', () => {
      expect(canonicalToVendor('O:SPY:20260320:C:500000', 'unusual_whales')).toBe(
        'SPY260320C00500000',
      );
    });
  });

  it('rejects invalid canonical IDs', () => {
    expect(() => canonicalToVendor('INVALID', 'marketdata')).toThrow('Invalid canonical');
  });
});

// ── Round-trip vendor ↔ canonical ────────────────────────────────

describe('round-trip vendor ↔ canonical', () => {
  const cases: Array<{ name: string; occ: string; canonical: string }> = [
    { name: 'SPY $500 call', occ: 'SPY260320C00500000', canonical: 'O:SPY:20260320:C:500000' },
    { name: 'TSLA $1234.56 put', occ: 'TSLA260619P01234560', canonical: 'O:TSLA:20260619:P:1234560' },
    { name: 'F $0.50 call', occ: 'F260116C00000500', canonical: 'O:F:20260116:C:500' },
    { name: 'AAPL $200 put', occ: 'AAPL261218P00200000', canonical: 'O:AAPL:20261218:P:200000' },
    { name: 'QQQ $420.69 call', occ: 'QQQ260918C00420690', canonical: 'O:QQQ:20260918:C:420690' },
  ];

  for (const { name, occ, canonical } of cases) {
    it(`marketdata round-trip: ${name}`, () => {
      expect(vendorToCanonical('marketdata', occ)).toBe(canonical);
      expect(canonicalToVendor(canonical, 'marketdata')).toBe(occ);
    });

    it(`unusual_whales round-trip: ${name}`, () => {
      expect(vendorToCanonical('unusual_whales', occ)).toBe(canonical);
      expect(canonicalToVendor(canonical, 'unusual_whales')).toBe(occ);
    });
  }
});
