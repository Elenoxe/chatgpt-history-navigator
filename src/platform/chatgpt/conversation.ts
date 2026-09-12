import { z } from 'zod';

const idSchema = z.string().min(1);
const messageSchema = z.object({
  id: idSchema,
  author: z.object({ role: z.string() }),
  content: z.looseObject({ content_type: z.string() }),
  metadata: z.looseObject({
    is_visually_hidden_from_conversation: z.boolean().optional(),
    parent_id: idSchema.nullish(),
  }),
  create_time: z.number().nullish(),
  update_time: z.number().nullish(),
  status: z.string().optional(),
  end_turn: z.boolean().nullish(),
  channel: z.string().nullish(),
});

type ApiMessage = z.infer<typeof messageSchema>;

export type ConversationMessage = {
  id: string;
  role: 'user' | 'assistant';
  content: ApiMessage['content'];
  metadata: ApiMessage['metadata'];
  createdAt: number | null;
  updatedAt: number | null;
  status: string | null;
  endTurn: boolean | null;
  channel: string | null;
  hidden: boolean;
};

export type BranchNode = {
  // Paginated responses do not expose mapping node IDs or parent node IDs.
  nodeId: string | null;
  parentNodeId: string | null;
  messageId: string | null;
  parentMessageId: string | null;
};

export type ConversationHistory = {
  conversationId: string;
  title: string;
  currentNodeId: string;
  messages: ConversationMessage[];
  nodes: BranchNode[];
  complete: boolean;
  missingNodeId: string | null;
};

export class ConversationDataError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConversationDataError';
  }
}

export function parseData<T>(schema: z.ZodType<T>, value: unknown): T {
  // MAIN-world capture and MV3 extension contexts disallow dynamic code generation.
  const result = schema.safeParse(value, { jitless: true });
  if (!result.success) {
    // Report locations, never raw response values or authentication data.
    const paths = result.error.issues.map((issue) => issue.path.join('.') || 'response');
    throw new ConversationDataError(`Invalid ChatGPT response fields: ${paths.join(', ')}`);
  }
  return result.data;
}

function retainMessage(message: ApiMessage): ConversationMessage[] {
  const role = message.author.role;
  if (role !== 'user' && role !== 'assistant') return [];
  return [{
    id: message.id,
    role,
    content: message.content,
    metadata: message.metadata,
    createdAt: message.create_time ?? null,
    updatedAt: message.update_time ?? null,
    status: message.status ?? null,
    endTurn: message.end_turn ?? null,
    channel: message.channel ?? null,
    hidden: message.metadata.is_visually_hidden_from_conversation === true,
  }];
}

const headerSchema = z.object({
  conversation_id: idSchema,
  title: z.string(),
  current_node: idSchema,
});
const nodeSchema = z.object({
  id: idSchema,
  parent: idSchema.nullable(),
  message: messageSchema.nullish(),
});
const historySchema = headerSchema.extend({
  mapping: z.record(z.string(), nodeSchema),
});

export function parseConversation(value: unknown): ConversationHistory {
  const data = parseData(historySchema, value);
  const path: z.infer<typeof nodeSchema>[] = [];
  const seen = new Set<string>();
  let id: string | null = data.current_node;
  let missingNodeId: string | null = null;
  while (id !== null) {
    if (seen.has(id)) throw new ConversationDataError('Cycle in active conversation branch');
    seen.add(id);
    const node: z.infer<typeof nodeSchema> | undefined = Object.hasOwn(data.mapping, id)
      ? data.mapping[id] : undefined;
    if (!node) {
      missingNodeId = id;
      break;
    }
    if (node.id !== id) throw new ConversationDataError('Mapping key does not match node ID');
    path.push(node);
    id = node.parent;
  }
  path.reverse();
  const messageIds = new Set<string>();
  for (const node of path) {
    if (!node.message) continue;
    if (messageIds.has(node.message.id)) {
      throw new ConversationDataError('Duplicate message ID in active branch');
    }
    messageIds.add(node.message.id);
  }
  return {
    conversationId: data.conversation_id,
    title: data.title,
    currentNodeId: data.current_node,
    messages: path.flatMap((node) => node.message ? retainMessage(node.message) : []),
    nodes: path.map((node) => ({
      nodeId: node.id,
      parentNodeId: node.parent,
      messageId: node.message?.id ?? null,
      parentMessageId: node.message?.metadata.parent_id ?? null,
    })),
    complete: missingNodeId === null,
    missingNodeId,
  };
}

const pageSchema = z.object({
  messages: z.array(messageSchema),
  page_info: z.object({
    has_previous_page: z.boolean(),
    has_next_page: z.boolean(),
    start_cursor: idSchema.nullable(),
    end_cursor: idSchema.nullable(),
  }),
});

export type ConversationPage = {
  conversationId: string;
  header: Pick<ConversationHistory, 'title' | 'currentNodeId'> | null;
  before: string | null;
  previousCursor: string | null;
  hasNewer: boolean;
  messages: ConversationMessage[];
  nodes: BranchNode[];
};

export function parseConversationPage(
  value: unknown,
  conversationId: string,
  before: string | null = null,
): ConversationPage {
  const data = parseData(pageSchema, value);
  const header = before === null ? parseData(headerSchema, value) : null;
  if (header && header.conversation_id !== conversationId) {
    throw new ConversationDataError('Conversation ID does not match request');
  }
  const previousCursor = data.page_info.has_previous_page ? data.page_info.start_cursor : null;
  if (data.page_info.has_previous_page && !previousCursor) {
    throw new ConversationDataError('Missing previous-page cursor');
  }
  if (previousCursor !== null && previousCursor === before) {
    throw new ConversationDataError('Conversation cursor did not advance');
  }
  return {
    conversationId,
    header: header ? { title: header.title, currentNodeId: header.current_node } : null,
    before,
    previousCursor,
    hasNewer: data.page_info.has_next_page,
    messages: data.messages.flatMap(retainMessage),
    nodes: data.messages.map((message) => ({
      nodeId: null,
      parentNodeId: null,
      messageId: message.id,
      parentMessageId: message.metadata.parent_id ?? null,
    })),
  };
}

// Pages are supplied in fetch order: latest page first, then progressively older pages.
export function mergeConversationPages(pages: readonly ConversationPage[]): ConversationHistory {
  const first = pages[0];
  if (!first?.header || first.before !== null) {
    throw new ConversationDataError('History must begin with the initial conversation page');
  }
  const cursors = new Set<string>();
  for (const [index, page] of pages.entries()) {
    const previous = pages[index - 1];
    if (page.conversationId !== first.conversationId ||
      (index > 0 && (!previous || previous.previousCursor === null ||
        page.before !== previous.previousCursor))) {
      throw new ConversationDataError('Pages do not form a continuous conversation history');
    }
    if (page.previousCursor !== null) {
      if (cursors.has(page.previousCursor)) throw new ConversationDataError('Repeated history cursor');
      cursors.add(page.previousCursor);
    }
  }
  // Keep the version from the more recent page when boundary messages overlap.
  const messages = new Map<string, ConversationMessage>();
  const nodes = new Map<string, BranchNode>();
  for (const page of pages) {
    for (const message of page.messages) if (!messages.has(message.id)) messages.set(message.id, message);
    for (const node of page.nodes) if (node.messageId && !nodes.has(node.messageId)) nodes.set(node.messageId, node);
  }
  const orderedIds = [...new Set([...pages].reverse().flatMap((page) =>
    page.nodes.flatMap((node) => node.messageId ? [node.messageId] : [])))];
  return {
    conversationId: first.conversationId,
    ...first.header,
    messages: orderedIds.flatMap((id) => messages.has(id) ? [messages.get(id)!] : []),
    nodes: orderedIds.map((id) => nodes.get(id)!),
    complete: !first.hasNewer && pages.at(-1)?.previousCursor === null,
    missingNodeId: null,
  };
}
