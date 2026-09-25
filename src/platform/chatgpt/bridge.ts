import { z } from "zod"
import { writingBlocksSchema } from "./writing"
import {
  conversationHistorySchema,
  conversationPageSchema,
  conversationMessageSchema,
  branchNodeSchema,
} from "./conversation"

const channel = "chatgpt-history-navigator:history"
const ensureHistoryEvent = "chatgpt-history-navigator:ensure-history"
const ensureHistoryCancelEvent = "chatgpt-history-navigator:cancel-ensure-history"
const nativeHistoryRequestSchema = z.object({
  requestId: z.uuid(),
  userId: z.string().min(1),
  conversationId: z.uuid(),
})
const nativeHistoryResultSchema = nativeHistoryRequestSchema.extend({
  result: z.enum(["loaded", "unavailable", "error"]),
})

export function installNativeHistoryHandler(
  load: (userId: string, conversationId: string, signal: AbortSignal) => Promise<boolean>,
) {
  document.addEventListener(ensureHistoryEvent, (event) => {
    const target = event.target
    if (!(target instanceof HTMLElement) || target.parentElement !== document.documentElement)
      return
    const parsed = nativeHistoryRequestSchema.safeParse(target.dataset)
    if (!parsed.success || target.dataset.accepted) return
    target.dataset.accepted = "true"
    const controller = new AbortController()
    const cancel = () => controller.abort()
    target.addEventListener(ensureHistoryCancelEvent, cancel, { once: true })
    void (async () => {
      let result: "loaded" | "unavailable" | "error"
      try {
        result = (await load(parsed.data.userId, parsed.data.conversationId, controller.signal))
          ? "loaded"
          : "unavailable"
      } catch (error) {
        if (controller.signal.aborted) return
        console.error("[chatgpt-history-navigator] Native history load failed:", {
          conversationId: parsed.data.conversationId,
          requestId: parsed.data.requestId,
          name: error instanceof Error ? error.name : "UnknownError",
          message: error instanceof Error ? error.message : "Unknown native history error",
        })
        result = "error"
      } finally {
        target.removeEventListener(ensureHistoryCancelEvent, cancel)
      }
      if (!controller.signal.aborted)
        // Same message queue as captures: all preceding captures are delivered
        // before the requester decides whether its cache still needs filling.
        window.postMessage(
          { channel, type: "native-history-done", payload: { ...parsed.data, result } },
          location.origin,
        )
    })()
  })
}

export function requestNativeHistory(
  userId: string,
  conversationId: string,
  signal: AbortSignal,
): Promise<boolean> {
  signal.throwIfAborted()
  return new Promise((resolve, reject) => {
    const request = document.createElement("span")
    request.hidden = true
    const requestId = crypto.randomUUID()
    Object.assign(request.dataset, { requestId, userId, conversationId })
    const cleanup = () => {
      request.remove()
      signal.removeEventListener("abort", abort)
      window.removeEventListener("message", done)
    }
    const abort = () => {
      console.debug("[chatgpt-history-navigator] Native history request cancelled:", {
        conversationId,
        requestId,
      })
      request.dispatchEvent(new Event(ensureHistoryCancelEvent))
      cleanup()
      reject(signal.reason)
    }
    const done = (event: MessageEvent) => {
      if (!isFromHistoryChannel(event) || event.data.type !== "native-history-done") return
      const parsed = nativeHistoryResultSchema.safeParse(event.data.payload)
      if (
        !parsed.success ||
        parsed.data.requestId !== requestId ||
        parsed.data.userId !== userId ||
        parsed.data.conversationId !== conversationId
      )
        return
      cleanup()
      if (parsed.data.result === "error") reject(new Error("Native history load failed"))
      else resolve(parsed.data.result === "loaded")
    }
    window.addEventListener("message", done)
    signal.addEventListener("abort", abort, { once: true })
    document.documentElement.append(request)
    request.dispatchEvent(new Event(ensureHistoryEvent, { bubbles: true }))
    if (request.dataset.accepted !== "true") {
      cleanup()
      resolve(false)
    }
  })
}

const revealEvent = "chatgpt-history-navigator:reveal-question"
const revealDoneEvent = "chatgpt-history-navigator:reveal-question-done"
const cancelRevealEvent = "chatgpt-history-navigator:cancel-reveal-question"
const revealRequestSchema = z.object({
  messageId: z.uuid(),
  pathname: z.string(),
})

export function installNavigationHandlers(
  reveal: (messageId: string, signal: AbortSignal) => Promise<boolean>,
) {
  document.addEventListener(revealEvent, (event) => {
    const target = event.target
    if (!(target instanceof HTMLElement) || target.parentElement !== document.documentElement)
      return
    const parsed = revealRequestSchema.safeParse(target.dataset)
    if (!parsed.success || parsed.data.pathname !== location.pathname || target.dataset.accepted)
      return
    target.dataset.accepted = "true"
    const controller = new AbortController()
    const cancel = () => controller.abort()
    target.addEventListener(cancelRevealEvent, cancel, { once: true })
    void reveal(parsed.data.messageId, controller.signal)
      .then((revealed) => {
        target.dataset.result = revealed ? "revealed" : "unavailable"
      })
      .catch((error) => {
        if (controller.signal.aborted) return
        console.warn("[chatgpt-history-navigator] Native navigation failed:", error)
        target.dataset.result = "error"
      })
      .finally(() => {
        target.removeEventListener(cancelRevealEvent, cancel)
        if (!controller.signal.aborted) target.dispatchEvent(new Event(revealDoneEvent))
      })
  })
}

export function tryRevealQuestion(messageId: string, signal: AbortSignal): Promise<boolean> {
  signal.throwIfAborted()
  return new Promise((resolve, reject) => {
    const request = document.createElement("span")
    request.hidden = true
    request.dataset.messageId = messageId
    request.dataset.pathname = location.pathname
    const cleanup = () => {
      signal.removeEventListener("abort", abort)
      request.removeEventListener(revealDoneEvent, done)
      request.remove()
    }
    const abort = () => {
      request.dispatchEvent(new Event(cancelRevealEvent))
      cleanup()
      reject(signal.reason)
    }
    const done = () => {
      const result = request.dataset.result
      cleanup()
      if (result === "error") reject(new Error("Native navigation failed"))
      else resolve(result === "revealed")
    }
    signal.addEventListener("abort", abort, { once: true })
    request.addEventListener(revealDoneEvent, done)
    document.documentElement.append(request)
    request.dispatchEvent(new Event(revealEvent, { bubbles: true }))
    // A missing adapter falls back immediately; a slow operation is not a failure.
    if (request.dataset.accepted !== "true") {
      cleanup()
      resolve(false)
    }
  })
}
const historyCaptureEventSchema = z.object({
  userId: z.string().min(1),
  conversationId: z.uuid(),
  requestStartedAt: z.number().finite().nonnegative(),
  result: z.discriminatedUnion("kind", [
    z.object({
      kind: z.literal("writing"),
      messageId: z.string().min(1),
      blocks: writingBlocksSchema,
    }),
    z.object({ kind: z.literal("files-changed") }),
    z.object({
      kind: z.literal("writing-file"),
      libraryId: z.string().min(1),
      fileId: z.string().min(1),
      version: z.number().int().nonnegative(),
      content: z.string().optional(),
    }),
    z.object({
      kind: z.literal("messages"),
      messages: z.array(conversationMessageSchema),
      nodes: z.array(branchNodeSchema),
      branchParentId: z.string().optional(),
      phase: z.enum(["streaming", "complete", "interrupted"]),
    }),
    z.object({
      kind: z.literal("history"),
      history: conversationHistorySchema,
    }),
    z.object({ kind: z.literal("page"), page: conversationPageSchema }),
    z.object({
      kind: z.literal("unavailable"),
      reason: z.enum(["request-failed", "response-read-failed", "invalid-json", "invalid-data"]),
    }),
  ]),
})
export type HistoryCaptureEvent = z.infer<typeof historyCaptureEventSchema>

function isFromHistoryChannel(event: MessageEvent) {
  return (
    event.source === window && event.origin === location.origin && event.data?.channel === channel
  )
}

function post(
  type: "receiver-ready" | "publisher-ready" | "receiver-stopped" | "capture",
  payload?: HistoryCaptureEvent,
) {
  window.postMessage({ channel, type, payload }, location.origin)
}

export function createHistoryPublisher() {
  let status: "waiting" | "ready" | "stopped" = "waiting"
  let pending: HistoryCaptureEvent[] = []
  // Retain only the control listener while stopped so a new receiver can resume.
  window.addEventListener("message", (event) => {
    if (!isFromHistoryChannel(event)) return
    if (event.data.type === "receiver-stopped") {
      status = "stopped"
      pending = []
    }
    if (event.data.type !== "receiver-ready") return
    status = "ready"
    for (const payload of pending) post("capture", payload)
    pending = []
  })
  post("publisher-ready")
  return {
    isStopped: () => status === "stopped",
    publish(capture: HistoryCaptureEvent) {
      if (status === "stopped") return
      if (status === "ready") post("capture", capture)
      else pending.push(capture)
    },
  }
}

export function subscribeHistoryCaptureEvents(onCapture: (capture: HistoryCaptureEvent) => void) {
  const listener = (event: MessageEvent) => {
    if (!isFromHistoryChannel(event)) return
    if (event.data.type === "publisher-ready") post("receiver-ready")
    if (event.data.type !== "capture") return
    const parsed = historyCaptureEventSchema.safeParse(event.data.payload, {
      jitless: true,
    })
    // Page messages are untrusted even with matching source and origin.
    // This bridge only accepts data; it never grants request or credential access.
    if (parsed.success) onCapture(parsed.data)
  }
  window.addEventListener("message", listener)
  post("receiver-ready")
  let stopped = false
  return () => {
    if (stopped) return
    stopped = true
    window.removeEventListener("message", listener)
    post("receiver-stopped")
  }
}
