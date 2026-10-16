import { randomUUID, timingSafeEqual } from 'node:crypto';
import {
  Message,
  NotImplementedError,
  parseMarkdown,
  stringifyMarkdown,
  type Adapter,
  type AdapterPostableMessage,
  type ChatInstance,
  type FetchOptions,
  type FetchResult,
  type FormattedContent,
  type RawMessage,
  type ThreadInfo,
  type WebhookOptions,
} from 'chat';

export interface GroupMeThreadId {
  groupId: string;
}

export interface GroupMeWebhookPayload {
  attachments?: Array<{ loci?: number[][]; type?: string; user_ids?: string[] }>;
  avatar_url?: string | null;
  created_at?: number;
  group_id?: string;
  id?: string;
  name?: string;
  sender_id?: string;
  sender_type?: 'bot' | 'system' | 'user' | string;
  system?: boolean;
  text?: string | null;
  user_id?: string;
}

export interface GroupMeAdapterConfig {
  apiBaseUrl?: string;
  botId: string;
  botName?: string;
  fetch?: typeof globalThis.fetch;
  secretToken: string;
}

const MAX_CACHED_MESSAGES = 40;

export function createGroupMeAdapter(
  config: GroupMeAdapterConfig,
): Adapter<GroupMeThreadId, GroupMeWebhookPayload> {
  const apiBaseUrl = (config.apiBaseUrl ?? 'https://api.groupme.com').replace(/\/+$/u, '');
  const botId = config.botId.trim();
  const userName = config.botName?.trim() || 'seb';
  const secretToken = config.secretToken.trim();
  const fetchImpl = config.fetch ?? globalThis.fetch;
  const history = new Map<string, Message<GroupMeWebhookPayload>[]>();
  let chat: ChatInstance | null = null;

  const recordMessage = (threadId: string, message: Message<GroupMeWebhookPayload>): void => {
    const list = history.get(threadId) ?? [];
    if (!list.some((item) => item.id === message.id)) {
      list.push(message);
      if (list.length > MAX_CACHED_MESSAGES) list.splice(0, list.length - MAX_CACHED_MESSAGES);
      history.set(threadId, list);
    }
  };

  const renderMessage = (message: AdapterPostableMessage): string => {
    if (typeof message === 'string') return message;
    if ('raw' in message && typeof message.raw === 'string') return message.raw;
    if ('markdown' in message && typeof message.markdown === 'string') return message.markdown;
    if ('ast' in message && message.ast) return stringifyMarkdown(message.ast);
    return '';
  };

  const adapter: Adapter<GroupMeThreadId, GroupMeWebhookPayload> = {
    name: 'groupme',
    userName,
    lockScope: 'channel',
    persistThreadHistory: true,

    async initialize(instance: ChatInstance): Promise<void> {
      chat = instance;
    },

    encodeThreadId({ groupId }: GroupMeThreadId): string {
      return `groupme:${groupId}:${groupId}`;
    },

    decodeThreadId(threadId: string): GroupMeThreadId {
      const [, groupId = ''] = threadId.split(':');
      if (!groupId) throw new Error(`Invalid GroupMe thread ID: ${threadId}`);
      return { groupId };
    },

    channelIdFromThreadId(threadId: string): string {
      const { groupId } = this.decodeThreadId(threadId);
      return `groupme:${groupId}`;
    },

    isDM(): boolean {
      return false;
    },

    parseMessage(raw: GroupMeWebhookPayload): Message<GroupMeWebhookPayload> {
      const groupId = String(raw.group_id ?? '').trim() || 'unknown';
      const threadId = this.encodeThreadId({ groupId });
      const text = String(raw.text ?? '');
      const senderType = raw.sender_type ?? (raw.system ? 'system' : 'user');
      const isBot = senderType === 'bot' || senderType === 'system' || Boolean(raw.system);
      const mentionPattern = new RegExp(`(?:^|\\s)@?${escapeRegExp(userName)}\\b`, 'iu');
      const isMention = !isBot && mentionPattern.test(text);
      return new Message({
        attachments: [],
        author: {
          fullName: String(raw.name ?? raw.sender_id ?? 'GroupMe User'),
          isBot,
          isMe: isBot,
          userId: String(raw.sender_id ?? raw.user_id ?? 'unknown'),
          userName: String(raw.name ?? raw.sender_id ?? 'user'),
        },
        formatted: parseMarkdown(text),
        id: String(raw.id ?? randomUUID()),
        isMention,
        links: [],
        metadata: {
          dateSent: typeof raw.created_at === 'number'
            ? new Date(raw.created_at * 1_000)
            : new Date(),
          edited: false,
        },
        raw,
        text,
        threadId,
      });
    },

    renderFormatted(content: FormattedContent): string {
      return stringifyMarkdown(content);
    },

    async handleWebhook(request: Request, options?: WebhookOptions): Promise<Response> {
      if (!verifySecret(request, secretToken)) {
        return new Response('Unauthorized', { status: 401 });
      }
      let payload: GroupMeWebhookPayload;
      try {
        payload = (await request.json()) as GroupMeWebhookPayload;
      } catch {
        return new Response('Bad Request', { status: 400 });
      }
      if (!payload || typeof payload !== 'object' || !payload.group_id) {
        return new Response('Bad Request', { status: 400 });
      }
      if (payload.sender_type === 'bot' || payload.sender_type === 'system' || payload.system) {
        return new Response('ok', { status: 200 });
      }
      const message = this.parseMessage(payload);
      recordMessage(message.threadId, message);
      chat?.processMessage(this, message.threadId, message, options);
      return new Response('ok', { status: 202 });
    },

    async postMessage(
      threadId: string,
      message: AdapterPostableMessage,
    ): Promise<RawMessage<GroupMeWebhookPayload>> {
      const { groupId } = this.decodeThreadId(threadId);
      const text = renderMessage(message).trim();
      const response = await fetchImpl(`${apiBaseUrl}/v3/bots/post`, {
        body: JSON.stringify({ bot_id: botId, text }),
        headers: { 'content-type': 'application/json' },
        method: 'POST',
      });
      if (!response.ok) {
        throw new Error(`GroupMe bot post failed with status ${response.status}.`);
      }
      const id = randomUUID();
      const raw: GroupMeWebhookPayload = {
        created_at: Math.floor(Date.now() / 1_000),
        group_id: groupId,
        id,
        name: userName,
        sender_id: botId,
        sender_type: 'bot',
        text,
      };
      recordMessage(threadId, new Message({
        attachments: [],
        author: { fullName: userName, isBot: true, isMe: true, userId: botId, userName },
        formatted: parseMarkdown(text),
        id,
        links: [],
        metadata: { dateSent: new Date(), edited: false },
        raw,
        text,
        threadId,
      }));
      return { id, raw, threadId };
    },

    async editMessage(
      threadId: string,
      _messageId: string,
      message: AdapterPostableMessage,
    ): Promise<RawMessage<GroupMeWebhookPayload>> {
      return await this.postMessage(threadId, message);
    },

    async deleteMessage(): Promise<void> {
      throw new NotImplementedError('GroupMe bots cannot delete messages.', 'deleteMessage');
    },

    async addReaction(): Promise<void> {},
    async removeReaction(): Promise<void> {},
    async startTyping(): Promise<void> {},

    async fetchMessages(
      threadId: string,
      options?: FetchOptions,
    ): Promise<FetchResult<GroupMeWebhookPayload>> {
      const list = history.get(threadId) ?? [];
      const limit = options?.limit ?? MAX_CACHED_MESSAGES;
      return { messages: list.slice(-limit) };
    },

    async fetchThread(threadId: string): Promise<ThreadInfo> {
      const { groupId } = this.decodeThreadId(threadId);
      return { channelId: `groupme:${groupId}`, id: threadId, isDM: false, metadata: {} };
    },
  };

  return adapter;
}

function verifySecret(request: Request, expected: string): boolean {
  const bearer = request.headers.get('authorization')?.replace(/^Bearer\s+/iu, '').trim();
  const header = request.headers.get('x-groupme-bot-secret')?.trim();
  const query = new URL(request.url, 'http://localhost').searchParams.get('secret')?.trim();
  const candidate = header || bearer || query;
  if (!candidate) return false;
  const left = Buffer.from(candidate);
  const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}
