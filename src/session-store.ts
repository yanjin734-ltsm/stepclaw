import { SessionBinding, FailureRecord, CooldownRecord } from './types';
import { logger } from './logger';
import * as fs from 'fs';
import * as path from 'path';

export class SessionStore {
  private bindings: Map<string, SessionBinding> = new Map();
  private failures: Map<string, Map<string, FailureRecord>> = new Map();
  private cooldowns: Map<string, Map<string, CooldownRecord>> = new Map();
  private dataDir: string;
  private bindingsFile: string;

  constructor(dataDir: string = './data') {
    this.dataDir = dataDir;
    this.bindingsFile = path.join(dataDir, 'session-bindings.json');
    this.ensureDir();
    this.load();
  }

  private ensureDir(): void {
    if (!fs.existsSync(this.dataDir)) {
      fs.mkdirSync(this.dataDir, { recursive: true });
    }
  }

  private load(): void {
    try {
      if (fs.existsSync(this.bindingsFile)) {
        const raw = fs.readFileSync(this.bindingsFile, 'utf-8');
        const data = JSON.parse(raw);
        if (data.bindings) {
          for (const [key, val] of Object.entries(data.bindings)) {
            this.bindings.set(key, val as SessionBinding);
          }
        }
        logger.info(`Loaded ${this.bindings.size} session bindings from disk`);
      }
    } catch (err: any) {
      logger.warn(`Failed to load session bindings: ${err.message}`);
    }
  }

  save(): void {
    try {
      const obj: Record<string, SessionBinding> = {};
      for (const [key, val] of this.bindings) {
        obj[key] = val;
      }
      fs.writeFileSync(this.bindingsFile, JSON.stringify({ bindings: obj }, null, 2));
    } catch (err: any) {
      logger.warn(`Failed to save session bindings: ${err.message}`);
    }
  }

  getBinding(sessionKey: string): SessionBinding | undefined {
    return this.bindings.get(sessionKey);
  }

  setBinding(sessionKey: string, upstreamName: string): void {
    const now = Date.now();
    const existing = this.bindings.get(sessionKey);
    this.bindings.set(sessionKey, {
      upstreamName,
      createdAt: existing ? existing.createdAt : now,
      updatedAt: now,
    });
    // 异步保存
    setTimeout(() => this.save(), 0);
  }

  removeBinding(sessionKey: string): void {
    this.bindings.delete(sessionKey);
    setTimeout(() => this.save(), 0);
  }

  recordFailure(sessionKey: string, upstreamName: string, windowSeconds: number): FailureRecord {
    const now = Date.now();
    if (!this.failures.has(sessionKey)) {
      this.failures.set(sessionKey, new Map());
    }
    const upstreamMap = this.failures.get(sessionKey)!;
    let record = upstreamMap.get(upstreamName);
    if (!record) {
      record = { count: 0, firstFailureAt: now, lastFailureAt: now };
    }
    // 清理过期窗口
    if (now - record.firstFailureAt > windowSeconds * 1000) {
      record = { count: 0, firstFailureAt: now, lastFailureAt: now };
    }
    record.count++;
    record.lastFailureAt = now;
    upstreamMap.set(upstreamName, record);
    return record;
  }

  clearFailures(sessionKey: string, upstreamName: string): void {
    const upstreamMap = this.failures.get(sessionKey);
    if (upstreamMap) {
      upstreamMap.delete(upstreamName);
    }
  }

  setCooldown(sessionKey: string, upstreamName: string, durationSeconds: number, reason: string): void {
    const until = Date.now() + durationSeconds * 1000;
    if (!this.cooldowns.has(sessionKey)) {
      this.cooldowns.set(sessionKey, new Map());
    }
    this.cooldowns.get(sessionKey)!.set(upstreamName, { until, reason });
  }

  isCooldown(sessionKey: string, upstreamName: string): boolean {
    const upstreamMap = this.cooldowns.get(sessionKey);
    if (!upstreamMap) return false;
    const record = upstreamMap.get(upstreamName);
    if (!record) return false;
    if (Date.now() > record.until) {
      upstreamMap.delete(upstreamName);
      return false;
    }
    return true;
  }

  getCooldownReason(sessionKey: string, upstreamName: string): string | undefined {
    const upstreamMap = this.cooldowns.get(sessionKey);
    if (!upstreamMap) return undefined;
    const record = upstreamMap.get(upstreamName);
    if (!record || Date.now() > record.until) return undefined;
    return record.reason;
  }

  cleanupExpired(ttlSeconds: number): void {
    const now = Date.now();
    const cutoff = now - ttlSeconds * 1000;
    let removed = 0;
    for (const [key, binding] of this.bindings) {
      if (binding.updatedAt < cutoff) {
        this.bindings.delete(key);
        this.failures.delete(key);
        this.cooldowns.delete(key);
        removed++;
      }
    }
    if (removed > 0) {
      logger.info(`Cleaned up ${removed} expired session bindings`);
      this.save();
    }
  }

  getAllBindings(): Map<string, SessionBinding> {
    return new Map(this.bindings);
  }

  getSessionCount(): number {
    return this.bindings.size;
  }
}
