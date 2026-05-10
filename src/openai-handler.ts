import { Request, Response } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { StepChatClient, ChatMessage } from './stepchat-client';
import { logger } from './logger';

/**
 * OpenAI-compatible API handler
 * Converts OpenAI format requests to StepChat internal API calls
 * and converts responses back to OpenAI format.
 */
export class OpenAIHandler {
  private client: StepChatClient;

  constructor(client: StepChatClient) {
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
          id: 'step-3.5-flash-2603',
          object: 'model',
          created: 1709893411,
          owned_by: 'stepfun',
        },
      ],
    });
  }

  /**
   * POST /v1/chat/completions - Chat completion (streaming & non-streaming)
   */
  async chatCompletions(req: Request, res: Response): Promise<void> {
    const { model, messages, stream, temperature, max_tokens, top_p } = req.body;

    if (!messages || !Array.isArray(messages) || messages.length === 0) {
      res.status(400).json({
        error: {
          message: 'messages is required and must be a non-empty array',
          type: 'invalid_request_error',
        },
      });
      return;
    }

    const token = this.client.getNextToken();
    let chatId: string | null = null;

    try {
      // Create a temporary chat session
      chatId = await this.client.createChat(token);

      if (stream) {
        await this.handleStreamResponse(res, chatId, token, messages, model);
      } else {
        await this.handleNonStreamResponse(res, chatId, token, messages, model);
      }
    } catch (err: any) {
      logger.error(`Chat completion error: ${err.message}`);

      // Check if it's an auth/rate-limit error
      if (err.message.includes('401') || err.message.includes('429') || err.message.includes('403')) {
        this.client.markTokenFailed(token);
      }

      if (!res.headersSent) {
        res.status(500).json({
          error: {
            message: err.message || 'Internal server error',
            type: 'server_error',
          },
        });
      }
    } finally {
      // Clean up chat session
      if (chatId) {
        this.client.deleteChat(chatId, token).catch(() => {});
      }
    }
  }

  /**
   * Handle streaming response - convert StepChat SSE to OpenAI SSE format
   */
  private async handleStreamResponse(
    res: Response,
    chatId: string,
    token: string,
    messages: ChatMessage[],
    model: string
  ): Promise<void> {
    const completionId = `chatcmpl-${uuidv4().replace(/-/g, '').slice(0, 24)}`;
    const created = Math.floor(Date.now() / 1000);

    // Set SSE headers
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();

    const stream = await this.client.sendMessage(chatId, token, messages, model, true);

    if (!stream) {
      throw new Error('No stream returned from StepChat');
    }

    let buffer = '';

    stream.on('data', (chunk: Buffer) => {
      buffer += chunk.toString();

      // Process complete SSE events from buffer
      const lines = buffer.split('\n');
      buffer = lines.pop() || ''; // Keep incomplete line in buffer

      for (const line of lines) {
        const trimmed = line.trim();

        if (trimmed === '') continue;
        if (trimmed === 'data: [DONE]') {
          // Send OpenAI-format done signal
          res.write('data: [DONE]\n\n');
          return;
        }

        if (trimmed.startsWith('data: ')) {
          const jsonStr = trimmed.slice(6);
          try {
            const data = JSON.parse(jsonStr);
            const openaiChunk = this.convertToOpenAIStreamChunk(data, completionId, created, model);
            if (openaiChunk) {
              res.write(`data: ${JSON.stringify(openaiChunk)}\n\n`);
            }
          } catch (e) {
            logger.debug(`Failed to parse SSE chunk: ${jsonStr}`);
          }
        }
      }
    });

    stream.on('end', () => {
      // Ensure we send [DONE] if not already sent
      if (!res.writableEnded) {
        res.write('data: [DONE]\n\n');
        res.end();
      }
    });

    stream.on('error', (err: Error) => {
      logger.error(`Stream error: ${err.message}`);
      if (!res.writableEnded) {
        res.end();
      }
    });

    // Handle client disconnect
    res.on('close', () => {
      if (stream.destroy) {
        stream.destroy();
      }
    });
  }

  /**
   * Handle non-streaming response
   */
  private async handleNonStreamResponse(
    res: Response,
    chatId: string,
    token: string,
    messages: ChatMessage[],
    model: string
  ): Promise<void> {
    const completionId = `chatcmpl-${uuidv4().replace(/-/g, '').slice(0, 24)}`;
    const created = Math.floor(Date.now() / 1000);

    // For non-stream, we still use streaming internally and collect the full response
    const stream = await this.client.sendMessage(chatId, token, messages, model, true);

    if (!stream) {
      throw new Error('No response from StepChat');
    }

    let fullContent = '';
    let buffer = '';

    await new Promise<void>((resolve, reject) => {
      stream.on('data', (chunk: Buffer) => {
        buffer += chunk.toString();
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          const trimmed = line.trim();
          if (trimmed === '' || trimmed === 'data: [DONE]') continue;

          if (trimmed.startsWith('data: ')) {
            try {
              const data = JSON.parse(trimmed.slice(6));
              const content = this.extractContent(data);
              if (content) {
                fullContent += content;
              }
            } catch (e) {
              // skip unparseable chunks
            }
          }
        }
      });

      stream.on('end', () => resolve());
      stream.on('error', (err: Error) => reject(err));
    });

    // Return OpenAI-format non-streaming response
    res.json({
      id: completionId,
      object: 'chat.completion',
      created: created,
      model: model || 'step-3.5-flash',
      choices: [
        {
          index: 0,
          message: {
            role: 'assistant',
            content: fullContent,
          },
          finish_reason: 'stop',
        },
      ],
      usage: {
        prompt_tokens: 0, // StepChat doesn't expose this in web API
        completion_tokens: 0,
        total_tokens: 0,
      },
    });
  }

  /**
   * Convert StepChat SSE data to OpenAI stream chunk format
   */
  private convertToOpenAIStreamChunk(
    data: any,
    completionId: string,
    created: number,
    model: string
  ): any | null {
    const content = this.extractContent(data);

    if (content === null && !data.finish_reason) {
      return null;
    }

    return {
      id: completionId,
      object: 'chat.completion.chunk',
      created: created,
      model: model || 'step-3.5-flash',
      choices: [
        {
          index: 0,
          delta: content !== null ? { content } : {},
          finish_reason: data.finish_reason || null,
        },
      ],
    };
  }

  /**
   * Extract text content from various StepChat response formats.
   * The exact format depends on the stepchat.cn internal API version,
   * so we try multiple known patterns.
   */
  private extractContent(data: any): string | null {
    // Pattern 1: OpenAI-like format (choices[0].delta.content)
    if (data?.choices?.[0]?.delta?.content !== undefined) {
      return data.choices[0].delta.content;
    }

    // Pattern 2: Direct content field
    if (data?.content !== undefined) {
      return data.content;
    }

    // Pattern 3: Message content
    if (data?.message?.content !== undefined) {
      return data.message.content;
    }

    // Pattern 4: Text field
    if (data?.text !== undefined) {
      return data.text;
    }

    // Pattern 5: Delta text
    if (data?.delta?.text !== undefined) {
      return data.delta.text;
    }

    return null;
  }
}
