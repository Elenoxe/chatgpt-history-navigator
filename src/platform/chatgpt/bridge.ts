import { z } from "zod";
import {
  conversationHistorySchema,
  conversationPageSchema,
  conversationMessageSchema,
  branchNodeSchema,
} from "./conversation";

const channel = "chatgpt-timeline:history";
const historyCaptureEventSchema = z.object({
  userId: z.string().min(1),
  conversationId: z.uuid(),
  requestStartedAt: z.number().finite().nonnegative(),
  result: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal('messages'), messages: z.array(conversationMessageSchema),
      nodes: z.array(branchNodeSchema), phase: z.enum(['streaming', 'complete', 'interrupted']) }),
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
});
export type HistoryCaptureEvent = z.infer<typeof historyCaptureEventSchema>;

function isFromHistoryChannel(event: MessageEvent) {
  return (
    event.source === window &&
    event.origin === location.origin &&
    event.data?.channel === channel
  );
}

function post(
  type: "receiver-ready" | "publisher-ready" | "receiver-stopped" | "capture",
  payload?: HistoryCaptureEvent,
) {
  window.postMessage({ channel, type, payload }, location.origin);
}

export function createHistoryPublisher() {
  let status: "waiting" | "ready" | "stopped" = "waiting";
  let pending: HistoryCaptureEvent[] = [];
  // Retain only the control listener while stopped so a new receiver can resume.
  window.addEventListener("message", (event) => {
    if (!isFromHistoryChannel(event)) return;
    if (event.data.type === "receiver-stopped") {
      status = "stopped";
      pending = [];
    }
    if (event.data.type !== "receiver-ready") return;
    status = "ready";
    for (const payload of pending) post("capture", payload);
    pending = [];
  });
  post("publisher-ready");
  return {
    isStopped: () => status === "stopped",
    publish(capture: HistoryCaptureEvent) {
      if (status === "stopped") return;
      if (status === "ready") post("capture", capture);
      else pending.push(capture);
    },
  };
}

export function subscribeHistoryCaptureEvents(
  onCapture: (capture: HistoryCaptureEvent) => void,
) {
  const listener = (event: MessageEvent) => {
    if (!isFromHistoryChannel(event)) return;
    if (event.data.type === "publisher-ready") post("receiver-ready");
    if (event.data.type !== "capture") return;
    const parsed = historyCaptureEventSchema.safeParse(event.data.payload, {
      jitless: true,
    });
    // Page messages are untrusted even with matching source and origin.
    // This bridge only accepts data; it never grants request or credential access.
    if (parsed.success) onCapture(parsed.data);
  };
  window.addEventListener("message", listener);
  post("receiver-ready");
  let stopped = false;
  return () => {
    if (stopped) return;
    stopped = true;
    window.removeEventListener("message", listener);
    post("receiver-stopped");
  };
}
