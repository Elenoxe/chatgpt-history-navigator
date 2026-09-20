import { z } from "zod";
import { writingBlocksSchema } from './writing';
import {
  conversationHistorySchema,
  conversationPageSchema,
  conversationMessageSchema,
  branchNodeSchema,
} from "./conversation";

const channel = "chatgpt-history-navigator:history";
const revealEvent = 'chatgpt-history-navigator:reveal-question';
const loadQuestionEvent = 'chatgpt-history-navigator:load-question';
const loadQuestionDoneEvent = 'chatgpt-history-navigator:load-question-done';
const cancelLoadQuestionEvent = 'chatgpt-history-navigator:cancel-load-question';
const revealRequestSchema = z.object({
  messageId: z.uuid(),
  pathname: z.string(),
  action: z.enum(['reveal', 'navigation-pending', 'cancel-navigation', 'refresh-pagination', 'stop-pagination']).default('reveal'),
});

export function installNavigationHandlers(
  reveal: (messageId: string) => boolean,
  loadHistory: (messageId: string, signal: AbortSignal) => Promise<boolean>,
  observePagination: (active: boolean) => void,
  controlNavigation: (messageId: string, cancel: boolean) => boolean,
) {
  document.addEventListener(revealEvent, event => {
    const target = event.target;
    if (!(target instanceof HTMLElement) || target.parentElement !== document.documentElement) return;
    const parsed = revealRequestSchema.safeParse({
      messageId: target.dataset.messageId, pathname: target.dataset.pathname, action: target.dataset.action,
    });
    if (!parsed.success || parsed.data.pathname !== location.pathname) return;
    let revealed = false;
    try {
      if (parsed.data.action === 'reveal') revealed = reveal(parsed.data.messageId);
      else if (parsed.data.action === 'navigation-pending' || parsed.data.action === 'cancel-navigation') {
        revealed = controlNavigation(parsed.data.messageId, parsed.data.action === 'cancel-navigation');
      }
      else observePagination(parsed.data.action === 'refresh-pagination');
    }
    catch (error) { console.warn('[chatgpt-history-navigator] Native question reveal failed:', error); }
    target.dataset.revealed = String(revealed);
  });
  document.addEventListener(loadQuestionEvent, event => {
    const target = event.target;
    if (!(target instanceof HTMLElement) || target.parentElement !== document.documentElement) return;
    const parsed = revealRequestSchema.safeParse({
      messageId: target.dataset.messageId, pathname: target.dataset.pathname,
    });
    if (!parsed.success || parsed.data.pathname !== location.pathname || target.dataset.loading) return;
    target.dataset.loading = 'true';
    const controller = new AbortController();
    const cancel = () => controller.abort();
    target.addEventListener(cancelLoadQuestionEvent, cancel, { once: true });
    void loadHistory(parsed.data.messageId, controller.signal).then(loaded => {
      target.dataset.result = loaded ? 'loaded' : 'unavailable';
    }).catch(error => {
      if (controller.signal.aborted) return;
      console.error('[chatgpt-history-navigator] Native history load failed:', error);
      target.dataset.result = 'error';
    }).finally(() => {
      target.removeEventListener(cancelLoadQuestionEvent, cancel);
      if (!controller.signal.aborted) target.dispatchEvent(new Event(loadQuestionDoneEvent));
    });
  });
}

export function requestQuestionHistory(messageId: string, signal: AbortSignal): Promise<boolean> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const request = document.createElement('span');
    request.hidden = true;
    request.dataset.messageId = messageId;
    request.dataset.pathname = location.pathname;
    const cleanup = () => {
      signal.removeEventListener('abort', abort);
      request.removeEventListener(loadQuestionDoneEvent, done);
      request.remove();
    };
    const abort = () => {
      request.dispatchEvent(new Event(cancelLoadQuestionEvent));
      cleanup();
      reject(signal.reason);
    };
    const done = () => {
      const result = request.dataset.result;
      cleanup();
      if (result === 'error') reject(new Error('Native history load failed'));
      else resolve(result === 'loaded');
    };
    signal.addEventListener('abort', abort, { once: true });
    request.addEventListener(loadQuestionDoneEvent, done);
    document.documentElement.append(request);
    request.dispatchEvent(new Event(loadQuestionEvent, { bubbles: true }));
    // Synchronous acknowledgement distinguishes a missing adapter from a slow
    // request, without imposing a timeout on loading.
    if (request.dataset.loading !== 'true') { cleanup(); resolve(false); }
  });
}

export function tryRevealQuestion(messageId: string): boolean {
  return dispatchNavigationAction(messageId, 'reveal');
}

export function isNativeNavigationPending(messageId: string): boolean {
  return dispatchNavigationAction(messageId, 'navigation-pending');
}

export function cancelNativeNavigation(messageId: string) {
  dispatchNavigationAction(messageId, 'cancel-navigation');
}

export function observeHistoryPagination(messageId: string, active: boolean) {
  dispatchNavigationAction(messageId, active ? 'refresh-pagination' : 'stop-pagination');
}

function dispatchNavigationAction(messageId: string, action: z.infer<typeof revealRequestSchema>['action']): boolean {
  // DOM event dispatch crosses the two worlds synchronously. An old queued
  // postMessage can therefore never execute after a newer navigation/cancel.
  // Only validated message IDs cross this bridge; no functions or credentials.
  const request = document.createElement('span');
  request.hidden = true;
  request.dataset.messageId = messageId;
  request.dataset.pathname = location.pathname;
  request.dataset.action = action;
  document.documentElement.append(request);
  try {
    request.dispatchEvent(new Event(revealEvent, { bubbles: true }));
    return request.dataset.revealed === 'true';
  } finally {
    request.remove();
  }
}
const historyCaptureEventSchema = z.object({
  userId: z.string().min(1),
  conversationId: z.uuid(),
  requestStartedAt: z.number().finite().nonnegative(),
  result: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal('writing'), messageId: z.string().min(1), blocks: writingBlocksSchema }),
    z.object({ kind: z.literal('files-changed') }),
    z.object({ kind: z.literal('writing-file'), libraryId: z.string().min(1), fileId: z.string().min(1),
      version: z.number().int().nonnegative(), content: z.string().optional() }),
    z.object({ kind: z.literal('messages'), messages: z.array(conversationMessageSchema),
      nodes: z.array(branchNodeSchema), branchParentId: z.string().optional(),
      phase: z.enum(['streaming', 'complete', 'interrupted']) }),
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
