import {
  ChatgptHttpError,
  fetchConversation,
  fetchConversationPage,
  fetchAccessToken,
} from "@/platform/chatgpt/api"
import {
  ConversationDataError,
  mergeConversationHistory,
  mergeConversationPages,
  mergeStreamMessages,
  type ConversationHistory,
  type ConversationPage,
} from "@/platform/chatgpt/conversation"
import { queryOptions, type QueryClient } from "@tanstack/react-query"
import { requestNativeHistory, subscribeHistoryCaptureEvents } from "@/platform/chatgpt/bridge"
import {
  getConversationContextSnapshot,
  subscribeConversationContext,
} from "@/platform/chatgpt/page"
import {
  applyWritingFileUpdates,
  mergeWritingBlocks,
  type WritingBlocks,
} from "@/platform/chatgpt/writing"

// Query objects own their ordering metadata; removal/GC also releases this state.
const historyLoadStates = new WeakMap<
  object,
  {
    acceptedSnapshotStartedAt: number
    activeLoadStartedAt: number
    nativeLoading: number
    streamStartedAt: number
    streamMessageIds: Set<string>
    streamBranchParentId?: string
    writingPatches: Map<string, { observedAt: number; blocks: WritingBlocks }>
  }
>()
function getHistoryLoadState(client: QueryClient, queryKey: readonly unknown[]) {
  const query = client.getQueryCache().build(client, { queryKey })
  let load = historyLoadStates.get(query)
  if (!load) {
    load = {
      acceptedSnapshotStartedAt: 0,
      activeLoadStartedAt: 0,
      nativeLoading: 0,
      streamStartedAt: 0,
      streamMessageIds: new Set(),
      writingPatches: new Map(),
    }
    historyLoadStates.set(query, load)
  }
  return load
}

function applyWritingUpdates(
  history: ConversationHistory,
  load: ReturnType<typeof getHistoryLoadState>,
  snapshotStartedAt = 0,
) {
  const messages = history.messages.map((message) => {
    const patch = load.writingPatches.get(message.id)
    if (!patch) return message
    if (snapshotStartedAt > patch.observedAt && message.metadata.writing_blocks) {
      load.writingPatches.delete(message.id)
      return message
    }
    return {
      ...message,
      metadata: {
        ...message.metadata,
        writing_blocks: mergeWritingBlocks(message.metadata.writing_blocks, patch.blocks),
      },
    }
  })
  return applyWritingFileUpdates({ ...history, messages })
}

export function startCapturedHistorySync(client: QueryClient) {
  let contextSnapshot = getConversationContextSnapshot()
  let contextChangedAt = 0
  let pages: ConversationPage[] = []
  let pageBatchStartedAt = 0
  const clearPages = () => {
    pages = []
    pageBatchStartedAt = 0
  }
  // Release page objects as soon as another accepted load supersedes this batch,
  // even if the page never sends another capture event.
  const unsubscribeCache = client.getQueryCache().subscribe((event) => {
    if (!pages.length) return
    const [userId, conversationId] = JSON.parse(contextSnapshot)
    const key = event.query.queryKey
    if (key[0] !== "timeline" || key[1] !== userId || key[2] !== conversationId) return
    if (
      event.type === "removed" ||
      (historyLoadStates.get(event.query)?.acceptedSnapshotStartedAt ?? 0) > pageBatchStartedAt
    )
      clearPages()
  })
  const updateContext = () => {
    const next = getConversationContextSnapshot()
    if (next === contextSnapshot) return
    const [previousUser, previousConversation] = JSON.parse(contextSnapshot)
    const [, nextConversation] = JSON.parse(next)
    contextSnapshot = next
    // Bootstrap identity appears after document_start on an initial page load.
    if (previousUser !== null || previousConversation !== nextConversation) {
      contextChangedAt = performance.timeOrigin + performance.now()
    }
    clearPages()
  }
  const unsubscribeContext = subscribeConversationContext(updateContext)
  const unsubscribeCapture = subscribeHistoryCaptureEvents((capture) => {
    updateContext()
    const [userId, conversationId] = JSON.parse(contextSnapshot) as [string | null, string | null]
    if (capture.result.kind === "writing-file") {
      if (capture.userId !== userId) return
      const revision = capture.result
      const key = ["preview", userId, "writing-revision", revision.libraryId]
      client.setQueryData<typeof revision>(key, (previous) =>
        previous && previous.version > revision.version ? previous : revision,
      )
      void client.invalidateQueries({ queryKey: ["preview", userId, "file"] })
      return
    }
    if (capture.result.kind === "files-changed") {
      if (capture.userId !== userId) return
      // Keep the version watermark, but release the saved-body override so observers can refetch.
      client.setQueriesData<{ fileId: string; version: number; content?: string }>(
        {
          queryKey: ["preview", userId, "writing-revision"],
        },
        (previous) => previous && { ...previous, content: undefined },
      )
      // Saved document content lives independently of conversation snapshots.
      void client
        .cancelQueries({ queryKey: ["preview", userId] })
        .then(() => client.invalidateQueries({ queryKey: ["preview", userId] }))
      return
    }
    if (capture.result.kind === "writing") {
      if (capture.userId !== userId) return
      const queryKey = ["timeline", userId, capture.conversationId] as const
      const load = getHistoryLoadState(client, queryKey)
      if (
        capture.requestStartedAt < load.streamStartedAt ||
        (capture.requestStartedAt !== load.streamStartedAt &&
          capture.requestStartedAt < load.acceptedSnapshotStartedAt)
      )
        return
      const { messageId, blocks } = capture.result
      load.writingPatches.set(messageId, {
        observedAt: performance.timeOrigin + performance.now(),
        blocks: mergeWritingBlocks(load.writingPatches.get(messageId)?.blocks, blocks),
      })
      client.setQueryData<ConversationHistory>(
        queryKey,
        (current) => current && applyWritingUpdates(current, load),
      )
      return
    }
    if (capture.result.kind === "messages") {
      // Streams remain associated with their request even after SPA navigation.
      if (capture.userId !== userId) return
      const queryKey = ["timeline", userId, capture.conversationId] as const
      const load = getHistoryLoadState(client, queryKey)
      if (
        capture.requestStartedAt < load.streamStartedAt ||
        (capture.requestStartedAt !== load.streamStartedAt &&
          capture.requestStartedAt < load.acceptedSnapshotStartedAt)
      )
        return
      if (capture.requestStartedAt !== load.streamStartedAt) {
        load.streamMessageIds.clear()
        load.streamBranchParentId = capture.result.branchParentId
      }
      load.streamStartedAt = capture.requestStartedAt
      load.acceptedSnapshotStartedAt = Math.max(
        load.acceptedSnapshotStartedAt,
        capture.requestStartedAt,
      )
      // Subsequent reply chunks must not cancel a refresh started during generation.
      if (load.activeLoadStartedAt < capture.requestStartedAt)
        void client.cancelQueries({ queryKey, exact: true })
      const { messages, nodes, phase, branchParentId } = capture.result
      for (const node of nodes) if (node.messageId) load.streamMessageIds.add(node.messageId)
      for (const message of messages) load.streamMessageIds.add(message.id)
      client.setQueryData<ConversationHistory>(queryKey, (current) =>
        applyWritingUpdates(
          mergeStreamMessages(
            current,
            capture.conversationId,
            messages,
            nodes,
            phase === "streaming",
            branchParentId,
          ),
          load,
        ),
      )
      const history = client.getQueryData<ConversationHistory>(queryKey)
      if (phase === "interrupted" || (phase === "complete" && !history?.isHistoryComplete)) {
        void client.invalidateQueries({ queryKey, exact: true })
      }
      return
    }
    if (
      capture.userId !== userId ||
      capture.conversationId !== conversationId ||
      capture.requestStartedAt < contextChangedAt
    )
      return
    const queryKey = ["timeline", userId, conversationId] as const
    if (client.getQueryData<ConversationHistory>(queryKey)?.isGenerating) return
    const load = getHistoryLoadState(client, queryKey)
    let snapshotStartedAt = capture.requestStartedAt
    if (capture.result.kind === "page" && capture.result.page.before !== null) {
      snapshotStartedAt = pageBatchStartedAt
    }
    if (snapshotStartedAt < load.acceptedSnapshotStartedAt) {
      if (pages.length && pageBatchStartedAt < load.acceptedSnapshotStartedAt) clearPages()
      return
    }
    if (capture.result.kind === "unavailable") {
      clearPages()
      console.warn(
        "[chatgpt-history-navigator] History capture unavailable:",
        capture.result.reason,
      )
      return
    }
    let history: ConversationHistory
    if (capture.result.kind === "history") {
      history = capture.result.history
      if (history.conversationId !== conversationId) return
      clearPages()
    } else {
      const page = capture.result.page
      if (page.conversationId !== conversationId) return
      if (page.before === null) {
        clearPages()
        pageBatchStartedAt = capture.requestStartedAt
      } else if (!pages.length || pages.at(-1)?.previousCursor !== page.before) return
      pages.push(page)
      try {
        history = mergeConversationPages(pages)
      } catch (error) {
        clearPages()
        if (!(error instanceof ConversationDataError)) throw error
        console.warn(
          "[chatgpt-history-navigator] Captured history cannot be merged:",
          error.message,
        )
        return
      }
    }
    load.acceptedSnapshotStartedAt = snapshotStartedAt
    const state = client.getQueryState<ConversationHistory>(queryKey)
    const supersedesActiveLoad =
      state?.fetchStatus === "fetching" && snapshotStartedAt > load.activeLoadStartedAt
    if (!load.nativeLoading && (history.isHistoryComplete || supersedesActiveLoad)) {
      void client.cancelQueries({ queryKey, exact: true })
    }
    if (history.isHistoryComplete || !state?.data?.isHistoryComplete) {
      client.setQueryData(
        queryKey,
        applyWritingUpdates(
          mergeConversationHistory(state?.data, history),
          load,
          snapshotStartedAt,
        ),
      )
    }
    if (history.isHistoryComplete) clearPages()
    else if (!load.nativeLoading && (supersedesActiveLoad || state?.fetchStatus !== "fetching")) {
      // A newer partial snapshot invalidates an older load, but still needs
      // completion. Keep any complete cached history visible during that load.
      void client.invalidateQueries({ queryKey, exact: true })
    }
  })
  return () => {
    unsubscribeCapture()
    unsubscribeContext()
    unsubscribeCache()
    clearPages()
  }
}

export function getTimelineQueryOptions(
  client: QueryClient,
  userId: string | null,
  conversationId: string | null,
) {
  const queryKey = ["timeline", userId, conversationId] as const
  return queryOptions<ConversationHistory>({
    queryKey,
    enabled: (query) =>
      userId !== null && conversationId !== null && !query.state.data?.isGenerating,
    retry: false,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    staleTime: (query) => (query.state.data?.isHistoryComplete ? 60_000 : 0),
    gcTime: 30 * 60_000,
    queryFn: async ({ signal }): Promise<ConversationHistory> => {
      if (!userId || !conversationId) throw new Error("No active conversation identity")
      const startedAt = performance.now()
      console.debug("[chatgpt-history-navigator] History loading started:", { conversationId })
      const complete = (history: ConversationHistory, source: string) => {
        console.debug("[chatgpt-history-navigator] History loading completed:", {
          conversationId,
          source,
          messages: history.messages.length,
          elapsedMs: Math.round(performance.now() - startedAt),
        })
        return history
      }
      const load = getHistoryLoadState(client, queryKey)
      let requestStartedAt = performance.timeOrigin + performance.now()
      const startedDuringGeneration =
        client.getQueryData<ConversationHistory>(queryKey)?.isGenerating === true
      load.activeLoadStartedAt = requestStartedAt
      load.nativeLoading = requestStartedAt
      let nativeAvailable: boolean
      try {
        nativeAvailable = await requestNativeHistory(userId, conversationId, signal)
      } finally {
        if (load.nativeLoading === requestStartedAt) load.nativeLoading = 0
      }
      signal.throwIfAborted()
      const captured = client.getQueryData<ConversationHistory>(queryKey)
      if (captured?.isHistoryComplete) return complete(captured, "captured/cache")
      console.info("[chatgpt-history-navigator] Loading history through the API:", {
        conversationId,
        reason: nativeAvailable
          ? "native history complete but extension cache incomplete"
          : "native loader unavailable",
      })
      // This is a new snapshot, later than any partial native captures.
      requestStartedAt = performance.timeOrigin + performance.now()
      load.activeLoadStartedAt = requestStartedAt
      const accessToken = await fetchAccessToken(signal)
      const options = { accessToken, signal }
      const updateHistoryCache = (history: ConversationHistory) => {
        signal.throwIfAborted()
        if (requestStartedAt < load.acceptedSnapshotStartedAt) {
          throw new ConversationDataError("History load superseded by a newer snapshot")
        }
        load.acceptedSnapshotStartedAt = requestStartedAt
        return client.setQueryData<ConversationHistory>(queryKey, (current) => {
          if (current?.isHistoryComplete && !history.isHistoryComplete) return current
          history = mergeConversationHistory(current, history)
          if (current && (startedDuringGeneration || current.isGenerating)) {
            return applyWritingUpdates(
              mergeStreamMessages(
                history,
                conversationId,
                current.messages.filter((message) => load.streamMessageIds.has(message.id)),
                current.nodes.filter(
                  (node) => node.messageId !== null && load.streamMessageIds.has(node.messageId),
                ),
                current.isGenerating === true,
                load.streamBranchParentId,
              ),
              load,
              requestStartedAt,
            )
          }
          return applyWritingUpdates(history, load, requestStartedAt)
        })!
      }
      try {
        const history = await fetchConversation(conversationId, options)
        signal.throwIfAborted()
        if (history.isHistoryComplete) {
          return complete(updateHistoryCache(history), "api")
        }
        updateHistoryCache(history)
      } catch (error) {
        signal.throwIfAborted()
        // Only an explicitly unsupported endpoint permits switching API paths.
        if (!(error instanceof ChatgptHttpError) || ![404, 405, 410, 501].includes(error.status))
          throw error
      }
      const pages: ConversationPage[] = []
      console.debug("[chatgpt-history-navigator] Loading paginated history:", { conversationId })
      let before: string | undefined
      do {
        signal.throwIfAborted()
        const page = await fetchConversationPage(conversationId, {
          ...options,
          before,
        })
        signal.throwIfAborted()
        pages.push(page)
        const history = mergeConversationPages(pages)
        const cachedHistory = updateHistoryCache(history)
        before = page.previousCursor ?? undefined
        if (before === undefined) {
          if (!history.isHistoryComplete)
            throw new ConversationDataError("History is missing the latest messages")
          return complete(cachedHistory, "paginated-api")
        }
      } while (before !== undefined)
      throw new ConversationDataError("History did not complete")
    },
  })
}
