import { TokenManager } from './token-manager';
import { logger } from './logger';

export interface StepChatConfig {
  baseUrl: string;
  tokens: string[];
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface StepChatRequest {
  model: string;
  messages: ChatMessage[];
  stream?: boolean;
  temperature?: number;
  max_tokens?: number;
  top_p?: number;
}

export interface StepChatSession {
  chatId: string;
  token: string;
}

/**
 * StepChat client - handles communication with stepchat.cn internal API
 * 
 * The stepchat.cn web interface uses a session-based API that differs from
 * the official StepFun platform API. This client reverse-engineers that
 * interface to provide programmatic access.
 * 
 * Key differences from official API:
 * - Auth via session cookie instead of API key
 * - Requires creating a "chat" session before sending messages
 * - Uses SSE for streaming responses
 * - Different request/response format than OpenAI standard
 */
export class StepChatClient {
  private config: StepChatConfig;
  private tokenManager: TokenManager;

  constructor(config: StepChatConfig) {
    this.config = config;
    this.tokenManager = new TokenManager(config.tokens);
  }

  /**
   * Get common headers for stepchat.cn requests
   */
  private getHeaders(token: string): Record<string, string> {
    return {
      'Content-Type': 'application/json',
      'Cookie': `token=${token}`,
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
      'Accept': '*/*',
      'Origin': this.config.baseUrl,
      'Referer': `${this.config.baseUrl}/`,
    };
  }

  /**
   * Create a new chat session on stepchat.cn
   * Returns a chat ID that can be used for subsequent messages
   */
  async createChat(token: string): Promise<string> {
    const fetch = (await import('node-fetch')).default;
    const url = `${this.config.baseUrl}/api/chat/create`;

    logger.debug(`Creating new chat session`);

    const response = await fetch(url, {
      method: 'POST',
      headers: this.getHeaders(token),
      body: JSON.stringify({}),
    });

    if (!response.ok) {
      throw new Error(`Failed to create chat: ${response.status} ${response.statusText}`);
    }

    const data = await response.json() as any;
    const chatId = data?.data?.id || data?.id;

    if (!chatId) {
      throw new Error(`Failed to extract chat ID from response: ${JSON.stringify(data)}`);
    }

    logger.debug(`Created chat session: ${chatId}`);
    return chatId;
  }

  /**
   * Send a message to stepchat.cn and get a streaming response
   * Returns a ReadableStream of SSE events
   */
  async sendMessage(
    chatId: string,
    token: string,
    messages: ChatMessage[],
    model: string = 'step-3.5-flash',
    stream: boolean = true
  ): Promise<NodeJS.ReadableStream | any> {
    const fetch = (await import('node-fetch')).default;
    const url = `${this.config.baseUrl}/api/chat/completion`;

    const body = {
      chat_id: chatId,
      messages: messages,
      model: model,
      stream: stream,
    };

    logger.debug(`Sending message to chat ${chatId}, model: ${model}, stream: ${stream}`);

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        ...this.getHeaders(token),
        'Accept': stream ? 'text/event-stream' : 'application/json',
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`StepChat API error: ${response.status} - ${errorText}`);
    }

    if (stream) {
      return response.body;
    } else {
      return await response.json();
    }
  }

  /**
   * Delete a chat session to clean up traces
   */
  async deleteChat(chatId: string, token: string): Promise<void> {
    const fetch = (await import('node-fetch')).default;
    const url = `${this.config.baseUrl}/api/chat/delete`;

    try {
      await fetch(url, {
        method: 'POST',
        headers: this.getHeaders(token),
        body: JSON.stringify({ id: chatId }),
      });
      logger.debug(`Deleted chat session: ${chatId}`);
    } catch (err) {
      logger.warn(`Failed to delete chat ${chatId}: ${err}`);
    }
  }

  /**
   * Get the next available token from the rotation pool
   */
  getNextToken(): string {
    return this.tokenManager.getNext();
  }

  /**
   * Mark a token as failed (rate limited or expired)
   */
  markTokenFailed(token: string): void {
    this.tokenManager.markFailed(token);
  }
}
