import type { AiGenerateRequest, AiGenerateResponse } from '../../../../core/src/provider.js';

export interface NvidiaClientOptions {
  apiKey?: string;
  baseUrl?: string;
}

export type NvidiaGenerateRequest = AiGenerateRequest;
export type NvidiaGenerateResponse = AiGenerateResponse;
