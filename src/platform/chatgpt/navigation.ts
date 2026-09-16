// This adapter runs in MAIN. ChatGPT does not expose a public reveal API.
// Its table-of-contents callback is retained in React Compiler's memo cache.
// Match the callback's named request fields, never a minified name or slot index.
// If that contract changes, return false and let DOM navigation take over.
type Fiber = {
  return?: Fiber;
  memoizedProps?: Record<string, unknown>;
  updateQueue?: { memoCache?: { data?: unknown[][] } };
};

type NativeHistoryLoader = (conversationId: string, options: {
  includeMessageId: string;
  forceNetworkFetch: boolean;
  signal: AbortSignal;
  shouldApplyResponse: () => boolean;
}) => Promise<unknown>;

export async function loadQuestionHistory(messageId: string, signal: AbortSignal): Promise<boolean> {
  const pathname = location.pathname;
  const conversationId = pathname.match(/\/c\/([^/]+)\/?$/)?.[1];
  // Reuse the module already loaded by the page. No bundled hash or minified
  // export name is stable; identify the native loader by its option contract.
  const moduleUrl = [...document.querySelectorAll<HTMLLinkElement>('link[href]')]
    .map(link => new URL(link.href))
    .find(url => url.origin === location.origin &&
      /^\/cdn\/assets\/conversation-small-[\w-]+\.js$/.test(url.pathname));
  if (!conversationId || !moduleUrl) return false;
  const exports: Record<string, unknown> = await import(/* @vite-ignore */ moduleUrl.href);
  signal.throwIfAborted();
  const loaders = Object.values(exports).filter((value): value is NativeHistoryLoader => {
    if (typeof value !== 'function') return false;
    const source = Function.prototype.toString.call(value);
    return source.startsWith('async function') &&
      ['includeMessageId', 'forceNetworkFetch', 'shouldApplyResponse', 'onConversationAppliedFromNetwork']
        .every(field => new RegExp(`\\b${field}\\s*:`).test(source));
  });
  if (loaders.length !== 1) return false;
  const isCurrent = () => !signal.aborted && location.pathname === pathname;
  if (!isCurrent()) return false;
  // The host owns parsing, branch state and pagination cursors. Never inject our
  // Query cache into its store. Late responses must not replace a newer target.
  await loaders[0]!(conversationId, {
    includeMessageId: messageId, forceNetworkFetch: true, signal,
    shouldApplyResponse: isCurrent,
  });
  signal.throwIfAborted();
  return isCurrent();
}

export function revealQuestion(messageId: string): boolean {
  const element = document.querySelector<HTMLElement>(
    `main [data-turn-id-container="${CSS.escape(messageId)}"]`,
  ) ?? document.querySelector<HTMLElement>('main [data-turn-id-container]');
  // The callback belongs to the conversation, not the target turn. An existing
  // turn can expose it before the requested turn has a placeholder.
  if (!element) return false;
  const key = Object.keys(element).find(key => key.startsWith('__reactFiber$'));
  if (!key) return false;
  let fiber = (element as unknown as Record<string, Fiber>)[key];
  const callbacks = new Set<(turnId: string, messageId: string) => void>();
  let flushSync: ((callback: () => void) => void) | undefined;
  for (; fiber; fiber = fiber.return) {
    const props = fiber.memoizedProps;
    if (typeof props?.flushSync === 'function') {
      flushSync = props.flushSync as typeof flushSync;
    }
    if (!props?.conversation || !('scrollContainerRef' in props) || !('enableTableOfContents' in props)) continue;
    for (const value of fiber.updateQueue?.memoCache?.data?.flat() ?? []) {
      if (typeof value !== 'function' || value.length !== 2) continue;
      const source = Function.prototype.toString.call(value);
      if (['messageId', 'turnId', 'requestId'].every(field =>
        new RegExp(`\\b${field}\\s*:`).test(source))) {
        callbacks.add(value as (turnId: string, messageId: string) => void);
      }
    }
  }
  if (callbacks.size !== 1 || !flushSync) return false;
  const callback = [...callbacks][0]!;
  // Commit the reveal immediately, including when background React work is
  // throttled. No private state is overwritten and the host owns rendering.
  flushSync(() => callback(messageId, messageId));
  return document.querySelector(`main [data-message-id="${CSS.escape(messageId)}"]`) !== null;
}
