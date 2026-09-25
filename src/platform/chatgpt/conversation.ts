import { z } from "zod"

const idSchema = z.string().min(1)
const messageSchema = z.object({
  id: idSchema,
  author: z.object({ role: z.string() }),
  recipient: z.string().nullish(),
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
})

type ApiMessage = z.infer<typeof messageSchema>

export const conversationMessageSchema = z.object({
  id: idSchema,
  role: z.enum(["user", "assistant", "tool"]),
  recipient: z.string().nullable(),
  content: messageSchema.shape.content,
  metadata: messageSchema.shape.metadata,
  createdAt: z.number().nullable(),
  updatedAt: z.number().nullable(),
  status: z.string().nullable(),
  endTurn: z.boolean().nullable(),
  channel: z.string().nullable(),
  hidden: z.boolean(),
})
export type ConversationMessage = z.infer<typeof conversationMessageSchema>

export const branchNodeSchema = z.object({
  // Paginated responses do not expose mapping node IDs or parent node IDs.
  nodeId: idSchema.nullable(),
  parentNodeId: idSchema.nullable(),
  messageId: idSchema.nullable(),
  parentMessageId: idSchema.nullable(),
})
export type BranchNode = z.infer<typeof branchNodeSchema>

export const conversationHistorySchema = z.object({
  conversationId: idSchema,
  title: z.string(),
  currentNodeId: idSchema,
  messages: z.array(conversationMessageSchema),
  nodes: z.array(branchNodeSchema),
  isHistoryComplete: z.boolean(),
  missingNodeId: idSchema.nullable(),
  isGenerating: z.boolean().optional(),
})
export type ConversationHistory = z.infer<typeof conversationHistorySchema>

export class ConversationDataError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "ConversationDataError"
  }
}

export function parseApiResponse<T>(schema: z.ZodType<T>, value: unknown): T {
  // MAIN-world capture and MV3 extension contexts disallow dynamic code generation.
  const result = schema.safeParse(value, { jitless: true })
  if (!result.success) {
    // Report locations, never raw response values or authentication data.
    const paths = result.error.issues.map((issue) => issue.path.join(".") || "response")
    throw new ConversationDataError(`Invalid ChatGPT response fields: ${paths.join(", ")}`)
  }
  return result.data
}

function normalizeDisplayMessage(message: ApiMessage): ConversationMessage[] {
  const role = message.author.role
  if (role !== "user" && role !== "assistant" && role !== "tool") return []
  return [
    {
      id: message.id,
      role,
      recipient: message.recipient ?? null,
      content: message.content,
      metadata: message.metadata,
      createdAt: message.create_time ?? null,
      updatedAt: message.update_time ?? null,
      status: message.status ?? null,
      endTurn: message.end_turn ?? null,
      channel: message.channel ?? null,
      hidden: role === "tool" || message.metadata.is_visually_hidden_from_conversation === true,
    },
  ]
}

export function parseStreamMessage(value: unknown) {
  const message = parseApiResponse(messageSchema, value)
  return {
    messages: normalizeDisplayMessage(message),
    node: {
      nodeId: null,
      parentNodeId: null,
      messageId: message.id,
      parentMessageId: message.metadata.parent_id ?? null,
    } satisfies BranchNode,
  }
}

export function mergeStreamMessages(
  current: ConversationHistory | undefined,
  conversationId: string,
  messages: ConversationMessage[],
  nodes: BranchNode[],
  isGenerating: boolean,
  branchParentId?: string,
): ConversationHistory {
  if (current && branchParentId !== undefined) {
    const parentIndex = current.nodes.findIndex(
      (node) => node.nodeId === branchParentId || node.messageId === branchParentId,
    )
    const retainedNodes = current.nodes.slice(0, parentIndex + 1)
    const retainedIds = new Set(retainedNodes.map((node) => node.messageId))
    current = {
      ...current,
      nodes: retainedNodes,
      messages: current.messages.filter((message) => retainedIds.has(message.id)),
      currentNodeId: branchParentId,
      isHistoryComplete: current.isHistoryComplete && parentIndex !== -1,
      missingNodeId: parentIndex === -1 ? branchParentId : current.missingNodeId,
    }
  }
  const mergedMessages = new Map(current?.messages.map((message) => [message.id, message]))
  const mergedNodes = new Map(current?.nodes.map((node) => [node.messageId ?? node.nodeId, node]))
  let complete = current?.isHistoryComplete ?? false
  for (const node of nodes) {
    if (
      !mergedNodes.has(node.messageId) &&
      node.parentMessageId &&
      !mergedNodes.has(node.parentMessageId) &&
      ![...mergedNodes.values()].some((parent) => parent.nodeId === node.parentMessageId)
    )
      complete = false
    const existing = mergedNodes.get(node.messageId)
    mergedNodes.set(
      node.messageId,
      existing ? { ...node, nodeId: existing.nodeId, parentNodeId: existing.parentNodeId } : node,
    )
  }
  for (const message of messages) mergedMessages.set(message.id, message)
  return {
    conversationId,
    title: current?.title ?? "",
    currentNodeId: nodes.at(-1)?.nodeId ?? nodes.at(-1)?.messageId ?? current?.currentNodeId ?? "",
    messages: [...mergedMessages.values()],
    nodes: [...mergedNodes.values()],
    isHistoryComplete: complete,
    missingNodeId: current?.missingNodeId ?? null,
    isGenerating,
  }
}

export function mergeConversationHistory(
  current: ConversationHistory | undefined,
  history: ConversationHistory,
): ConversationHistory {
  if (!current || history.isHistoryComplete) return history
  const firstId = history.nodes[0]?.messageId
  const index = firstId ? current.nodes.findIndex((node) => node.messageId === firstId) : -1
  if (index <= 0) return history
  // A stable shared message identifies the same ancestors, even after an edit
  // replaces its descendants. Keep that prefix and take the new active suffix.
  const prefix = current.nodes.slice(0, index)
  const prefixIds = new Set(prefix.map((node) => node.messageId))
  return {
    ...history,
    nodes: [...prefix, ...history.nodes],
    messages: [
      ...current.messages.filter((message) => prefixIds.has(message.id)),
      ...history.messages,
    ],
    missingNodeId: current.missingNodeId,
  }
}

const conversationInfoSchema = z.object({
  conversation_id: idSchema,
  title: z.string(),
  current_node: idSchema,
})
const nodeSchema = z.object({
  id: idSchema,
  parent: idSchema.nullable(),
  message: messageSchema.nullish(),
})
const historySchema = conversationInfoSchema.extend({
  mapping: z.record(z.string(), nodeSchema),
})

export function parseConversation(value: unknown): ConversationHistory {
  const data = parseApiResponse(historySchema, value)
  const path: z.infer<typeof nodeSchema>[] = []
  const seen = new Set<string>()
  let id: string | null = data.current_node
  let missingNodeId: string | null = null
  while (id !== null) {
    if (seen.has(id)) throw new ConversationDataError("Cycle in active conversation branch")
    seen.add(id)
    const node: z.infer<typeof nodeSchema> | undefined = Object.hasOwn(data.mapping, id)
      ? data.mapping[id]
      : undefined
    if (!node) {
      missingNodeId = id
      break
    }
    if (node.id !== id) throw new ConversationDataError("Mapping key does not match node ID")
    path.push(node)
    id = node.parent
  }
  path.reverse()
  const messageIds = new Set<string>()
  for (const node of path) {
    if (!node.message) continue
    if (messageIds.has(node.message.id)) {
      throw new ConversationDataError("Duplicate message ID in active branch")
    }
    messageIds.add(node.message.id)
  }
  return {
    conversationId: data.conversation_id,
    title: data.title,
    currentNodeId: data.current_node,
    messages: path.flatMap((node) => (node.message ? normalizeDisplayMessage(node.message) : [])),
    nodes: path.map((node) => ({
      nodeId: node.id,
      parentNodeId: node.parent,
      messageId: node.message?.id ?? null,
      parentMessageId: node.message?.metadata.parent_id ?? null,
    })),
    isHistoryComplete: missingNodeId === null,
    missingNodeId,
  }
}

const pageSchema = z.object({
  messages: z.array(messageSchema),
  page_info: z.object({
    has_previous_page: z.boolean(),
    has_next_page: z.boolean(),
    start_cursor: idSchema.nullable(),
    end_cursor: idSchema.nullable(),
  }),
})

export const conversationPageSchema = z.object({
  conversationId: idSchema,
  conversationInfo: conversationHistorySchema.pick({ title: true, currentNodeId: true }).nullable(),
  before: idSchema.nullable(),
  previousCursor: idSchema.nullable(),
  hasNewerMessages: z.boolean(),
  messages: z.array(conversationMessageSchema),
  nodes: z.array(branchNodeSchema),
})
export type ConversationPage = z.infer<typeof conversationPageSchema>

export function parseConversationPage(
  value: unknown,
  conversationId: string,
  before: string | null = null,
): ConversationPage {
  const data = parseApiResponse(pageSchema, value)
  const conversationInfo = before === null ? parseApiResponse(conversationInfoSchema, value) : null
  if (conversationInfo && conversationInfo.conversation_id !== conversationId) {
    throw new ConversationDataError("Conversation ID does not match request")
  }
  const previousCursor = data.page_info.has_previous_page ? data.page_info.start_cursor : null
  if (data.page_info.has_previous_page && !previousCursor) {
    throw new ConversationDataError("Missing previous-page cursor")
  }
  if (previousCursor !== null && previousCursor === before) {
    throw new ConversationDataError("Conversation cursor did not advance")
  }
  return {
    conversationId,
    conversationInfo: conversationInfo
      ? { title: conversationInfo.title, currentNodeId: conversationInfo.current_node }
      : null,
    before,
    previousCursor,
    hasNewerMessages: data.page_info.has_next_page,
    messages: data.messages.flatMap(normalizeDisplayMessage),
    nodes: data.messages.map((message) => ({
      nodeId: null,
      parentNodeId: null,
      messageId: message.id,
      parentMessageId: message.metadata.parent_id ?? null,
    })),
  }
}

// Pages are supplied in fetch order: latest page first, then progressively older pages.
export function mergeConversationPages(pages: readonly ConversationPage[]): ConversationHistory {
  const first = pages[0]
  if (!first?.conversationInfo || first.before !== null) {
    throw new ConversationDataError("History must begin with the initial conversation page")
  }
  const cursors = new Set<string>()
  for (const [index, page] of pages.entries()) {
    const previous = pages[index - 1]
    if (
      page.conversationId !== first.conversationId ||
      (index > 0 &&
        (!previous || previous.previousCursor === null || page.before !== previous.previousCursor))
    ) {
      throw new ConversationDataError("Pages do not form a continuous conversation history")
    }
    if (page.previousCursor !== null) {
      if (cursors.has(page.previousCursor))
        throw new ConversationDataError("Repeated history cursor")
      cursors.add(page.previousCursor)
    }
  }
  // Keep the version from the more recent page when boundary messages overlap.
  const messages = new Map<string, ConversationMessage>()
  const nodes = new Map<string, BranchNode>()
  for (const page of pages) {
    for (const message of page.messages)
      if (!messages.has(message.id)) messages.set(message.id, message)
    for (const node of page.nodes)
      if (node.messageId && !nodes.has(node.messageId)) nodes.set(node.messageId, node)
  }
  const orderedIds = [
    ...new Set(
      [...pages]
        .reverse()
        .flatMap((page) => page.nodes.flatMap((node) => (node.messageId ? [node.messageId] : []))),
    ),
  ]
  return {
    conversationId: first.conversationId,
    ...first.conversationInfo,
    messages: orderedIds.flatMap((id) => (messages.has(id) ? [messages.get(id)!] : [])),
    nodes: orderedIds.map((id) => nodes.get(id)!),
    isHistoryComplete: !first.hasNewerMessages && pages.at(-1)?.previousCursor === null,
    missingNodeId: null,
  }
}
