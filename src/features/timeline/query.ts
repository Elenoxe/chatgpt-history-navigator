import {
  ChatgptHttpError,
  fetchConversation,
  fetchConversationPage,
  fetchAccessToken,
} from "@/platform/chatgpt/api";
import {
  ConversationDataError,
  mergeConversationPages,
  mergeStreamMessages,
  type ConversationHistory,
  type ConversationPage,
} from "@/platform/chatgpt/conversation";
import { queryOptions, type QueryClient } from "@tanstack/react-query";
import { subscribeHistoryCaptureEvents } from '@/platform/chatgpt/bridge';
import { getConversationContextSnapshot, subscribeConversationContext } from '@/platform/chatgpt/page';

// Query objects own their ordering metadata; removal/GC also releases this state.
const historyLoadStates = new WeakMap<object, {
  acceptedSnapshotStartedAt: number;
  activeLoadStartedAt: number;
  streamStartedAt: number;
  streamMessageIds: Set<string>;
  streamBranchParentId?: string;
}>();
function getHistoryLoadState(client: QueryClient, queryKey: readonly unknown[]) {
  const query = client.getQueryCache().build(client, { queryKey });
  let load = historyLoadStates.get(query);
  if (!load) {
    load = { acceptedSnapshotStartedAt: 0, activeLoadStartedAt: 0, streamStartedAt: 0, streamMessageIds: new Set() };
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
    if (capture.result.kind === 'messages') {
      // Streams remain associated with their request even after SPA navigation.
      if (capture.userId !== userId) return;
      const queryKey = ['timeline', userId, capture.conversationId] as const;
      const load = getHistoryLoadState(client, queryKey);
      if (capture.requestStartedAt < load.streamStartedAt ||
          (capture.requestStartedAt !== load.streamStartedAt && capture.requestStartedAt < load.acceptedSnapshotStartedAt)) return;
      if (capture.requestStartedAt !== load.streamStartedAt) {
        load.streamMessageIds.clear();
        load.streamBranchParentId = capture.result.branchParentId;
      }
      load.streamStartedAt = capture.requestStartedAt;
      load.acceptedSnapshotStartedAt = Math.max(load.acceptedSnapshotStartedAt, capture.requestStartedAt);
      // Subsequent reply chunks must not cancel a refresh started during generation.
      if (load.activeLoadStartedAt < capture.requestStartedAt) void client.cancelQueries({ queryKey, exact: true });
      const { messages, nodes, phase, branchParentId } = capture.result;
      for (const node of nodes) if (node.messageId) load.streamMessageIds.add(node.messageId);
      for (const message of messages) load.streamMessageIds.add(message.id);
      client.setQueryData<ConversationHistory>(queryKey, current => mergeStreamMessages(
        current, capture.conversationId, messages, nodes, phase === 'streaming', branchParentId));
      const history = client.getQueryData<ConversationHistory>(queryKey);
      if (phase === 'interrupted' || (phase === 'complete' && !history?.isHistoryComplete)) {
        void client.invalidateQueries({ queryKey, exact: true });
      }
      return;
    }
    if (capture.userId !== userId || capture.conversationId !== conversationId ||
        capture.requestStartedAt < contextChangedAt) return;
    const queryKey = ['timeline', userId, conversationId] as const;
    if (client.getQueryData<ConversationHistory>(queryKey)?.isGenerating) return;
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
      console.warn('[chatgpt-history-navigator] History capture unavailable:', capture.result.reason);
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
        console.warn('[chatgpt-history-navigator] Captured history cannot be merged:', error.message);
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
    enabled: query => userId !== null && conversationId !== null && !query.state.data?.isGenerating,
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
      const startedDuringGeneration = client.getQueryData<ConversationHistory>(queryKey)?.isGenerating === true;
      load.activeLoadStartedAt = requestStartedAt;
      const accessToken = await fetchAccessToken(signal);
      const options = { accessToken, signal };
      const updateHistoryCache = (history: ConversationHistory) => {
        signal.throwIfAborted();
        if (requestStartedAt < load.acceptedSnapshotStartedAt) {
          throw new ConversationDataError('History load superseded by a newer snapshot');
        }
        load.acceptedSnapshotStartedAt = requestStartedAt;
        return client.setQueryData<ConversationHistory>(queryKey, (current) => {
          if (current?.isHistoryComplete && !history.isHistoryComplete) return current;
          if (current && (startedDuringGeneration || current.isGenerating)) {
            return mergeStreamMessages(history, conversationId,
              current.messages.filter(message => load.streamMessageIds.has(message.id)),
              current.nodes.filter(node => node.messageId !== null && load.streamMessageIds.has(node.messageId)),
              current.isGenerating === true, load.streamBranchParentId);
          }
          return history;
        })!;
      };
      try {
        const history = await fetchConversation(conversationId, options);
        signal.throwIfAborted();
        if (history.isHistoryComplete) {
          return updateHistoryCache(history);
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
        const cachedHistory = updateHistoryCache(history);
        before = page.previousCursor ?? undefined;
        if (before === undefined) {
          if (!history.isHistoryComplete)
            throw new ConversationDataError(
              "History is missing the latest messages",
            );
          return cachedHistory;
        }
      } while (before !== undefined);
      throw new ConversationDataError("History did not complete");
    },
  });
}
