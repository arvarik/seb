import { describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import type { ChatTransport, UIMessage, UIMessageChunk } from 'ai';
import { SebTerminalRenderer } from '../src/interactive/renderer.js';
import { MemoryPromptHistory } from '../src/interactive/history.js';
import { InteractiveUiState } from '../src/interactive/ui-state.js';
import { createSessionState } from '../src/interactive/session.js';
import { SourceTracker } from '../src/sources.js';

import {
  SebConversationRunner,
  type SebConversationRenderer,
} from '../src/interactive/tui.js';

describe('SebConversationRunner', () => {
  it('accepts a retry draft during a failed response and sends the original question without partial output', async () => {
    class Input extends EventEmitter {
      isTTY = true;
      pause() { return this; }
      resume() { return this; }
      setRawMode() { return this; }
      type(value: string) { this.emit('data', Buffer.from(value)); }
    }
    class Output extends EventEmitter {
      columns = 100;
      rows = 30;
      text = '';
      write(value: string | Uint8Array) { this.text += String(value); return true; }
    }
    const input = new Input();
    const output = new Output();
    const uiState = new InteractiveUiState();
    const renderer = new SebTerminalRenderer({ input, output, uiState,
      environment: { NO_COLOR: '1' }, model: 'test', version: 'test',
      history: new MemoryPromptHistory(), session: createSessionState(), sources: new SourceTracker() });
    const sent: UIMessage[][] = [];
    let first!: ReadableStreamDefaultController<UIMessageChunk>;
    const transport = transportFor((messages) => {
      sent.push(structuredClone(messages));
      return new ReadableStream({ start(controller) {
        if (sent.length === 1) { first = controller; return; }
        controller.enqueue({ type: 'text-start', id: 'answer' });
        controller.enqueue({ type: 'text-delta', id: 'answer', delta: 'The weather is clear.' });
        controller.enqueue({ type: 'text-end', id: 'answer' });
        controller.enqueue({ type: 'finish', finishReason: 'stop' });
        controller.close();
      } });
    });
    const conversation = new SebConversationRunner({ renderer, transport, title: 'Test' }).run();
    input.type('What is the weather?\r');
    await expect.poll(() => sent.length).toBe(1);
    first.enqueue({ type: 'text-start', id: 'partial' });
    first.enqueue({ type: 'text-delta', id: 'partial', delta: 'Untrusted partial weather.' });
    await expect.poll(() => output.text).toContain('Untrusted partial weather.');
    input.type('Please try again\r');
    first.enqueue({ type: 'error', errorText: 'Weather request failed.' });
    first.close();
    await expect.poll(() => output.text.split('\x1b[H').at(-1)).toContain('Ready');
    expect(sent).toHaveLength(1);
    input.type('\r');
    await expect.poll(() => uiState.latestAnswer).toBe('The weather is clear.');
    expect(sent[1]?.map(textOf)).toEqual(['What is the weather?', 'Please try again']);
    expect(JSON.stringify(sent[1])).not.toContain('Untrusted partial');
    input.type('/exit\r');
    await conversation;
  });

  it('opens the renderer before transport setup completes and cancels a late stream', async () => {
    let resolveSetup!: (stream: ReadableStream<UIMessageChunk>) => void;
    let signal: AbortSignal | undefined;
    let cancelled = false;
    const renderer = rendererFor(['Question', undefined], []);
    renderer.renderStream = async (result) => {
      expect(signal?.aborted).toBe(false);
      result.abort?.();
      await (result.uiMessageStream as ReadableStream<UIMessageChunk>).cancel();
      resolveSetup(new ReadableStream({ cancel() { cancelled = true; } }));
      return undefined;
    };
    const transport: ChatTransport<UIMessage> = {
      reconnectToStream: async () => null,
      sendMessages: (options) => {
        signal = options.abortSignal;
        return new Promise((resolve) => { resolveSetup = resolve; });
      },
    };
    await new SebConversationRunner({ renderer, transport, title: 'Test' }).run();
    expect(signal?.aborted).toBe(true);
    await expect.poll(() => cancelled).toBe(true);
  });

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

  it('shows a transport setup failure and keeps the conversation available', async () => {
    const close = vi.fn();
    const renderer = {
      ...rendererFor(['Question'], []),
      close,
    };
    const transport: ChatTransport<UIMessage> = {
      reconnectToStream: () => Promise.resolve(null),
      sendMessages: () => Promise.reject(new Error('Transport setup failed')),
    };

    await expect(new SebConversationRunner({
      renderer,
      title: 'Seb test',
      transport,
    }).run()).resolves.toBeUndefined();

    expect(close).toHaveBeenCalledOnce();
  });

  it('keeps the failed question when the user asks to try again', async () => {
    const sent: UIMessage[][] = [];
    const renderer = rendererFor(
      ['What is the weather?', 'Please try again', undefined],
      [undefined, assistant('answer-2', 'Second answer')],
    );
    const transport = transportFor((messages) => {
      sent.push(structuredClone(messages));
      return emptyStream();
    });

    await new SebConversationRunner({
      renderer,
      title: 'Seb test',
      transport,
    }).run();

    expect(sent).toHaveLength(2);
    expect(sent[1]?.map((message) => message.role)).toEqual(['user', 'user']);
    expect(textOf(sent[1]?.[0])).toBe('What is the weather?');
    expect(textOf(sent[1]?.[1])).toBe('Please try again');
  });

  it('removes a failed approval continuation before the next prompt', async () => {
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
    const sent: UIMessage[][] = [];
    const renderer = rendererFor(
      ['Run the tool', 'Next question', undefined],
      [approvalMessage, undefined, assistant('answer-2', 'Second answer')],
    );
    const transport = transportFor((messages) => {
      sent.push(structuredClone(messages));
      return emptyStream();
    });

    await new SebConversationRunner({
      chatId: 'failed-approval-chat',
      renderer,
      title: 'Seb test',
      transport,
    }).run();

    expect(sent).toHaveLength(3);
    expect(sent[1]?.map((message) => message.role)).toEqual([
      'user',
      'assistant',
    ]);
    expect(sent[2]?.map((message) => message.role)).toEqual(['user', 'user']);
    expect(textOf(sent[2]?.[0])).toBe('Run the tool');
    expect(textOf(sent[2]?.[1])).toBe('Next question');
  });
});

function rendererFor(
  prompts: Array<string | undefined>,
  responses: Array<UIMessage | undefined>,
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
