import { UpstreamConfig, ProxyConfig, RequestContext } from './types';
import { SessionStore } from './session-store';
import { logger } from './logger';
import { createHash } from 'crypto';

export interface UpstreamState {
  config: UpstreamConfig;
  healthy: boolean;
  consecutiveFailures: number;
  lastHealthCheck: number;
  totalRequests: number;
  failedRequests: number;
}

export class Scheduler {
  private config: ProxyConfig;
  private store: SessionStore;
  private upstreams: Map<string, UpstreamState> = new Map();
  private cleanupInterval?: NodeJS.Timeout;

  constructor(config: ProxyConfig, store: SessionStore) {
    this.config = config;
    this.store = store;
    for (const u of config.upstreams) {
      this.upstreams.set(u.name, {
        config: u,
        healthy: true,
        consecutiveFailures: 0,
        lastHealthCheck: 0,
        totalRequests: 0,
        failedRequests: 0,
      });
    }
    this.startCleanup();
  }

  private startCleanup(): void {
    // 每 5 分钟清理一次过期 session
    this.cleanupInterval = setInterval(() => {
      this.store.cleanupExpired(this.config.routing.sessionTtlSeconds);
    }, 5 * 60 * 1000);
  }

  destroy(): void {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
    }
  }

  getUpstreamNames(): string[] {
    return Array.from(this.upstreams.keys());
  }

  getUpstreamState(name: string): UpstreamState | undefined {
    return this.upstreams.get(name);
  }

  getAllStates(): UpstreamState[] {
    return Array.from(this.upstreams.values());
  }

  /**
   * 为主 sessionKey 选择一个 upstream
   */
  selectUpstream(sessionKey: string): UpstreamState | null {
    // 1. 检查现有绑定
    const binding = this.store.getBinding(sessionKey);
    if (binding) {
      const state = this.upstreams.get(binding.upstreamName);
      if (state && state.healthy && !this.store.isCooldown(sessionKey, state.config.name)) {
        return state;
      }
      // 绑定失效或冷却中，需要重新选择
    }

    // 2. 获取可用 upstream 列表
    const available = this.getAvailableUpstreams(sessionKey);
    if (available.length === 0) {
      logger.warn(`No available upstreams for session ${this.maskKey(sessionKey)}`);
      return null;
    }

    // 3. 用 Rendezvous Hashing 选择
    const chosen = this.rendezvousHash(sessionKey, available);
    if (chosen) {
      this.store.setBinding(sessionKey, chosen.config.name);
      logger.info(`New binding: session=${this.maskKey(sessionKey)} -> upstream=${chosen.config.name}`);
    }
    return chosen;
  }

  /**
   * 获取对某个 session 可用的 upstream 列表（排除不健康、排除冷却中）
   */
  getAvailableUpstreams(sessionKey: string): UpstreamState[] {
    const result: UpstreamState[] = [];
    for (const state of this.upstreams.values()) {
      if (!state.healthy) continue;
      if (this.store.isCooldown(sessionKey, state.config.name)) {
        const reason = this.store.getCooldownReason(sessionKey, state.config.name);
        logger.debug(`Upstream ${state.config.name} in cooldown for session ${this.maskKey(sessionKey)}: ${reason}`);
        continue;
      }
      result.push(state);
    }
    return result;
  }

  /**
   * Rendezvous Hashing：一致性哈希，新增/删除 upstream 时影响最小
   */
  private rendezvousHash(sessionKey: string, candidates: UpstreamState[]): UpstreamState | null {
    if (candidates.length === 0) return null;

    let maxScore = -1;
    let winner: UpstreamState | null = null;

    for (const state of candidates) {
      const hash = createHash('sha256')
        .update(`${sessionKey}:${state.config.name}`)
        .digest('hex');
      // 把 hash 转成 0-1 的分数
      const score = parseInt(hash.slice(0, 16), 16) / 0xFFFFFFFFFFFFFFFF;
      // 乘以权重
      const weightedScore = score * state.config.weight;
      if (weightedScore > maxScore) {
        maxScore = weightedScore;
        winner = state;
      }
    }
    return winner;
  }

  /**
   * 记录请求成功
   */
  recordSuccess(sessionKey: string, upstreamName: string): void {
    const state = this.upstreams.get(upstreamName);
    if (state) {
      state.totalRequests++;
      state.consecutiveFailures = 0;
    }
    this.store.clearFailures(sessionKey, upstreamName);
  }

  /**
   * 记录请求失败，返回是否需要迁移
   */
  recordFailure(sessionKey: string, upstreamName: string, statusCode?: number, error?: Error): boolean {
    const state = this.upstreams.get(upstreamName);
    if (state) {
      state.totalRequests++;
      state.failedRequests++;
      state.consecutiveFailures++;
    }

    // 429：立即迁移
    if (statusCode === 429) {
      this.store.setCooldown(sessionKey, upstreamName, this.config.cooldowns.rateLimitSeconds, 'rate-limit');
      this.store.clearFailures(sessionKey, upstreamName);
      logger.warn(`Rate limit on ${upstreamName} for session ${this.maskKey(sessionKey)}, migrating`);
      return true;
    }

    // 5xx / 网络错误：检查短时间多次失败
    const record = this.store.recordFailure(
      sessionKey,
      upstreamName,
      this.config.retries.twoFailuresWindowSeconds
    );

    if (record.count >= this.config.retries.twoFailuresToMigrate) {
      const cooldown = statusCode && statusCode >= 500
        ? this.config.cooldowns.serverErrorSeconds
        : this.config.cooldowns.transportErrorSeconds;
      const reason = statusCode && statusCode >= 500 ? `server-error-${statusCode}` : 'transport-error';
      this.store.setCooldown(sessionKey, upstreamName, cooldown, reason);
      this.store.clearFailures(sessionKey, upstreamName);
      logger.warn(`Too many failures on ${upstreamName} for session ${this.maskKey(sessionKey)}, migrating (${reason})`);
      return true;
    }

    return false;
  }

  /**
   * 检查某次失败是否“可切换”
   */
  isSwitchableError(statusCode?: number, error?: Error): boolean {
    if (statusCode === 429) return true;
    if (statusCode && statusCode >= 500) return true;
    if (error) {
      const msg = error.message.toLowerCase();
      if (msg.includes('econnrefused') || msg.includes('etimeout') || msg.includes('econnreset') ||
          msg.includes('socket hang up') || msg.includes('network') || msg.includes('fetch failed')) {
        return true;
      }
    }
    return false;
  }

  /**
   * 检查是否为不可切换的客户端错误
   */
  isClientError(statusCode?: number): boolean {
    if (!statusCode) return false;
    return statusCode >= 400 && statusCode < 500 && statusCode !== 429;
  }

  /**
   * 健康检查：标记 upstream 健康/不健康
   */
  setUpstreamHealth(name: string, healthy: boolean): void {
    const state = this.upstreams.get(name);
    if (state) {
      const wasHealthy = state.healthy;
      state.healthy = healthy;
      state.lastHealthCheck = Date.now();
      if (!healthy) {
        state.consecutiveFailures++;
        logger.warn(`Upstream ${name} marked unhealthy (consecutive failures: ${state.consecutiveFailures})`);
      } else if (!wasHealthy && healthy) {
        state.consecutiveFailures = 0;
        logger.info(`Upstream ${name} recovered to healthy`);
      }
    }
  }

  /**
   * 手动禁用/启用 upstream
   */
  disableUpstream(name: string): void {
    this.setUpstreamHealth(name, false);
  }

  enableUpstream(name: string): void {
    this.setUpstreamHealth(name, true);
  }

  private maskKey(key: string): string {
    if (key.length <= 8) return '***';
    return key.slice(0, 4) + '****' + key.slice(-4);
  }
}
