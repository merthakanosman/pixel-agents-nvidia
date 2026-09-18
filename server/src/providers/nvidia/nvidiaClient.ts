import type {
  NvidiaClientOptions,
  NvidiaGenerateRequest,
  NvidiaGenerateResponse,
} from './types.js';

/**
 * Thin NVIDIA inference client boundary.
 *
 * Network transport is intentionally added in the next step. Keeping the
 * client behind this class lets AgentRuntime depend on the shared AiProvider
 * contract instead of NVIDIA-specific request details.
 */
export class NvidiaClient {
  private readonly apiKey?: string;
  private readonly baseUrl?: string;

  constructor(options: NvidiaClientOptions = {}) {
    this.apiKey = options.apiKey;
    this.baseUrl = options.baseUrl;
  }

  isConfigured(): boolean {
    return Boolean(this.apiKey);
  }

  getBaseUrl(): string | undefined {
    return this.baseUrl;
  }

  async generate(request: NvidiaGenerateRequest): Promise<NvidiaGenerateResponse> {
    void request;
    throw new Error('NVIDIA API transport is not implemented yet.');
  }
}
