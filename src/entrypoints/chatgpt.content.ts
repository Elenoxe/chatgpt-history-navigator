import { createHistoryPublisher, installNavigationHandlers, type HistoryCaptureEvent } from '@/platform/chatgpt/bridge';
import { revealQuestion, loadQuestionHistory, setHistoryPaginationObservation, controlNativeNavigation } from '@/platform/chatgpt/navigation';
import { parseConversation, parseConversationPage } from '@/platform/chatgpt/conversation';
import { getConversationContextSnapshot } from '@/platform/chatgpt/page';
import { installMessageStreamCapture } from '@/platform/chatgpt/stream';

export default defineContentScript({
  matches: ['https://chatgpt.com/*'],
  world: 'MAIN',
  runAt: 'document_start',
  main() {
    installNavigationHandlers(revealQuestion, loadQuestionHistory, setHistoryPaginationObservation, controlNativeNavigation);
    const publisher = createHistoryPublisher();
    const messageStreamCapture = installMessageStreamCapture(publisher);
    const originalFetch = window.fetch;
    window.fetch = function (input, init) {
      // Request bodies must be cloned before native fetch consumes them.
      let captureInput = input;
      if (input instanceof Request && ['POST', 'PUT', 'PATCH'].includes((init?.method ?? input.method).toUpperCase()) && !init?.body) {
        try { captureInput = input.clone(); }
        catch { console.warn('[chatgpt-history-navigator] Unable to clone submitted request'); }
      }
      const responsePromise = originalFetch.call(this, input, init);
      if (publisher.isStopped()) return responsePromise;
      // Capture failures must never change the page's request or response.
      try {
        const url = new URL(input instanceof Request ? input.url : String(input), location.href);
        const method = init?.method ?? (input instanceof Request ? input.method : 'GET');
        if (url.origin === location.origin && ['POST', 'PUT', 'PATCH', 'DELETE'].includes(method.toUpperCase()) &&
            /^\/backend-api\/files\/library\/(?:shared\/)?files(?:\/|$)/.test(url.pathname) && !url.pathname.endsWith('/opened')) {
          const [userId, conversationId] = JSON.parse(getConversationContextSnapshot());
          if (userId && conversationId) {
            const requestStartedAt = performance.timeOrigin + performance.now();
            const submitted = typeof init?.body === 'string' ? Promise.resolve(init.body)
              : captureInput instanceof Request ? captureInput.text() : Promise.resolve('');
            void Promise.all([responsePromise, submitted]).then(async ([response, body]) => {
              if (!response.ok || publisher.isStopped()) return;
              if (method.toUpperCase() === 'PATCH' && /^\/backend-api\/files\/library\/files\/[^/]+$/.test(url.pathname)) {
                const data = await response.clone().json();
                const request = body ? JSON.parse(body) : {};
                if (typeof data.id === 'string' && typeof data.file_id === 'string' && Number.isSafeInteger(data.current_version_number)) {
                  publisher.publish({ userId, conversationId, requestStartedAt, result: { kind: 'writing-file',
                    libraryId: data.id, fileId: data.file_id, version: data.current_version_number,
                    ...(typeof request.inline_content === 'string' ? { content: request.inline_content } : {}) } });
                  return;
                }
              }
              publisher.publish({ userId, conversationId, requestStartedAt, result: { kind: 'files-changed' } });
            }).catch(error => console.warn('[chatgpt-history-navigator] Unable to capture library update:', error));
          }
        }
        if (url.origin === location.origin && method.toUpperCase() === 'POST' &&
            /^\/backend-api\/(?:f\/)?conversation$/.test(url.pathname)) {
          const [userId] = JSON.parse(getConversationContextSnapshot());
          if (userId) void messageStreamCapture.captureRequest(captureInput, init, responsePromise, userId);
          return responsePromise;
        }
        if (url.origin === location.origin && method.toUpperCase() === 'GET' && url.pathname.startsWith('/backend-api/')) {
          void messageStreamCapture.captureResume(url, responsePromise);
        }
        const match = url.pathname.match(/^\/backend-api\/(conversation|conversations)\/([\da-f-]{36})(\/messages)?$/i);
        if (url.origin !== location.origin || method.toUpperCase() !== 'GET' || !match ||
            (match[1] === 'conversation' && match[3])) return responsePromise;
        const [userId] = JSON.parse(getConversationContextSnapshot()) as [string | null, string | null];
        // Never attribute a response to an account discovered only after its request.
        if (!userId) return responsePromise;
        const requestContext = { userId, conversationId: match[2]!, requestStartedAt: performance.timeOrigin + performance.now() };
        const before = url.searchParams.get('before');
        let failureReason: Extract<HistoryCaptureEvent['result'], { kind: 'unavailable' }>['reason'] = 'request-failed';
        void responsePromise.then(async (result) => {
          if (publisher.isStopped()) return;
          if (!result.ok || !result.headers.get('content-type')?.includes('application/json')) return;
          failureReason = 'response-read-failed';
          const reader = result.clone().body?.getReader();
          if (!reader) return;
          const decoder = new TextDecoder();
          let text = '';
          try {
            while (true) {
              const chunk = await reader.read();
              if (chunk.done) break;
              if (publisher.isStopped()) {
                void reader.cancel().catch(() => {});
                return;
              }
              text += decoder.decode(chunk.value, { stream: true });
            }
            if (publisher.isStopped()) return;
            text += decoder.decode();
            failureReason = 'invalid-json';
            const value: unknown = JSON.parse(text);
            failureReason = 'invalid-data';
            const captured: HistoryCaptureEvent['result'] = match[1] === 'conversation'
              ? { kind: 'history', history: parseConversation(value) }
              : { kind: 'page', page: parseConversationPage(value, requestContext.conversationId, before) };
            publisher.publish({ ...requestContext, result: captured });
          } finally {
            reader.releaseLock();
          }
        }).catch(() => publisher.publish({ ...requestContext, result: { kind: 'unavailable', reason: failureReason } }));
      } catch {
      console.warn('[chatgpt-history-navigator] Unable to observe history request');
      }
      return responsePromise;
    };
  },
});
