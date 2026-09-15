'use strict';

// Hunter rate-limits the Hydrawise cloud per account. The GraphQL client
// (lib/HydrawiseSensors.js) has honoured that from the start; the legacy
// statusschedule.php / setzone.php path had no notion of it at all, so a 429
// surfaced raw to the user and left the zone device unavailable.
//
// This is the shared gate for the legacy path. Deliberately tiny and
// dependency-free so app.js, Zone.js and the tests can all use it.

/** Never retry sooner than this after a 429, even if the server asks for less. */
const MIN_BACKOFF_MS = 60000;

class RateLimit {
  constructor({ now = Date.now } = {}) {
    this.now = now;
    this.retryAfter = 0;
  }

  /** True while the account is in a server-requested cool-off. */
  get limited() {
    return this.now() < this.retryAfter;
  }

  /** Milliseconds left of the cool-off, 0 when clear. */
  get remaining() {
    return Math.max(0, this.retryAfter - this.now());
  }

  /**
   * Records a 429. `retryAfterHeader` is HTTP's `Retry-After`: either a
   * seconds count or an HTTP date — both shapes are accepted, and anything
   * unparseable falls back to the floor rather than to "retry immediately".
   */
  penalise(retryAfterHeader) {
    const seconds = Number(retryAfterHeader);
    const delay = Number.isFinite(seconds)
      ? seconds * 1000
      : Date.parse(retryAfterHeader) - this.now();
    this.retryAfter = this.now() + Math.max(MIN_BACKOFF_MS, Number.isFinite(delay) ? delay : 0);
  }

  /** Clears the cool-off — used after a successful call. */
  clear() {
    this.retryAfter = 0;
  }
}

module.exports = { RateLimit, MIN_BACKOFF_MS };
