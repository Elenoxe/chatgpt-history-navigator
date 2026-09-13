import { z } from 'zod';
import { ConversationDataError, parseConversation, parseConversationPage, parseApiResponse } from './conversation';

export class ChatgptHttpError extends Error {
  constructor(readonly status: number) {
    super(`ChatGPT request failed (HTTP ${status})`);
    this.name = 'ChatgptHttpError';
  }
}

async function requestJson(path: string, signal?: AbortSignal, accessToken?: string): Promise<unknown> {
  signal?.throwIfAborted();
  const response = await fetch(path, {
    credentials: 'include',
    cache: 'no-store',
    headers: {
      Accept: 'application/json',
      ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
    },
    signal,
  });
  if (!response.ok) throw new ChatgptHttpError(response.status);
  const text = await response.text();
  signal?.throwIfAborted();
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new ConversationDataError('ChatGPT returned invalid JSON');
  }
}

// No global token cache. The caller owns these credentials for its loading operation;
// never persist them in Query data or forward them through the page bridge.
export async function fetchAccessToken(signal?: AbortSignal): Promise<string> {
  const data = await requestJson('/api/auth/session', signal);
  return parseApiResponse(z.object({ accessToken: z.string().min(1) }), data).accessToken;
}

type RequestOptions = { accessToken: string; signal?: AbortSignal };

function conversationPath(conversationId: string, kind: 'mapping' | 'paginated'): string {
  // IDs come from page URLs/events; reject malformed IDs before making a request.
  const id = z.uuid().parse(conversationId);
  return `/backend-api/${kind === 'paginated' ? 'conversations' : 'conversation'}/${id}`;
}

export async function fetchConversation(conversationId: string, options: RequestOptions) {
  const path = conversationPath(conversationId, 'mapping');
  if (!options.accessToken.trim()) throw new Error('ChatGPT access token is required');
  const data = await requestJson(path, options.signal, options.accessToken);
  const history = parseConversation(data);
  if (history.conversationId !== conversationId) {
    throw new ConversationDataError('Conversation ID does not match request');
  }
  return history;
}

export async function fetchConversationPage(
  conversationId: string,
  options: RequestOptions & { before?: string },
) {
  const before = options.before === undefined ? null : z.string().min(1).parse(options.before);
  const path = conversationPath(conversationId, 'paginated');
  if (!options.accessToken.trim()) throw new Error('ChatGPT access token is required');
  const query = new URLSearchParams({ num_turns: '100', include_has_versions: 'true' });
  if (before !== null) query.set('before', before);
  const data = await requestJson(`${path}${before !== null ? '/messages' : ''}?${query}`, options.signal, options.accessToken);
  return parseConversationPage(data, conversationId, before);
}
