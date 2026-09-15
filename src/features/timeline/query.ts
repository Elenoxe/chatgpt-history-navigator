import {
  ChatgptHttpError,
  fetchConversation,
  fetchConversationPage,
  fetchAccessToken,
} from "@/platform/chatgpt/api";
import {
  ConversationDataError,
  mergeConversationPages,
  type ConversationHistory,
  type ConversationPage,
} from "@/platform/chatgpt/conversation";
import { queryOptions, type QueryClient } from "@tanstack/react-query";
import { subscribeHistoryCaptureEvents } from '@/platform/chatgpt/bridge';
import { getConversationContextSnapshot, subscribeConversationContext } from '@/platform/chatgpt/page';

// Query objects own their ordering metadata; removal/GC also releases this state.
const historyLoadStates = new WeakMap<object, { acceptedSnapshotStartedAt: number; activeLoadStartedAt: number }>();
function getHistoryLoadState(client: QueryClient, queryKey: readonly unknown[]) {
  const query = client.getQueryCache().build(client, { queryKey });
  let load = historyLoadStates.get(query);
  if (!load) {
    load = { acceptedSnapshotStartedAt: 0, activeLoadStartedAt: 0 };
    historyLoadStates.set(query, load);
  }
  return load;
}

export function startCapturedHistorySync(client: QueryClient) {
  let contextSnapshot = getConversationContextSnapshot();
  let contextChangedAt = 0;
  let pages: ConversationPage[] = [];
  let pageBatchStartedAt = 0;
  const clearPages = () => {
    pages = [];
    pageBatchStartedAt = 0;
  };
  // Release page objects as soon as another accepted load supersedes this batch,
  // even if the page never sends another capture event.
  const unsubscribeCache = client.getQueryCache().subscribe((event) => {
    if (!pages.length) return;
    const [userId, conversationId] = JSON.parse(contextSnapshot);
    const key = event.query.queryKey;
    if (key[0] !== 'timeline' || key[1] !== userId || key[2] !== conversationId) return;
    if (event.type === 'removed' ||
        (historyLoadStates.get(event.query)?.acceptedSnapshotStartedAt ?? 0) > pageBatchStartedAt) clearPages();
  });
  const updateContext = () => {
    const next = getConversationContextSnapshot();
    if (next === contextSnapshot) return;
    const [previousUser, previousConversation] = JSON.parse(contextSnapshot);
    const [, nextConversation] = JSON.parse(next);
    contextSnapshot = next;
    // Bootstrap identity appears after document_start on an initial page load.
    if (previousUser !== null || previousConversation !== nextConversation) {
      contextChangedAt = performance.timeOrigin + performance.now();
    }
    clearPages();
  };
  const unsubscribeContext = subscribeConversationContext(updateContext);
  const unsubscribeCapture = subscribeHistoryCaptureEvents((capture) => {
    updateContext();
    const [userId, conversationId] = JSON.parse(contextSnapshot) as [string | null, string | null];
    if (capture.userId !== userId || capture.conversationId !== conversationId ||
        capture.requestStartedAt < contextChangedAt) return;
    const queryKey = ['timeline', userId, conversationId] as const;
    const load = getHistoryLoadState(client, queryKey);
    let snapshotStartedAt = capture.requestStartedAt;
    if (capture.result.kind === 'page' && capture.result.page.before !== null) {
      snapshotStartedAt = pageBatchStartedAt;
    }
    if (snapshotStartedAt < load.acceptedSnapshotStartedAt) {
      if (pages.length && pageBatchStartedAt < load.acceptedSnapshotStartedAt) clearPages();
      return;
    }
    if (capture.result.kind === 'unavailable') {
      clearPages();
      console.warn('[chatgpt-timeline] History capture unavailable:', capture.result.reason);
      return;
    }
    let history: ConversationHistory;
    if (capture.result.kind === 'history') {
      history = capture.result.history;
      if (history.conversationId !== conversationId) return;
      clearPages();
    } else {
      const page = capture.result.page;
      if (page.conversationId !== conversationId) return;
      if (page.before === null) {
        clearPages();
        pageBatchStartedAt = capture.requestStartedAt;
      } else if (!pages.length || pages.at(-1)?.previousCursor !== page.before) return;
      pages.push(page);
      try {
        history = mergeConversationPages(pages);
      } catch (error) {
        clearPages();
        if (!(error instanceof ConversationDataError)) throw error;
        console.warn('[chatgpt-timeline] Captured history cannot be merged:', error.message);
        return;
      }
    }
    load.acceptedSnapshotStartedAt = snapshotStartedAt;
    const state = client.getQueryState<ConversationHistory>(queryKey);
    const supersedesActiveLoad = state?.fetchStatus === 'fetching' &&
      snapshotStartedAt > load.activeLoadStartedAt;
    if (history.isHistoryComplete || supersedesActiveLoad) {
      void client.cancelQueries({ queryKey, exact: true });
    }
    if (history.isHistoryComplete || !state?.data?.isHistoryComplete) {
      client.setQueryData(queryKey, history);
    }
    if (history.isHistoryComplete) clearPages();
    else if (supersedesActiveLoad || state?.fetchStatus !== 'fetching') {
      // A newer partial snapshot invalidates an older load, but still needs
      // completion. Keep any complete cached history visible during that load.
      void client.invalidateQueries({ queryKey, exact: true });
    }
  });
  return () => {
    unsubscribeCapture();
    unsubscribeContext();
    unsubscribeCache();
    clearPages();
  };
}

export function getTimelineQueryOptions(
  client: QueryClient,
  userId: string | null,
  conversationId: string | null,
) {
  const queryKey = ["timeline", userId, conversationId] as const;
  return queryOptions<ConversationHistory>({
    queryKey,
    enabled: userId !== null && conversationId !== null,
    retry: false,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    staleTime: (query) => (query.state.data?.isHistoryComplete ? 60_000 : 0),
    gcTime: 30 * 60_000,
    queryFn: async ({ signal }): Promise<ConversationHistory> => {
      if (!userId || !conversationId)
        throw new Error("No active conversation identity");
      const load = getHistoryLoadState(client, queryKey);
      const requestStartedAt = performance.timeOrigin + performance.now();
      load.activeLoadStartedAt = requestStartedAt;
      const accessToken = await fetchAccessToken(signal);
      const options = { accessToken, signal };
      const updateHistoryCache = (history: ConversationHistory) => {
        signal.throwIfAborted();
        if (requestStartedAt < load.acceptedSnapshotStartedAt) {
          throw new ConversationDataError('History load superseded by a newer snapshot');
        }
        load.acceptedSnapshotStartedAt = requestStartedAt;
        client.setQueryData<ConversationHistory>(queryKey, (current) =>
          current?.isHistoryComplete && !history.isHistoryComplete ? current : history);
      };
      try {
        const history = await fetchConversation(conversationId, options);
        signal.throwIfAborted();
        if (history.isHistoryComplete) {
          updateHistoryCache(history);
          return history;
        }
        updateHistoryCache(history);
      } catch (error) {
        signal.throwIfAborted();
        // Only an explicitly unsupported endpoint permits switching API paths.
        if (
          !(error instanceof ChatgptHttpError) ||
          ![404, 405, 410, 501].includes(error.status)
        )
          throw error;
      }
      const pages: ConversationPage[] = [];
      let before: string | undefined;
      do {
        signal.throwIfAborted();
        const page = await fetchConversationPage(conversationId, {
          ...options,
          before,
        });
        signal.throwIfAborted();
        pages.push(page);
        const history = mergeConversationPages(pages);
        updateHistoryCache(history);
        before = page.previousCursor ?? undefined;
        if (before === undefined) {
          if (!history.isHistoryComplete)
            throw new ConversationDataError(
              "History is missing the latest messages",
            );
          return history;
        }
      } while (before !== undefined);
      throw new ConversationDataError("History did not complete");
    },
  });
}
