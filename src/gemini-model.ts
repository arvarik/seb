import { createGoogle } from '@ai-sdk/google';

type GoogleProvider = ReturnType<typeof createGoogle>;

/**
 * Selects the standard Gemini generateContent endpoint.
 * Keep this selection shared by production and live verification code.
 */
export function createGeminiLanguageModel(
  provider: GoogleProvider,
  model: string,
) {
  return provider(model);
}
