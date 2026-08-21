import { describe, expect, it } from 'vitest';
import type { ChatTransport, UIMessage, UIMessageChunk } from 'ai';

import {
  SebConversationRunner,
  type SebConversationRenderer,
} from '../src/interactive/tui.js';

describe('SebConversationRunner', () => {
  it('keeps conversation messages through the public chat transport', async () => {
    const sent: UIMessage[][] = [];
    const responses = [assistant('answer-1', 'First answer'), assistant('answer-2', 'Second answer')];
    const renderer = rendererFor(['First question', 'Second question', undefined], responses);
    const transport = transportFor((messages) => {
      sent.push(structuredClone(messages));
      return emptyStream();
    });

    await new SebConversationRunner({
      chatId: 'stable-chat',
      renderer,
      title: 'Seb test',
      transport,
    }).run();

    expect(sent).toHaveLength(2);
    expect(sent[0]?.map((message) => message.role)).toEqual(['user']);
    expect(sent[1]?.map((message) => message.role)).toEqual([
      'user',
      'assistant',
      'user',
    ]);
    expect(textOf(sent[1]?.at(-1))).toBe('Second question');
  });

  it('returns a terminal approval through the next transport call', async () => {
    const approvalMessage = {
      id: 'approval-message',
      role: 'assistant',
      parts: [{
        approval: { id: 'approval-1', isAutomatic: false },
        input: { target: 'example' },
        state: 'approval-requested',
        toolCallId: 'tool-1',
        toolName: 'exampleTool',
        type: 'dynamic-tool',
      }],
    } as UIMessage;
    const renderer = rendererFor(
      ['Run the tool', undefined],
      [approvalMessage, assistant('answer-2', 'Tool complete')],
    );
    const sent: UIMessage[][] = [];
    const transport = transportFor((messages) => {
      sent.push(structuredClone(messages));
      return emptyStream();
    });

    await new SebConversationRunner({
      chatId: 'approval-chat',
      renderer,
      title: 'Seb test',
      transport,
    }).run();

    expect(renderer.approvals).toEqual(['exampleTool']);
    expect(sent).toHaveLength(2);
    expect(sent[1]).toHaveLength(2);
    expect(sent[1]?.at(-1)?.parts[0]).toMatchObject({
      approval: { approved: true, id: 'approval-1' },
      state: 'approval-responded',
    });
  });
});

function rendererFor(
  prompts: Array<string | undefined>,
  responses: UIMessage[],
): SebConversationRenderer & { approvals: string[] } {
  let promptIndex = 0;
  let responseIndex = 0;
  const approvals: string[] = [];
  return {
    approvals,
    readPrompt: () => Promise.resolve(prompts[promptIndex++]),
    readToolApproval: (request) => {
      approvals.push(request.toolName);
      return Promise.resolve({ approved: true });
    },
    renderStream: () => Promise.resolve(responses[responseIndex++]),
  };
}

function transportFor(
  send: (messages: UIMessage[]) => ReadableStream<UIMessageChunk>,
): ChatTransport<UIMessage> {
  return {
    reconnectToStream: () => Promise.resolve(null),
    sendMessages: ({ messages }) => Promise.resolve(send(messages)),
  };
}

function assistant(id: string, text: string): UIMessage {
  return { id, parts: [{ text, type: 'text' }], role: 'assistant' };
}

function emptyStream(): ReadableStream<UIMessageChunk> {
  return new ReadableStream({ start: (controller) => controller.close() });
}

function textOf(message: UIMessage | undefined): string | undefined {
  const part = message?.parts[0];
  return part?.type === 'text' ? part.text : undefined;
}
