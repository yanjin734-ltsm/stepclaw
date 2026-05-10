import { Request, Response } from 'express';
import { StepClawClient } from './stepclaw-client';
import { logger } from './logger';

/**
 * OpenAI-compatible API handler
 * 
 * Since the StepClaw desktop app already exposes a standard OpenAI-compatible
 * endpoint at http://127.0.0.1:3199/v1, this handler is now a thin passthrough
 * that forwards requests and remaps model names.
 */
export class OpenAIHandler {
  private client: StepClawClient;

  constructor(client: StepClawClient) {
    this.client = client;
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
   * Directly forwards to the local StepClaw proxy with model name remapping.
   */
  async chatCompletions(req: Request, res: Response): Promise<void> {
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

    try {
      const result = await this.client.chatCompletions(req.body, isStream);

      if (isStream) {
        // Forward SSE stream directly
        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Connection', 'keep-alive');
        res.setHeader('X-Accel-Buffering', 'no');
        res.flushHeaders();

        const stream = result.body as NodeJS.ReadableStream;

        stream.on('data', (chunk: Buffer) => {
          res.write(chunk);
        });

        stream.on('end', () => {
          if (!res.writableEnded) {
            res.end();
          }
        });

        stream.on('error', (err: Error) => {
          logger.error(`Stream error: ${err.message}`);
          if (!res.writableEnded) {
            res.end();
          }
        });

        res.on('close', () => {
          if ((stream as any).destroy) {
            (stream as any).destroy();
          }
        });
      } else {
        // Forward JSON response directly
        res.json(result.body);
      }
    } catch (err: any) {
      logger.error(`Chat completion error: ${err.message}`);

      if (!res.headersSent) {
        res.status(502).json({
          error: {
            message: `StepClaw proxy error: ${err.message}`,
            type: 'upstream_error',
          },
        });
      }
    }
  }
}
