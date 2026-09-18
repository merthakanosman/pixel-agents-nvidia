import type {
  AiGenerateRequest,
  AiGenerateResponse,
  AiProvider,
} from '../../../../core/src/provider.js';
import { NvidiaClient } from './nvidiaClient.js';

function createClient(): NvidiaClient {
  return new NvidiaClient({
    apiKey: process.env['NVIDIA_API_KEY'],
    baseUrl: process.env['NVIDIA_API_BASE_URL'],
  });
}

/**
 * NVIDIA-backed inference provider.
 *
 * The client is created lazily so environment variables loaded after module
 * import (for example from .env in local development) are still picked up.
 */
export const nvidiaProvider: AiProvider = {
  kind: 'ai',
  id: 'nvidia',
  displayName: 'NVIDIA',

  isConfigured(): boolean {
    return createClient().isConfigured();
  },

  generate(request: AiGenerateRequest): Promise<AiGenerateResponse> {
    return createClient().generate(request);
  },
};
