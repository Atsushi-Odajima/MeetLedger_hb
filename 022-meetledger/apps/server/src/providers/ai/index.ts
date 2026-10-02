import type { Config } from '../../config';
import type { AiProvider } from './types';
import { LocalRulesProvider } from './localRules';
import { AnthropicProvider, OllamaProvider, OpenAiProvider } from './llmProviders';

export { LocalRulesProvider, extractWithRules, answerExtractive } from './localRules';
export { OpenAiProvider, AnthropicProvider, OllamaProvider, DEFAULT_MODELS, modelFor } from './llmProviders';
export { findDue, parseDue, isValidYmd } from './dueDate';

/**
 * All AI providers of this installation. 'local-rules' is always present and never uses the network.
 * Cloud providers are registered but report `available() = false` without an API key; the policy layer
 * (privacy/policy.ts decideAi) decides which one may be used for a meeting.
 */
export function createAiProviders(cfg: Config): Map<string, AiProvider> {
  const m = new Map<string, AiProvider>();
  m.set('local-rules', new LocalRulesProvider());
  m.set('openai', new OpenAiProvider(cfg));
  m.set('anthropic', new AnthropicProvider(cfg));
  m.set('ollama', new OllamaProvider(cfg));
  return m;
}
