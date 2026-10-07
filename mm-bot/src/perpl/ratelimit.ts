// Token bucket for Perpl's trading request budget (README "Rate Limits": 60/min on testnet, 120/min mainnet; pings count).
// We run at ≤ 50/min on testnet so a burst never closes the socket with 1008 (which loses in-flight requests silently).
export class TokenBucket {
  private tokens: number;
  private last: number;
  constructor(
    readonly capacity: number,
    /** tokens per minute */
    readonly perMinute: number,
    now: number,
  ) {
    if (!(capacity >= 1) || !(perMinute > 0)) throw new RangeError("capacity >= 1 and perMinute > 0");
    this.tokens = capacity;
    this.last = now;
  }
  private refill(now: number): void {
    if (now > this.last) {
      this.tokens = Math.min(this.capacity, this.tokens + ((now - this.last) * this.perMinute) / 60_000);
      this.last = now;
    }
  }
  /** Takes one token if available. */
  tryTake(now: number): boolean {
    this.refill(now);
    if (this.tokens < 1) return false;
    this.tokens -= 1;
    return true;
  }
  /** ms until one token is available (0 = now). */
  waitMs(now: number): number {
    this.refill(now);
    return this.tokens >= 1 ? 0 : Math.ceil(((1 - this.tokens) * 60_000) / this.perMinute);
  }
}
