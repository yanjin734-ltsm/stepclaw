import { logger } from './logger';

interface TokenState {
  token: string;
  failedAt: number | null;
  cooldownMs: number;
}

/**
 * Manages multiple tokens with round-robin rotation and failure cooldown.
 * When a token fails (rate limit, expired), it enters a cooldown period
 * before being retried.
 */
export class TokenManager {
  private tokens: TokenState[];
  private currentIndex: number = 0;
  private defaultCooldownMs: number = 60_000; // 1 minute cooldown

  constructor(tokens: string[], cooldownMs?: number) {
    if (tokens.length === 0) {
      throw new Error('At least one token is required');
    }

    if (cooldownMs) {
      this.defaultCooldownMs = cooldownMs;
    }

    this.tokens = tokens.map(t => ({
      token: t.trim(),
      failedAt: null,
      cooldownMs: this.defaultCooldownMs,
    }));

    logger.info(`TokenManager initialized with ${this.tokens.length} token(s)`);
  }

  /**
   * Get the next available token using round-robin.
   * Skips tokens that are in cooldown.
   * Throws if all tokens are in cooldown.
   */
  getNext(): string {
    const now = Date.now();
    const totalTokens = this.tokens.length;

    for (let i = 0; i < totalTokens; i++) {
      const index = (this.currentIndex + i) % totalTokens;
      const state = this.tokens[index];

      // Check if token is available (not failed or cooldown expired)
      if (state.failedAt === null || (now - state.failedAt) > state.cooldownMs) {
        // Reset if cooldown expired
        if (state.failedAt !== null) {
          state.failedAt = null;
          logger.info(`Token #${index + 1} cooldown expired, back in rotation`);
        }

        this.currentIndex = (index + 1) % totalTokens;
        return state.token;
      }
    }

    // All tokens in cooldown - find the one that will recover soonest
    const soonest = this.tokens.reduce((min, t) => {
      if (t.failedAt === null) return min;
      const recoveryTime = t.failedAt + t.cooldownMs;
      return recoveryTime < min ? recoveryTime : min;
    }, Infinity);

    const waitMs = soonest - now;
    throw new Error(`All tokens are in cooldown. Next available in ${Math.ceil(waitMs / 1000)}s`);
  }

  /**
   * Mark a token as failed. It will enter cooldown.
   */
  markFailed(token: string): void {
    const state = this.tokens.find(t => t.token === token);
    if (state) {
      state.failedAt = Date.now();
      const index = this.tokens.indexOf(state);
      logger.warn(`Token #${index + 1} marked as failed, cooldown ${state.cooldownMs / 1000}s`);
    }
  }

  /**
   * Get count of currently available tokens
   */
  getAvailableCount(): number {
    const now = Date.now();
    return this.tokens.filter(t =>
      t.failedAt === null || (now - t.failedAt) > t.cooldownMs
    ).length;
  }

  /**
   * Get total token count
   */
  getTotalCount(): number {
    return this.tokens.length;
  }
}
