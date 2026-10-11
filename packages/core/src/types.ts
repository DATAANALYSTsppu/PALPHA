// === Polymarket API Types ===

export interface PolyTag {
  id: string;
  label: string;
  slug: string;
}

export interface PolyMarket {
  id: string;
  question: string;
  conditionId: string;
  slug: string;
  closed: boolean;
  active: boolean;
  endDate: string;
  outcomePrices: string; // JSON string of [yesPrice, noPrice]
  clobTokenIds?: string; // JSON string of [yesTokenId, noTokenId]
  description?: string;
  enableOrderBook?: boolean;
  outcomes?: string; // JSON string
  tags?: PolyTag[];
  negRisk?: boolean;
  minimum_tick_size?: number;
}

export interface PolyEvent {
  id: string;
  title: string;
  slug: string;
  description?: string;
  endDate: string;
  closed?: boolean;
  active?: boolean;
  tags?: PolyTag[];
  markets?: PolyMarket[];
}

export interface PolyTrade {
  proxyWallet: string;
  side: 'BUY' | 'SELL';
  asset: string;
  conditionId: string;
  size: number;
  price: number;
  timestamp: number;
  title: string;
  slug: string;
  outcome: string; // 'Yes' or 'No'
  outcomeIndex: number;
  name?: string;
  pseudonym?: string;
  eventSlug?: string;
  transactionHash?: string;
}

export interface PolyPosition {
  proxyWallet: string;
  asset: string;
  conditionId: string;
  size: number;
  avgPrice: number;
  initialValue: number;
  currentValue: number;
  cashPnl: number;
  percentPnl: number;
  totalBought: number;
  realizedPnl: number;
  curPrice: number;
  redeemable: boolean;
  title: string;
  slug: string;
  outcome: string;
  outcomeIndex: number;
  endDate: string;
}

// === Generic Classified Event ===

export interface ClassifiedEvent {
  polyEventId: number;
  title: string;
  slug: string;
  description?: string;
  endDate: string;
  category: string;      // "weather", "sports", etc.
  subcategory?: string;  // sport type, weather category, etc.
  subcategoryDetail?: string; // league, city, etc.
  tags: string[];
}

// === Plugin System ===

export interface CategoryPlugin {
  name: string;
  tags: string[];
  keywords: Record<string, string[]>;
  blacklist: string[];
  classifyEvent(event: PolyEvent): ClassifiedEvent | null;
  isMatchingEvent(event: PolyEvent): boolean;
  getMigrationDir(): string;
  getExtraScoring?(): { diversityField: string; diversityWeight: number };
}

// === Trading Engine ===

export type TradingMode = 'paper' | 'live';

export interface TradingEngine {
  mode: TradingMode;
  openPosition(params: OpenPositionParams): Promise<{ id: number; orderId?: string }>;
  closePosition(positionId: number, exitPrice: number, reason: string): Promise<void>;
  getBalance(): Promise<number>;
  getOpenPositions(): Promise<Position[]>;
  getOpenPositionCount(): Promise<number>;
  getDailyRealizedLoss(): Promise<number>;
  hasOpenPositionForMarket(targetId: number, conditionId: string): Promise<boolean>;
}

export interface OpenPositionParams {
  copyTargetId: number;
  marketId: number;
  eventId: number;
  conditionId: string;
  side: 'YES' | 'NO';
  entryPrice: number;
  sizeUsd: number;
  shares: number;
  metadata?: Record<string, unknown>;
}

export interface Position {
  id: number;
  copyTargetId: number;
  marketId: number;
  eventId: number;
  conditionId: string;
  side: string;
  entryPrice: number;
  sizeUsd: number;
  shares: number;
  status: string;
  openedAt: Date;
  closedAt?: Date;
  exitPrice?: number;
  pnl?: number;
  metadata: Record<string, unknown>;
}

// === Trader & Copy Trading Types ===

export interface TraderStats {
  proxyWallet: string;
  displayName?: string;
  totalTrades: number;
  totalMarkets: number;
  winRate: number;
  roi: number;
  totalPnl: number;
  consistencyScore: number;
  compositeScore: number;
  categories: string[]; // sports, cities, etc. depending on plugin
}

export interface CopyTarget {
  id: number;
  proxyWallet: string;
  displayName?: string;
  compositeScore: number;
  winRate: number;
  roi: number;
  totalTrades: number;
  totalMarkets: number;
  status: string;
  addedAt: Date;
  lastCheckedAt?: Date;
}

export interface CopySignal {
  copyTargetId: number;
  proxyWallet: string;
  conditionId: string;
  marketId: number;
  eventId: number;
  side: 'YES' | 'NO';
  price: number;
  traderSize: number;
  timestamp: number;
}

export interface Account {
  id: number;
  address: string;
  proxyWallet?: string;
  balance: number;
  totalDeposited: number;
  totalWithdrawn: number;
  createdAt: Date;
}

// === Configuration Types ===

export interface PaperTradingConfig {
  enabled: boolean;
  initialBalance: number;
  positionSize: number;
  maxPricePerShare: number;
  minHoursBeforeResolution: number;
  maxOpenPositions: number;
  dailyLossLimit: number;
  pollIntervalMs: number;
}

export interface FilterConfig {
  maxPrice: number;
  maxHoursToResolution: number;
  maxPositions: number;
  dailyLossLimit: number;
  positionSize: number;
  excludeSubcategories: string[];
  convertPriceThreshold: number;
  pollIntervalMs: number;
}

export interface ScoringWeights {
  winRate: number;
  roi: number;
  consistency: number;
  marketCount: number;
  diversity: number;
}

// === V2 Clean Ingestion Types ===

/**
 * Trade type as labeled by Polymarket data-api `type` field.
 * - TRADE: normal buy/sell
 * - CONVERT: Yes+No redemption at $1 (signal noise)
 * - REDEEM: winning position cashed out
 * - MERGE: combining Yes+No back into collateral
 * - SPLIT: splitting collateral into Yes+No
 */
export type PolyTradeType = 'TRADE' | 'CONVERT' | 'REDEEM' | 'MERGE' | 'SPLIT' | string;

export type TraderRole = 'maker' | 'taker';

/**
 * Ingestion checkpoint — resume state for a data source.
 */
export interface IngestCheckpoint {
  source: string;
  cursorValue: string | null;
  recordsIngested: number;
  lastRunAt: Date | null;
  lastError: string | null;
  status: 'idle' | 'running' | 'error';
}

/**
 * Orderbook snapshot captured on a signal (for realistic slippage analysis).
 */
export interface OrderbookSnapshot {
  marketId: number;
  conditionId: string;
  tokenId: string;
  outcome: string;
  capturedAt: Date;
  bestBid: number | null;
  bestAsk: number | null;
  midpoint: number | null;
  spread: number | null;
  bids: Array<[number, number]>;
  asks: Array<[number, number]>;
  sourceHash?: string;
  trigger: 'signal' | 'scheduled' | 'trade';
  triggerRef?: string;
}

/**
 * Execution log — our entry price vs trader's entry price, latency, slippage.
 */
export interface ExecutionLogEntry {
  copySignalId?: number;
  copyTargetId: number;
  mode: TradingMode;
  conditionId: string;
  side: 'YES' | 'NO';
  traderPrice: number;
  traderTimestamp: number;
  ourPrice: number;
  ourTimestamp: Date;
  latencyMs: number;
  slippage: number;
  midpointAtSignal?: number;
  bestBidAtSignal?: number;
  bestAskAtSignal?: number;
  metadata?: Record<string, unknown>;
}
