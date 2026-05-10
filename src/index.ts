import express from 'express';
import { StepChatClient } from './stepchat-client';
import { OpenAIHandler } from './openai-handler';
import { logger } from './logger';

function loadConfig() {
  const tokensRaw = process.env.STEP_TOKENS || '';
  const tokens = tokensRaw.split(',').map(t => t.trim()).filter(t => t.length > 0);

  if (tokens.length === 0) {
    console.error('[ERROR] STEP_TOKENS environment variable is required.');
    console.error('');
    console.error('How to get your token:');
    console.error('  1. Open https://stepchat.cn and log in');
    console.error('  2. Open DevTools (F12) -> Application -> Cookies');
    console.error('  3. Copy the value of the "token" cookie');
    console.error('  4. Set STEP_TOKENS=your_token_value');
    console.error('  5. For multiple tokens: STEP_TOKENS=token1,token2,token3');
    console.error('');
    process.exit(1);
  }

  return {
    port: parseInt(process.env.PORT || '8080', 10),
    baseUrl: process.env.STEP_BASE_URL || 'https://stepchat.cn',
    tokens,
  };
}

function main() {
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

  const config = loadConfig();

  logger.info(`Starting stepclaw-opencode-proxy v1.0.0`);
  logger.info(`Tokens loaded: ${config.tokens.length}`);
  logger.info(`Target: ${config.baseUrl}`);

  // Initialize client and handler
  const client = new StepChatClient({
    baseUrl: config.baseUrl,
    tokens: config.tokens,
  });

  const handler = new OpenAIHandler(client);

  // Create Express app
  const app = express();
  app.use(express.json({ limit: '10mb' }));

  // Health check
  app.get('/', (_req, res) => {
    res.json({
      status: 'ok',
      service: 'stepclaw-opencode-proxy',
      version: '1.0.0',
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
    logger.info(`OpenCode config: baseUrl = "http://127.0.0.1:${config.port}/v1"`);
    logger.info('');
    logger.info('Ready to accept requests.');
  });
}

main();
