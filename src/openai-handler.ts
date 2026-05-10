import { Request, Response } from 'express';
import { StepClawClient, StepClawError } from './stepclaw-client';
import { Scheduler } from './scheduler';
import { SessionStore } from './session-store';
import { logger } from './logger';
import { v4 as uuidv4 } from 'uuid';
import { ProxyConfig } from './types';

/**
 * OpenAI-compatible API handler with multi-upstream support
 * 
 * Features:
 * - Sticky session routing based on apiKey
 * - Automatic failover between upstreams on errors
 * - Bounded retries (max 2 retries for non-streaming)
 * - SSE streaming with no mid-stream switching
 */
export class OpenAIHandler {
  private scheduler: Scheduler;
  private store: SessionStore;
  private config: ProxyConfig;

  constructor(scheduler: Scheduler, store: SessionStore, config: ProxyConfig) {
    this.scheduler = scheduler;
    this.store = store;
    this.config = config;
  }

  /**
   * Extract session key from Authorization header
   */
  private getSessionKey(req: Request): string {
    const auth = req.headers.authorization || '';
    const match = auth.match(/^Bearer\s+(.+)$/i);
    if (match) {
      return match[1].trim();
    }
    // Fallback to a default key if no auth provided
    return 'default-session';
  }

  /**
   * GET /v1/models - List available models
   */
  async listModels(_req: Request, res: Response): Promise<void> {
    res.json({
      object: 'list',
      data: [
        {
          id: 'step-3.5-flash',
          object: 'model',
          created: 1709893411,
          owned_by: 'stepfun',
        },
        {
          id: 'step-alpha',
          object: 'model',
          created: 1709893411,
          owned_by: 'stepfun',
        },
        {
          id: 'vision-model',
          object: 'model',
          created: 1709893411,
          owned_by: 'stepfun',
        },
      ],
    });
  }

  /**
   * POST /v1/chat/completions - Chat completion (streaming & non-streaming)
   * 
   * Routing logic:
   * 1. Extract sessionKey from Authorization header
   * 2. Select upstream using scheduler (sticky + failover)
   * 3. Forward request to upstream
   * 4. On failure, retry with different upstream if switchable
   * 5. For streaming: no mid-stream switching once started
   */
  async chatCompletions(req: Request, res: Response): Promise<void> {
    const requestId = uuidv4().slice(0, 8);
    const sessionKey = this.getSessionKey(req);
    const { messages, stream } = req.body;

    if (!messages || !Array.isArray(messages) || messages.length === 0) {
      res.status(400).json({
        error: {
          message: 'messages is required and must be a non-empty array',
          type: 'invalid_request_error',
        },
      });
      return;
    }

    const isStream = stream === true;
    const startTime = Date.now();

    // Try upstreams with bounded retries
    let retries = 0;
    let lastError: any = null;

    while (retries <= this.config.retries.maxRetries) {
      const upstream = this.scheduler.selectUpstream(sessionKey);
      if (!upstream) {
        logger.error(`[${requestId}] No available upstream for session ${this.maskKey(sessionKey)}`);
        if (!res.headersSent) {
          res.status(503).json({
            error: {
              message: 'No available upstreams. All accounts may be exhausted or unavailable.',
              type: 'service_unavailable',
            },
          });
        }
        return;
      }

      const upstreamName = upstream.config.name;
      logger.info(`[${requestId}] Request to upstream=${upstreamName} (attempt=${retries + 1}) session=${this.maskKey(sessionKey)}`);

      const client = new StepClawClient({
        baseUrl: upstream.config.baseUrl,
        apiKey: upstream.config.apiKey,
        defaultModel: 'step-alpha',
      });

      try {
        const result = await client.chatCompletions(req.body, isStream);
        const latency = Date.now() - startTime;

        // Success
        this.scheduler.recordSuccess(sessionKey, upstreamName);
        logger.info(`[${requestId}] Success upstream=${upstreamName} latency=${latency}ms`);

        if (isStream) {
          await this.handleStreamResponse(requestId, res, result.body as NodeJS.ReadableStream, upstreamName);
        } else {
          res.json(result.body);
        }
        return;

      } catch (err: any) {
        lastError = err;
        const statusCode = err instanceof StepClawError ? err.statusCode : undefined;
        const latency = Date.now() - startTime;

        logger.warn(`[${requestId}] Failed upstream=${upstreamName} status=${statusCode || 'network'} latency=${latency}ms error=${err.message}`);

        // Check if error is switchable
        if (this.scheduler.isSwitchableError(statusCode, err)) {
          const shouldMigrate = this.scheduler.recordFailure(sessionKey, upstreamName, statusCode, err);
          if (shouldMigrate) {
            logger.info(`[${requestId}] Session ${this.maskKey(sessionKey)} migrated from ${upstreamName} due to repeated failures`);
          }
          retries++;
          if (retries <= this.config.retries.maxRetries) {
            logger.info(`[${requestId}] Retrying with different upstream (retry ${retries}/${this.config.retries.maxRetries})`);
            continue;
          }
        } else if (this.scheduler.isClientError(statusCode)) {
          // Client error - don't retry across upstreams
          logger.warn(`[${requestId}] Client error ${statusCode}, not retrying across upstreams`);
          if (!res.headersSent) {
            res.status(statusCode || 400).json({
              error: {
                message: err.message,
                type: 'invalid_request_error',
              },
            });
          }
          return;
        } else {
          // Unknown error, try once more
          retries++;
          if (retries <= this.config.retries.maxRetries) {
            logger.info(`[${requestId}] Retrying unknown error (retry ${retries}/${this.config.retries.maxRetries})`);
            continue;
          }
        }

        // Max retries exceeded or non-switchable
        break;
      }
    }

    // All retries exhausted
    logger.error(`[${requestId}] All retries exhausted for session ${this.maskKey(sessionKey)}. Last error: ${lastError?.message}`);
    if (!res.headersSent) {
      res.status(502).json({
        error: {
          message: `All upstreams failed. Last error: ${lastError?.message || 'Unknown error'}`,
          type: 'upstream_error',
        },
      });
    }
  }

  /**
   * Handle SSE streaming response
   * Important: Once we start writing to the client, we CANNOT switch upstreams.
   */
  private async handleStreamResponse(
    requestId: string,
    res: Response,
    stream: NodeJS.ReadableStream,
    upstreamName: string
  ): Promise<void> {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();

    let hasStarted = false;

    stream.on('data', (chunk: Buffer) => {
      hasStarted = true;
      res.write(chunk);
    });

    stream.on('end', () => {
      if (!res.writableEnded) {
        res.end();
      }
    });

    stream.on('error', (err: Error) => {
      logger.error(`[${requestId}] Stream error from upstream=${upstreamName}: ${err.message}`);
      if (!hasStarted) {
        // If stream hasn't started, we could theoretically retry
        // But for simplicity, we return error
        if (!res.headersSent) {
          res.status(502).json({
            error: {
              message: `Stream error: ${err.message}`,
              type: 'stream_error',
            },
          });
        }
      } else {
        // Stream already started - close gracefully
        if (!res.writableEnded) {
          res.end();
        }
      }
    });

    res.on('close', () => {
      if ((stream as any).destroy) {
        (stream as any).destroy();
      }
    });
  }

  private maskKey(key: string): string {
    if (key.length <= 8) return '***';
    return key.slice(0, 4) + '****' + key.slice(-4);
  }
}
