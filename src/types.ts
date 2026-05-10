export interface UpstreamConfig {
  name: string;
  baseUrl: string;
  apiKey: string;
  weight: number;
}

export interface RoutingConfig {
  strategy: 'rendezvous-hash';
  sessionTtlSeconds: number;
}

export interface RetriesConfig {
  maxRetries: number;
  twoFailuresWindowSeconds: number;
  twoFailuresToMigrate: number;
}

export interface CooldownsConfig {
  rateLimitSeconds: number;
  transportErrorSeconds: number;
  serverErrorSeconds: number;
}

export interface HealthCheckConfig {
  enabled: boolean;
  intervalSeconds: number;
  consecutiveFailures: number;
}

export interface ProxyConfig {
  upstreams: UpstreamConfig[];
  routing: RoutingConfig;
  retries: RetriesConfig;
  cooldowns: CooldownsConfig;
  healthCheck: HealthCheckConfig;
}

export interface SessionBinding {
  upstreamName: string;
  createdAt: number;
  updatedAt: number;
}

export interface FailureRecord {
  count: number;
  firstFailureAt: number;
  lastFailureAt: number;
}

export interface CooldownRecord {
  until: number;
  reason: string;
}

export type SwitchableError =
  | { type: 'rate-limit'; statusCode: 429 }
  | { type: 'transport-error'; error: Error }
  | { type: 'server-error'; statusCode: number };

export type NonSwitchableError =
  | { type: 'client-error'; statusCode: number; message: string }
  | { type: 'unknown'; error: Error };

export interface RequestContext {
  requestId: string;
  sessionKey: string;
  chosenUpstream: string;
  retriesCount: number;
  migrationOccurred: boolean;
  upstreamStatusCode?: number;
  errorType?: string;
  latencyMs: number;
}
