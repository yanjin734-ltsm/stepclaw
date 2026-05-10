import express from 'express';
import { StepClawClient } from './stepclaw-client';
import { OpenAIHandler } from './openai-handler';
import { logger } from './logger';

function loadConfig() {
  // Load .env file if present
  try {
    const fs = require('fs');
    const path = require('path');
    const envPath = path.resolve(process.cwd(), '.env');
    if (fs.existsSync(envPath)) {
      const envContent = fs.readFileSync(envPath, 'utf-8');
      for (const line of envContent.split('\n')) {
        const trimmed = line.trim();
        if (trimmed && !trimmed.startsWith('#')) {
          const eqIndex = trimmed.indexOf('=');
          if (eqIndex > 0) {
            const key = trimmed.slice(0, eqIndex).trim();
            const value = trimmed.slice(eqIndex + 1).trim();
            if (!process.env[key]) {
              process.env[key] = value;
            }
          }
        }
      }
    }
  } catch (e) {
    // .env loading is optional
  }

  // Auto-detect StepClaw local proxy settings
  const baseUrl = process.env.STEPCLAW_BASE_URL || 'http://127.0.0.1:3199/v1';
  const apiKey = process.env.STEPCLAW_API_KEY || 'stepfun-model-proxy';
  const defaultModel = process.env.STEPCLAW_DEFAULT_MODEL || 'step-alpha';
  const port = parseInt(process.env.PORT || '8080', 10);

  return { baseUrl, apiKey, defaultModel, port };
}

async function main() {
  const config = loadConfig();

  logger.info(`Starting stepclaw-opencode-proxy v2.0.0`);
  logger.info(`StepClaw local proxy: ${config.baseUrl}`);
  logger.info(`Default model: ${config.defaultModel}`);

  // Initialize client
  const client = new StepClawClient({
    baseUrl: config.baseUrl,
    apiKey: config.apiKey,
    defaultModel: config.defaultModel,
  });

  // Health check - verify StepClaw desktop app is running
  logger.info('Checking StepClaw desktop app connectivity...');
  const healthy = await client.healthCheck();
  if (!healthy) {
    logger.warn('');
    logger.warn('⚠ Cannot reach StepClaw local proxy at ' + config.baseUrl);
    logger.warn('  Make sure the 阶跃AI桌面伙伴 (StepFun desktop app) is running.');
    logger.warn('  The proxy will start anyway and retry on each request.');
    logger.warn('');
  } else {
    logger.info('StepClaw local proxy is reachable. Connection OK.');
  }

  const handler = new OpenAIHandler(client);

  // Create Express app
  const app = express();
  app.use(express.json({ limit: '10mb' }));

  // Health check
  app.get('/', (_req, res) => {
    res.json({
      status: 'ok',
      service: 'stepclaw-opencode-proxy',
      version: '2.0.0',
      upstream: config.baseUrl,
      endpoints: {
        models: '/v1/models',
        chat: '/v1/chat/completions',
      },
    });
  });

  // OpenAI-compatible endpoints
  app.get('/v1/models', (req, res) => handler.listModels(req, res));
  app.post('/v1/chat/completions', (req, res) => handler.chatCompletions(req, res));

  // Start server
  app.listen(config.port, '127.0.0.1', () => {
    logger.info(`Proxy server listening on http://127.0.0.1:${config.port}`);
    logger.info('');
    logger.info('=== OpenCode Configuration ===');
    logger.info('Add this to ~/.config/opencode/opencode.json:');
    logger.info('');
    logger.info(`  "providers": {`);
    logger.info(`    "stepclaw": {`);
    logger.info(`      "baseUrl": "http://127.0.0.1:${config.port}/v1",`);
    logger.info(`      "api": "openai-completions",`);
    logger.info(`      "apiKey": "not-needed"`);
    logger.info(`    }`);
    logger.info(`  }`);
    logger.info('');
    logger.info('Ready to accept requests.');
  });
}

main();
