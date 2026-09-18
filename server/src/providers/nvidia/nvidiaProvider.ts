import type {
  AiGenerateRequest,
  AiGenerateResponse,
  AiProvider,
} from '../../../../core/src/provider.js';
import { NvidiaClient } from './nvidiaClient.js';

const client = new NvidiaClient({
  apiKey: process.env['NVIDIA_API_KEY'],
  baseUrl: process.env['NVIDIA_API_BASE_URL'],
});

/**
 * NVIDIA-backed inference provider.
 *
 * This first scaffold only registers the provider with the runtime. The HTTP
 * transport and model selection are added separately so the existing Pixel
 * Agents office can stay unchanged while the AI backend is replaced.
 */
export const nvidiaProvider: AiProvider = {
  kind: 'ai',
  id: 'nvidia',
  displayName: 'NVIDIA',

  isConfigured(): boolean {
    return client.isConfigured();
  },

  generate(request: AiGenerateRequest): Promise<AiGenerateResponse> {
    return client.generate(request);
  },
};
