/**
 * Shared HTTP client with retry + backoff for Polymarket APIs.
 *
 * All three APIs (gamma, data, clob) periodically return 429 (rate limit) or
 * transient 5xx. A single hiccup shouldn't abort a multi-hour backfill.
 */
import { createLogger } from '../logger.js';

const log = createLogger('http');

interface RetryOptions {
  maxAttempts?: number;  // total tries (including first)
  baseDelayMs?: number;  // initial backoff
  maxDelayMs?: number;   // cap
}

const DEFAULT_RETRY: Required<RetryOptions> = {
  maxAttempts: 5,
  baseDelayMs: 500,
  maxDelayMs: 15_000,
};

async function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

function isRetryable(status: number): boolean {
  // 408 Request Timeout, 429 Too Many Requests, 502/503/504 transient upstream
  return status === 408 || status === 429 || (status >= 500 && status <= 599);
}

function backoff(attempt: number, opts: Required<RetryOptions>): number {
  // Exponential with jitter: base * 2^(attempt-1) ± 20%
  const exp = Math.min(opts.baseDelayMs * Math.pow(2, attempt - 1), opts.maxDelayMs);
  const jitter = exp * 0.2 * (Math.random() * 2 - 1);
  return Math.max(50, Math.floor(exp + jitter));
}

/**
 * Fetch JSON with retry on transient failures (429, 5xx, network errors).
 * Respects Retry-After header if present.
 * Optional `headers` param for authenticated endpoints (e.g. CLOB HMAC).
 */
export async function fetchJsonWithRetry<T>(
  url: string,
  label: string,
  options: RetryOptions = {},
  headers?: Record<string, string>,
): Promise<T> {
  const opts = { ...DEFAULT_RETRY, ...options };
  let lastErr: Error | null = null;

  for (let attempt = 1; attempt <= opts.maxAttempts; attempt++) {
    let res: Response;
    try {
      res = await fetch(url, headers ? { headers } : undefined);
    } catch (err) {
      // Network-level failure (DNS, socket, etc). Always retry.
      lastErr = new Error(`${label} fetch failed: ${(err as Error).message}`);
      if (attempt < opts.maxAttempts) {
        const delay = backoff(attempt, opts);
        log.warn({ url, attempt, delay, err: (err as Error).message }, 'Network error, retrying');
        await sleep(delay);
        continue;
      }
      throw lastErr;
    }

    if (res.ok) {
      return res.json() as Promise<T>;
    }

    if (isRetryable(res.status) && attempt < opts.maxAttempts) {
      // Honour Retry-After if present (seconds or HTTP-date).
      const ra = res.headers.get('retry-after');
      let delay = backoff(attempt, opts);
      if (ra) {
        const raSec = parseInt(ra, 10);
        if (Number.isFinite(raSec) && raSec > 0) delay = Math.min(raSec * 1000, opts.maxDelayMs);
      }
      log.warn({ url, attempt, status: res.status, delay }, 'Transient HTTP error, retrying');
      await sleep(delay);
      continue;
    }

    // Non-retryable or out of attempts
    throw new Error(`${label} error: ${res.status} ${res.statusText} for ${url}`);
  }

  // Shouldn't reach here, but TypeScript needs it
  throw lastErr ?? new Error(`${label}: exhausted retries for ${url}`);
}
