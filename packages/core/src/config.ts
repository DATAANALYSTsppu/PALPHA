import { config as loadEnv } from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';
import { existsSync } from 'fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Load .env from whichever of these locations exists, in order:
//   1. packages/core/.env  (per-package convention)
//   2. <repo-root>/.env    (monorepo convention)
// Both work; pick whichever you prefer. Resolved from this file's own
// __dirname so cwd doesn't matter (PM2 vs tsx vs node all work).
// In source: packages/core/src/config.ts → core/.env is ../.env,  root/.env is ../../../.env
// In dist:   packages/core/dist/config.js → core/.env is ../.env,  root/.env is ../../../.env
const ENV_CANDIDATES = [
  resolve(__dirname, '..', '.env'),
  resolve(__dirname, '..', '..', '..', '.env'),
];
for (const path of ENV_CANDIDATES) {
  if (existsSync(path)) {
    loadEnv({ path });
    break;
  }
}

export const config = {
  database: {
    url: process.env.DATABASE_URL || 'postgresql://polymarket:polymarket_dev@localhost:5432/polymarket',
  },
  api: {
    gammaUrl: process.env.GAMMA_API_URL || 'https://gamma-api.polymarket.com',
    dataUrl: process.env.DATA_API_URL || 'https://data-api.polymarket.com',
    clobUrl: process.env.CLOB_API_URL || 'https://clob.polymarket.com',
    requestDelayMs: parseInt(process.env.API_DELAY_MS || '200'),
    pageSize: parseInt(process.env.API_PAGE_SIZE || '100'),
  },
  paperTrading: {
    enabled: process.env.PAPER_TRADING_ENABLED !== 'false',
    initialBalance: parseInt(process.env.PAPER_INITIAL_BALANCE || '1000'),
    positionSize: parseInt(process.env.PAPER_POSITION_SIZE || '10'),
    maxPricePerShare: parseFloat(process.env.PAPER_MAX_PRICE || '0.70'),
    minHoursBeforeResolution: parseInt(process.env.PAPER_MIN_HOURS || '6'),
    maxOpenPositions: parseInt(process.env.PAPER_MAX_POSITIONS || '20'),
    dailyLossLimit: parseInt(process.env.PAPER_DAILY_LOSS_LIMIT || '100'),
    pollIntervalMs: parseInt(process.env.PAPER_POLL_INTERVAL || '60000'),
  },
  liveTrade: {
    enabled: process.env.LIVE_TRADING_ENABLED === 'true',
    privateKey: process.env.POLY_PRIVATE_KEY || '',
    apiKey: process.env.POLY_API_KEY || '',
    apiSecret: process.env.POLY_API_SECRET || '',
    passphrase: process.env.POLY_PASSPHRASE || '',
  },
  scoring: {
    minMarkets: parseInt(process.env.SCORING_MIN_MARKETS || '5'),
    minTrades: parseInt(process.env.SCORING_MIN_TRADES || '20'),
    weights: {
      winRate: 0.40,
      roi: 0.30,
      consistency: 0.20,
      marketCount: 0.07,
      diversity: 0.03,
    },
  },
  polygon: {
    rpcUrl: process.env.POLYMARKET_RPC || process.env.POLYGON_RPC || 'https://polygon-rpc.com',
    chunkSize: parseInt(process.env.POLYGON_CHUNK_SIZE || '500'),
    concurrency: parseInt(process.env.POLYGON_CONCURRENCY || '5'),
  },
  logLevel: process.env.LOG_LEVEL || 'info',
};

export type AppConfig = typeof config;
