export class RetryableExtractionError extends Error {
  readonly retryable = true;
  constructor(message: string, readonly retryAfterMs?: number, readonly addJitter = false) { super(message); }
}
