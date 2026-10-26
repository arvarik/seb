import { pruneMessages, type ModelMessage } from 'ai';

const COMPACTED_TOOL_RECEIPT_PREFIX =
  '[Verified tool calls in this turn (outputs compacted): ';

export function pruneFantasyMessages(
  messages: readonly ModelMessage[],
): ModelMessage[] {
  const turnStart = messages.findLastIndex((message) => message.role === 'user');
  // Keep the active turn intact, including provider signatures and early research.
  // Removing a tool pair here makes the model repeat work and can break continuation.
  const history = turnStart < 0 ? messages : messages.slice(0, turnStart);
  const activeTurn = turnStart < 0 ? [] : messages.slice(turnStart);
  const prunedHistory = pruneMessages({
    messages: [...history],
    reasoning: 'all',
    toolCalls: 'before-last-6-messages',
    emptyMessages: 'remove',
  });
  const survivingToolCallIds = collectToolCallIds(prunedHistory);
  const annotatedHistory = annotatePrunedTurnReceipts(history, survivingToolCallIds);
  if (!annotatedHistory) return prunedHistory.concat(activeTurn);
  return pruneMessages({
    messages: annotatedHistory,
    reasoning: 'all',
    toolCalls: 'before-last-6-messages',
    emptyMessages: 'remove',
  }).concat(activeTurn);
}

function collectToolCallIds(messages: readonly ModelMessage[]): Set<string> {
  const ids = new Set<string>();
  for (const message of messages) {
    if (!Array.isArray(message.content)) continue;
    for (const part of message.content) {
      if (
        part &&
        typeof part === 'object' &&
        (part.type === 'tool-call' || part.type === 'tool-result') &&
        typeof part.toolCallId === 'string'
      ) {
        ids.add(part.toolCallId);
      }
    }
  }
  return ids;
}

function annotatePrunedTurnReceipts(
  history: readonly ModelMessage[],
  survivingToolCallIds: ReadonlySet<string>,
): ModelMessage[] | null {
  if (history.length === 0) return null;
  const turns: number[][] = [];
  for (let index = 0; index < history.length; index += 1) {
    if (history[index]?.role === 'user' || turns.length === 0) turns.push([index]);
    else turns.at(-1)?.push(index);
  }
  let annotated: ModelMessage[] | null = null;
  for (const turn of turns) {
    const prunedToolNames: string[] = [];
    let targetAssistantIndex = -1;
    let alreadyNoted = false;
    for (const index of turn) {
      const message = history[index];
      if (!message) continue;
      if (message.role === 'assistant') {
        const text = assistantText(message);
        if (text.includes(COMPACTED_TOOL_RECEIPT_PREFIX)) alreadyNoted = true;
        else if (text.trim().length > 0) targetAssistantIndex = index;
      }
      if (!Array.isArray(message.content)) continue;
      for (const part of message.content) {
        if (
          part &&
          typeof part === 'object' &&
          (part.type === 'tool-call' || part.type === 'tool-result') &&
          typeof part.toolCallId === 'string' &&
          typeof part.toolName === 'string' &&
          !survivingToolCallIds.has(part.toolCallId) &&
          !prunedToolNames.includes(part.toolName)
        ) {
          prunedToolNames.push(part.toolName);
        }
      }
    }
    if (alreadyNoted || prunedToolNames.length === 0 || targetAssistantIndex < 0) {
      continue;
    }
    annotated ??= [...history];
    const target = annotated[targetAssistantIndex];
    if (target?.role === 'assistant') {
      annotated[targetAssistantIndex] = appendAssistantNote(
        target,
        `\n\n${COMPACTED_TOOL_RECEIPT_PREFIX}${prunedToolNames.join(', ')}]`,
      );
    }
  }
  return annotated;
}

function assistantText(message: Extract<ModelMessage, { role: 'assistant' }>): string {
  if (typeof message.content === 'string') return message.content;
  return message.content
    .filter((part): part is Extract<typeof message.content[number], { type: 'text' }> =>
      part.type === 'text')
    .map((part) => part.text)
    .join('\n');
}

function appendAssistantNote(
  message: Extract<ModelMessage, { role: 'assistant' }>,
  note: string,
): Extract<ModelMessage, { role: 'assistant' }> {
  if (typeof message.content === 'string') {
    return { ...message, content: `${message.content.trimEnd()}${note}` };
  }
  const parts = [...message.content];
  for (let index = parts.length - 1; index >= 0; index -= 1) {
    const part = parts[index];
    if (part?.type === 'text') {
      parts[index] = { ...part, text: `${part.text.trimEnd()}${note}` };
      return { ...message, content: parts };
    }
  }
  return message;
}
