import { z } from "zod"
import { writingBlocksSchema } from "./writing"
import {
  parseApiResponse,
  parseStreamMessage,
  ConversationDataError,
  type ConversationMessage,
  type BranchNode,
} from "./conversation"
import type { createHistoryPublisher } from "./bridge"
import { getConversationContextSnapshot } from "./page"

// The v1 delta stream elides repeated operation/path fields, including across channels.
export function createMessageStreamParser(
  onMessage: (value: unknown) => void,
  onControl: (value: Record<string, unknown>) => void,
) {
  let buffer = ""
  let operation = "add"
  let path = ""
  let channel = 0
  const values = new Map<number, unknown>()
  const object = (value: unknown): value is Record<string, unknown> =>
    value !== null && typeof value === "object" && !Array.isArray(value)
  const apply = (root: unknown, op: string, pointer: string, value: unknown): unknown => {
    if (op === "patch") {
      if (!Array.isArray(value)) throw new ConversationDataError("Invalid stream patch")
      for (const patch of value) {
        if (!object(patch) || typeof patch.o !== "string" || typeof patch.p !== "string")
          throw new ConversationDataError("Invalid stream operation")
        root = apply(root, patch.o, patch.p, patch.v)
      }
      return root
    }
    if (!["add", "replace", "append", "remove"].includes(op))
      throw new ConversationDataError("Unsupported stream operation")
    if (pointer === "") {
      if (op !== "add" && op !== "replace")
        throw new ConversationDataError("Invalid stream root operation")
      return value
    }
    if (!pointer.startsWith("/")) throw new ConversationDataError("Invalid stream path")
    const keys = pointer
      .slice(1)
      .split("/")
      .map((key) => key.replace(/~1/g, "/").replace(/~0/g, "~"))
    if (keys.some((key) => ["__proto__", "constructor", "prototype"].includes(key)))
      throw new ConversationDataError("Unsafe stream path")
    let target = root as Record<string, unknown>
    for (const key of keys.slice(0, -1)) {
      if (!target || typeof target !== "object" || !Object.hasOwn(target, key))
        throw new ConversationDataError("Missing stream path")
      target = target[key] as Record<string, unknown>
    }
    if (!target || typeof target !== "object")
      throw new ConversationDataError("Missing stream target")
    const key = keys.at(-1)!
    if (op === "append") {
      const previous = target[key]
      if (typeof previous === "string" && typeof value === "string") target[key] = previous + value
      else if (Array.isArray(previous) && Array.isArray(value))
        target[key] = [...previous, ...value]
      else if (object(previous) && object(value)) target[key] = { ...previous, ...value }
      else throw new ConversationDataError("Invalid stream append")
    } else if (op === "remove") {
      if (Array.isArray(target)) target.splice(Number(key), 1)
      else delete target[key]
    } else target[key] = value
    return root
  }
  return (text: string) => {
    buffer += text
    let match: RegExpExecArray | null
    while ((match = /\r?\n\r?\n/.exec(buffer))) {
      const block = buffer.slice(0, match.index)
      buffer = buffer.slice(match.index + match[0].length)
      const lines = block.split(/\r?\n/)
      const data = lines
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).replace(/^ /, ""))
        .join("\n")
      if (!data || data === "[DONE]") continue // Transport EOF is not generation completion.
      const event = lines
        .find((line) => line.startsWith("event:"))
        ?.slice(6)
        .trim()
      const value: unknown = JSON.parse(data)
      if (event === "delta_encoding") {
        if (value !== "v1") throw new ConversationDataError("Unsupported stream encoding")
        continue
      }
      if (!object(value)) continue
      if (event === "delta") {
        if (typeof value.c === "number") channel = value.c
        if (typeof value.o === "string") operation = value.o
        if (typeof value.p === "string") path = value.p
        const root = apply(values.get(channel), operation, path, value.v)
        values.set(channel, root)
        if (object(root)) {
          onControl(root)
          if (root.message) onMessage(root.message)
        }
      } else if (value.type === "input_message") onMessage(value.input_message)
      else if (value.message) {
        onControl(value)
        onMessage(value.message)
      } else onControl(value)
    }
  }
}

const requestBaseSchema = z.object({
  conversation_id: z.uuid().optional(),
  parent_message_id: z.string(),
})
const requestSchema = z.discriminatedUnion("action", [
  requestBaseSchema.extend({
    action: z.literal("next"),
    messages: z.array(
      z.looseObject({ id: z.string(), metadata: z.record(z.string(), z.unknown()).optional() }),
    ),
  }),
  requestBaseSchema.extend({ action: z.literal("variant") }),
])
const wsFrameSchema = z.object({
  type: z.literal("message"),
  payload: z.object({
    type: z.literal("conversation-turn-stream"),
    payload: z.object({
      conversation_id: z.uuid(),
      type: z.enum(["stream-item", "done"]),
      encoded_item: z.string().optional(),
      stream_item_id: z.string().optional(),
    }),
  }),
})

export function installMessageStreamCapture(publisher: ReturnType<typeof createHistoryPublisher>) {
  type Session = ReturnType<typeof createSession>
  const sessions = new Map<string, Session>()
  function createSession(
    userId: string,
    conversationId: string | undefined,
    requestStartedAt: number,
    branchParentId: string,
  ) {
    const messages = new Map<string, ConversationMessage>()
    const nodes = new Map<string, BranchNode>()
    const seen = new Set<string>()
    let timer: ReturnType<typeof setTimeout> | undefined
    let finished = false
    let handedOff = false
    let branchPending = true
    const topics = new Set<string>()
    const emit = (phase: "streaming" | "complete" | "interrupted") => {
      if (timer) clearTimeout(timer)
      timer = undefined
      if (!conversationId) return
      if (conversationId && !publisher.isStopped())
        publisher.publish({
          userId,
          conversationId,
          requestStartedAt,
          result: {
            kind: "messages",
            messages: [...messages.values()],
            nodes: [...nodes.values()],
            phase,
            ...(branchPending ? { branchParentId } : {}),
          },
        })
      branchPending = false
      messages.clear()
      nodes.clear()
    }
    const finish = (phase: "complete" | "interrupted") => {
      if (finished) return
      finished = true
      emit(phase)
      if (conversationId && sessions.get(conversationId) === session)
        sessions.delete(conversationId)
    }
    const addMessage = (value: unknown) => {
      if (finished) return
      const parsed = parseStreamMessage(value)
      for (const message of parsed.messages) {
        messages.set(message.id, message)
      }
      nodes.set(parsed.node.messageId!, parsed.node)
      if (!timer) timer = setTimeout(() => emit("streaming"), 50)
    }
    const bind = (id: string) => {
      if (finished) return
      if (conversationId && conversationId !== id)
        throw new ConversationDataError("Stream conversation changed")
      conversationId = id
      const previous = sessions.get(id)
      if (previous && previous !== session) previous.discard()
      sessions.set(id, session)
      if (messages.size && !timer) timer = setTimeout(() => emit("streaming"), 50)
    }
    const feed = createMessageStreamParser(addMessage, (control) => {
      if (typeof control.conversation_id === "string")
        bind(parseApiResponse(z.uuid(), control.conversation_id))
      if (control.type === "writing_blocks_metadata_patch" && conversationId) {
        const patch = parseApiResponse(
          z.object({ message_id: z.string().min(1), writing_blocks: writingBlocksSchema }),
          control,
        )
        emit("streaming")
        publisher.publish({
          userId,
          conversationId,
          requestStartedAt,
          result: { kind: "writing", messageId: patch.message_id, blocks: patch.writing_blocks },
        })
      }
      if (control.type === "stream_handoff") {
        handedOff = true
        if (Array.isArray(control.options))
          for (const option of control.options) {
            if (typeof option?.topic_id === "string") topics.add(option.topic_id)
          }
      }
      if (control.type === "message_stream_complete") finish("complete")
      if (control.type === "error") finish("interrupted")
    })
    const session = {
      userId,
      addMessage,
      bind,
      feed,
      seen,
      topics,
      finish,
      start: () => emit("streaming"),
      discard: () => {
        finished = true
        clearTimeout(timer)
        messages.clear()
        nodes.clear()
        seen.clear()
      },
      get finished() {
        return finished
      },
      get handedOff() {
        return handedOff
      },
    }
    if (conversationId) bind(conversationId)
    return session
  }
  const originalSend = WebSocket.prototype.send
  const watched = new WeakSet<WebSocket>()
  WebSocket.prototype.send = function (data) {
    if (!watched.has(this)) {
      watched.add(this)
      const socketSessions = new Set<Session>()
      this.addEventListener("close", () => {
        for (const session of socketSessions) session.finish("interrupted")
        socketSessions.clear()
      })
      this.addEventListener("message", (event) => {
        if (publisher.isStopped() || typeof event.data !== "string") return
        let frames: unknown
        try {
          frames = JSON.parse(event.data)
        } catch {
          return
        }
        if (!Array.isArray(frames)) return
        for (const frame of frames) {
          const catchups: unknown[] = Array.isArray(frame?.reply?.catchups)
            ? frame.reply.catchups
            : []
          for (const candidate of [frame, ...catchups]) {
            const parsed = wsFrameSchema.safeParse(candidate, { jitless: true })
            if (!parsed.success) continue
            const item = parsed.data.payload.payload
            const session = sessions.get(item.conversation_id)
            if (
              !session ||
              !session.handedOff ||
              JSON.parse(getConversationContextSnapshot())[0] !== session.userId
            )
              continue
            if (session.topics.size && !session.topics.has(candidate.topic_id)) continue
            socketSessions.add(session)
            try {
              if (item.type === "done") session.finish("complete")
              else if (
                item.stream_item_id &&
                item.encoded_item &&
                !session.seen.has(item.stream_item_id)
              ) {
                session.seen.add(item.stream_item_id)
                session.feed(item.encoded_item)
              }
              if (session.finished) socketSessions.delete(session)
            } catch {
              console.warn("[chatgpt-history-navigator] Unable to parse message stream")
              session.finish("interrupted")
            }
          }
        }
      })
    }
    return originalSend.call(this, data)
  }
  const readResponse = async (response: Response, session: Session) => {
    const reader = response.clone().body?.getReader()
    if (!reader) throw new ConversationDataError("Missing conversation stream body")
    const decoder = new TextDecoder()
    try {
      while (!session.finished) {
        const chunk = await reader.read()
        if (chunk.done) break
        if (publisher.isStopped()) {
          session.finish("interrupted")
          break
        }
        session.feed(decoder.decode(chunk.value, { stream: true }))
      }
      if (!session.finished && !session.handedOff) session.finish("interrupted")
    } finally {
      void reader.cancel().catch(() => {})
      reader.releaseLock()
    }
  }
  const captureRequest = async (
    input: RequestInfo | URL,
    init: RequestInit | undefined,
    response: Promise<Response>,
    userId: string,
  ) => {
    let session: Session | undefined
    try {
      const body =
        typeof init?.body === "string"
          ? init.body
          : input instanceof Request
            ? await input.text()
            : null
      if (body === null) throw new ConversationDataError("Unsupported conversation request body")
      const request = parseApiResponse(requestSchema, JSON.parse(body))
      session = createSession(
        userId,
        request.conversation_id,
        performance.timeOrigin + performance.now(),
        request.parent_message_id,
      )
      if (request.action === "next")
        for (const message of request.messages)
          session.addMessage({
            ...message,
            metadata: { ...message.metadata, parent_id: request.parent_message_id },
          })
      session.start()
      const result = await response
      if (!result.ok || !result.headers.get("content-type")?.includes("text/event-stream"))
        throw new ConversationDataError("Invalid conversation stream response")
      await readResponse(result, session)
    } catch {
      // A handed-off stream can be aborted normally by the page after switching to WS.
      if (!session?.handedOff) session?.finish("interrupted")
      if (!session) console.warn("[chatgpt-history-navigator] Unsupported conversation submission")
    }
  }
  return {
    captureRequest,
    async captureResume(url: URL, response: Promise<Response>) {
      // Observe only resume requests associated with a handoff we already saw.
      const session = [...sessions.entries()].find(
        ([id, session]) =>
          session.handedOff &&
          (url.pathname.includes(id) ||
            [...session.topics].some((topic) => url.pathname.includes(topic))),
      )?.[1]
      if (!session) return
      try {
        const result = await response
        if (!result.headers.get("content-type")?.includes("text/event-stream")) return
        if (!result.ok) throw new ConversationDataError("Resume stream request failed")
        await readResponse(result, session)
        if (!session.finished) session.finish("interrupted")
      } catch {
        session.finish("interrupted")
      }
    },
  }
}
