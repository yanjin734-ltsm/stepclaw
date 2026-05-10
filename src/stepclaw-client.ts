import { logger } from './logger';

export interface StepClawProxyConfig {
  /** Local proxy URL exposed by StepClaw desktop app */
  baseUrl: string;
  /** API key used by the local proxy (from openclaw.json) */
  apiKey: string;
  /** Default model ID */
  defaultModel: string;
}

/**
 * StepClaw Desktop Proxy Client
 * 
 * The StepClaw desktop app (阶跃AI桌面伙伴) runs a local OpenAI-compatible
 * proxy at http://127.0.0.1:3199/v1. This proxy handles authentication
 * with StepFun's cloud API using the user's account credentials.
 * 
 * Discovery:
 * - Config at: D:\StepClaw\data\openclaw.json (or ~/.stepclaw state dir)
 * - Local proxy: http://127.0.0.1:3199/v1
 * - API key: "stepfun-model-proxy" (static, no real auth needed)
 * - Models: "step-alpha" (coding), "vision-model" (image understanding)
 * - Protocol: Standard OpenAI /v1/chat/completions (streaming + non-streaming)
 * - Gateway: OpenClaw gateway on port 30999 (separate from model proxy)
 * 
 * This means we DON'T need to reverse-engineer anything complex.
 * The desktop app already exposes a standard OpenAI-compatible endpoint locally.
 * We just need to forward OpenCode's requests to it.
 */
export class StepClawClient {
  private config: StepClawProxyConfig;

  constructor(config: StepClawProxyConfig) {
    this.config = config;
    logger.info(`StepClaw client initialized: ${config.baseUrl}, model: ${config.defaultModel}`);
  }

  /**
   * Forward a chat completion request to the local StepClaw proxy.
   * Returns the raw response (streaming or JSON).
   */
  async chatCompletions(
    body: any,
    stream: boolean
  ): Promise<{ status: number; headers: Record<string, string>; body: NodeJS.ReadableStream | any }> {
    const fetch = (await import('node-fetch')).default;
    const url = `${this.config.baseUrl}/chat/completions`;

    // Remap model name if needed
    const requestBody = {
      ...body,
      model: this.remapModel(body.model),
      stream: stream,
    };

    logger.debug(`Forwarding to StepClaw: ${url}, model: ${requestBody.model}, stream: ${stream}`);

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.config.apiKey}`,
      },
      body: JSON.stringify(requestBody),
    });

    const responseHeaders: Record<string, string> = {};
    response.headers.forEach((value, key) => {
      responseHeaders[key] = value;
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`StepClaw proxy error: ${response.status} - ${errorText}`);
    }

    if (stream) {
      return {
        status: response.status,
        headers: responseHeaders,
        body: response.body as unknown as NodeJS.ReadableStream,
      };
    } else {
      const json = await response.json();
      return {
        status: response.status,
        headers: responseHeaders,
        body: json,
      };
    }
  }

  /**
   * Map user-facing model names to StepClaw internal model IDs.
   * Users can use friendly names; we translate to what the local proxy expects.
   */
  private remapModel(model: string): string {
    const modelMap: Record<string, string> = {
      'step-3.5-flash': 'step-alpha',
      'step-3.5-flash-2603': 'step-alpha',
      'step-alpha': 'step-alpha',
      'vision-model': 'vision-model',
      'step-vision': 'vision-model',
    };

    return modelMap[model] || this.config.defaultModel;
  }

  /**
   * Check if the local StepClaw proxy is reachable
   */
  async healthCheck(): Promise<boolean> {
    const fetch = (await import('node-fetch')).default;
    try {
      const response = await fetch(`${this.config.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.config.apiKey}`,
        },
        body: JSON.stringify({
          model: this.config.defaultModel,
          messages: [{ role: 'user', content: 'ping' }],
          max_tokens: 1,
          stream: false,
        }),
      });
      return response.ok;
    } catch {
      return false;
    }
  }
}
