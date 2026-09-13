import { getConversationContextSnapshot, subscribeConversationContext } from "@/platform/chatgpt/page";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo, useSyncExternalStore } from "react";
import { getTimelineQueryOptions } from "./query";

export function useTimeline() {
  const snapshot = useSyncExternalStore(subscribeConversationContext, getConversationContextSnapshot);
  const [userId, conversationId] = JSON.parse(snapshot) as [
    string | null,
    string | null,
  ];
  const client = useQueryClient();
  const query = useQuery(
    getTimelineQueryOptions(client, userId, conversationId),
  );
  const questions = useMemo(
    () =>
      query.data?.messages
        .filter((message) => message.role === "user" && !message.hidden)
        .map((message) => ({
          id: message.id,
          text: Array.isArray(message.content.parts)
            ? message.content.parts
                .filter((part): part is string => typeof part === "string")
                .join("\n")
                .trim()
            : typeof message.content.text === "string"
              ? message.content.text.trim()
              : "",
        })) ?? [],
    [query.data],
  );
  return {
    conversationId,
    identityAvailable: userId !== null,
    questions,
    loadedQuestionCount: questions.length,
    totalQuestionCount: query.data?.isHistoryComplete ? questions.length : null,
    isLoading: query.isLoading,
    isSyncing: query.isFetching && query.data !== undefined,
    error: query.error,
    refresh: () => query.refetch({ cancelRefetch: false }),
  };
}
