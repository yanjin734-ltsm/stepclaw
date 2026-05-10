import express from 'express';
import { OpenAIHandler } from './openai-handler';
import { Scheduler } from './scheduler';
import { SessionStore } from './session-store';
import { logger } from './logger';
import { ProxyConfig, UpstreamConfig } from './types';
import * as fs from 'fs';
import * as path from 'path';

const DEFAULT_CONFIG: ProxyConfig = {
  upstreams: [
    {
      name: 'default',
      baseUrl: process.env.STEPCLAW_BASE_URL || 'http://127.0.0.1:3199/v1',
      apiKey: process.env.STEPCLAW_API_KEY || 'stepfun-model-proxy',
      weight: 1,
    },
  ],
  routing: {
    strategy: 'rendezvous-hash',
    sessionTtlSeconds: 86400,
  },
  retries: {
    maxRetries: 2,
    twoFailuresWindowSeconds: 60,
    twoFailuresToMigrate: 2,
  },
  cooldowns: {
    rateLimitSeconds: 1800,
    transportErrorSeconds: 300,
    serverErrorSeconds: 300,
  },
  healthCheck: {
    enabled: true,
    intervalSeconds: 15,
    consecutiveFailures: 3,
  },
};

function loadConfig(): ProxyConfig {
  // 1. Try config file
  const configPaths = [
    path.resolve(process.cwd(), 'config', 'upstreams.json'),
    path.resolve(process.cwd(), 'upstreams.json'),
  ];

  for (const configPath of configPaths) {
    if (fs.existsSync(configPath)) {
      try {
        const raw = fs.readFileSync(configPath, 'utf-8');
        const parsed = JSON.parse(raw);
        logger.info(`Loaded config from ${configPath}`);
        return { ...DEFAULT_CONFIG, ...parsed };
      } catch (err: any) {
        logger.warn(`Failed to parse config ${configPath}: ${err.message}`);
      }
    }
  }

  // 2. Fallback to env vars (single upstream mode)
  logger.info('No config file found, using environment variables (single upstream mode)');
  return DEFAULT_CONFIG;
}

async function main() {
  const config = loadConfig();
  const port = parseInt(process.env.PORT || '8080', 10);

  logger.info(`Starting stepclaw-opencode-proxy v3.0.0 (multi-upstream)`);
  logger.info(`Loaded ${config.upstreams.length} upstream(s)`);
  for (const u of config.upstreams) {
    logger.info(`  - ${u.name}: ${u.baseUrl} (weight=${u.weight})`);
  }

  // Initialize session store and scheduler
  const store = new SessionStore('./data');
  const scheduler = new Scheduler(config, store);

  // Health check loop
  if (config.healthCheck.enabled) {
    setInterval(async () => {
      for (const upstream of config.upstreams) {
        try {
          const fetch = (await import('node-fetch')).default;
          const response = await fetch(`${upstream.baseUrl}/chat/completions`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Authorization': `Bearer ${upstream.apiKey}`,
            },
            body: JSON.stringify({
              model: 'step-alpha',
              messages: [{ role: 'user', content: 'ping' }],
              max_tokens: 1,
              stream: false,
            }),
          });
          scheduler.setUpstreamHealth(upstream.name, response.ok);
        } catch {
          scheduler.setUpstreamHealth(upstream.name, false);
        }
      }
    }, config.healthCheck.intervalSeconds * 1000);
  }

  const handler = new OpenAIHandler(scheduler, store, config);

  // Create Express app
  const app = express();
  app.use(express.json({ limit: '10mb' }));

  // Health check
  app.get('/', (_req, res) => {
    const states = scheduler.getAllStates();
    res.json({
      status: 'ok',
      service: 'stepclaw-opencode-proxy',
      version: '3.0.0',
      upstreams: states.map(s => ({
        name: s.config.name,
        healthy: s.healthy,
        baseUrl: s.config.baseUrl,
        totalRequests: s.totalRequests,
        failedRequests: s.failedRequests,
      })),
      endpoints: {
        models: '/v1/models',
        chat: '/v1/chat/completions',
      },
    });
  });

  // OpenAI-compatible endpoints
  app.get('/v1/models', (req, res) => handler.listModels(req, res));
  app.post('/v1/chat/completions', (req, res) => handler.chatCompletions(req, res));

  // Admin endpoints (localhost only)
  app.get('/_admin/upstreams', (_req, res) => {
    const states = scheduler.getAllStates();
    res.json({
      upstreams: states.map(s => ({
        name: s.config.name,
        baseUrl: s.config.baseUrl,
        healthy: s.healthy,
        consecutiveFailures: s.consecutiveFailures,
        lastHealthCheck: s.lastHealthCheck,
        totalRequests: s.totalRequests,
        failedRequests: s.failedRequests,
      })),
    });
  });

  app.get('/_admin/sessions', (_req, res) => {
    const bindings = store.getAllBindings();
    const sessions: Array<{ sessionKey: string; upstream: string; createdAt: number; updatedAt: number }> = [];
    for (const [key, binding] of bindings) {
      sessions.push({
        sessionKey: key.slice(0, 4) + '****' + key.slice(-4),
        upstream: binding.upstreamName,
        createdAt: binding.createdAt,
        updatedAt: binding.updatedAt,
      });
    }
    res.json({
      totalSessions: sessions.length,
      sessions: sessions.slice(0, 100),
    });
  });

  app.post('/_admin/upstreams/:name/disable', (req, res) => {
    const name = req.params.name;
    scheduler.disableUpstream(name);
    res.json({ message: `Upstream ${name} disabled` });
  });

  app.post('/_admin/upstreams/:name/enable', (req, res) => {
    const name = req.params.name;
    scheduler.enableUpstream(name);
    res.json({ message: `Upstream ${name} enabled` });
  });

  // Start server
  app.listen(port, '127.0.0.1', () => {
    logger.info(`Proxy server listening on http://127.0.0.1:${port}`);
    logger.info('');
    logger.info('=== OpenCode Configuration ===');
    logger.info('Add this to ~/.config/opencode/opencode.json:');
    logger.info('');
    logger.info(`  "providers": {`);
    logger.info(`    "stepclaw": {`);
    logger.info(`      "baseUrl": "http://127.0.0.1:${port}/v1",`);
    logger.info(`      "api": "openai-completions",`);
    logger.info(`      "apiKey": "your-session-key-or-not-needed"`);
    logger.info(`    }`);
    logger.info(`  }`);
    logger.info('');
    logger.info('Ready to accept requests.');
  });
}

main();
