import type {
  NvidiaClientOptions,
  NvidiaGenerateRequest,
  NvidiaGenerateResponse,
} from './types.js';

const DEFAULT_BASE_URL = 'https://integrate.api.nvidia.com/v1';

interface NvidiaChatCompletionResponse {
  model?: string;
  choices?: Array<{
    message?: { content?: string | null };
    finish_reason?: string | null;
  }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
  };
  detail?: string;
  message?: string;
}

/**
 * Thin NVIDIA inference client using NVIDIA's OpenAI-compatible
 * /v1/chat/completions endpoint.
 */
export class NvidiaClient {
  private readonly apiKey?: string;
  private readonly baseUrl: string;

  constructor(options: NvidiaClientOptions = {}) {
    this.apiKey = options.apiKey;
    this.baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, '');
  }

  isConfigured(): boolean {
    return Boolean(this.apiKey);
  }

  getBaseUrl(): string {
    return this.baseUrl;
  }

  async generate(request: NvidiaGenerateRequest): Promise<NvidiaGenerateResponse> {
    if (!this.apiKey) {
      throw new Error('NVIDIA_API_KEY is not configured.');
    }

    if (!request.model.trim()) {
      throw new Error('NVIDIA model id is required.');
    }

    const response = await fetch(`${this.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        Accept: 'application/json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: request.model,
        messages: request.messages,
        stream: false,
        chat_template_kwargs: { enable_thinking: false },
        ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
        ...(request.maxTokens !== undefined ? { max_tokens: request.maxTokens } : {}),
      }),
    });

    const raw = (await response.json().catch(() => null)) as NvidiaChatCompletionResponse | null;

    if (!response.ok) {
      const detail = raw?.detail ?? raw?.message ?? response.statusText;
      throw new Error(`NVIDIA API request failed (${response.status}): ${detail}`);
    }

    const content = raw?.choices?.[0]?.message?.content;
    if (typeof content !== 'string') {
      throw new Error('NVIDIA API response did not contain assistant text.');
    }

    return {
      model: raw?.model ?? request.model,
      content,
      finishReason: raw?.choices?.[0]?.finish_reason ?? undefined,
      usage: raw?.usage
        ? {
            inputTokens: raw.usage.prompt_tokens,
            outputTokens: raw.usage.completion_tokens,
            totalTokens: raw.usage.total_tokens,
          }
        : undefined,
    };
  }
}
