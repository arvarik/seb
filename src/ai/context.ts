import { pruneMessages, type ModelMessage } from 'ai';

export function pruneFantasyMessages(
  messages: readonly ModelMessage[],
): ModelMessage[] {
  return pruneMessages({
    messages: [...messages],
    reasoning: 'all',
    toolCalls: 'before-last-6-messages',
    emptyMessages: 'remove',
  });
}
