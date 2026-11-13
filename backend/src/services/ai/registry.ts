/**
 * AI provider adapter registry. Resolves an adapter by provider id.
 * Adapters are independent integrations; adding a provider means adding a
 * module here, never touching note services.
 */
import { openAiAdapter } from './providers/openai.js';
import { geminiAdapter } from './providers/gemini.js';
import { deepseekAdapter } from './providers/deepseek.js';
import { nvidiaNimAdapter } from './providers/nvidia-nim.js';
import { anthropicAdapter } from './providers/anthropic.js';
import { mistralAdapter } from './providers/mistral.js';
import { groqAdapter } from './providers/groq.js';
import { openrouterAdapter } from './providers/openrouter.js';
import { ollamaAdapter } from './providers/ollama.js';
import { antigravityCliAdapter } from './providers/antigravity-cli.js';
import { isProviderId, type ProviderAdapter, type ProviderId } from './provider-types.js';

const ADAPTERS: Record<ProviderId, ProviderAdapter> = {
  openai: openAiAdapter,
  gemini: geminiAdapter,
  deepseek: deepseekAdapter,
  nvidia_nim: nvidiaNimAdapter,
  anthropic: anthropicAdapter,
  mistral: mistralAdapter,
  groq: groqAdapter,
  openrouter: openrouterAdapter,
  ollama: ollamaAdapter,
  antigravity_cli: antigravityCliAdapter,
};

export function getAdapter(provider: string): ProviderAdapter | null {
  if (!isProviderId(provider)) return null;
  return ADAPTERS[provider];
}

export { PROVIDER_IDS, PROVIDER_LABELS, isProviderId } from './provider-types.js';
export type { ProviderId, ProviderAdapter } from './provider-types.js';
