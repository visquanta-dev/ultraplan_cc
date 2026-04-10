// ---------------------------------------------------------------------------
// Retry with exponential backoff — Phase 13
// Used by scraping (3 attempts) and PR creation (3 attempts).
// ---------------------------------------------------------------------------

export interface RetryOptions {
  /** Maximum number of attempts (including the first). Default: 3 */
  maxAttempts?: number;
  /** Base delay in ms between retries. Default: 1000 */
  baseDelayMs?: number;
  /** Optional logger for retry attempts */
  onRetry?: (attempt: number, error: Error) => void;
}

/**
 * Retry an async function with exponential backoff.
 * Delays: baseDelay * 2^(attempt-1) → 1s, 2s, 4s for default settings.
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  options: RetryOptions = {},
): Promise<T> {
  const maxAttempts = options.maxAttempts ?? 3;
  const baseDelayMs = options.baseDelayMs ?? 1000;

  let lastError: Error | undefined;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));

      if (attempt < maxAttempts) {
        const delay = baseDelayMs * Math.pow(2, attempt - 1);
        options.onRetry?.(attempt, lastError);
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }
  }

  throw lastError!;
}
