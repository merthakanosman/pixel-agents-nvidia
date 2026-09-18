import { loadEnvFile } from 'node:process';

import { nvidiaProvider } from './nvidiaProvider.js';

try {
  loadEnvFile();
} catch (err) {
  const code = (err as NodeJS.ErrnoException).code;
  if (code !== 'ENOENT') throw err;
}

const model = process.env['NVIDIA_MODEL'] ?? 'nvidia/nemotron-3-nano-30b-a3b';

async function main(): Promise<void> {
  if (!nvidiaProvider.isConfigured()) {
    throw new Error('NVIDIA_API_KEY is missing. Add it to .env first.');
  }

  const result = await nvidiaProvider.generate({
    model,
    messages: [{ role: 'user', content: 'Merhaba. Tek cümleyle cevap ver.' }],
    temperature: 0.2,
    maxTokens: 80,
  });

  console.log(`Model: ${result.model}`);
  console.log(`Response: ${result.content.trim()}`);
  if (result.usage?.totalTokens !== undefined) {
    console.log(`Tokens: ${result.usage.totalTokens}`);
  }
}

void main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});
