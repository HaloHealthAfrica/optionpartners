export interface QuoteSnapshot {
  bid: number;
  ask: number;
  mid: number;
  capturedAt: number;
}

export interface FillEstimate {
  fillPrice: number;
  side: 'BUY' | 'SELL';
  quoteSnapshot: QuoteSnapshot;
}

export interface SpreadFillEstimate {
  netPrice: number;
  direction: 'CREDIT' | 'DEBIT';
  shortFill: FillEstimate;
  longFill: FillEstimate;
}

export function estimateFill(side: 'BUY' | 'SELL', bid: number, ask: number): FillEstimate {
  const mid = (bid + ask) / 2;
  return {
    fillPrice: side === 'BUY' ? ask : bid,
    side,
    quoteSnapshot: { bid, ask, mid, capturedAt: Date.now() },
  };
}

export function estimateSpreadFill(
  shortBid: number,
  shortAsk: number,
  longBid: number,
  longAsk: number,
  direction: 'CREDIT' | 'DEBIT',
): SpreadFillEstimate {
  const shortFill = estimateFill('SELL', shortBid, shortAsk);
  const longFill = estimateFill('BUY', longBid, longAsk);

  const netPrice = direction === 'CREDIT'
    ? shortBid - longAsk
    : longAsk - shortBid;

  return { netPrice, direction, shortFill, longFill };
}
