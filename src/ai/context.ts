import { pruneMessages, type ModelMessage } from 'ai';

export function pruneFantasyMessages(
  messages: readonly ModelMessage[],
): ModelMessage[] {
  const turnStart = messages.findLastIndex((message) => message.role === 'user');
  // Keep the active turn intact, including provider signatures and early research.
  // Removing a tool pair here makes the model repeat work and can break continuation.
  const history = turnStart < 0 ? messages : messages.slice(0, turnStart);
  const activeTurn = turnStart < 0 ? [] : messages.slice(turnStart);
  return pruneMessages({
    messages: [...history],
    reasoning: 'all',
    toolCalls: 'before-last-6-messages',
    emptyMessages: 'remove',
  }).concat(
    activeTurn.length > 6
      ? pruneMessages({
          messages: [...activeTurn],
          reasoning: 'before-last-message',
          toolCalls: 'none',
          emptyMessages: 'keep',
        })
      : activeTurn,
  );
}
