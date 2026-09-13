import {
  ChatgptHttpError,
  fetchConversation,
  fetchConversationPage,
  getAccessToken,
} from "@/platform/chatgpt/api";
import {
  ConversationDataError,
  mergeConversationPages,
  type ConversationHistory,
  type ConversationPage,
} from "@/platform/chatgpt/conversation";
import { queryOptions, type QueryClient } from "@tanstack/react-query";

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
    staleTime: (query) => (query.state.data?.complete ? 60_000 : 0),
    gcTime: 30 * 60_000,
    queryFn: async ({ signal }): Promise<ConversationHistory> => {
      if (!userId || !conversationId)
        throw new Error("No active conversation identity");
      const accessToken = await getAccessToken(signal);
      const options = { accessToken, signal };
      const publish = (history: ConversationHistory) => {
        signal.throwIfAborted();
        client.setQueryData(queryKey, history);
      };
      try {
        const history = await fetchConversation(conversationId, options);
        signal.throwIfAborted();
        if (history.complete) return history;
        publish(history);
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
        publish(history);
        before = page.previousCursor ?? undefined;
        if (before === undefined) {
          if (!history.complete)
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
