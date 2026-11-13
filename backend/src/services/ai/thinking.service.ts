/**
 * Model-specific controls for user-selected reasoning effort.
 *
 * Never imply that a normal instruct/chat model has native hidden reasoning.
 * Unsupported models fail before queueing the request (and without storing
 * the user message) instead of silently ignoring the selected effort.
 */
import type { ProviderId } from './provider-types.js';

export type ThinkingEffort = 'low' | 'medium' | 'high';
export type ThinkingSelection = 'auto' | ThinkingEffort;

export class ThinkingUnavailableError extends Error {
  readonly code = 'thinking_not_supported';
  readonly statusCode = 400;
  constructor(message: string) {
    super(message);
    this.name = 'ThinkingUnavailableError';
  }
}

export function resolveThinkingEffort(
  provider: ProviderId | string,
  modelId: string,
  selected: ThinkingSelection = 'auto',
): ThinkingEffort | null {
  if (selected === 'auto') return null;
  if (!['low', 'medium', 'high'].includes(selected)) {
    throw new ThinkingUnavailableError('Invalid thinking effort. Choose Auto, Low, Medium, or High.');
  }
  const model = modelId.toLowerCase();
  switch (provider) {
    case 'openai':
      // GPT-4/4.1/4o chat models reject the Responses reasoning parameter.
      if (/^(gpt-(?:5|6)(?:[.\-]|$)|o[1-9](?:[.\-]|$))/.test(model)) return selected;
      break;
    case 'gemini':
      // Gemini 2.5 uses thinkingBudget; Gemini 3+ uses thinkingLevel.
      if (/^gemini-(?:2\.5|[3-9](?:\.|-))/.test(model)) {
        // Gemini 3 Pro preview supports low/high only.
        if (selected === 'medium' && /^gemini-3-pro-preview(?:$|-)/.test(model)) {
          throw new ThinkingUnavailableError('This Gemini model does not support Medium thinking; use Low or High.');
        }
        return selected;
      }
      break;
    case 'deepseek':
      // DeepSeek Chat Completion accepts low/high/max; medium is an alias
      // that maps to high. Keep the user's selected level in the app metadata.
      return selected;
    case 'nvidia_nim':
      // NVIDIA documents native low/high/max reasoning for GLM-5.3 and
      // GLM-5.3-Flash. Map UI Low/Medium/High to all three distinct levels
      // in the provider adapter (low/high/max). Never reject these GLM models.
      if (isNvidiaGlm53(model)) return selected;
      // Other NVIDIA reasoning controls are recipe/model-specific.
      if (/^openai\/gpt-oss-(?:20b|120b)$/.test(model)) return selected;
      if (/^nvidia\/nemotron-3(?:\.5)?-super(?:-|$)/.test(model)) {
        if (selected === 'medium') throw new ThinkingUnavailableError('This NVIDIA model supports Low or High thinking, not Medium.');
        return selected;
      }
      break;
    case 'antigravity_cli':
      return selected;
  }
  throw new ThinkingUnavailableError(
    'The selected model has no verified thinking-effort control in Pocket Diary. Choose a reasoning-capable model in AI Settings or select Auto.'
  );
}

/** Exact verified GLM-5.3 family (avoid granting unsupported models). */
export function isNvidiaGlm53(modelId: string): boolean {
  return /^(?:z-ai|zai-org)\/glm-5\.3(?:-flash)?$/i.test(modelId.trim());
}

export function providerThinkingValue(provider: string, effort: ThinkingEffort): string {
  if (provider === 'deepseek' && effort === 'medium') return 'high';
  return effort;
}
